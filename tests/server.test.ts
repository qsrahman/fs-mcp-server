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

const callError = async (
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
          arguments: {
            path: file,
            edits: [{ oldText, newText, replaceAll: true }],
          },
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
  it('cuts a file that does not fit in the shared budget, with where to continue', async () => {
    const client = await connect(false)
    const row = 'x'.repeat(99) + '\n'
    await fs.writeFile(path.join(dir, 'one.txt'), row.repeat(1500)) // 150,000 chars
    await fs.writeFile(path.join(dir, 'two.txt'), row.repeat(1500))
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [
          path.join(dir, 'one.txt'),
          path.join(dir, 'note.txt'),
          path.join(dir, 'two.txt'),
        ],
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain('note.txt:\noriginal')
    expect(text).toContain('Continue with read_file offset=')
    expect(text.length).toBeLessThan(200_500)
  })
})

describe('write_file', () => {
  it('creates missing parent directories', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: path.join(dir, 'new', 'deep', 'f.ts'), content: 'x' },
    })
    expect(result.isError).toBeFalsy()
    expect(await fs.readFile(path.join(dir, 'new/deep/f.ts'), 'utf-8')).toBe(
      'x',
    )
  })

  it('creates them relative to the first allowed directory', async () => {
    const client = await connect(false)
    await client.callTool({
      name: 'write_file',
      arguments: { path: 'rel/dir/g.ts', content: 'y' },
    })
    expect(await fs.readFile(path.join(dir, 'rel/dir/g.ts'), 'utf-8')).toBe('y')
  })

  it('creates nothing when the path leaves the allowed directories', async () => {
    const client = await connect(false)
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-x-')),
    )
    try {
      await fs.symlink(outside, path.join(dir, 'out'))
      const viaLink = await callError(client, 'write_file', {
        path: path.join(dir, 'out', 'a', 'b.txt'),
        content: 'bad',
      })
      expect(viaLink).toContain('Access denied')
      const traversal = await callError(client, 'write_file', {
        path: path.join(dir, '..', 'fs-mcp-escape', 'b.txt'),
        content: 'bad',
      })
      expect(traversal).toContain('Access denied')
      expect(await fs.readdir(outside)).toEqual([])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('read_file for agents', () => {
  const read = async (client: Client, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'read_file', arguments: args })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('reads a range with offset and limit', async () => {
    const client = await connect(false)
    await fs.writeFile(
      path.join(dir, 'ten.txt'),
      Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n',
    )
    const { text } = await read(client, {
      path: path.join(dir, 'ten.txt'),
      offset: 4,
      limit: 3,
    })
    expect(text).toMatch(
      /^l4\nl5\nl6\n\[\.\.\. showing lines 4-6; more lines follow\. Continue with read_file offset=7\]$/,
    )
  })

  it('caps a long file and says where to continue', async () => {
    const client = await connect(false)
    await fs.writeFile(
      path.join(dir, 'long.txt'),
      ('y'.repeat(79) + '\n').repeat(5000),
    ) // 400,000 chars
    const { text } = await read(client, { path: path.join(dir, 'long.txt') })
    expect(text.length).toBeLessThan(101_000)
    expect(text).toMatch(/Continue with read_file offset=\d+\]$/)
  })

  it('rejects combining head, tail and offset/limit', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    for (const extra of [
      { head: 1, offset: 1 },
      { tail: 1, limit: 1 },
      { head: 1, tail: 1 },
    ]) {
      expect((await read(client, { path: file, ...extra })).isError).toBe(true)
    }
  })

  it("explains a directory, a missing file and a binary file in the caller's words", async () => {
    const client = await connect(false)
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]))
    expect((await read(client, { path: 'sub' })).text).toBe(
      'sub is a directory, not a file',
    )
    expect((await read(client, { path: 'missing/none.txt' })).text).toBe(
      'File not found: missing/none.txt',
    )
    expect((await read(client, { path: 'blob.bin' })).text).toBe(
      'blob.bin looks like a binary file or is not valid UTF-8 text',
    )
  })
})

describe('edit_file ambiguity', () => {
  const call = (client: Client, args: Record<string, unknown>) =>
    client.callTool({ name: 'edit_file', arguments: args })

  it('refuses an oldText that matches several places and writes nothing', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'dup.txt')
    await fs.writeFile(file, 'a=1\nb=1\na=1\n')
    const result = await call(client, {
      path: file,
      edits: [{ oldText: 'a=1', newText: 'a=2' }],
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain(
      'matches 2 places (lines 1, 3)',
    )
    expect(await fs.readFile(file, 'utf-8')).toBe('a=1\nb=1\na=1\n')
  })

  it('replaces every match with replaceAll', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'dup.txt')
    await fs.writeFile(file, 'a=1\nb=1\na=1\n')
    const result = await call(client, {
      path: file,
      edits: [{ oldText: 'a=1', newText: 'a=2', replaceAll: true }],
    })
    expect(result.isError).toBeFalsy()
    expect(await fs.readFile(file, 'utf-8')).toBe('a=2\nb=1\na=2\n')
  })
})

describe('server instructions', () => {
  it('tell the client the allowed directory and how to read and write', async () => {
    const instructions = (await connect(false)).getInstructions() ?? ''
    expect(instructions).toContain(dir)
    expect(instructions).toContain('offset and limit')
    expect(instructions).toContain('edit_file')
    expect(instructions).not.toContain('shell')
  })

  it('leave out write advice in read-only mode and mention an enabled shell', async () => {
    const readOnly = (await connect(true)).getInstructions() ?? ''
    expect(readOnly).toContain('offset and limit')
    expect(readOnly).not.toContain('edit_file')
    expect((await connect(false, true)).getInstructions()).toContain(
      'shell tool is not limited',
    )
  })
})
