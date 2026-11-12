import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  checkedLookup,
  FetchRefusedError,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  hostIsAllowed,
  isPublicAddress,
  normalizeAllowedHost,
  safeGet,
} from '../src/net.js'

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255', // just below 172.16.0.0/12
    '172.32.0.1', // just above it
    '100.63.255.255', // just below the shared range
    '100.128.0.1', // just above it
    '192.0.0.9', // a globally reachable assignment inside a reserved range
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // IPv4-mapped: the IPv4 inside decides
    '64:ff9b::808:808', // NAT64 of 8.8.8.8: reachable on an IPv6-only network
  ])('allows the public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })

  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.100.100.200', // Alibaba Cloud metadata
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '::1',
    '::',
    'fe80::1',
    'fe80::1%en0',
    'fd00:ec2::254', // AWS metadata over IPv6
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::1', // 6to4
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '::ffff:0:7f00:1', // IPv4-translated 127.0.0.1
  ])('refuses the non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('refuses anything that is not an IP address', () => {
    for (const value of [
      '',
      'localhost',
      'example.com',
      '999.1.1.1',
      '1.2.3',
    ]) {
      expect(isPublicAddress(value), value).toBe(false)
    }
  })
})

describe('the host allowlist', () => {
  it('normalizes entries: case, trailing dot, IDNA, IPv6', () => {
    expect(normalizeAllowedHost(' Example.COM. ')).toBe('example.com')
    expect(normalizeAllowedHost('*.Example.com')).toBe('*.example.com')
    expect(normalizeAllowedHost('bücher.example')).toBe('xn--bcher-kva.example')
    expect(normalizeAllowedHost('[::1]')).toBe('::1')
    expect(normalizeAllowedHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it.each([
    'https://example.com',
    'example.com:8080',
    'example.com/path',
    '*.*.example.com',
    'a*.example.com',
    '',
    '*.',
    'user@example.com',
    'a..b',
    '[example.com]', // brackets belong to IPv6 literals only
    '[example.com',
    'example.com]',
  ])('rejects the entry %j', (entry) => {
    expect(() => normalizeAllowedHost(entry)).toThrow()
  })

  it('matches an exact host, or any depth of subdomain for a wildcard but not its apex', () => {
    const allowed = ['example.com', '*.docs.example.org', '::1']
    expect(hostIsAllowed('example.com', allowed)).toBe(true)
    expect(hostIsAllowed('EXAMPLE.com.', allowed)).toBe(true)
    expect(hostIsAllowed('www.example.com', allowed)).toBe(false)
    expect(hostIsAllowed('a.docs.example.org', allowed)).toBe(true)
    expect(hostIsAllowed('a.b.docs.example.org', allowed)).toBe(true)
    expect(hostIsAllowed('docs.example.org', allowed)).toBe(false)
    expect(hostIsAllowed('evildocs.example.org', allowed)).toBe(false)
    expect(hostIsAllowed('[::1]', allowed)).toBe(true)
    expect(hostIsAllowed('example.com.evil.test', allowed)).toBe(false)
  })
})

describe('safeGet', () => {
  let server: Server
  let base: string
  let seen: string[]
  const open = () => true // let the tests reach 127.0.0.1

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '')
      const url = req.url ?? ''
      if (url === '/ok') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('hello')
      } else if (url === '/redirect') {
        res
          .writeHead(302, { location: '/ok' })
          .end('this body must never be read')
      } else if (url === '/redirect-twice') {
        res.writeHead(301, { location: '/redirect' }).end()
      } else if (url === '/redirect-private') {
        res
          .writeHead(302, {
            location: 'http://169.254.169.254/latest/meta-data/',
          })
          .end()
      } else if (url === '/redirect-file') {
        res.writeHead(302, { location: 'file:///etc/passwd' }).end()
      } else if (url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end()
      } else if (url === '/echo') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(req.headers))
      } else if (url.startsWith('/status/')) {
        res
          .writeHead(Number(url.slice(8)), { 'content-type': 'text/plain' })
          .end('error page')
      } else if (url === '/gzip') {
        res
          .writeHead(200, { 'content-encoding': 'gzip' })
          .end(zlib.gzipSync('zipped body'))
      } else if (url === '/gzip-bomb') {
        // a few KB on the wire, far over the cap once inflated
        res
          .writeHead(200, { 'content-encoding': 'gzip' })
          .end(zlib.gzipSync(Buffer.alloc(MAX_RESPONSE_BYTES + 1_000_000)))
      } else if (url === '/br') {
        res.writeHead(200, { 'content-encoding': 'br' }).end('x')
      } else if (url === '/declared-big') {
        res.writeHead(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) })
        res.write('x')
        setTimeout(() => res.destroy(), 50)
      } else if (url === '/endless') {
        res.writeHead(200)
        const timer = setInterval(() => res.write(Buffer.alloc(256 * 1024)), 1)
        res.on('close', () => clearInterval(timer))
      } else if (url === '/silent') {
        // never answers
      } else if (url === '/stalled-body') {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
      } else {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    seen = []
  })

  const get = (
    path: string,
    extra: Partial<Parameters<typeof safeGet>[1]> = {},
  ) => safeGet(`${base}${path}`, { timeoutMs: 5000, permit: open, ...extra })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => 'no error',
      (error: Error) => error.message,
    )

  describe('fetching', () => {
    it('returns the status, headers and body', async () => {
      const response = await get('/ok')
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toBe('text/plain')
      expect(response.body.toString()).toBe('hello')
      expect(response.url.pathname).toBe('/ok')
    })

    it('sends the headers it is given, and asks for compression', async () => {
      const response = await get('/echo', {
        headers: { 'User-Agent': 'test-agent/1', Accept: 'text/markdown' },
      })
      const sent = JSON.parse(response.body.toString())
      expect(sent['user-agent']).toBe('test-agent/1')
      expect(sent.accept).toBe('text/markdown')
      expect(sent['accept-encoding']).toBe('gzip, deflate')
    })

    it('decompresses gzip', async () => {
      expect((await get('/gzip')).body.toString()).toBe('zipped body')
    })

    it('follows redirects, reporting the final URL', async () => {
      const response = await get('/redirect-twice')
      expect(response.body.toString()).toBe('hello')
      expect(response.url.pathname).toBe('/ok')
      expect(seen).toEqual(['/redirect-twice', '/redirect', '/ok'])
    })

    it('stops a redirect loop', async () => {
      expect(await failure(get('/loop'))).toContain(
        `more than ${MAX_REDIRECTS} redirects`,
      )
      expect(seen).toHaveLength(MAX_REDIRECTS + 1)
    })

    it('does not read the body of an error response unless asked', async () => {
      const response = await get('/status/404')
      expect(response.status).toBe(404)
      expect(response.body.length).toBe(0)
      const wanted = await get('/status/404', { wantBody: () => true })
      expect(wanted.body.toString()).toBe('error page')
    })

    it('runs beforeRequest for the first request and every hop, and lets it stop the fetch', async () => {
      const urls: string[] = []
      await get('/redirect', {
        beforeRequest: async (url) => void urls.push(url.pathname),
      })
      expect(urls).toEqual(['/redirect', '/ok'])
      seen = []
      const message = await failure(
        get('/redirect', {
          beforeRequest: async (url) => {
            if (url.pathname === '/ok') throw new Error('stopped by the hook')
          },
        }),
      )
      expect(message).toBe('stopped by the hook')
      expect(seen).toEqual(['/redirect'])
    })
  })

  describe('limits', () => {
    it('refuses a body that declares more than the cap, without reading it', async () => {
      expect(await failure(get('/declared-big'))).toContain('byte limit')
    })

    it('stops an endless body at the cap', async () => {
      const started = Date.now()
      expect(await failure(get('/endless', { timeoutMs: 20_000 }))).toContain(
        'byte limit',
      )
      expect(Date.now() - started).toBeLessThan(10_000)
    })

    it('stops a small gzip body that inflates past the cap', async () => {
      expect(await failure(get('/gzip-bomb'))).toContain('byte limit')
    })

    it('honours a smaller cap', async () => {
      expect(await failure(get('/gzip', { maxBytes: 4 }))).toContain(
        '4 byte limit',
      )
    })

    it('refuses a content encoding it does not decode', async () => {
      expect(await failure(get('/br'))).toContain(
        'unsupported content encoding (br)',
      )
    })

    it('gives up on a server that never answers, and on one that stalls mid-body', async () => {
      for (const path of ['/silent', '/stalled-body']) {
        const started = Date.now()
        expect(await failure(get(path, { timeoutMs: 400 })), path).toBe(
          'timed out after 400 ms',
        )
        expect(Date.now() - started).toBeLessThan(3000)
      }
    })

    it('reports a cancellation as a cancellation, not a timeout', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)
      const message = await failure(
        get('/silent', { signal: controller.signal, timeoutMs: 10_000 }),
      )
      expect(message).not.toContain('timed out')
      expect(message).toBeTruthy()
    })
  })

  describe('the address policy', () => {
    it.each([
      ['127.0.0.1', (port: string) => `http://127.0.0.1:${port}/ok`],
      ['an IPv6 loopback literal', (port: string) => `http://[::1]:${port}/ok`],
      [
        'the decimal form of 127.0.0.1',
        (port: string) => `http://2130706433:${port}/ok`,
      ],
      [
        'the hex short form 0x7f.1',
        (port: string) => `http://0x7f.1:${port}/ok`,
      ],
      ['the short form 127.1', (port: string) => `http://127.1:${port}/ok`],
      [
        'an IPv4-mapped loopback',
        (port: string) => `http://[::ffff:127.0.0.1]:${port}/ok`,
      ],
      [
        'the cloud metadata address',
        () => 'http://169.254.169.254/latest/meta-data/',
      ],
      ['a private address', () => 'http://10.0.0.5/'],
    ])('refuses %s by default, before connecting', async (_label, make) => {
      const port = base.split(':')[2]
      await expect(safeGet(make(port), { timeoutMs: 2000 })).rejects.toThrow(
        FetchRefusedError,
      )
      expect(seen).toEqual([])
    })

    it('refuses a name that resolves to a loopback address, using the lookup the connection uses', async () => {
      const port = base.split(':')[2]
      const message = await failure(
        safeGet(`http://localhost:${port}/ok`, { timeoutMs: 2000 }),
      )
      expect(message).toMatch(
        /localhost resolves to (127\.0\.0\.1|::1), which is not a public address/,
      )
      expect(seen).toEqual([])
    })

    it('refuses a redirect to a non-public address, and never connects to it', async () => {
      const message = await failure(
        get('/redirect-private', { permit: (ip) => ip === '127.0.0.1' }),
      )
      expect(message).toContain('169.254.169.254 is not a public address')
      expect(seen).toEqual(['/redirect-private'])
    })

    it('refuses a redirect to another scheme', async () => {
      expect(await failure(get('/redirect-file'))).toContain(
        'Only http:// and https:// URLs',
      )
    })

    it('can be told to allow private addresses', async () => {
      expect(
        (await safeGet(`${base}/ok`, { timeoutMs: 2000, permit: () => true }))
          .status,
      ).toBe(200)
    })

    it.each([
      'ftp://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'not a url',
    ])('refuses %s', async (url) => {
      await expect(safeGet(url, { timeoutMs: 1000 })).rejects.toThrow(
        FetchRefusedError,
      )
    })

    it('refuses a URL with credentials in it', async () => {
      const message = await failure(
        get('/ok', {}).then(() =>
          safeGet('http://user:secret@example.com/', { timeoutMs: 1000 }),
        ),
      )
      expect(message).toContain('user name or password')
      expect(message).not.toContain('secret')
    })
  })

  describe('the host allowlist', () => {
    it('refuses a host that is not listed, before connecting', async () => {
      const message = await failure(
        get('/ok', { allowedHosts: ['*.example.com'] }),
      )
      expect(message).toContain(
        'is not one of the hosts this server is allowed to fetch from',
      )
      expect(seen).toEqual([])
    })

    it('allows a listed host, and refuses a redirect to an unlisted one', async () => {
      expect((await get('/ok', { allowedHosts: ['127.0.0.1'] })).status).toBe(
        200,
      )
      const message = await failure(
        get('/redirect-private', { allowedHosts: ['127.0.0.1'] }),
      )
      expect(message).toContain('169.254.169.254 is not one of the hosts')
    })
  })
})

describe('checkedLookup', () => {
  const lookup = (permit: (address: string) => boolean, all: boolean) =>
    new Promise<unknown>((resolve) =>
      checkedLookup('localhost', permit)('localhost', { all }, (...result) =>
        resolve(result),
      ),
    )

  it('answers with a single address when one is asked for', async () => {
    const [error, address, family] = (await lookup(() => true, false)) as [
      unknown,
      string,
      number,
    ]
    expect(error).toBeNull()
    expect(['127.0.0.1', '::1']).toContain(address)
    expect([4, 6]).toContain(family)
  })

  it('answers with every address when all is set', async () => {
    const [error, addresses] = (await lookup(() => true, true)) as [
      unknown,
      { address: string }[],
    ]
    expect(error).toBeNull()
    expect(addresses.length).toBeGreaterThan(0)
  })

  it.each([true, false])(
    'refuses a forbidden address (all=%s)',
    async (all) => {
      const [error] = (await lookup(() => false, all)) as [Error]
      expect(error).toBeInstanceOf(FetchRefusedError)
      expect(error.message).toContain('not a public address')
    },
  )
})
