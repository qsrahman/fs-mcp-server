import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FS_CALL_TIMEOUT_MS } from '../src/paths.js'
import {
  friendlyFsError,
  listDirectory,
  readText,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../src/files.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string
let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await removeTempDirs(root, outside)
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

  it('creates missing parent directories', async () => {
    const f = path.join(root, 'new', 'deep', 'f.txt')
    await writeFileContent(f, 'hi')
    expect(await fs.readFile(f, 'utf-8')).toBe('hi')
  })

  it('fails clearly when a parent is a file', async () => {
    await fs.writeFile(path.join(root, 'plain'), 'x')
    await expect(
      writeFileContent(path.join(root, 'plain', 'child.txt'), 'y'),
    ).rejects.toThrow()
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

describe('readText', () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  const write = async (name: string, content: string) => {
    const f = path.join(root, name)
    await fs.writeFile(f, content)
    return f
  }

  it('returns a small file byte for byte', async () => {
    const f = await write('small.txt', 'a\r\nb\n')
    expect(await readText(f)).toBe('a\r\nb\n')
  })

  it('reads a range with offset and limit', async () => {
    const f = await write('range.txt', lines(10).join('\n') + '\n')
    expect(await readText(f, { offset: 3, limit: 2 })).toMatch(
      /^line 3\nline 4\n\[\.\.\. showing lines 3-4; more lines follow\. Continue with read_file offset=5\]$/,
    )
    expect(await readText(f, { offset: 9 })).toBe('line 9\nline 10')
    expect(await readText(f, { offset: 11 })).toContain(
      'past the end of the file, which has 10 lines',
    )
  })

  it('returns the first N lines with limit, normalizing CRLF', async () => {
    const f = await write('l.txt', 'a\r\nb\r\nc\r\nd\n')
    expect(await readText(f, { limit: 2 })).toMatch(
      /^a\nb\n\[\.\.\. showing lines 1-2/,
    )
    expect(await readText(f, { limit: 4 })).toBe('a\nb\nc\nd')
  })

  it('cuts a long file at a line boundary and says where to continue', async () => {
    const f = await write('long.txt', lines(5000).join('\n') + '\n')
    const text = await readText(f, { maxChars: 1000 })
    const note = text.match(
      /\[\.\.\. showing lines 1-(\d+); more lines follow\. Continue with read_file offset=(\d+)\]$/,
    )
    expect(note).not.toBeNull()
    expect(Number(note![2])).toBe(Number(note![1]) + 1)
    const body = text.slice(0, note!.index).trimEnd()
    expect(body.length).toBeLessThanOrEqual(1000)
    expect(body.split('\n')).toEqual(lines(Number(note![1])))
    // continuing from the note picks up at the next line
    expect(
      (await readText(f, { offset: Number(note![2]), limit: 1 })).split(
        '\n',
      )[0],
    ).toBe(`line ${note![2]}`)
  })

  it('cuts one line that is longer than the whole budget instead of skipping it', async () => {
    const f = await write('wide.txt', 'x'.repeat(5000) + '\nnext\n')
    const text = await readText(f, { maxChars: 100 })
    expect(text.startsWith('x'.repeat(100))).toBe(true)
    expect(text).toContain('line cut: it has 5000 characters')
    expect(text).toContain('Continue with read_file offset=2')
  })

  it('reads a file far past the old whole-file limit by the first part', async () => {
    const f = path.join(root, 'huge.txt')
    await fs.writeFile(f, 'a\n'.repeat(6 * 1024 * 1024))
    const text = await readText(f)
    expect(text.length).toBeLessThan(101_000)
    expect(text).toContain('more lines follow')
  })

  it('opens a file once and closes that handle, whichever way it reads', async () => {
    const f = await write('once.txt', lines(3000).join('\n') + '\n')
    const open = vi.spyOn(fs, 'open')
    try {
      await readText(f) // whole file (fits)
      await readText(f, { maxChars: 500 }) // streamed
      await tailFile(f, 5)
      expect(open).toHaveBeenCalledTimes(3)
    } finally {
      open.mockRestore()
    }
  })

  it('closes its file descriptor on an early exit', async () => {
    const f = await write('big.txt', 'x\n'.repeat(200_000))
    const open = async () => (await fs.readdir('/dev/fd')).length
    const before = await open()
    for (let i = 0; i < 30; i++) await readText(f, { limit: 1 })
    await sleep(100)
    expect(await open()).toBeLessThan(before + 5)
  })

  it('refuses a directory and a binary file with recognisable codes', async () => {
    await fs.mkdir(path.join(root, 'dir'))
    await expect(readText(path.join(root, 'dir'))).rejects.toMatchObject({
      code: 'EISDIR',
    })
    const bin = path.join(root, 'blob.bin')
    await fs.writeFile(bin, Buffer.from([0x68, 0x00, 0x69, 0x0a]))
    await expect(readText(bin)).rejects.toMatchObject({ code: 'EBINARY' })
    await expect(tailFile(bin, 1)).rejects.toMatchObject({ code: 'EBINARY' })
  })

  it('refuses text that is not valid UTF-8, such as Latin-1', async () => {
    const f = path.join(root, 'latin1.txt')
    await fs.writeFile(f, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])) // "café" in Latin-1
    await expect(readText(f)).rejects.toMatchObject({ code: 'EBINARY' })
  })

  it('accepts UTF-8 whose multi-byte character straddles the 8 KB sniff boundary', async () => {
    const f = path.join(root, 'edge.txt')
    await fs.writeFile(f, 'a'.repeat(8191) + 'é€' + 'b'.repeat(500) + '\n')
    const text = await readText(f, { maxChars: 100 })
    expect(text).toContain('a'.repeat(50))
    await expect(readText(f, { offset: 1, limit: 1 })).resolves.toContain('é€')
  })
})

describe('tailFile', () => {
  it('returns the last N lines, and nothing for 0', async () => {
    const f = path.join(root, 'l.txt')
    await fs.writeFile(f, 'a\r\nb\r\nc\r\nd\n')
    expect(await tailFile(f, 2)).toBe('c\nd')
    expect(await tailFile(f, 0)).toBe('')
    expect(await tailFile(f, 10)).toBe('a\nb\nc\nd')
  })

  it('tails across chunk boundaries, with multi-byte text and no final newline', async () => {
    const f = path.join(root, 'many.txt')
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} é€`)
    await fs.writeFile(f, lines.join('\n'))
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    await fs.writeFile(f, lines.join('\n') + '\n')
    expect(await tailFile(f, 3)).toBe(lines.slice(-3).join('\n'))
    expect(await tailFile(f, 50_000, 10_000_000)).toBe(lines.join('\n'))
  })

  it('caps a huge tail request at maxChars without reading the whole file', async () => {
    const f = path.join(root, 'tail-cap.txt')
    await fs.writeFile(f, 'some log line\n'.repeat(100_000))
    const text = await tailFile(f, 1_000_000, 500)
    expect(text).toContain('showing only the last 500 characters')
    expect(text.length).toBeLessThan(600)
    expect(text.endsWith('some log line')).toBe(true)
  })
})

describe('friendlyFsError', () => {
  it('names the path as the caller wrote it for common fs failures', () => {
    const shown = 'src/a.ts'
    const code = (c: string) => Object.assign(new Error(c), { code: c })
    expect(friendlyFsError(code('ENOENT'), shown).message).toBe(
      'File not found: src/a.ts',
    )
    expect(friendlyFsError(code('EISDIR'), shown).message).toBe(
      'src/a.ts is a directory, not a file',
    )
    expect(friendlyFsError(code('ENOTDIR'), shown).message).toContain(
      'not a directory',
    )
    expect(friendlyFsError(code('EACCES'), shown).message).toBe(
      'Permission denied: src/a.ts',
    )
    expect(friendlyFsError(code('EBINARY'), shown).message).toContain(
      'binary file',
    )
  })

  it('passes other errors through unchanged', () => {
    const error = new Error('Access denied - path outside allowed directories')
    expect(friendlyFsError(error, 'x')).toBe(error)
  })
})

describe('withFileLock', () => {
  it('runs calls with the same key one after another, in order', async () => {
    const events: string[] = []
    const task = (name: string, ms: number) =>
      withFileLock('k', async () => {
        events.push(`start ${name}`)
        await sleep(ms)
        events.push(`end ${name}`)
      })
    await Promise.all([task('a', 30), task('b', 1), task('c', 1)])
    expect(events).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ])
  })

  it('does not block other keys', async () => {
    const events: string[] = []
    await Promise.all([
      withFileLock('x', async () => {
        await sleep(40)
        events.push('x')
      }),
      withFileLock('y', async () => {
        events.push('y')
      }),
    ])
    expect(events).toEqual(['y', 'x'])
  })

  it('keeps going after a failure, and returns the failure to its own caller', async () => {
    const failing = withFileLock('k', async () => {
      throw new Error('boom')
    })
    const next = withFileLock('k', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ok')
  })

  it('keeps concurrent writers of one file from overwriting each other', async () => {
    const f = path.join(root, 'counter.txt')
    await fs.writeFile(f, '0')
    const bump = () =>
      withFileLock(f, async () => {
        const n = Number(await fs.readFile(f, 'utf-8'))
        await sleep(5)
        await writeFileContent(f, String(n + 1))
      })
    await Promise.all(Array.from({ length: 10 }, bump))
    expect(await fs.readFile(f, 'utf-8')).toBe('10')
  })
})

describe('listDirectory', () => {
  const make = async (...names: string[]) => {
    for (const name of names) {
      const target = path.join(root, name)
      if (name.endsWith('/')) await fs.mkdir(target, { recursive: true })
      else {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, 'x')
      }
    }
  }

  it('lists directories first, then files, each sorted, with / on directories', async () => {
    await make('b.txt', 'a.txt', 'zdir/', 'adir/')
    expect(await listDirectory(root, false)).toBe('adir/\nzdir/\na.txt\nb.txt')
  })

  it('says so when a directory is empty', async () => {
    expect(await listDirectory(root, false)).toBe('(empty)')
  })

  it('does not look inside subdirectories unless asked', async () => {
    await make('src/deep/file.ts', 'top.txt')
    expect(await listDirectory(root, false)).toBe('src/\ntop.txt')
  })

  it('lists subdirectories breadth first with names relative to the directory', async () => {
    await make('a/b/c.txt', 'a/x.txt', 'top.txt')
    expect(await listDirectory(root, true)).toBe(
      'a/\ntop.txt\na/b/\na/x.txt\na/b/c.txt',
    )
  })

  it('marks a symbolic link with @ and never follows it', async () => {
    await make('real/inside.txt')
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'))
    await fs.symlink(outside, path.join(root, 'out'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 's')
    const listing = await listDirectory(root, true)
    expect(listing).toContain('link@')
    expect(listing).toContain('out@')
    expect(listing).not.toContain('secret.txt')
    expect(listing).not.toContain('link/inside.txt')
  })

  it('lists node_modules and .git but does not enter them', async () => {
    await make('node_modules/pkg/index.js', '.git/HEAD', 'src/a.ts')
    const listing = await listDirectory(root, true)
    expect(listing).toContain('node_modules/')
    expect(listing).toContain('.git/')
    expect(listing).toContain('src/a.ts')
    expect(listing).not.toContain('pkg')
    expect(listing).not.toContain('HEAD')
  })

  it('stops at 1000 entries and says how to see more', async () => {
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) =>
        fs.writeFile(path.join(root, `f${String(i).padStart(4, '0')}.txt`), ''),
      ),
    )
    const lines = (await listDirectory(root, false)).split('\n')
    expect(lines).toHaveLength(1001)
    expect(lines[999]).toBe('f0999.txt')
    expect(lines[1000]).toContain('stopped after 1000 entries')
  })

  it('keeps the shallow entries when a recursive listing is cut', async () => {
    await make('a/', 'b/')
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        fs.writeFile(
          path.join(root, 'a', `f${String(i).padStart(4, '0')}`),
          '',
        ),
      ),
    )
    const lines = (await listDirectory(root, true)).split('\n')
    expect(lines.slice(0, 2)).toEqual(['a/', 'b/'])
    expect(lines.at(-1)).toContain('stopped after 1000 entries')
  })

  it.skipIf(process.getuid?.() === 0)(
    'notes a subdirectory it cannot read',
    async () => {
      await make('open/x.txt', 'locked/y.txt')
      await fs.chmod(path.join(root, 'locked'), 0)
      try {
        const listing = await listDirectory(root, true)
        expect(listing).toContain('open/x.txt')
        expect(listing).toContain('[some subdirectories could not be read]')
      } finally {
        await fs.chmod(path.join(root, 'locked'), 0o755)
      }
    },
  )

  it('gives up on a directory that never answers, and says so', async () => {
    vi.useFakeTimers()
    vi.spyOn(fs, 'readdir').mockReturnValue(new Promise(() => {}) as never)
    const outcome = listDirectory(root, false).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(FS_CALL_TIMEOUT_MS)
    expect(await outcome).toContain('timed out after 15000 ms: readdir')
  })

  it('ends a recursive listing with the timeout when a subdirectory stalls', async () => {
    await make('a/x.txt')
    const real = fs.readdir.bind(fs)
    vi.useFakeTimers()
    vi.spyOn(fs, 'readdir').mockImplementation(((
      target: string,
      ...rest: never[]
    ) =>
      target.endsWith('a')
        ? new Promise(() => {})
        : real(target, ...rest)) as never)
    const outcome = listDirectory(root, true).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(FS_CALL_TIMEOUT_MS)
    expect(await outcome).toContain('readdir')
  })

  it('names a file given instead of a directory, and a missing directory', async () => {
    await make('f.txt')
    const asFile = await listDirectory(path.join(root, 'f.txt'), false).catch(
      (error: unknown) => friendlyFsError(error, 'f.txt').message,
    )
    expect(asFile).toBe(
      'f.txt is a file, not a directory; read it with read_file',
    )
    const missing = await listDirectory(path.join(root, 'nope'), false).catch(
      (error: unknown) => friendlyFsError(error, 'nope').message,
    )
    expect(missing).toBe('File not found: nope')
  })
})
