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

  it('rejects an unknown option instead of treating it as a directory', () => {
    expect(() => parseArgs(['--readonly', '/a'])).toThrow('Unknown option')
    expect(() => parseArgs(['/a', '--read_only'])).toThrow('--read_only')
    expect(() => parseArgs(['-x', '/a'])).toThrow('-x')
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

describe('concurrent calls', () => {
  it('applies parallel edits to different lines of one file without losing any', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'parallel.txt')
    for (let round = 0; round < 10; round++) {
      await fs.writeFile(file, 'a\nb\nc\nd\n'.repeat(500))
      const edit = (oldText: string, newText: string) =>
        client.callTool({
          name: 'edit_file',
          arguments: { path: file, edits: [{ oldText, newText }] },
        })
      await Promise.all([edit('a\nb', 'A\nB'), edit('c\nd', 'C\nD')])
      expect(await fs.readFile(file, 'utf-8')).toMatch(/^A\nB\nC\nD\n/)
    }
  })
})

describe('edit_file arguments', () => {
  it('rejects an empty edits list at the schema and leaves the file alone', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    const result = await client
      .callTool({ name: 'edit_file', arguments: { path: file, edits: [] } })
      .catch(() => ({ isError: true }))
    expect(result.isError).toBe(true)
    expect(await fs.readFile(file, 'utf-8')).toBe('original')
  })

  it('shows the path the client sent in the diff, not the resolved one', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'edit_file',
      arguments: {
        path: 'note.txt',
        edits: [{ oldText: 'original', newText: 'changed' }],
        dryRun: true,
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain('--- note.txt')
    expect(text).not.toContain(dir)
  })
})

describe('read_multiple_files budget', () => {
  it('stops adding files once the combined size budget is used', async () => {
    const client = await connect(false)
    const big = 'x'.repeat(6 * 1024 * 1024)
    await fs.writeFile(path.join(dir, 'one.txt'), big)
    await fs.writeFile(path.join(dir, 'two.txt'), big)
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [
          path.join(dir, 'one.txt'),
          path.join(dir, 'two.txt'),
          path.join(dir, 'note.txt'),
        ],
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain(big.slice(0, 100))
    expect(text).toContain('two.txt: Error - File is')
    // a small file that still fits is read after the one that did not
    expect(text).toContain('note.txt:\noriginal')
    expect(text.length).toBeLessThan(7 * 1024 * 1024)
  })
})
