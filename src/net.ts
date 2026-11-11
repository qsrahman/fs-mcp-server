// Safe HTTP GET for the fetch_url tool.
//
// The design follows the fetch server in modelcontextprotocol/servers
// (src/fetch; MIT License, Copyright (c) 2024 Anthropic, PBC; see
// THIRD_PARTY_NOTICES.md): non-public destinations are refused, redirects are
// followed one hop at a time with every hop checked, the body is read with a
// byte cap that also counts decompressed bytes, and an optional host allowlist
// applies to every request. The address list and the allowlist's two entry
// forms are theirs; this implementation is written for Node.
//
// One difference matters for safety. A check made by a lookup of its own
// before the connection is not enough, because the connection looks the name
// up again and could be given a different answer (DNS rebinding). Here the
// check runs inside the lookup the connection itself uses, so the address that
// was checked is the address that is connected to.
import dns from 'node:dns'
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const MAX_REDIRECTS = 10

/** A request the policy refuses: a non-public address, an unlisted host, a bad URL. */
export class FetchRefusedError extends Error {
  override name = 'FetchRefusedError'
}

// ---------------------------------------------------------------- addresses

// IANA special-purpose ranges that are not public destinations (the list
// upstream uses, so the answer does not depend on the Node version).
const NON_PUBLIC_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // shared address space; holds Alibaba Cloud's metadata endpoint
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local; holds most cloud metadata endpoints
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
]
const NON_PUBLIC_V6: Array<[string, number]> = [
  ['::', 96], // IPv4-compatible (deprecated); holds :: and ::1
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7], // unique local; holds AWS's fd00:ec2::254
  ['fe80::', 10],
  ['fec0::', 10],
]
// Globally reachable assignments inside the ranges above (anycast and the like).
const PUBLIC_EXCEPTIONS_V4: Array<[string, number]> = [
  ['192.0.0.9', 32],
  ['192.0.0.10', 32],
]
const PUBLIC_EXCEPTIONS_V6: Array<[string, number]> = [
  ['2001:1::1', 128],
  ['2001:1::2', 128],
  ['2001:3::', 32],
  ['2001:4:112::', 48],
  ['2001:20::', 28],
  ['2001:30::', 28],
]

function blockList(v4: Array<[string, number]>, v6: Array<[string, number]>) {
  const list = new net.BlockList()
  for (const [address, prefix] of v4) list.addSubnet(address, prefix, 'ipv4')
  for (const [address, prefix] of v6) list.addSubnet(address, prefix, 'ipv6')
  return list
}
const nonPublic = blockList(NON_PUBLIC_V4, NON_PUBLIC_V6)
const exceptions = blockList(PUBLIC_EXCEPTIONS_V4, PUBLIC_EXCEPTIONS_V6)
// The rest of the IPv6 space (reserved, multicast, ...) is not a public
// destination either, so anything outside global unicast is refused by default.
const globalUnicastV6 = blockList([], [['2000::', 3]])

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] {
  // The URL parser writes any IPv6 address in one canonical, compressed form.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [head, tail] = canonical.split('::')
  const first = head ? head.split(':') : []
  const last = tail ? tail.split(':') : []
  const zeros =
    tail === undefined
      ? []
      : Array<string>(8 - first.length - last.length).fill('0')
  return [...first, ...zeros, ...last].map((group) => parseInt(group, 16))
}

/**
 * The IPv4 address an IPv6 one wraps, for the forms that reach that IPv4
 * address: IPv4-mapped, the well-known NAT64 prefix, and IPv4-translated. On an
 * IPv6-only network a public site is reached through a NAT64 address, so the
 * IPv4 inside decides.
 */
