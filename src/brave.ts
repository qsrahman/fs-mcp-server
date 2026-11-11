// Brave Search for the brave_web_search and brave_news_search tools.
//
// Adapted from brave/brave-search-mcp-server (MIT License, Copyright (c) 2024
// Anthropic, PBC and (c) 2025 Brave Software, Inc; see THIRD_PARTY_NOTICES.md):
// the endpoints and the meaning of the parameters follow that project. The
// parameter set is trimmed to what an agent needs, and the client, the result
// formatting and the error handling are rewritten for this server. The API key
// is only ever sent in the X-Subscription-Token header.
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1'

const REQUEST_TIMEOUT_MS = 15_000
// Brave's free plan allows about one query per second, and a model that asks
// for web and news results at once will hit that. A rate-limit answer that
// says the window resets within this many seconds is waited out and retried once.
const MAX_RETRY_WAIT_SECONDS = 5
const MAX_TITLE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 500

const wordCount = (text: string) => text.trim().split(/\s+/).length

/** The parameters the two tools share. Only `count` differs in range. */
function searchInput(maxCount: number, defaultCount: number) {
  return z.strictObject({
    query: z
      .string()
      .min(1)
      .max(400)
      .refine((text) => wordCount(text) <= 50, 'Query cannot exceed 50 words')
      .describe('Search query, at most 400 characters and 50 words.'),
    count: z
      .number()
      .int()
      .min(1)
      .max(maxCount)
      .optional()
      .describe(`Number of results, 1-${maxCount} (default ${defaultCount}).`),
    offset: z
      .number()
      .int()
      .min(0)
      .max(9)
      .optional()
      .describe(
        'Pages to skip, each of `count` results (0-9, default 0). Use 1 for the second page.',
      ),
    freshness: z
      .string()
      .regex(/^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/)
      .optional()
      .describe(
        'Only results discovered in a time window: pd (last 24 hours), pw (7 days), pm (31 days), py (365 days), or a range such as 2024-01-01to2024-03-31.',
      ),
    country: z
      .string()
      .regex(/^([A-Za-z]{2}|ALL)$/)
      .optional()
      .describe(
        'Two-letter country code that results should come from, for example US, GB or DE (default US), or ALL.',
      ),
    search_lang: z
      .string()
      .regex(/^[A-Za-z]{2}(-[A-Za-z]{2,4})?$/)
      .optional()
      .describe(
        'Language of the results, for example en, de, pt-br or zh-hans (default en).',
      ),
    safesearch: z
      .enum(['off', 'moderate', 'strict'])
      .optional()
      .describe('Adult-content filtering (default moderate).'),
  })
}

export const webSearchInput = searchInput(20, 10)
export const newsSearchInput = searchInput(50, 10)
type SearchInput = z.infer<typeof webSearchInput>

// Only the fields that are used. The response comes from the network, so it is
// parsed, not cast.
const result = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  age: z.string().optional(),
  breaking: z.boolean().optional(),
  meta_url: z.object({ hostname: z.string().optional() }).optional(),
})
const query = z.object({ altered: z.string().optional() }).optional()
const webResponse = z.object({
  query,
  web: z.object({ results: z.array(result).optional() }).optional(),
})
const newsResponse = z.object({
  query,
  results: z.array(result).optional(),
})

type Result = z.infer<typeof result>

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

