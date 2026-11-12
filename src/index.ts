#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { normalizeAllowedHost } from './net.js'
import { createServer } from './server.js'

function parseAllowedHosts(hostLists: string[]): string[] | undefined {
  const normalized = hostLists
    .flatMap((list) => list.split(','))
    .filter((entry) => entry.trim() !== '')
    .map(normalizeAllowedHost)
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Keeps both the given and the realpath'd spelling (e.g. macOS /var and
 * /private/var), so a path under either is accepted; validatePath still
 * resolves every request to its real path before using it.
 */
async function resolveAllowedDirectories(args: string[]): Promise<string[]> {
  const dirs: string[] = []
  for (const arg of args) {
    try {
      const real = await fs.realpath(path.resolve(arg))
      if ((await fs.stat(real)).isDirectory())
        dirs.push(...new Set([path.resolve(arg), real]))
      else console.error(`Warning: ${arg} is not a directory, skipping`)
    } catch {
      console.error(`Warning: cannot access directory ${arg}, skipping`)
    }
  }
  return dirs
}

export function parseArgs(args: string[]) {
  // strict makes an unknown option throw instead of becoming a directory: a
  // mistyped --read-only or --no-shell must not start the server with more
  // access than asked for. `--` still ends the options, so a directory that
  // starts with -- can follow it.
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      'read-only': { type: 'boolean', default: false },
      'no-shell': { type: 'boolean', default: false },
      'no-fetch': { type: 'boolean', default: false },
      'allow-private-ips': { type: 'boolean', default: false },
      'ignore-robots-txt': { type: 'boolean', default: false },
      'allowed-hosts': { type: 'string', multiple: true },
    },
  })
  const allowedHosts = parseAllowedHosts(values['allowed-hosts'] ?? [])
  return {
    directories: positionals,
    readOnly: values['read-only'],
    shell: !values['no-shell'],
    fetch: values['no-fetch']
      ? (false as const)
      : {
          allowPrivateIps: values['allow-private-ips'],
          ignoreRobotsTxt: values['ignore-robots-txt'],
          allowedHosts,
        },
  }
}

const USAGE =
  'Usage: workshop-mcp [--read-only] [--no-shell] [--no-fetch] [--allow-private-ips]\n' +
  '                     [--ignore-robots-txt] [--allowed-hosts a.com,*.b.org] [allowed-directory...]\n' +
  'With no directories, file access is not restricted to any.'

/**
 * Everything the server is started with, from the command line and the
 * environment. Throws, with a message fit to print, when the arguments are
 * unusable; `main` turns that into exit code 1.
 */
export async function resolveConfig(argv: string[], env: NodeJS.ProcessEnv) {
  const { directories, readOnly, shell, fetch } = parseArgs(argv)

  // No directories means no restriction. Directories that were given but could
  // not be used must never turn into "no restriction", so that case throws.
  let allowedDirs: string[] | null = null
  if (directories.length > 0) {
    allowedDirs = await resolveAllowedDirectories(directories)
    if (allowedDirs.length === 0) {
      throw new Error('Error: none of the specified directories are accessible')
    }
  }

  // The key comes from the environment, not an option, so it never shows up in
  // a process listing. Without one, the web search tools are not offered.
  const apiKey = env.BRAVE_API_KEY?.trim()
  const brave = apiKey ? { apiKey } : undefined
  return { allowedDirs, readOnly, shell, fetch, brave }
}

function buildStatusMessage(
  readOnly: boolean,
  shell: boolean,
  fetch:
    | boolean
    | {
        allowPrivateIps: boolean
        ignoreRobotsTxt: boolean
        allowedHosts?: string[]
      },
  brave: { apiKey: string } | undefined,
  allowedDirs: string[] | null,
): string {
  const mode = readOnly ? ' (read-only)' : shell ? '' : ' (shell disabled)'
  const fetchStatus = fetch ? '' : ' (fetch disabled)'
  const braveStatus = brave ? ' (web search on)' : ''
  const dirStatus = allowedDirs
    ? `Allowed: ${allowedDirs.join(', ')}`
    : 'File access is not restricted.'
  return `workshop-mcp running on stdio${mode}${fetchStatus}${braveStatus}. ${dirStatus}`
}

async function main() {
  let config: Awaited<ReturnType<typeof resolveConfig>>
  try {
    config = await resolveConfig(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`)
    process.exit(1)
  }
  const { allowedDirs, readOnly, shell, fetch, brave } = config

  serveStdio(
    () => createServer(allowedDirs, { readOnly, shell, brave, fetch }),
    {
      onerror: (error) => {
        console.error('Transport error:', error)
        process.exitCode = 1
      },
    },
  )
  console.error(buildStatusMessage(readOnly, shell, fetch, brave, allowedDirs))
}

// Run only as the entry point (npm links the bin via a symlink, hence realpath),
// so importing this module, as the tests do, starts nothing.
const entry = process.argv[1]
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Fatal error running server:', error)
    process.exit(1)
  })
}
