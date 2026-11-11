import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { makeTempDirs, removeTempDirs } from './helpers.js'

// These run the built package as a separate process, the way an MCP client
// does, so they need `pnpm build` first (`pnpm validate` does it).
const entry = path.resolve('dist/index.js')

describe('the built server process', () => {
  let root: string
  let outside: string
  let bin: string

  beforeAll(async () => {
    if (!existsSync(entry)) {
      throw new Error(`${entry} is missing: run pnpm build before pnpm test`)
    }
    ;({ root, outside } = await makeTempDirs())
    await fs.writeFile(path.join(root, 'note.txt'), 'hello from a file')
    // npm starts a package's bin through a symlink; the entry-point check in
    // index.ts has to see through it, or the server silently never starts.
    bin = path.join(outside, 'workshop-mcp')
    await fs.symlink(entry, bin)
  })
  afterAll(() => removeTempDirs(root, outside))

  async function withClient<T>(
    program: string,
    args: string[],
    use: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ name: 'cli-test', version: '0.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [program, ...args],
        stderr: 'ignore',
      }),
    )
    try {
      return await use(client)
    } finally {
      await client.close()
    }
  }

  const toolNames = async (client: Client) =>
    (await client.listTools()).tools.map((tool) => tool.name).sort()

  it('starts through a symlink, lists its tools and reads a file', async () => {
    await withClient(bin, [root], async (client) => {
      expect(await toolNames(client)).toEqual([
        'edit_file',
        'fetch_url',
        'read_file',
        'read_multiple_files',
        'shell',
        'write_file',
      ])
      const result = await client.callTool({
        name: 'read_file',
        arguments: { path: path.join(root, 'note.txt') },
      })
      expect((result.content as Array<{ text: string }>)[0].text).toBe(
        'hello from a file',
      )
    })
  })

  it('applies --read-only and --no-fetch from the command line', async () => {
    await withClient(entry, ['--read-only', '--no-fetch', root], async (c) => {
      expect(await toolNames(c)).toEqual(['read_file', 'read_multiple_files'])
    })
  })

  it('refuses a path outside the directory it was started with', async () => {
    await withClient(entry, [root], async (client) => {
      const result = await client.callTool({
        name: 'read_file',
        arguments: { path: path.join(outside, 'workshop-mcp') },
      })
      expect(result.isError).toBe(true)
    })
  })

  const exits = (args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf-8',
      timeout: 15_000,
    })

  it('exits with status 1 and the usage for an unknown option', () => {
    const run = exits(['--readonly'])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('Unknown option')
    expect(run.stderr).toContain('Usage: workshop-mcp')
  })

  it('exits with status 1 rather than run unrestricted when no directory is usable', () => {
    const run = exits([path.join(outside, 'missing')])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('none of the specified directories')
  })
})
