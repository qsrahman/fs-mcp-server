import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/index.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

describe('resolveConfig', () => {
  let root: string
  let outside: string

  beforeAll(async () => {
    ;({ root, outside } = await makeTempDirs())
  })
  afterAll(() => removeTempDirs(root, outside))

  it('restricts nothing when no directory is given', async () => {
    expect((await resolveConfig([], {})).allowedDirs).toBeNull()
  })

  it('allows a given directory', async () => {
    const { allowedDirs } = await resolveConfig([root], {})
    expect(allowedDirs).toContain(root)
  })

  it('keeps both spellings of a directory reached through a symlink', async () => {
    const link = path.join(outside, 'link')
    await fs.symlink(root, link)
    const { allowedDirs } = await resolveConfig([link], {})
    expect(allowedDirs).toEqual([link, root])
  })

  it('throws rather than fall back to unrestricted when no directory is usable', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        resolveConfig([path.join(root, 'missing')], {}),
      ).rejects.toThrow('none of the specified directories are accessible')
      // a file is not a directory either
      const file = path.join(root, 'file.txt')
      await fs.writeFile(file, 'x')
      await expect(resolveConfig([file], {})).rejects.toThrow('accessible')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a usable directory when another one is not', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { allowedDirs } = await resolveConfig(
        [path.join(root, 'missing'), root],
        {},
      )
      expect(allowedDirs).toEqual([root])
    } finally {
      warn.mockRestore()
    }
  })

  it('throws on an unknown option', async () => {
    await expect(resolveConfig(['--readonly'], {})).rejects.toThrow(
      'Unknown option',
    )
  })

  it('turns web search on only when BRAVE_API_KEY is set and not blank', async () => {
    expect((await resolveConfig([], {})).brave).toBeUndefined()
    expect((await resolveConfig([], { BRAVE_API_KEY: '  ' })).brave).toBe(
      undefined,
    )
    expect((await resolveConfig([], { BRAVE_API_KEY: ' key ' })).brave).toEqual(
      { apiKey: 'key' },
    )
  })

  it('passes the access switches through', async () => {
    expect(
      await resolveConfig(['--read-only', '--no-shell', '--no-fetch'], {}),
    ).toMatchObject({ readOnly: true, shell: false, fetch: false })
  })
})
