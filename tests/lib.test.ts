import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyFileEdits,
  headFile,
  tailFile,
  validatePath,
  writeFileContent,
} from '../src/lib.js'

let root: string
let outside: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-')))
  outside = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-out-')),
  )
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('validatePath', () => {
  it('accepts files inside and new files with an existing parent', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'x')
    expect(await validatePath(path.join(root, 'a.txt'), [root])).toBe(
      path.join(root, 'a.txt'),
    )
    expect(await validatePath(path.join(root, 'new.txt'), [root])).toBe(
      path.join(root, 'new.txt'),
    )
  })

  it('rejects traversal, siblings with a shared prefix and missing parents', async () => {
    await expect(
      validatePath(path.join(root, '..', 'etc'), [root]),
    ).rejects.toThrow('Access denied')
    await expect(validatePath(root + '-evil/x', [root])).rejects.toThrow(
      'Access denied',
    )
    await expect(
      validatePath(path.join(root, 'no/such/f'), [root]),
    ).rejects.toThrow('Parent directory')
  })

  it('rejects a symlink that points outside', async () => {
    await fs.writeFile(path.join(outside, 's'), 'secret')
    await fs.symlink(path.join(outside, 's'), path.join(root, 'link'))
    await expect(validatePath(path.join(root, 'link'), [root])).rejects.toThrow(
      'symlink target',
    )
  })
})

describe('writeFileContent', () => {
  it('creates, overwrites, and refuses non-regular files', async () => {
    const f = path.join(root, 'f.txt')
    await writeFileContent(f, 'one')
    await writeFileContent(f, 'two')
    expect(await fs.readFile(f, 'utf-8')).toBe('two')
    await fs.mkdir(path.join(root, 'd'))
    await expect(writeFileContent(path.join(root, 'd'), 'x')).rejects.toThrow()
  })

  it('does not write through a symlink', async () => {
    const target = path.join(outside, 't')
    await fs.writeFile(target, 'keep')
    await fs.symlink(target, path.join(root, 'l'))
    await expect(
      writeFileContent(path.join(root, 'l'), 'bad'),
    ).rejects.toThrow()
    expect(await fs.readFile(target, 'utf-8')).toBe('keep')
  })
})

describe('head / tail', () => {
  it('returns the first and last N lines, and nothing for 0', async () => {
    const f = path.join(root, 'l.txt')
    await fs.writeFile(f, 'a\r\nb\r\nc\r\nd\n')
    expect(await headFile(f, 2)).toBe('a\nb')
    expect(await tailFile(f, 2)).toBe('c\nd')
    expect(await headFile(f, 0)).toBe('')
    expect(await tailFile(f, 0)).toBe('')
    expect(await tailFile(f, 10)).toBe('a\nb\nc\nd')
  })
})

describe('applyFileEdits', () => {
  it('applies edits in order and returns a diff', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'hello world\n')
    const diff = await applyFileEdits(f, [
      { oldText: 'hello', newText: 'bye' },
      { oldText: 'bye world', newText: 'bye all' },
    ])
    expect(await fs.readFile(f, 'utf-8')).toBe('bye all\n')
    expect(diff).toContain('-hello world')
  })

  it('dryRun does not write; failed match writes nothing', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'a\nb\n')
    await applyFileEdits(f, [{ oldText: 'a', newText: 'z' }], true)
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nb\n')
    await expect(
      applyFileEdits(f, [
        { oldText: 'a', newText: 'z' },
        { oldText: 'missing', newText: 'q' },
      ]),
    ).rejects.toThrow('edit 2 of 2')
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nb\n')
  })

  it('matches whole lines ignoring indentation and keeps the file indentation and CRLF', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'if (x) {\r\n    foo()\r\n}\r\n')
    await applyFileEdits(f, [{ oldText: 'foo()', newText: 'bar()' }])
    expect(await fs.readFile(f, 'utf-8')).toBe('if (x) {\r\n    bar()\r\n}\r\n')
    await applyFileEdits(f, [{ oldText: '  bar()', newText: '  baz()' }])
    expect(await fs.readFile(f, 'utf-8')).toBe('if (x) {\r\n    baz()\r\n}\r\n')
  })
})
