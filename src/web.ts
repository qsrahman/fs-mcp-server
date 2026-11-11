// The fetch_url tool: fetch a web page and give the model its readable content.
//
// Adapted from the fetch server in modelcontextprotocol/servers (src/fetch; MIT
// License, Copyright (c) 2024 Anthropic, PBC; see THIRD_PARTY_NOTICES.md): it
// asks for markdown first and returns markdown as it is, obeys robots.txt for a
// fetch the model starts (every redirect hop included, with the path checked as
// spelled and as a typical origin resolves it), extracts the main content of a
// page with Readability, converts it to markdown, and lets a long page be read
// in parts. The code is written for Node, with a different set of libraries.
import robotsModule from 'robots-parser'
import { z } from 'zod'
import {
  FetchRefusedError,
  isPublicAddress,
  safeGet,
  type SafeResponse,
} from './net.js'

// robots-parser's typings declare an ES default export, but the package is
// CommonJS, and its default import is the function itself at runtime.
const robotsParser = robotsModule as unknown as typeof robotsModule.default

/** A failure whose message is already worded for the model; it is passed on unchanged. */
class FetchFailure extends Error {
  override name = 'FetchFailure'
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_LENGTH = 20_000
export const MAX_MAX_LENGTH = 100_000

// Parsing and extracting run on the main thread and take about 0.4 s for a
// 1 MB page, so the HTML that is converted is capped; a larger page is cut.
const MAX_EXTRACT_HTML_CHARS = 1_500_000
// Readability's cost grows steeply with nesting depth (a 6 KB page nested 500
// deep blocks the process for over a second, 22 KB at 2000 deep for about a
// minute), and conversion runs on the main thread. Real pages nest well under
// 100 levels, so a deeper page is not converted.
const MAX_DOM_DEPTH = 256
const CACHE_TTL_MS = 5 * 60_000
const CACHE_ENTRIES = 5

// A site that can serve markdown natively is asked to; one that cannot serves
// HTML (the next best), which is simplified.
const MARKDOWN_ACCEPT = 'text/markdown, text/html;q=0.9, */*;q=0.8'

export const fetchUrlInput = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe('The http:// or https:// URL to fetch.'),
  max_length: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_LENGTH)
    .optional()
    .describe(`Most characters to return (default ${DEFAULT_MAX_LENGTH}).`),
  start_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Character index to start from, to read on in a page whose earlier part was cut off (default 0).',
    ),
  raw: z
    .boolean()
    .optional()
    .describe(
      'Return the page as the server sent it (for HTML, the source) instead of simplified to markdown.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .optional()
    .describe(
      `How long to wait for the server, in milliseconds, for each request including redirects (default ${DEFAULT_TIMEOUT_MS}).`,
    ),
})
export type FetchUrlInput = z.infer<typeof fetchUrlInput>

export interface WebFetcherOptions {
  /** Sent as the User-Agent, and matched against robots.txt rules. */
  userAgent: string
  /** Allow private, loopback and link-local addresses. Off by default. */
  allowPrivateIps?: boolean
  /** Do not consult robots.txt. Off by default. */
  ignoreRobotsTxt?: boolean
  /** Normalized allowlist (see normalizeAllowedHost); when given, only these hosts. */
  allowedHosts?: readonly string[]
}

export interface Page {
  /** The URL that finally answered, after redirects. */
  url: string
  requested: string
  /** The whole content: markdown, or the page as served. */
  text: string
  /** A note to show before the content, such as that it is the raw text. */
  prefix: string
}

// ---------------------------------------------------------------- decoding

const ENCODING_BY_BOM: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], 'utf-8'],
  [[0xff, 0xfe], 'utf-16le'],
  [[0xfe, 0xff], 'utf-16be'],
]

/** The page's text: by byte-order mark, then the header's charset, then a <meta> tag, else UTF-8. */
export function decodeBody(contentType: string, body: Buffer): string {
  let label =
    ENCODING_BY_BOM.find(([bom]) =>
      bom.every((byte, i) => body[i] === byte),
    )?.[1] ?? /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
  if (!label && /html/i.test(contentType || 'html')) {
    const head = body.subarray(0, 2048).toString('latin1')
    label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(head)?.[1]
  }
  try {
    return new TextDecoder(label ?? 'utf-8').decode(body)
  } catch {
    return new TextDecoder('utf-8').decode(body) // a label the platform does not know
  }
}

const BINARY_TYPE =
  /^(image|audio|video|font)\/|^application\/(pdf|zip|gzip|x-gzip|octet-stream|x-tar|x-7z-compressed|x-rar-compressed|wasm)\b/
const NUL = 0

