import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client } from '@modelcontextprotocol/client'
import { callError, connect, dir } from './harness.js'

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

describe('read_multiple_files, once the budget is used up', () => {
  it('skips the remaining files and says how to read them', async () => {
    const client = await connect(false)
    // exactly the call's 200,000-character budget: nothing is left for note.txt
    await fs.writeFile(
      path.join(dir, 'big.txt'),
      ('x'.repeat(99) + '\n').repeat(2000),
    )
    const result = await client.callTool({
      name: 'read_multiple_files',
      arguments: {
        paths: [path.join(dir, 'big.txt'), path.join(dir, 'note.txt')],
      },
    })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain(
      `${path.join(dir, 'note.txt')}: Skipped - the size limit for this call was reached; read it with read_file`,
    )
    expect(text).not.toContain('original')
  })
})

describe('list_directory', () => {
  const list = async (args: Record<string, unknown>) => {
    const client = await connect(false)
    const result = await client.callTool({
      name: 'list_directory',
      arguments: args,
    })
    return {
      isError: result.isError,
      text: (result.content as Array<{ text: string }>)[0].text,
    }
  }

  it('lists a directory, and a subdirectory by relative path', async () => {
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'inner.txt'), 'x')
    expect((await list({ path: dir })).text).toBe('sub/\nnote.txt')
    expect((await list({ path: 'sub' })).text).toBe('inner.txt')
  })

  it('lists recursively when asked', async () => {
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'inner.txt'), 'x')
    expect((await list({ path: dir, recursive: true })).text).toBe(
      'sub/\nnote.txt\nsub/inner.txt',
    )
  })

  it('refuses a directory outside the allowed ones, and a link that leads there', async () => {
    const outside = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ls-out-')),
    )
    try {
      await fs.symlink(outside, path.join(dir, 'escape'))
      for (const target of ['/etc', '..', path.join(dir, 'escape')]) {
        const result = await list({ path: target })
        expect(result.isError, target).toBe(true)
        expect(result.text, target).toContain('Access denied')
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('says what is wrong when the path is a file or missing', async () => {
    const file = await list({ path: 'note.txt' })
    expect(file.isError).toBe(true)
    expect(file.text).toBe(
      'note.txt is a file, not a directory; read it with read_file',
    )
    expect((await list({ path: 'nope' })).isError).toBe(true)
  })
})

describe('read_file tail', () => {
  it('returns the last lines through the tool', async () => {
    const client = await connect(false)
    await fs.writeFile(path.join(dir, 'lines.txt'), 'a\nb\nc\nd\n')
    const result = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(dir, 'lines.txt'), tail: 2 },
    })
    expect((result.content as Array<{ text: string }>)[0].text).toBe('c\nd')
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
