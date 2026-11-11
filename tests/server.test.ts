import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { parseArgs } from '../src/index.js'
import { createServer } from '../src/server.js'

let dir: string
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

async function connect(
  readOnly: boolean,
  enableShell = false,
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  const handle = serveStdio(
    () => createServer([dir], { readOnly, enableShell }),
    {
      transport: serverTransport,
    },
  )
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(clientTransport)
  closers.push(
    () => handle.close(),
    () => client.close(),
  )
  return client
}

const names = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort()

describe('tools', () => {
  it('lists the four tools', async () => {
    expect(await names(await connect(false))).toEqual([
      'edit_file',
      'read_file',
      'read_multiple_files',
      'write_file',
    ])
  })

  it('refuses a path outside the allowed directory with isError', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: '/etc/passwd' },
    })
    expect(result.isError).toBe(true)
  })

  it('rejects head and tail together', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'note.txt'), head: 1, tail: 1 },
    })
    expect(result.isError).toBe(true)
  })

  it('reports a failed read inline in read_multiple_files', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [path.join(dir, 'note.txt'), path.join(dir, 'nope')],
      },
    })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('original')
    expect(JSON.stringify(result.content)).toContain('Error')
  })
})

describe('--read-only', () => {
  it('serves only the tools annotated readOnlyHint: true', async () => {
    const client = await connect(true)
    expect(await names(client)).toEqual(['read_file', 'read_multiple_files'])
    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })

  it('refuses a write tool and leaves the file untouched', async () => {
    const client = await connect(true)
    const target = path.join(dir, 'note.txt')
    const result = await client
      .callTool({
        name: 'write_file',
        arguments: { path: target, content: 'x' },
      })
      .catch(() => ({ isError: true }))
    expect(result.isError).toBe(true)
    expect(await fs.readFile(target, 'utf-8')).toBe('original')
  })

  it('still serves reads', async () => {
    const client = await connect(true)
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'note.txt') },
    })
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([{ type: 'text', text: 'original' }])
  })
})

describe('parseArgs', () => {
  it('takes plain arguments as directories', () => {
    expect(parseArgs(['/a', '/b'])).toEqual({
      directories: ['/a', '/b'],
      readOnly: false,
      enableShell: false,
    })
  })

  it('accepts --read-only anywhere', () => {
    expect(parseArgs(['--read-only', '/a']).readOnly).toBe(true)
    expect(parseArgs(['/a', '--read-only', '/b'])).toEqual({
      directories: ['/a', '/b'],
      readOnly: true,
      enableShell: false,
    })
  })

  it('accepts --enable-shell', () => {
    expect(parseArgs(['--enable-shell', '/a'])).toMatchObject({
      directories: ['/a'],
      enableShell: true,
    })
  })

  it('treats everything after -- as a directory', () => {
    expect(parseArgs(['--', '--read-only'])).toEqual({
      directories: ['--read-only'],
      readOnly: false,
      enableShell: false,
    })
  })
})

describe('inputs and outputs', () => {
  it('rejects an empty oldText and too many paths at the schema', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    const empty = await client
      .callTool({
        name: 'edit_file',
        arguments: { path: file, edits: [{ oldText: '', newText: 'x' }] },
      })
      .catch(() => ({ isError: true }))
    expect(empty.isError).toBe(true)
    expect(await fs.readFile(file, 'utf-8')).toBe('original')
    const many = await client
      .callTool({
        name: 'read_multiple_files',
        arguments: { paths: Array.from({ length: 51 }, () => file) },
      })
      .catch(() => ({ isError: true }))
    expect(many.isError).toBe(true)
  })

  it('returns file contents once, without a duplicate structuredContent', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'note.txt') },
    })
    expect(result.structuredContent).toBeUndefined()
  })
})

describe('server info', () => {
  it('reports the version from package.json', async () => {
    const client = await connect(false)
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as {
      version: string
    }
    expect(client.getServerVersion()?.version).toBe(pkg.version)
  })
})

describe('shell tool', () => {
  const callShell = async (client: Client, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'shell', arguments: args })
    const block = (result.content as Array<{ type: string; text: string }>)[0]
    return { isError: result.isError, text: block.text }
  }

  it('is absent by default and under --read-only, present with --enable-shell', async () => {
    expect(await names(await connect(false))).not.toContain('shell')
    expect(await names(await connect(true, true))).not.toContain('shell')
    expect(await names(await connect(false, true))).toContain('shell')
  })

  it('runs in the first allowed directory by default', async () => {
    const client = await connect(false, true)
    const { isError, text } = await callShell(client, { command: 'pwd' })
    expect(isError).toBeFalsy()
    expect(await fs.realpath(JSON.parse(text).stdout)).toBe(dir)
  })

  it('flags a failing command with isError and keeps the result', async () => {
    const client = await connect(false, true)
    const { isError, text } = await callShell(client, { command: 'exit 3' })
    expect(isError).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ ok: false, exitCode: 3 })
  })

  it('refuses a cwd outside the allowed directories', async () => {
    const client = await connect(false, true)
    const { isError, text } = await callShell(client, {
      command: 'pwd',
      cwd: '/',
    })
    expect(isError).toBe(true)
    expect(text).toContain('Access denied')
  })

  it('accepts a cwd inside the allowed directories', async () => {
    await fs.mkdir(path.join(dir, 'sub'))
    const client = await connect(false, true)
    const { text } = await callShell(client, {
      command: 'pwd',
      cwd: path.join(dir, 'sub'),
    })
    expect(JSON.parse(text).stdout).toMatch(/sub$/)
  })
})
