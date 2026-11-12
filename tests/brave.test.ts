import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBrave } from '../src/brave.js'
import { startFakeBrave } from './helpers.js'

const KEY = 'test-key-do-not-leak-1234'

let fake: Awaited<ReturnType<typeof startFakeBrave>>
let brave: ReturnType<typeof createBrave>

beforeEach(async () => {
  fake = await startFakeBrave()
  brave = createBrave({ apiKey: KEY, baseUrl: fake.baseUrl })
})

afterEach(async () => {
  await fake.close()
})

const webBody = (results: object[], extra: object = {}) => ({
  type: 'search',
  web: { type: 'search', results },
  ...extra,
})

describe('brave_web_search requests', () => {
  it('sends the key in a header, never in the URL, and asks for plain web results', async () => {
    fake.replies.push({ body: webBody([]) })
    await brave.web({ query: 'node streams' })
    const { url, headers } = fake.requests[0]
    expect(url.pathname).toBe('/web/search')
    expect(headers['x-subscription-token']).toBe(KEY)
    expect(headers.accept).toBe('application/json')
    expect(url.toString()).not.toContain(KEY)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'node streams',
      count: '10',
      text_decorations: 'false',
      result_filter: 'web',
    })
  })

  it('passes every option through, normalising the case of codes', async () => {
    fake.replies.push({ body: webBody([]) })
    await brave.web({
      query: 'rust async',
      count: 5,
      offset: 2,
      freshness: 'pw',
      country: 'gb',
      search_lang: 'PT-BR',
      safesearch: 'strict',
    })
    expect(Object.fromEntries(fake.requests[0].url.searchParams)).toEqual({
      q: 'rust async',
      count: '5',
      offset: '2',
      freshness: 'pw',
      country: 'GB',
      search_lang: 'pt-br',
      safesearch: 'strict',
      text_decorations: 'false',
      result_filter: 'web',
    })
  })

  it('encodes a query with special characters', async () => {
    fake.replies.push({ body: webBody([]) })
    await brave.web({ query: 'c++ & "std::vector" #1' })
    expect(fake.requests[0].url.searchParams.get('q')).toBe(
      'c++ & "std::vector" #1',
    )
  })
})

describe('brave_web_search results', () => {
  it('lists title, source, age, URL and description, numbered', async () => {
    fake.replies.push({
      body: webBody([
        {
          title: 'Streams | Node.js',
          url: 'https://nodejs.org/api/stream.html',
          description: 'The stream module.',
          age: '2 weeks ago',
          meta_url: { hostname: 'nodejs.org' },
        },
        { title: 'No extras', url: 'https://example.com/b' },
      ]),
    })
    expect(await brave.web({ query: 'node streams' })).toBe(
      [
        '2 web results for "node streams"',
        '',
        '1. Streams | Node.js (nodejs.org, 2 weeks ago)',
        '   https://nodejs.org/api/stream.html',
        '   The stream module.',
        '',
        '2. No extras',
        '   https://example.com/b',
      ].join('\n'),
    )
  })

  it('says when the spelling was corrected', async () => {
    fake.replies.push({
      body: webBody([{ title: 'T', url: 'https://x.test' }], {
        query: { altered: 'javascript' },
      }),
    })
    expect(await brave.web({ query: 'javscript' })).toContain(
      '1 web results for "javscript" (spelling corrected to "javascript")',
    )
  })

  it('cuts very long titles and descriptions', async () => {
    fake.replies.push({
      body: webBody([
        {
          title: 'T'.repeat(500),
          url: 'https://x.test',
          description: 'D'.repeat(2000),
        },
      ]),
    })
    const text = await brave.web({ query: 'long' })
    expect(text).toContain('T'.repeat(199) + '…')
    expect(text).toContain('D'.repeat(499) + '…')
    expect(text.length).toBeLessThan(1000)
  })

  it('reports no results as a plain answer, not an error', async () => {
    fake.replies.push({ body: { type: 'search' } })
    expect(await brave.web({ query: 'zzzzqqq' })).toBe(
      'No web results for "zzzzqqq".',
    )
  })
})

describe('failures', () => {
  const failure = async (reply: Parameters<typeof fake.replies.push>[0]) => {
    fake.replies.push(reply)
    return brave.web({ query: 'x' }).then(
      () => 'no error',
      (error: Error) => error.message,
    )
  }

  it('explains a rejected key without repeating it', async () => {
    for (const status of [401, 403]) {
      const message = await failure({
        status,
        body: { error: { detail: 'bad token' } },
      })
      expect(message).toContain(`HTTP ${status}`)
      expect(message).toContain('BRAVE_API_KEY')
      expect(message).not.toContain(KEY)
    }
  })

  it('recognises an invalid key even though Brave answers it with HTTP 422', async () => {
    // the real response to a made-up key, captured from api.search.brave.com
    const message = await failure({
      status: 422,
      body: {
        type: 'ErrorResponse',
        error: {
          code: 'SUBSCRIPTION_TOKEN_INVALID',
          detail: 'The provided subscription token is invalid.',
          meta: { component: 'authentication' },
          status: 422,
        },
      },
    })
    expect(message).toContain(
      'rejected the API key (HTTP 422: The provided subscription token is invalid.)',
    )
    expect(message).toContain('BRAVE_API_KEY')
    expect(message).not.toContain('search parameters')
    expect(message).not.toContain(KEY)
  })

  it('passes on the detail of a rejected parameter', async () => {
    const message = await failure({
      status: 422,
      body: { error: { detail: 'Unable to validate request parameter(s)' } },
    })
    expect(message).toContain('HTTP 422')
    expect(message).toContain('Unable to validate request parameter(s)')
    expect(message).toContain('check the search parameters')
  })

  it('copes with an error page that is not JSON', async () => {
    const message = await failure({
      status: 502,
      body: '<html>Bad gateway</html>',
    })
    expect(message).toBe('Brave Search returned HTTP 502 Bad Gateway.')
  })

  it('rejects a response in an unexpected format', async () => {
    expect(
      await failure({ body: { web: { results: 'not a list' } } }),
    ).toContain('unexpected format')
  })

  it('waits out a short per-second rate limit and retries once', async () => {
    fake.replies.push(
      {
        status: 429,
        headers: {
          'x-ratelimit-remaining': '0, 14000',
          'x-ratelimit-reset': '0, 2400000',
        },
        body: { error: { code: 'RATE_LIMITED' } },
      },
      { body: webBody([{ title: 'After the wait', url: 'https://ok.test' }]) },
    )
    expect(await brave.web({ query: 'x' })).toContain('After the wait')
    expect(fake.requests).toHaveLength(2)
  })

  it('gives up after one retry', async () => {
    const limited = {
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      body: {},
    }
    fake.replies.push(limited, limited)
    const message = await brave.web({ query: 'x' }).then(
      () => 'no error',
      (error: Error) => error.message,
    )
    expect(message).toContain('rate limit reached')
    expect(fake.requests).toHaveLength(2)
  })

  it('does not wait for a monthly quota that resets in weeks', async () => {
    const message = await failure({
      status: 429,
      headers: {
        'x-ratelimit-remaining': '5, 0',
        'x-ratelimit-reset': '1, 2400000',
      },
      body: {},
    })
    expect(message).toContain('resets in 2400000 seconds')
    expect(fake.requests).toHaveLength(1)
  })

  it('stops when the caller cancels', async () => {
    fake.replies.push({ delayMs: 2000, body: webBody([]) })
    const controller = new AbortController()
    const pending = brave.web({ query: 'x' }, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    await expect(pending).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1500)
  })
})
