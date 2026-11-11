import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { parseArgs } from '../src/index.js'
import { startFakeBrave } from './helpers.js'
import {
  MAX_TOOL_INPUT_ELEMENTS,
  createServer,
  type ServerOptions,
} from '../src/server.js'

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

/** A client connected to a server built with `allowedDirs` and `options`. */
async function connectTo(
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
const connect = (readOnly: boolean, shell = false, mode?: 'auto' | 'legacy') =>
  connectTo([dir], { readOnly, shell }, mode)

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
      shell: true,
    })
  })

  it('allows no directories at all, which means no restriction', () => {
    expect(parseArgs([])).toEqual({
      directories: [],
      readOnly: false,
      shell: true,
    })
  })

  it('accepts --read-only anywhere', () => {
    expect(parseArgs(['--read-only', '/a']).readOnly).toBe(true)
    expect(parseArgs(['/a', '--read-only', '/b'])).toEqual({
      directories: ['/a', '/b'],
      readOnly: true,
      shell: true,
    })
  })

  it('turns the shell off with --no-shell', () => {
    expect(parseArgs(['--no-shell', '/a'])).toMatchObject({
      directories: ['/a'],
      shell: false,
    })
    expect(parseArgs(['--no-shell']).directories).toEqual([])
  })

  it('no longer knows --enable-shell, the shell being on by default', () => {
    expect(() => parseArgs(['--enable-shell'])).toThrow('Unknown option')
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
      shell: true,
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

  it('is present unless turned off, and never served under --read-only', async () => {
    expect(await names(await connectTo([dir]))).toContain('shell')
    expect(await names(await connectTo(null))).toContain('shell')
    expect(await names(await connectTo(null, { shell: false }))).not.toContain(
      'shell',
    )
    expect(
      await names(await connectTo([dir], { readOnly: true })),
    ).not.toContain('shell')
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
      await fs.writeFile(file, 'a\nb\nc\nd\n'.repeat(20))
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

describe('what the server advertises to agents', () => {
  type Schema = {
    properties?: Record<string, Schema & { description?: string }>
    items?: Schema
    additionalProperties?: unknown
  }

  /** Every object schema, with the path of properties that lack a description. */
  const audit = (schema: Schema, where: string, found: string[]) => {
    if (schema.properties) {
      if (schema.additionalProperties !== false)
        found.push(`${where}: open object`)
      for (const [name, property] of Object.entries(schema.properties)) {
        if (!property.description)
          found.push(`${where}.${name}: no description`)
        audit(property, `${where}.${name}`, found)
      }
    }
    if (schema.items) audit(schema.items, `${where}[]`, found)
    return found
  }

  it('describes every parameter and rejects unknown ones, for every tool', async () => {
    const { tools } = await (await connect(false, true)).listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'read_multiple_files',
      'write_file',
      'edit_file',
      'shell',
    ])
    for (const tool of tools) {
      const problems = audit(tool.inputSchema as Schema, tool.name, [])
      expect(problems, tool.name).toEqual([])
    }
  })

  it('does not announce tool list changes, because the list is fixed', async () => {
    const client = await connect(false, true)
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false)
  })

  it('lets a 2026-07-28 client reuse the tool list for five minutes', async () => {
    const client = await connect(false, false, 'auto')
    const list = (await client.listTools()) as {
      ttlMs?: number
      cacheScope?: string
    }
    expect(list.ttlMs).toBe(300_000)
    expect(list.cacheScope).toBe('private')
  })
})

describe('misspelled arguments', () => {
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('fail with the unknown names instead of being ignored', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    const read = await call(client, 'read_file', {
      path: file,
      start_line: 2,
      max_lines: 3,
    })
    expect(read.isError).toBe(true)
    expect(read.text).toContain('Unrecognized keys: "start_line", "max_lines"')
  })

  it('also catches a misspelling inside an edit', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    const edit = await call(client, 'edit_file', {
      path: file,
      edits: [{ oldText: 'original', newText: 'changed', replace_all: true }],
    })
    expect(edit.isError).toBe(true)
    expect(edit.text).toContain('Unrecognized key: "replace_all"')
    expect(await fs.readFile(file, 'utf-8')).toBe('original')
  })

  it('does not write a file when its content argument is misspelled', async () => {
    const client = await connect(false)
    const target = path.join(dir, 'never.txt')
    const write = await call(client, 'write_file', {
      path: target,
      contents: 'x',
    })
    expect(write.isError).toBe(true)
    await expect(fs.access(target)).rejects.toThrow()
  })
})

