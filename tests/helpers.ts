import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Two fresh, realpath'd temp directories: one to allow, one outside it. */
export async function makeTempDirs() {
  const make = async (prefix: string) =>
    fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  return { root: await make('fs-mcp-'), outside: await make('fs-mcp-out-') }
}

export async function removeTempDirs(...dirs: string[]) {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
}

/** One scripted answer from the fake Brave Search API. */
export interface FakeReply {
  status?: number
  headers?: Record<string, string>
  /** An object is sent as JSON; a string is sent as it is. */
  body: unknown
  delayMs?: number
}

/**
 * A local stand-in for the Brave Search API: records each request and answers
 * from `replies` in order (an empty JSON object once they run out).
 */
export async function startFakeBrave() {
  const requests: Array<{ url: URL; headers: IncomingHttpHeaders }> = []
  const replies: FakeReply[] = []
  const server = createHttpServer((req, res) => {
    requests.push({
      url: new URL(req.url ?? '/', 'http://fake'),
      headers: req.headers,
    })
    const reply = replies.shift() ?? { body: {} }
    setTimeout(() => {
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers,
      })
      res.end(
        typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body),
      )
    }, reply.delayMs ?? 0)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    replies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
