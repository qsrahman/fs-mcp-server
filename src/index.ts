#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs as parseNodeArgs } from 'node:util'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server.js'

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
  // mistyped --read-only must not start the server writable. `--` still ends
  // the options, so a directory that starts with -- can follow it.
  const { values, positionals } = parseNodeArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      'read-only': { type: 'boolean', default: false },
      'enable-shell': { type: 'boolean', default: false },
    },
  })
  return {
    directories: positionals,
    readOnly: values['read-only'],
    enableShell: values['enable-shell'],
  }
}

const USAGE =
  'Usage: fs-mcp-server [--read-only] [--enable-shell] <allowed-directory> [additional-directories...]'

async function main() {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`)
    process.exit(1)
  }
  const { directories, readOnly, enableShell } = parsed
  if (directories.length === 0) {
    console.error(USAGE)
    process.exit(1)
  }
  const allowedDirs = await resolveAllowedDirectories(directories)
  if (allowedDirs.length === 0) {
    console.error('Error: none of the specified directories are accessible')
    process.exit(1)
  }
  serveStdio(() => createServer(allowedDirs, { readOnly, enableShell }), {
    onerror: (error) => {
      console.error('Transport error:', error)
      process.exitCode = 1
    },
  })
  console.error(
    `FS MCP Server running on stdio${readOnly ? ' (read-only)' : ''}${enableShell ? ' (shell enabled)' : ''}. Allowed: ${allowedDirs.join(', ')}`,
  )
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