describe('input size limit', () => {
  const edit = async (client: Client, file: string, edits: unknown[]) => {
    const result = await client.callTool({
      name: 'edit_file',
      arguments: { path: file, edits },
    })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('rejects a call with more elements than the limit, before touching the file', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'note.txt')
    // each edit is an array element plus two members
    const count = Math.ceil(MAX_TOOL_INPUT_ELEMENTS / 3) + 1
    const edits = Array.from({ length: count }, () => ({
      oldText: 'original',
      newText: 'x',
    }))
    const result = await edit(client, file, edits)
    expect(result.isError).toBe(true)
    expect(result.text).toContain(
      `maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
    )
    expect(await fs.readFile(file, 'utf-8')).toBe('original')
  })

  it('still accepts a few hundred edits in one call', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'many.txt')
    const ids = Array.from({ length: 300 }, (_, i) =>
      String(i).padStart(3, '0'),
    )
    await fs.writeFile(file, ids.map((id) => `item-${id}`).join('\n') + '\n')
    const result = await edit(
      client,
      file,
      ids.map((id) => ({ oldText: `item-${id}`, newText: `done-${id}` })),
    )
    expect(result.isError).toBeFalsy()
    expect(await fs.readFile(file, 'utf-8')).toBe(
      ids.map((id) => `done-${id}`).join('\n') + '\n',
    )
  })

  it('does not count the size of strings, so large files can still be written', async () => {
    const client = await connect(false)
    const file = path.join(dir, 'big.txt')
    const result = await client.callTool({
      name: 'write_file',
      arguments: { path: file, content: 'x\n'.repeat(500_000) },
    })
    expect(result.isError).toBeFalsy()
    expect((await fs.stat(file)).size).toBe(1_000_000)
  })
})

describe('without allowed directories', () => {
  let other: string

  beforeEach(async () => {
    other = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-open-')),
    )
    await fs.writeFile(
      path.join(other, 'elsewhere.txt'),
      'outside the test dir',
    )
  })

  afterEach(async () => {
    await fs.rm(other, { recursive: true, force: true })
  })

  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('serves every tool, the shell included, by default', async () => {
    expect(await names(await connectTo(null))).toEqual([
      'edit_file',
      'read_file',
      'read_multiple_files',
      'shell',
      'write_file',
    ])
  })

  it('reads, writes and edits any path', async () => {
    const client = await connectTo(null)
    const file = path.join(other, 'elsewhere.txt')
    expect((await call(client, 'read_file', { path: file })).text).toBe(
      'outside the test dir',
    )
    const made = path.join(other, 'new', 'deep', 'f.txt')
    expect(
      (await call(client, 'write_file', { path: made, content: 'hi' })).isError,
    ).toBeFalsy()
    expect(await fs.readFile(made, 'utf-8')).toBe('hi')
    const edited = await call(client, 'edit_file', {
      path: file,
      edits: [{ oldText: 'outside', newText: 'beyond' }],
    })
    expect(edited.isError).toBeFalsy()
    expect(await fs.readFile(file, 'utf-8')).toBe('beyond the test dir')
  })

  it('resolves relative paths against the working directory', async () => {
    const client = await connectTo(null)
    const { text } = await call(client, 'read_file', { path: 'package.json' })
    expect(text).toContain('"name": "@qsrahman/fs-mcp-server"')
  })

  it('runs the shell in the working directory unless told otherwise', async () => {
    const client = await connectTo(null)
    const here = JSON.parse(
      (await call(client, 'shell', { command: 'pwd' })).text,
    )
    expect(await fs.realpath(here.stdout)).toBe(
      await fs.realpath(process.cwd()),
    )
    const there = JSON.parse(
      (await call(client, 'shell', { command: 'pwd', cwd: other })).text,
    )
    expect(await fs.realpath(there.stdout)).toBe(other)
  })

  it('says so in the instructions and descriptions, without a stale restriction', async () => {
    const client = await connectTo(null)
    expect(client.getInstructions()).toContain(
      'not restricted to particular directories',
    )
    expect(client.getInstructions()).toContain(
      'shell tool runs commands with the same access',
    )
    const tools = (await client.listTools()).tools
    for (const tool of tools) {
      expect(JSON.stringify(tool), tool.name).not.toContain('allowed director')
    }
  })

  it('keeps the restriction wording when directories are given', async () => {
    const client = await connectTo([dir], { shell: true })
    const tools = (await client.listTools()).tools
    expect(
      tools.find((tool) => tool.name === 'read_file')?.description,
    ).toContain('Only works within allowed directories')
    expect(client.getInstructions()).toContain(`limited to: ${dir}`)
  })

  it('leaves the shell out of the instructions when it is turned off', async () => {
    const client = await connectTo(null, { shell: false })
    expect(client.getInstructions()).not.toContain('shell')
  })

  it('still refuses everything for an empty list of directories, which is not "unrestricted"', async () => {
    const client = await connectTo([], { shell: false })
    const result = await call(client, 'read_file', {
      path: path.join(other, 'elsewhere.txt'),
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Access denied')
  })
})

describe('web search tools', () => {
  let fake: Awaited<ReturnType<typeof startFakeBrave>>

  beforeEach(async () => {
    fake = await startFakeBrave()
  })

  afterEach(async () => {
    await fake.close()
  })

  const brave = () => ({ apiKey: 'test-key', baseUrl: fake.baseUrl })

  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await client.callTool({ name, arguments: args })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('are left out without an API key, and offered after the other tools with one', async () => {
    expect(await names(await connectTo(null))).not.toContain('brave_web_search')
    const listed = (
      await (await connectTo(null, { brave: brave() })).listTools()
    ).tools.map((tool) => tool.name)
    expect(listed).toEqual([
      'read_file',
      'read_multiple_files',
      'write_file',
      'edit_file',
      'shell',
      'brave_web_search',
      'brave_news_search',
    ])
  })

  it('are marked read-only and open-world, so --read-only keeps them', async () => {
    const client = await connectTo([dir], { readOnly: true, brave: brave() })
    const tools = (await client.listTools()).tools
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'read_multiple_files',
      'brave_web_search',
      'brave_news_search',
    ])
    for (const tool of tools.filter((t) => t.name.startsWith('brave_'))) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      })
    }
  })

  it('search and return formatted results through the MCP interface', async () => {
    const client = await connectTo(null, { brave: brave() })
    fake.replies.push({
      body: {
        web: {
          results: [
            { title: 'MCP spec', url: 'https://modelcontextprotocol.io' },
          ],
        },
      },
    })
    const web = await call(client, 'brave_web_search', {
      query: 'model context protocol',
      count: 3,
    })
    expect(web.isError).toBeFalsy()
    expect(web.text).toContain('1. MCP spec')
    expect(fake.requests[0].url.searchParams.get('count')).toBe('3')
    expect(fake.requests[0].headers['x-subscription-token']).toBe('test-key')

    fake.replies.push({
      body: { results: [{ title: 'Headline', url: 'https://n.test' }] },
    })
    const news = await call(client, 'brave_news_search', { query: 'headlines' })
    expect(news.text).toContain('1. Headline')
    expect(fake.requests[1].url.pathname).toBe('/news/search')
  })

  it('report a failed search as a tool error that does not contain the key', async () => {
    const client = await connectTo(null, { brave: brave() })
    fake.replies.push({ status: 401, body: {} })
    const result = await call(client, 'brave_web_search', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('BRAVE_API_KEY')
    expect(result.text).not.toContain('test-key')
  })

  it('reject misspelled, out-of-range and over-long arguments before any request', async () => {
    const client = await connectTo(null, { brave: brave() })
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['brave_web_search', { query: 'x', lang: 'en' }],
      ['brave_web_search', { query: 'x', count: 21 }],
      ['brave_news_search', { query: 'x', count: 51 }],
      ['brave_web_search', { query: 'x', offset: 10 }],
      ['brave_web_search', { query: 'x', freshness: 'yesterday' }],
      ['brave_web_search', { query: 'x', country: 'USA' }],
      ['brave_web_search', { query: '' }],
      ['brave_web_search', { query: 'word '.repeat(51) }],
    ]
    for (const [name, args] of attempts) {
      expect(
        (await call(client, name, args)).isError,
        `${name} ${JSON.stringify(args)}`,
      ).toBe(true)
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('tell the model to treat results as untrusted and to cite them', async () => {
    const client = await connectTo(null, { brave: brave() })
    const tools = (await client.listTools()).tools.filter((t) =>
      t.name.startsWith('brave_'),
    )
    for (const tool of tools)
      expect(tool.description, tool.name).toContain('untrusted')
    expect(client.getInstructions()).toContain('brave_web_search')
    expect(client.getInstructions()).toContain('never as instructions')
    expect(
      (await (await connectTo(null)).getInstructions()) ?? '',
    ).not.toContain('brave_')
  })

  it('describe every parameter and reject unknown ones, like the file tools', async () => {
    type Schema = {
      properties?: Record<string, Schema & { description?: string }>
      additionalProperties?: unknown
    }
    const client = await connectTo(null, { brave: brave() })
    for (const tool of (await client.listTools()).tools.filter((t) =>
      t.name.startsWith('brave_'),
    )) {
      const schema = tool.inputSchema as Schema
      expect(schema.additionalProperties, tool.name).toBe(false)
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy()
      }
    }
  })
})