/** Text is what a model can use; images, PDFs and archives are a dead end for it. */
function isTextual(mime: string, body: Buffer): boolean {
  if (BINARY_TYPE.test(mime)) return false
  return !body.subarray(0, 8192).includes(NUL)
}

const isHtmlType = (mime: string) =>
  mime === 'text/html' || mime === 'application/xhtml+xml'
const isMarkdownType = (mime: string) =>
  mime === 'text/markdown' || mime === 'text/x-markdown'
const looksLikeHtml = (text: string) =>
  /<!doctype html|<html[\s>]/i.test(text.slice(0, 1000))

// -------------------------------------------------------------- extraction

const normalizedWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

interface TreeNode {
  firstChild: TreeNode | null
  nextSibling: TreeNode | null
}

/** True when the tree nests deeper than `limit`; counted without recursion. */
function nestsDeeperThan(root: TreeNode, limit: number): boolean {
  const stack: [TreeNode, number][] = [[root, 0]]
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [node, depth] = item
    if (depth > limit) return true
    for (let child = node.firstChild; child; child = child.nextSibling) {
      stack.push([child, depth + 1])
    }
  }
  return false
}

/**
 * The main content of an HTML page as markdown. Heavy libraries are loaded the
 * first time they are needed, so a server that never fetches a page does not
 * pay for them.
 */
export async function htmlToMarkdown(
  html: string,
  pageUrl: string,
): Promise<string> {
  const [{ parseHTML }, { Readability }, { default: Turndown }] =
    await Promise.all([
      import('linkedom'),
      import('@mozilla/readability'),
      import('turndown'),
    ])
  const cut = html.length > MAX_EXTRACT_HTML_CHARS
  const source = cut ? html.slice(0, MAX_EXTRACT_HTML_CHARS) : html
  const turndown = new Turndown({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })
  turndown.remove(['script', 'style', 'noscript'])

  const { document } = parseHTML(source)
  if (!document.documentElement) {
    throw new FetchFailure(
      `${pageUrl} has no readable content; it does not look like an HTML page. Try raw=true.`,
    )
  }
  if (nestsDeeperThan(document, MAX_DOM_DEPTH)) {
    throw new FetchFailure(
      `${pageUrl} nests its HTML more than ${MAX_DOM_DEPTH} levels deep, which is too slow to convert. Try raw=true for its source.`,
    )
  }
  // Readability makes links absolute against the document's base; without one
  // a model would be given /docs/page, which it cannot follow.
  const base = document.createElement('base')
  base.setAttribute('href', pageUrl)
  // Inside <head>: put before it, the base element makes linkedom lose the title.
  ;(document.head ?? document.documentElement).prepend(base)
  const pageTitle = document.title?.trim() ?? ''
  const article = new Readability(document).parse()

  let markdown = article?.content
    ? turndown.turndown(article.content).trim()
    : ''
  let title = article?.title?.trim() || pageTitle
  if (!markdown) {
    // Not article-shaped (an index, a landing page): take the whole body instead.
    const whole = parseHTML(source).document
    markdown = turndown.turndown(whole.body?.innerHTML ?? '').trim()
  }
  if (!markdown) {
    throw new FetchFailure(
      `${pageUrl} has no readable content; it may build its content with JavaScript. Try raw=true for its source.`,
    )
  }
  // Put the title first unless the content already opens with it.
  if (
    title &&
    !normalizedWords(markdown.slice(0, 400)).includes(normalizedWords(title))
  ) {
    markdown = `# ${title}\n\n${markdown}`
  }
  return cut
    ? `${markdown}\n\n[... the page is very large: only the first ${MAX_EXTRACT_HTML_CHARS} characters of its HTML were converted ...]`
    : markdown
}

// ---------------------------------------------------------------- robots.txt

/**
 * The URL with its path spelled the way a typical origin resolves it. A site
 * can serve //private, /x/../private and /%2Fprivate as /private, so rules are
 * matched against this spelling as well as the one requested.
 */
function resolvedPathUrl(url: URL): string {
  const decoded = url.pathname
    .replace(/%2f/gi, '/')
    .replace(/%2e/gi, '.')
    .replace(/\/{2,}/g, '/')
  const resolved = new URL(decoded, url.origin) // the URL parser removes dot segments
  return `${url.origin}${resolved.pathname}${url.search}`
}

// ------------------------------------------------------------------ fetcher

