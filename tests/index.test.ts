import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseArgs, resolveConfig } from '../src/index.js'
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

describe('parseArgs', () => {
  it('takes plain arguments as directories', () => {
    expect(parseArgs(['/a', '/b'])).toEqual({
      directories: ['/a', '/b'],
      readOnly: false,
      shell: true,
      fetch: { allowPrivateIps: false, ignoreRobotsTxt: false },
    })
  })

  it('allows no directories at all, which means no restriction', () => {
    expect(parseArgs([])).toEqual({
      directories: [],
      readOnly: false,
      shell: true,
      fetch: { allowPrivateIps: false, ignoreRobotsTxt: false },
    })
  })

  it('accepts --read-only anywhere', () => {
    expect(parseArgs(['--read-only', '/a']).readOnly).toBe(true)
    expect(parseArgs(['/a', '--read-only', '/b'])).toEqual({
      directories: ['/a', '/b'],
      readOnly: true,
      shell: true,
      fetch: { allowPrivateIps: false, ignoreRobotsTxt: false },
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
      fetch: { allowPrivateIps: false, ignoreRobotsTxt: false },
    })
  })
})

describe('fetch options', () => {
  it('turns fetching off with --no-fetch', () => {
    expect(parseArgs(['--no-fetch']).fetch).toBe(false)
    expect(parseArgs(['--no-fetch', '/a']).directories).toEqual(['/a'])
  })

  it('reads the network policy flags', () => {
    expect(
      parseArgs(['--allow-private-ips', '--ignore-robots-txt']).fetch,
    ).toEqual({
      allowPrivateIps: true,
      ignoreRobotsTxt: true,
    })
  })

  it('reads --allowed-hosts as a comma separated list, repeated or not, and normalizes it', () => {
    const hosts = (...args: string[]) =>
      (parseArgs(args).fetch as { allowedHosts?: string[] }).allowedHosts
    expect(hosts('--allowed-hosts', 'Example.com,*.docs.example.org')).toEqual([
      'example.com',
      '*.docs.example.org',
    ])
    expect(
      hosts('--allowed-hosts', 'a.test', '--allowed-hosts', 'b.test'),
    ).toEqual(['a.test', 'b.test'])
    expect(hosts()).toBeUndefined()
  })

  it('rejects an allowed host that is not a host, rather than ignoring it', () => {
    expect(() => parseArgs(['--allowed-hosts', 'https://example.com'])).toThrow(
      'not a host name',
    )
    expect(() => parseArgs(['--allowed-hosts', 'example.com:8080'])).toThrow(
      'not a host name',
    )
  })

  it('does not take a directory for the value of a flag without one', () => {
    expect(parseArgs(['--allow-private-ips', '/a']).directories).toEqual(['/a'])
  })
})
