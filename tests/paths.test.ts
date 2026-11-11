import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FS_CALL_TIMEOUT_MS,
  validatePath,
  withFsTimeout,
} from '../src/paths.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string
let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(() => removeTempDirs(root, outside))

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
  })

  it('rejects a symlink that points outside', async () => {
    await fs.writeFile(path.join(outside, 's'), 'secret')
    await fs.symlink(path.join(outside, 's'), path.join(root, 'link'))
    await expect(validatePath(path.join(root, 'link'), [root])).rejects.toThrow(
      'symlink target',
    )
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

  it('accepts a filesystem root as an allowed directory', async () => {
    expect(
      await validatePath(path.join(root, 'x'), [path.parse(root).root]),
    ).toBe(path.join(root, 'x'))
  })

  it('accepts a path several levels below the last existing directory', async () => {
    expect(
      await validatePath(path.join(root, 'no/such/dir/f.txt'), [root]),
    ).toBe(path.join(root, 'no/such/dir/f.txt'))
  })

  it('resolves the existing part of a new path through symlinks', async () => {
    await fs.mkdir(path.join(root, 'real'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'))
    expect(
      await validatePath(path.join(root, 'alias', 'a', 'b.txt'), [root]),
    ).toBe(path.join(root, 'real', 'a', 'b.txt'))
  })

  it('refuses a deep new path under a symlink that leaves', async () => {
    await fs.symlink(outside, path.join(root, 'out'))
    await expect(
      validatePath(path.join(root, 'out', 'a', 'b', 'c.txt'), [root]),
    ).rejects.toThrow('Access denied')
  })

  it('names a broken symlink in the middle of a path', async () => {
    await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'))
    await expect(
      validatePath(path.join(root, 'broken', 'sub', 'f.txt'), [root]),
    ).rejects.toThrow('Broken symlink')
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

describe('filesystem call timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('rejects a call that never settles, naming the operation and path', async () => {
    await expect(
      withFsTimeout(new Promise(() => {}), 'realpath', '/cloud/x', 20),
    ).rejects.toThrow(
      /timed out after 20 ms: realpath \/cloud\/x.*cloud-storage/,
    )
  })

  it('passes through a value, and a rejection, that arrives in time', async () => {
    expect(await withFsTimeout(Promise.resolve('ok'), 'stat', '/x', 1000)).toBe(
      'ok',
    )
    await expect(
      withFsTimeout(Promise.reject(new Error('boom')), 'stat', '/x', 1000),
    ).rejects.toThrow('boom')
  })

  it('leaves no timer behind once the call settles', async () => {
    vi.useFakeTimers()
    await withFsTimeout(Promise.resolve(1), 'stat', '/x', 1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes validatePath fail with a timeout when realpath hangs', async () => {
    vi.useFakeTimers()
    vi.spyOn(fs, 'realpath').mockReturnValue(new Promise(() => {}) as never)
    const outcome = validatePath(path.join(root, 'stuck.txt'), [root]).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(FS_CALL_TIMEOUT_MS)
    expect(await outcome).toContain('timed out after 15000 ms: realpath')
  })
})

describe('without allowed directories', () => {
  it('accepts any path, resolved through symlinks', async () => {
    await fs.writeFile(path.join(outside, 's'), 'secret')
    await fs.symlink(path.join(outside, 's'), path.join(root, 'link'))
    expect(await validatePath(path.join(root, 'link'), null)).toBe(
      path.join(outside, 's'),
    )
    expect(
      await validatePath(path.join(outside, 'new', 'deep.txt'), null),
    ).toBe(path.join(outside, 'new', 'deep.txt'))
  })

  it('resolves a relative path against the working directory', async () => {
    expect(await validatePath('package.json', null)).toBe(
      path.join(await fs.realpath(process.cwd()), 'package.json'),
    )
  })

  it('still refuses a NUL byte and names a broken symlink', async () => {
    await expect(validatePath(path.join(root, 'a\0b'), null)).rejects.toThrow(
      'Access denied',
    )
    await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'))
    await expect(validatePath(path.join(root, 'broken'), null)).rejects.toThrow(
      'Broken symlink',
    )
  })

  it('treats an empty list as "nothing allowed", not as "no restriction"', async () => {
    await expect(validatePath(path.join(root, 'x'), [])).rejects.toThrow(
      'Access denied',
    )
  })
})