export function createWebFetcher(options: WebFetcherOptions) {
  const permit = options.allowPrivateIps ? () => true : isPublicAddress
  const cache = new Map<string, { page: Page; expires: number }>()

  async function checkRobots(
    url: URL,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const robotsUrl = `${url.origin}/robots.txt`
    let response: SafeResponse
    try {
      response = await safeGet(robotsUrl, {
        headers: { 'User-Agent': options.userAgent },
        timeoutMs,
        signal,
        permit,
        allowedHosts: options.allowedHosts,
        wantBody: (status) => status < 300,
      })
    } catch (error) {
      if (error instanceof FetchRefusedError || signal?.aborted) throw error
      throw new FetchFailure(
        `Failed to fetch robots.txt ${robotsUrl}: ${(error as Error).message}`,
        {
          cause: error,
        },
      )
    }
    const status = response.status
    // RFC 9309: unreachable (5xx) or forbidden means do not crawl; other 4xx means no rules.
    if (status === 401 || status === 403 || status >= 500) {
      throw new FetchRefusedError(
        `robots.txt (${robotsUrl}) answered with status ${status}, so automated fetching is assumed not to be allowed`,
      )
    }
    if (status >= 400) return
    const rules = robotsParser(robotsUrl, decodeBody('', response.body))
    const allowed =
      rules.isAllowed(url.href, options.userAgent) !== false &&
      rules.isAllowed(resolvedPathUrl(url), options.userAgent) !== false
    if (!allowed) {
      throw new FetchRefusedError(
        `the site's robots.txt (${robotsUrl}) does not allow automated fetching of ${url.href}. ` +
          'Tell the user the page could not be read, and that they can open it themselves',
      )
    }
  }

  async function load(
    url: string,
    raw: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Page> {
    const response = await safeGet(url, {
      headers: {
        'User-Agent': options.userAgent,
        Accept: raw ? '*/*' : MARKDOWN_ACCEPT,
      },
      timeoutMs,
      signal,
      permit,
      allowedHosts: options.allowedHosts,
      beforeRequest: options.ignoreRobotsTxt
        ? undefined
        : (hop) => checkRobots(hop, timeoutMs, signal),
    })
    const finalUrl = response.url.href
    if (response.status >= 400) {
      throw new FetchFailure(
        `Failed to fetch ${url} - status code ${response.status}`,
      )
    }
    const contentType = String(response.headers['content-type'] ?? '')
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (!isTextual(mime, response.body)) {
      throw new FetchFailure(
        `${finalUrl} is ${mime ? `a ${mime} file` : 'binary content'}, not text; fetch_url returns text only`,
      )
    }
    const text = decodeBody(contentType, response.body)
    const page = (content: string, prefix = ''): Page => ({
      url: finalUrl,
      requested: url,
      text: content,
      prefix,
    })

    if (isMarkdownType(mime)) return page(text)
    if (raw) return page(text)
    if (
      isHtmlType(mime) ||
      (!mime && looksLikeHtml(text)) ||
      text.slice(0, 100).includes('<html')
    ) {
      return page(await htmlToMarkdown(text, finalUrl))
    }
    return page(
      text,
      `Content type ${mime || '(not declared)'} cannot be simplified to markdown, but here is the raw content:\n`,
    )
  }

  return {
    async fetch(
      url: string,
      {
        raw = false,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        signal,
      }: { raw?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<Page> {
      const key = `${raw ? 'raw' : 'md'} ${url}`
      const cached = cache.get(key)
      if (cached && cached.expires > Date.now()) return cached.page
      cache.delete(key)

      let page: Page
      try {
        page = await load(url, raw, timeoutMs, signal)
      } catch (error) {
        if (error instanceof FetchRefusedError) {
          const hint = /not a public address/.test(error.message)
            ? ' Start the server with --allow-private-ips to allow private, loopback and link-local addresses.'
            : ''
          throw new Error(`Refused to fetch ${url}: ${error.message}.${hint}`, {
            cause: error,
          })
        }
        if (error instanceof FetchFailure || signal?.aborted) throw error
        throw new Error(`Failed to fetch ${url}: ${(error as Error).message}`, {
          cause: error,
        })
      }
      cache.set(key, { page, expires: Date.now() + CACHE_TTL_MS })
      while (cache.size > CACHE_ENTRIES)
        cache.delete(cache.keys().next().value as string)
      return page
    },
  }
}

// ---------------------------------------------------------------- pagination

/** One slice of a page for the model, with where to continue when more remains. */
export function paginate(
  page: Page,
  startIndex: number,
  maxLength: number,
): string {
  const head =
    `${page.prefix}Contents of ${page.url}` +
    (page.requested !== page.url
      ? ` (redirected from ${page.requested})`
      : '') +
    ':\n'
  const length = page.text.length
  if (startIndex >= length) {
    return `${head}[start_index ${startIndex} is past the end of the content, which has ${length} characters]`
  }
  const end = Math.min(startIndex + maxLength, length)
  const slice = page.text.slice(startIndex, end)
  return end < length
    ? `${head}${slice}\n\n[... showing characters ${startIndex}-${end} of ${length}; more follows. Continue with fetch_url start_index=${end}]`
    : `${head}${slice}`
}
