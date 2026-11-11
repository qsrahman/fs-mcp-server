import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer, type ServerOptions } from '../src/server.js'

// Importing this file gives a test file a fresh temp directory (`dir`, holding
// note.txt) and cleanup of every client connected through it, for each test.
export let dir: string
let closers: Array<() => Promise<void>>

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-srv-')),
  )
  await fs.writeFile(path.join(dir, 'note.txt'), 'original')
  closers = []
})

afterEach(async () => {
  for (const close of closers.reverse()) await close()
  await fs.rm(dir, { recursive: true, force: true })
})

/** A client connected to a server built with `allowedDirs` and `options`. */
export async function connectTo(
  allowedDirs: string[] | null,
  options: ServerOptions = {},
  // Left out, the client's default applies. 'auto' negotiates the 2026-07-28
  // protocol revision, 'legacy' the 2025 one.
  mode?: 'auto' | 'legacy',
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createServer(allowedDirs, options), {
    transport: serverTransport,
  })
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    mode ? { versionNegotiation: { mode } } : undefined,
  )
  await client.connect(clientTransport)
  closers.push(
    () => handle.close(),
    () => client.close(),
  )
  return client
}

/** The usual test server: restricted to `dir`, shell off unless asked for. */
export const connect = (
  readOnly: boolean,
  shell = false,
  mode?: 'auto' | 'legacy',
) => connectTo([dir], { readOnly, shell }, mode)

export const callError = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const result = await client
    .callTool({ name, arguments: args })
    .catch((error: unknown) => ({
      isError: true,
      content: [{ text: String(error) }],
    }))
  return (result.content as Array<{ text: string }>)[0].text
}

export const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort()