function embeddedIPv4(groups: number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  const mapped =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff
  const nat64 =
    g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0
  const translated =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0xffff && g4 === 0 && g5 === 0
  if (!mapped && !nat64 && !translated) return undefined
  return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`
}

function isPublicV4(address: string): boolean {
  if (exceptions.check(address, 'ipv4')) return true
  return !nonPublic.check(address, 'ipv4')
}

/**
 * True when `address` is a globally routable unicast address. Loopback,
 * private, link-local (cloud metadata), shared, multicast, documentation and
 * other special-purpose ranges are refused, and so is anything that is not an
 * IP address at all.
 */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/%.*$/, '') // a zone id such as fe80::1%en0
  const family = net.isIP(address)
  if (family === 4) return isPublicV4(address)
  if (family !== 6) return false
  const embedded = embeddedIPv4(ipv6Groups(address))
  if (embedded) return isPublicV4(embedded)
  if (exceptions.check(address, 'ipv6')) return true
  if (nonPublic.check(address, 'ipv6')) return false
  return globalUnicastV6.check(address, 'ipv6')
}

// ----------------------------------------------------------------- allowlist

/**
 * The canonical form of one allowed-host entry, or an error. Two forms only: an
 * exact host (a name or an IP literal) and `*.example.com`, which matches any
 * subdomain at any depth but not example.com itself. No scheme, port or path.
 */
export function normalizeAllowedHost(entry: string): string {
  const value = entry.trim().replace(/\.$/, '').toLowerCase()
  const wildcard = value.startsWith('*.')
  const name = wildcard ? value.slice(2) : value
  const literal = name.replace(/^\[|\]$/g, '')
  if (!wildcard && net.isIP(literal)) {
    return new URL(
      `http://${net.isIP(literal) === 6 ? `[${literal}]` : literal}/`,
    ).hostname.replace(/^\[|\]$/g, '')
  }
  if (!name || /[*/\\:@[\]?#%\s]/.test(name) || name.includes('..')) {
    throw new Error(
      `${JSON.stringify(entry)} is not a host name, an IP address or *.<domain> (no scheme, port, path or other wildcard)`,
    )
  }
  let ascii: string
  try {
    ascii = new URL(`http://${name}/`).hostname // punycode for non-ASCII names
  } catch {
    throw new Error(`${JSON.stringify(entry)} is not a valid host name`)
  }
  return wildcard ? `*.${ascii}` : ascii
}

/** Whether `host` (a URL's hostname) matches a normalized allowlist entry. */
export function hostIsAllowed(
  host: string,
  allowed: readonly string[],
): boolean {
  let name = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (net.isIP(name) === 6)
    name = new URL(`http://[${name}]/`).hostname.slice(1, -1)
  return allowed.some((entry) =>
    entry.startsWith('*.') ? name.endsWith(entry.slice(1)) : name === entry,
  )
}

// ---------------------------------------------------------------------- GET

interface SafeGetOptions {
  headers?: Record<string, string>
  timeoutMs: number
  /** The caller's cancellation. */
  signal?: AbortSignal
  /** Whether a destination address may be connected to. Default: public addresses only. */
  permit?: (address: string) => boolean
  /** Normalized allowlist; when given, every request must name a listed host. */
  allowedHosts?: readonly string[]
  /** Runs before each request, the first and every redirect hop; may throw to stop. */
  beforeRequest?: (url: URL) => Promise<void>
  /** Whether to read the body of a response with this status. Default: below 400. */
  wantBody?: (status: number) => boolean
  maxBytes?: number
}

export interface SafeResponse {
  /** The URL that finally answered, after redirects. */
  url: URL
  status: number
  headers: IncomingHttpHeaders
  /** Empty when the body was not wanted. */
  body: Buffer
}

class BodyTooLargeError extends Error {}

/** A connection's lookup, refusing any address the policy does not permit. */
export function checkedLookup(
  hostname: string,
  permit: (address: string) => boolean,
): net.LookupFunction {
  return (name, options, callback) => {
    dns.lookup(name, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const refused = addresses.find((entry) => !permit(entry.address))
      if (refused) {
        return callback(
          new FetchRefusedError(
            `${hostname} resolves to ${refused.address}, which is not a public address`,
          ),
          '',
          0,
        )
      }
      if (options.all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  permit: (address: string) => boolean,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers,
        // no pooled sockets: every request is looked up, checked and connected afresh
        agent: false,
        lookup: checkedLookup(url.hostname, permit),
        signal,
      },
      resolve,
    )
    request.on('error', reject)
    request.end()
  })
}

