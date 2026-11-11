import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { MAX_TOOL_INPUT_ELEMENTS } from '../src/server.js'
import { connect, connectTo, dir, names } from './harness.js'

describe('tools', () => {
  it('lists the file tools, and fetch_url which is on by default', async () => {
    expect(await names(await connect(false))).toEqual([
      'edit_file',
      'fetch_url',
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

  it('rejects head: 0 instead of returning a "continue" note for nothing', async () => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'note.txt'), head: 0 },
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
    expect(await names(client)).toEqual([
      'fetch_url',
      'read_file',
      'read_multiple_files',
    ])
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
      'fetch_url',
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
      'fetch_url',
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
    expect(text).toContain('"name": "@qsrahman/workshop-mcp"')
  })

  it('runs the shell in the working directory unless told otherwise', async () => {
    const client = await connectTo(null)
    const here = (await call(client, 'shell', { command: 'pwd' })).text
    expect(await fs.realpath(here)).toBe(await fs.realpath(process.cwd()))
    const there = (await call(client, 'shell', { command: 'pwd', cwd: other }))
      .text
    expect(await fs.realpath(there)).toBe(other)
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
