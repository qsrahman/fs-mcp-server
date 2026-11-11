import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePath } from '../src/paths.js'
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