async function readBody(
  response: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = Number(response.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new BodyTooLargeError()

  const encoding = String(response.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase()
  const decoders: NodeJS.ReadWriteStream[] = []
  if (encoding === 'gzip' || encoding === 'x-gzip')
    decoders.push(zlib.createGunzip())
  else if (encoding === 'deflate') decoders.push(zlib.createInflate())
  else if (encoding !== 'identity' && encoding !== '') {
    throw new Error(
      `the server answered with an unsupported content encoding (${encoding})`,
    )
  }

  const chunks: Buffer[] = []
  let total = 0
  await pipeline(
    response,
    ...decoders,
    // Counts decoded bytes, so a small body that inflates enormously is stopped
    // too: throwing here destroys the whole chain, decoder included.
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) {
        total += chunk.length
        if (total > maxBytes) throw new BodyTooLargeError()
        chunks.push(chunk)
      }
    },
    { signal },
  )
  return Buffer.concat(chunks)
}

/** Check a URL against the policy that does not need the network. */
function checkUrl(
  url: URL,
  options: SafeGetOptions,
  permit: (address: string) => boolean,
) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefusedError(
      `Only http:// and https:// URLs can be fetched (got ${url.protocol}//)`,
    )
  }
  if (url.username || url.password) {
    throw new FetchRefusedError(
      'A URL with a user name or password in it cannot be fetched',
    )
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (options.allowedHosts && !hostIsAllowed(host, options.allowedHosts)) {
    throw new FetchRefusedError(
      `${host} is not one of the hosts this server is allowed to fetch from (--allowed-hosts)`,
    )
  }
  // A connection to an IP address does no lookup, so a literal is checked here.
  // (The URL parser has already turned forms such as 2130706433 and 0x7f.1 into 127.0.0.1.)
  if (net.isIP(host) && !permit(host)) {
    throw new FetchRefusedError(`${host} is not a public address`)
  }
}

const REDIRECT = new Set([301, 302, 303, 307, 308])

/**
 * GET `target`, following redirects by hand so that every hop is checked and
 * the body of a redirect is never read. Throws FetchRefusedError for a request
 * the policy forbids.
 */
export async function safeGet(
  target: string | URL,
  options: SafeGetOptions,
): Promise<SafeResponse> {
  const permit = options.permit ?? isPublicAddress
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const wantBody = options.wantBody ?? ((status: number) => status < 400)
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout
  const headers = { 'Accept-Encoding': 'gzip, deflate', ...options.headers }

  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new FetchRefusedError(`${String(target)} is not a valid URL`)
  }

  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url, options, permit)
      await options.beforeRequest?.(url)
      const response = await requestOnce(url, headers, permit, signal)
      const status = response.statusCode ?? 0
      const location = response.headers.location

      if (REDIRECT.has(status) && location) {
        response.destroy() // a redirect's body is never read
        if (hop >= MAX_REDIRECTS)
          throw new Error(`more than ${MAX_REDIRECTS} redirects`)
        try {
          url = new URL(location, url)
        } catch {
          throw new FetchRefusedError(`the server redirected to an invalid URL`)
        }
        continue
      }
      if (!wantBody(status)) {
        response.destroy()
        return { url, status, headers: response.headers, body: Buffer.alloc(0) }
      }
      return {
        url,
        status,
        headers: response.headers,
        body: await readBody(response, maxBytes, signal),
      }
    }
  } catch (error) {
    if (error instanceof FetchRefusedError) throw error
    if (timeout.aborted) {
      throw new Error(`timed out after ${options.timeoutMs} ms`, {
        cause: error,
      })
    }
    if (options.signal?.aborted) throw error
    if (error instanceof BodyTooLargeError) {
      throw new Error(
        `the response body is larger than the ${maxBytes} byte limit this server reads`,
        {
          cause: error,
        },
      )
    }
    // a lookup refusal arrives wrapped in the socket error; unwrap it
    const refused = findRefusal(error)
    if (refused) throw refused
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(
      code ? `${(error as Error).message} (${code})` : (error as Error).message,
      {
        cause: error,
      },
    )
  }
}

function findRefusal(error: unknown): FetchRefusedError | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof FetchRefusedError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
