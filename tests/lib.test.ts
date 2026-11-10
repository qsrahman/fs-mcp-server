import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyFileEdits } from '../src/edit.js'
import {
  MAX_READ_BYTES,
  headFile,
  readFileContent,
  tailFile,
  writeFileContent,
} from '../src/files.js'
import { validatePath } from '../src/paths.js'

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

describe('validatePath edge cases', () => {
  it('rejects a NUL byte', async () => {
    await expect(validatePath(path.join(root, 'a\0b'), [root])).rejects.toThrow(
      'Access denied',
    )
  })

  it('allows the allowed directory itself', async () => {
    expect(await validatePath(root, [root])).toBe(root)
  })

  it('refuses ~ when home is outside the allowed directories', async () => {
    await expect(validatePath('~/x', [root])).rejects.toThrow('Access denied')
  })

  it('resolves relative paths against the first allowed directory, not the cwd', async () => {
    await fs.writeFile(path.join(root, 'rel.txt'), 'x')
    expect(await validatePath('rel.txt', [root])).toBe(
      path.join(root, 'rel.txt'),
    )
    await expect(validatePath('../escape', [root])).rejects.toThrow(
      'Access denied',
    )
  })

  it('refuses a new file under a symlinked directory that leaves', async () => {
    await fs.symlink(outside, path.join(root, 'out'))
    await expect(
      validatePath(path.join(root, 'out', 'new.txt'), [root]),
    ).rejects.toThrow('Access denied')
  })

  it('follows a symlink that stays inside', async () => {
    await fs.writeFile(path.join(root, 'real.txt'), 'x')
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'in'))
    expect(await validatePath(path.join(root, 'in'), [root])).toBe(
      path.join(root, 'real.txt'),
    )
  })

  it('does not write through a dangling symlink pointing outside', async () => {
    const target = path.join(outside, 'not-yet')
    await fs.symlink(target, path.join(root, 'dangling'))
    const validated = await validatePath(path.join(root, 'dangling'), [
      root,
    ]).catch(() => null)
    if (validated)
      await expect(writeFileContent(validated, 'bad')).rejects.toThrow()
    await expect(fs.access(target)).rejects.toThrow()
  })
})

describe('edit_file no-match error', () => {
  const edit = async (
    content: string,
    oldText: string,
    index = 0,
    count = 1,
  ) => {
    const f = path.join(root, 'm.txt')
    await fs.writeFile(f, content)
    const edits = Array.from({ length: count }, (_, i) =>
      i === index
        ? { oldText, newText: 'x' }
        : { oldText: content.split('\n')[0], newText: content.split('\n')[0] },
    )
    return applyFileEdits(f, edits).then(
      () => '',
      (e: Error) => e.message,
    )
  }

  it('names the edit, quotes the closest numbered lines and says nothing was applied', async () => {
    const message = await edit('alpha\nbeta gamma\ndelta\n', 'beta  gamma')
    expect(message).toContain('edit 1 of 1')
    expect(message).toContain('No edits were applied')
    expect(message).toContain('2: beta gamma')
    expect(message).toContain('First difference')
  })

  it('says so when no line resembles oldText, or the file is empty', async () => {
    expect(await edit('aaa\nbbb\n', 'zzzz')).toContain(
      'No line of the file resembles oldText',
    )
    expect(await edit('', 'zzzz')).toContain('The file is empty')
  })

  it('reports oldText that runs past the end of the file', async () => {
    expect(await edit('one\ntwo\n', 'two\nthree')).toContain(
      'runs past the end of the file',
    )
  })

  it('cuts a very long file line', async () => {
    const message = await edit('x'.repeat(2000) + '\n', 'x'.repeat(10) + 'y')
    expect(message).toContain('[... cut: the line has 2000 characters]')
  })

  it('caps the quoted region at 30 lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const message = await edit(
      lines.join('\n') + '\n',
      lines.slice(10, 70).join('\n') + '\nDIFF',
    )
    const quoted = message.match(/^\d+: /gm) ?? []
    expect(quoted.length).toBeLessThanOrEqual(30)
  })

  it('notes earlier edits when a later edit fails', async () => {
    expect(await edit('a1\nb2\nc3\n', 'b2x', 1, 2)).toContain(
      'after the earlier edits in this call',
    )
  })
})

describe('regressions', () => {
  it('head closes its file descriptor on an early exit', async () => {
    const f = path.join(root, 'big.txt')
    await fs.writeFile(f, 'x\n'.repeat(200_000))
    const open = async () => (await fs.readdir('/dev/fd')).length
    const before = await open()
    for (let i = 0; i < 30; i++) await headFile(f, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await open()).toBeLessThan(before + 5)
  })

  it('rejects an empty oldText instead of prepending', async () => {
    const f = path.join(root, 'a.txt')
    await fs.writeFile(f, 'hello\n')
    await expect(
      applyFileEdits(f, [{ oldText: '', newText: 'X' }]),
    ).rejects.toThrow('empty')
    expect(await fs.readFile(f, 'utf-8')).toBe('hello\n')
  })

  it('refuses to edit a file that is not valid UTF-8, leaving its bytes alone', async () => {
    const f = path.join(root, 'b.bin')
    const bytes = Buffer.from([0x68, 0x69, 0x0a, 0xff, 0xfe, 0x0a])
    await fs.writeFile(f, bytes)
    await expect(
      applyFileEdits(f, [{ oldText: 'hi', newText: 'ho' }]),
    ).rejects.toThrow('UTF-8')
    expect((await fs.readFile(f)).equals(bytes)).toBe(true)
  })

  it('accepts a filesystem root as an allowed directory', async () => {
    expect(
      await validatePath(path.join(root, 'x'), [path.parse(root).root]),
    ).toBe(path.join(root, 'x'))
  })
})

describe('read limits and tail', () => {
  it('refuses a whole-file read over the limit but still serves head and tail', async () => {
    const f = path.join(root, 'huge.txt')
    await fs.writeFile(f, 'a\n'.repeat(MAX_READ_BYTES / 2 + 1))
    await expect(readFileContent(f)).rejects.toThrow('Use head or tail')
    expect(await headFile(f, 2)).toBe('a\na')
    expect(await tailFile(f, 2)).toBe('a\na')
  })

  it('tails across chunk boundaries, with multi-byte text and no final newline', async () => {
    const f = path.join(root, 'many.txt')
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} é€`)
    await fs.writeFile(f, lines.join('\n'))
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    await fs.writeFile(f, lines.join('\n') + '\n')
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    expect(await tailFile(f, 50_000)).toBe(lines.join('\n'))
  })

  it('names a broken symlink instead of a generic error', async () => {
    await fs.symlink(
      path.join(root, 'missing-target'),
      path.join(root, 'dangling'),
    )
    await expect(
      validatePath(path.join(root, 'dangling'), [root]),
    ).rejects.toThrow('Broken symlink')
  })
})
