import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_READ_BYTES,
  headFile,
  readFileContent,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../src/files.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string
let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(() => removeTempDirs(root, outside))

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

  it('head closes its file descriptor on an early exit', async () => {
    const f = path.join(root, 'big.txt')
    await fs.writeFile(f, 'x\n'.repeat(200_000))
    const open = async () => (await fs.readdir('/dev/fd')).length
    const before = await open()
    for (let i = 0; i < 30; i++) await headFile(f, 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await open()).toBeLessThan(before + 5)
  })
})

describe('read limits and tail', () => {
  it('refuses a whole-file read over the limit but still serves head and tail', async () => {
    const f = path.join(root, 'huge.txt')
    await fs.writeFile(f, 'a\n'.repeat(MAX_READ_BYTES / 2 + 1))
    await expect(readFileContent(f)).rejects.toThrow('head or tail')
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
})

describe('read budget', () => {
  it('refuses a file over a smaller maxBytes and says how to read part of it', async () => {
    const f = path.join(root, 'budget.txt')
    await fs.writeFile(f, 'x'.repeat(100))
    expect(await readFileContent(f, 100)).toHaveLength(100)
    await expect(readFileContent(f, 99)).rejects.toThrow('head or tail')
  })
})

describe('withFileLock', () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms))

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