function formatResults(
  kind: string,
  searched: string,
  altered: string | undefined,
  results: Result[],
): string {
  if (results.length === 0) return `No ${kind} results for "${searched}".`
  const heading =
    `${results.length} ${kind} results for "${searched}"` +
    (altered && altered !== searched
      ? ` (spelling corrected to "${altered}")`
      : '')
  const entries = results.map((entry, index) => {
    const source = entry.meta_url?.hostname
    const meta = [
      entry.breaking ? 'BREAKING' : undefined,
      source,
      entry.age,
    ].filter(Boolean)
    return [
      `${index + 1}. ${clip(entry.title ?? '(untitled)', MAX_TITLE_CHARS)}` +
        (meta.length > 0 ? ` (${meta.join(', ')})` : ''),
      `   ${entry.url ?? ''}`,
      entry.description
        ? `   ${clip(entry.description, MAX_DESCRIPTION_CHARS)}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join('\n')
  })
  return `${heading}\n\n${entries.join('\n\n')}`
}

/** Seconds until a rate limit that has run out resets, from Brave's headers. */
function secondsUntilReset(headers: Headers): number | undefined {
  // Brave lists one value per window (per second, per month), comma separated.
  const numbers = (name: string) =>
    (headers.get(name) ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n))
  const remaining = numbers('x-ratelimit-remaining')
  const reset = numbers('x-ratelimit-reset')
  const exhausted = remaining.findIndex((n) => n <= 0)
  return exhausted === -1 ? undefined : reset[exhausted]
}

/** Turn an HTTP failure into a message an agent can act on. Never includes the key. */
async function failure(response: Response): Promise<Error> {
  const status = response.status
  let error: {
    code?: string
    detail?: string
    message?: string
    meta?: { component?: string }
  } = {}
  try {
    error = ((await response.json()) as { error?: typeof error }).error ?? {}
  } catch {
    // an error page, not JSON: the status line is all there is to say
  }
  const detail = error.detail ?? error.message ?? ''

  // An invalid key is HTTP 422 (SUBSCRIPTION_TOKEN_INVALID), not 401, so go by
  // what the error says it is about as well as by the status.
  if (
    status === 401 ||
    status === 403 ||
    error.meta?.component === 'authentication' ||
    /TOKEN/.test(error.code ?? '')
  ) {
    return new Error(
      `Brave Search rejected the API key (HTTP ${status}${detail ? `: ${clip(detail, 200)}` : ''}). ` +
        'Check BRAVE_API_KEY, and that the plan allows this search.',
    )
  }
  if (status === 429) {
    const wait = secondsUntilReset(response.headers)
    return new Error(
      'Brave Search rate limit reached' +
        (wait === undefined ? '.' : `; it resets in ${wait} seconds.`) +
        ' Try again later, or make fewer searches.',
    )
  }
  return new Error(
    `Brave Search returned HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}` +
      (detail ? `: ${clip(detail, 300)}` : '') +
      (status === 422 ? ' (check the search parameters).' : '.'),
  )
}

export interface BraveOptions {
  apiKey: string
  /** Only for tests, which point this at a local server. */
  baseUrl?: string
}

export function createBrave({
  apiKey,
  baseUrl = BRAVE_API_BASE,
}: BraveOptions) {
  async function request(
    path: string,
    input: SearchInput,
    extra: Record<string, string>,
    defaultCount: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`)
    const params = url.searchParams
    params.set('q', input.query)
    params.set('count', String(input.count ?? defaultCount))
    if (input.offset !== undefined) params.set('offset', String(input.offset))
    if (input.freshness) params.set('freshness', input.freshness)
    if (input.country) params.set('country', input.country.toUpperCase())
    if (input.search_lang)
      params.set('search_lang', input.search_lang.toLowerCase())
    if (input.safesearch) params.set('safesearch', input.safesearch)
    // Snippets come back with highlight markup unless this is off; a model has no use for it.
    params.set('text_decorations', 'false')
    for (const [name, value] of Object.entries(extra)) params.set(name, value)

    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      }).catch((error: unknown) => {
        if (timeout.aborted) {
          throw new Error(
            `Brave Search did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
            { cause: error },
          )
        }
        throw error
      })
      if (response.ok) return response.json()

      const wait =
        response.status === 429
          ? secondsUntilReset(response.headers)
          : undefined
      if (
        attempt === 1 &&
        wait !== undefined &&
        wait <= MAX_RETRY_WAIT_SECONDS
      ) {
        await response.body?.cancel()
        await sleep(wait * 1000 + 100, undefined, { signal })
        continue
      }
      throw await failure(response)
    }
  }

  function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body)
    if (!parsed.success)
      throw new Error('Brave Search sent a response in an unexpected format.')
    return parsed.data
  }

  return {
    async web(input: SearchInput, signal?: AbortSignal): Promise<string> {
      // result_filter=web leaves out the discussions, videos, FAQ and news
      // sections: this tool is for pages, and news has its own tool.
      const body = parse(
        webResponse,
        await request(
          '/web/search',
          input,
          { result_filter: 'web' },
          10,
          signal,
        ),
      )
      return formatResults(
        'web',
        input.query,
        body.query?.altered,
        body.web?.results ?? [],
      )
    },
    async news(input: SearchInput, signal?: AbortSignal): Promise<string> {
      const body = parse(
        newsResponse,
        await request('/news/search', input, {}, 10, signal),
      )
      return formatResults(
        'news',
        input.query,
        body.query?.altered,
        body.results ?? [],
      )
    },
  }
}
