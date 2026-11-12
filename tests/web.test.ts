import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createWebFetcher,
  decodeBody,
  DEFAULT_MAX_LENGTH,
  paginate,
  type Page,
  type WebFetcherOptions,
} from '../src/web.js'

const UA = 'workshop-mcp-test/1.0'
const lorem =
  'The quick brown fox jumps over the lazy dog while the page explains something useful. '.repeat(
    12,
  )

const article = `<!doctype html><html><head><title>Fox Facts | Example Site</title></head><body>
<nav><a href="/home">Home</a> <a href="/about">About us</a></nav>
<article><h1>Fox Facts</h1>
<p>${lorem}</p>
<p>See <a href="/docs/more">the docs</a> and <a href="sibling.html">a sibling page</a>.</p>
<h2>Details</h2><ul><li>Red</li><li>Quick</li></ul>
<pre><code>const fox = 1</code></pre>
</article>
<footer>Copyright footer text nobody needs</footer></body></html>`

describe('web fetching', () => {
  let server: Server
  let base: string
  let requests: Array<{ path: string; headers: IncomingHttpHeaders }>
  let robots: { status: number; body: string } | 'destroy'

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push({ path, headers: req.headers })
      const send = (
        status: number,
        type: string | undefined,
        body: string | Buffer,
      ) => res.writeHead(status, type ? { 'content-type': type } : {}).end(body)
      if (path === '/robots.txt') {
        if (robots === 'destroy') return void res.destroy()
        return send(robots.status, 'text/plain', robots.body)
      }
      if (path === '/article') send(200, 'text/html; charset=utf-8', article)
      else if (path === '/bare')
        send(
          200,
          'text/html',
          `<!doctype html><html><head><title>Short Page</title></head><body><p>${lorem}</p></body></html>`,
        )
      else if (path === '/md')
        send(
          200,
          'text/markdown; charset=utf-8',
          '# Native\n\nAlready markdown.',
        )
      else if (path === '/json') send(200, 'application/json', '{"a":1}')
      else if (path === '/plain') send(200, 'text/plain', 'just text')
      else if (path === '/png')
        send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
      else if (path === '/nul-no-type')
        send(200, undefined, Buffer.from([0x61, 0, 0x62]))
      else if (path === '/html-no-type') send(200, undefined, article)
      else if (path === '/latin1')
        send(
          200,
          'text/html; charset=iso-8859-1',
          Buffer.from(
            `<html><body><article><p>caf\xe9 ${lorem}</p></article></body></html>`,
            'latin1',
          ),
        )
      else if (path === '/meta-charset')
        send(
          200,
          'text/html',
          Buffer.from(
            `<html><head><meta charset="windows-1252"></head><body><article><p>na\xefve ${lorem}</p></article></body></html>`,
            'latin1',
          ),
        )
      else if (path === '/spa')
        send(
          200,
          'text/html',
          '<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>',
        )
      else if (path === '/deep')
        send(
          200,
          'text/html',
          `<html><body>${'<div>'.repeat(2000)}<p>${lorem}</p></body></html>`,
        )
      else if (path === '/huge')
        send(
          200,
          'text/html',
          `<html><body><article>${`<p>${lorem}</p>`.repeat(2500)}</article></body></html>`,
        )
      else if (path === '/plain-doctype')
        send(
          200,
          'text/plain',
          `<!doctype html>${' '.repeat(100)}<p>shown as written</p>`,
        )
      else if (path === '/redirect')
        res.writeHead(302, { location: '/article' }).end()
      else if (path === '/to-private')
        res.writeHead(302, { location: '/private/page' }).end()
      else if (path.startsWith('/status/'))
        send(Number(path.slice(8)), 'text/plain', 'nope')
      else if (
        path.includes('private') ||
        path === '/ok' ||
        path.startsWith('/x/')
      )
        send(200, 'text/plain', `served ${path}`)
      else send(404, 'text/plain', 'missing')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    requests = []
    robots = { status: 404, body: '' }
  })

  const fetcher = (extra: Partial<WebFetcherOptions> = {}) =>
    createWebFetcher({ userAgent: UA, allowPrivateIps: true, ...extra })
  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => 'no error',
      (error: Error) => error.message,
    )
  const paths = () =>
    requests.filter((r) => r.path !== '/robots.txt').map((r) => r.path)

  describe('content', () => {
    it('extracts the article as markdown, without the page furniture, and makes links absolute', async () => {
      const page = await fetcher().fetch(`${base}/article`)
      expect(page.text).toContain('# Fox Facts')
      expect(page.text).toContain('quick brown fox')
      expect(page.text).toContain('## Details')
      expect(page.text).toMatch(/- {1,3}Red/)
      expect(page.text).toContain('const fox = 1')
      expect(page.text).toContain(`[the docs](${base}/docs/more)`)
      expect(page.text).toContain(`[a sibling page](${base}/sibling.html)`)
      expect(page.text).not.toContain('About us')
      expect(page.text).not.toContain('Copyright footer')
      expect(page.prefix).toBe('')
    })

    it('puts the page title first when the content does not open with it', async () => {
      const page = await fetcher().fetch(`${base}/bare`)
      expect(page.text.startsWith('# Short Page\n\nThe quick brown fox')).toBe(
        true,
      )
      // and does not repeat a title the content already opens with
      const withHeading = await fetcher().fetch(`${base}/article`)
      expect(withHeading.text.match(/Fox Facts/g)).toHaveLength(1)
    })

    it('asks for markdown first, and sends its own User-Agent', async () => {
      await fetcher().fetch(`${base}/article`)
      const sent = requests.find((r) => r.path === '/article')!.headers
      expect(sent.accept).toBe('text/markdown, text/html;q=0.9, */*;q=0.8')
      expect(sent['user-agent']).toBe(UA)
    })

    it('returns markdown that the site serves as it is', async () => {
      const page = await fetcher().fetch(`${base}/md`)
      expect(page.text).toBe('# Native\n\nAlready markdown.')
    })

    it('returns the source with raw=true, asking for whatever the site has', async () => {
      const page = await fetcher().fetch(`${base}/article`, { raw: true })
      expect(page.text).toBe(article)
      expect(requests.find((r) => r.path === '/article')!.headers.accept).toBe(
        '*/*',
      )
    })

    it('does not treat a text/plain body as a page just because it starts like one', async () => {
      const page = await fetcher().fetch(`${base}/plain-doctype`)
      expect(page.text).toContain('<p>shown as written</p>')
      expect(page.prefix).toContain('cannot be simplified to markdown')
    })

    it('passes other text through, saying it was not simplified', async () => {
      const json = await fetcher().fetch(`${base}/json`)
      expect(json.text).toBe('{"a":1}')
      expect(json.prefix).toBe(
        'Content type application/json cannot be simplified to markdown, but here is the raw content:\n',
      )
    })

    it('treats a page with no Content-Type as HTML when it looks like HTML', async () => {
      const page = await fetcher().fetch(`${base}/html-no-type`)
      expect(page.text).toContain('# Fox Facts')
    })

    it('says so for a page that has no content without JavaScript', async () => {
      expect(await failure(fetcher().fetch(`${base}/spa`))).toContain(
        'no readable content',
      )
      expect(await failure(fetcher().fetch(`${base}/spa`))).toContain(
        'raw=true',
      )
    })

    it('refuses a deeply nested page quickly instead of blocking on it', async () => {
      // Readability took about a minute on this 22 KB page before the guard.
      const started = performance.now()
      expect(await failure(fetcher().fetch(`${base}/deep`))).toContain(
        'raw=true',
      )
      expect(performance.now() - started).toBeLessThan(2000)
    })

    it('cuts a very large page before converting it, and says so', async () => {
      const page = await fetcher().fetch(`${base}/huge`)
      expect(page.text).toContain('the page is very large')
      expect(page.text.length).toBeLessThan(1_500_000)
    })

    it('refuses images and other binary content', async () => {
      expect(await failure(fetcher().fetch(`${base}/png`))).toContain(
        'a image/png file, not text',
      )
      expect(await failure(fetcher().fetch(`${base}/nul-no-type`))).toContain(
        'binary content, not text',
      )
    })

    it('reports an error status', async () => {
      expect(await failure(fetcher().fetch(`${base}/status/404`))).toBe(
        `Failed to fetch ${base}/status/404 - status code 404`,
      )
      expect(await failure(fetcher().fetch(`${base}/status/500`))).toContain(
        'status code 500',
      )
    })

    it('follows a redirect and says where it ended up', async () => {
      const page = await fetcher().fetch(`${base}/redirect`)
      expect(page.url).toBe(`${base}/article`)
      expect(page.requested).toBe(`${base}/redirect`)
      expect(paginate(page, 0, 50)).toContain(
        `Contents of ${base}/article (redirected from ${base}/redirect):`,
      )
    })
  })

  describe('decoding', () => {
    it('uses the charset in the header, the meta tag, or a byte-order mark', async () => {
      expect((await fetcher().fetch(`${base}/latin1`)).text).toContain('café')
      expect((await fetcher().fetch(`${base}/meta-charset`)).text).toContain(
        'naïve',
      )
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('héllo', 'utf16le'),
      ])
      expect(decodeBody('text/plain', utf16)).toBe('héllo')
      expect(
        decodeBody(
          'text/plain',
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]),
        ),
      ).toBe('hi')
    })

    it('falls back to UTF-8 for an unknown charset label', () => {
      expect(
        decodeBody('text/plain; charset=no-such-charset', Buffer.from('héllo')),
      ).toBe('héllo')
    })
  })

  describe('reading a page in parts', () => {
    const page: Page = {
      url: 'https://x.test/a',
      requested: 'https://x.test/a',
      text: '0123456789'.repeat(10),
      prefix: '',
    }

    it('shows where to continue when more remains', () => {
      const out = paginate(page, 0, 30)
      expect(out).toBe(
        `Contents of https://x.test/a:\n${page.text.slice(0, 30)}\n\n[... showing characters 0-30 of 100; more follows. Continue with fetch_url start_index=30]`,
      )
    })

    it('continues from start_index, and says nothing more at the end', () => {
      expect(paginate(page, 90, 30)).toBe(
        `Contents of https://x.test/a:\n${page.text.slice(90)}`,
      )
      expect(paginate(page, 100, 30)).toContain(
        'past the end of the content, which has 100 characters',
      )
    })

    it('puts a content-type note before the contents', () => {
      expect(
        paginate({ ...page, prefix: 'NOTE\n' }, 0, 5).startsWith(
          'NOTE\nContents of',
        ),
      ).toBe(true)
    })

    it('has a default length large enough to be useful', () => {
      expect(DEFAULT_MAX_LENGTH).toBeGreaterThanOrEqual(10_000)
    })
  })

  describe('caching', () => {
    it('serves a second request for the same page without fetching it again', async () => {
      const f = fetcher()
      const first = await f.fetch(`${base}/article`)
      const second = await f.fetch(`${base}/article`)
      expect(second).toBe(first)
      expect(paths()).toEqual(['/article'])
    })

    it('keeps raw and simplified copies apart, and one cache per fetcher', async () => {
      const f = fetcher()
      await f.fetch(`${base}/article`)
      await f.fetch(`${base}/article`, { raw: true })
      await fetcher().fetch(`${base}/article`)
      expect(paths()).toEqual(['/article', '/article', '/article'])
    })

    it('does not cache a failure', async () => {
      const f = fetcher()
      await failure(f.fetch(`${base}/status/500`))
      await failure(f.fetch(`${base}/status/500`))
      expect(paths()).toEqual(['/status/500', '/status/500'])
    })
  })

  describe('robots.txt', () => {
    const disallow = (rules: string) => (robots = { status: 200, body: rules })

    it('fetches robots.txt first, as the same user agent', async () => {
      await fetcher().fetch(`${base}/ok`, { raw: true })
      expect(requests.map((r) => r.path)).toEqual(['/robots.txt', '/ok'])
      expect(requests[0].headers['user-agent']).toBe(UA)
    })

    it('refuses a page it disallows, without requesting it', async () => {
      disallow('User-agent: *\nDisallow: /private')
      const message = await failure(fetcher().fetch(`${base}/private/page`))
      expect(message).toContain('Refused to fetch')
      expect(message).toContain(`${base}/robots.txt`)
      expect(message).toContain('does not allow automated fetching')
      expect(paths()).toEqual([])
    })

    it('matches the path as an origin would resolve it, not only as written', async () => {
      disallow('User-agent: *\nDisallow: /private')
      for (const path of [
        '//private/x',
        '/x/../private/x',
        '/%2Fprivate/x',
        '/%2e%2e/private/x',
      ]) {
        const message = await failure(fetcher().fetch(`${base}${path}`))
        expect(message, path).toContain('does not allow automated fetching')
      }
      expect(paths()).toEqual([])
    })

    it('matches a rule that names a query string, in the resolved spelling too', async () => {
      disallow('User-agent: *\nDisallow: /private?id=')
      // as written the path is //private, so only the resolved spelling matches
      const message = await failure(fetcher().fetch(`${base}//private?id=1`))
      expect(message).toContain('does not allow automated fetching')
      expect(paths()).toEqual([])
    })

    it('allows what robots.txt allows, and groups by user agent', async () => {
      disallow(
        `User-agent: *\nDisallow: /\n\nUser-agent: workshop-mcp-test\nAllow: /ok\nDisallow: /private`,
      )
      expect((await fetcher().fetch(`${base}/ok`, { raw: true })).text).toBe(
        'served /ok',
      )
      expect(await failure(fetcher().fetch(`${base}/private/page`))).toContain(
        'does not allow',
      )
    })

    it('treats a missing robots.txt as no rules', async () => {
      robots = { status: 404, body: 'Disallow: /' }
      expect((await fetcher().fetch(`${base}/ok`, { raw: true })).text).toBe(
        'served /ok',
      )
    })

    it.each([401, 403, 500, 503])(
      'assumes fetching is not allowed when robots.txt answers %i',
      async (status) => {
        robots = { status, body: '' }
        const message = await failure(fetcher().fetch(`${base}/ok`))
        expect(message).toContain(`status ${status}`)
        expect(message).toContain('assumed not to be allowed')
        expect(paths()).toEqual([])
      },
    )

    it('reports a robots.txt it cannot reach', async () => {
      robots = 'destroy'
      expect(await failure(fetcher().fetch(`${base}/ok`))).toContain(
        'Failed to fetch robots.txt',
      )
      expect(paths()).toEqual([])
    })

    it('checks every redirect hop against the robots.txt of its own origin', async () => {
      disallow('User-agent: *\nDisallow: /private')
      const message = await failure(fetcher().fetch(`${base}/to-private`))
      expect(message).toContain('does not allow')
      expect(paths()).toEqual(['/to-private'])
    })

    it('is skipped with ignoreRobotsTxt', async () => {
      disallow('User-agent: *\nDisallow: /')
      const page = await fetcher({ ignoreRobotsTxt: true }).fetch(
        `${base}/ok`,
        { raw: true },
      )
      expect(page.text).toBe('served /ok')
      expect(requests.map((r) => r.path)).toEqual(['/ok'])
    })
  })

  describe('the network policy', () => {
    it('refuses private addresses by default, saying how to allow them, and sends nothing', async () => {
      const message = await failure(
        createWebFetcher({ userAgent: UA }).fetch(`${base}/ok`),
      )
      expect(message).toContain('Refused to fetch')
      expect(message).toContain('not a public address')
      expect(message).toContain('--allow-private-ips')
      expect(requests).toEqual([])
    })

    it('restricts fetching to the allowed hosts, robots.txt requests included', async () => {
      const message = await failure(
        fetcher({ allowedHosts: ['*.example.com'] }).fetch(`${base}/ok`),
      )
      expect(message).toContain('--allowed-hosts')
      expect(requests).toEqual([])
      expect(
        (
          await fetcher({ allowedHosts: ['127.0.0.1'] }).fetch(`${base}/ok`, {
            raw: true,
          })
        ).text,
      ).toBe('served /ok')
    })

    it('refuses other schemes and malformed URLs', async () => {
      for (const url of [
        'file:///etc/passwd',
        'ftp://example.com/',
        'nonsense',
      ]) {
        expect(await failure(fetcher().fetch(url)), url).toMatch(
          /Refused to fetch/,
        )
      }
    })

    it('stops when the caller cancels, without calling it a failure to fetch', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        fetcher().fetch(`${base}/ok`, { signal: controller.signal }),
      ).rejects.toThrow()
    })
  })
})
