#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import {
  applyFileEdits,
  headFile,
  readFileContent,
  tailFile,
  validatePath,
  writeFileContent,
} from './lib.js'

const text = (content: string) => ({
  content: [{ type: 'text' as const, text: content }],
  structuredContent: { content },
})

const outputSchema = z.object({ content: z.string() })

export function createServer(allowedDirs: readonly string[]): McpServer {
  const server = new McpServer({ name: 'fs-mcp-server', version: '0.1.0' })

  server.registerTool(
    'read_text_file',
    {
      title: 'Read Text File',
      description:
        'Read the complete contents of a file as text. Use the head parameter ' +
        'to read only the first N lines, or the tail parameter to read only ' +
        'the last N lines. Only works within allowed directories.',
      inputSchema: z.object({
        path: z.string(),
        tail: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('If provided, returns only the last N lines of the file'),
        head: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('If provided, returns only the first N lines of the file'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      if (args.head !== undefined && args.tail !== undefined) {
        throw new Error(
          'Cannot specify both head and tail parameters simultaneously',
        )
      }
      const file = await validatePath(args.path, allowedDirs)
      return text(
        args.tail !== undefined
          ? await tailFile(file, args.tail)
          : args.head !== undefined
            ? await headFile(file, args.head)
            : await readFileContent(file),
      )
    },
  )

  server.registerTool(
    'read_multiple_files',
    {
      title: 'Read Multiple Files',
      description:
        "Read the contents of multiple files simultaneously. Each file's " +
        'content is returned with its path as a reference. A failed read of ' +
        'one file does not stop the others. Only works within allowed directories.',
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .min(1)
          .describe('Paths of the files to read.'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const results = await Promise.all(
        args.paths.map(async (filePath) => {
          try {
            const file = await validatePath(filePath, allowedDirs)
            return `${filePath}:\n${await readFileContent(file)}\n`
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)
            return `${filePath}: Error - ${message}`
          }
        }),
      )
      return text(results.join('\n---\n'))
    },
  )

  server.registerTool(
    'write_file',
    {
      title: 'Write File',
      description:
        'Create a new file or completely overwrite an existing file. ' +
        'Overwrites without warning. Only works within allowed directories.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const file = await validatePath(args.path, allowedDirs)
      await writeFileContent(file, args.content)
      return text(`Successfully wrote to ${args.path}`)
    },
  )

  server.registerTool(
    'edit_file',
    {
      title: 'Edit File',
      description:
        'Make line-based edits to a text file. Edits apply in order, each ' +
        'replacing the first match of oldText with newText. oldText must match ' +
        'exactly, except that line endings and leading/trailing whitespace on ' +
        'whole lines are ignored when there is no exact match. If any edit has ' +
        'no match, nothing is written. Returns a git-style diff. Only works ' +
        'within allowed directories.',
      inputSchema: z.object({
        path: z.string(),
        edits: z.array(
          z.object({
            oldText: z
              .string()
              .describe('Text to search for - must match exactly'),
            newText: z.string().describe('Text to replace with'),
          }),
        ),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Preview changes using git-style diff format'),
      }),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const file = await validatePath(args.path, allowedDirs)
      return text(await applyFileEdits(file, args.edits, args.dryRun))
    },
  )

  return server
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

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error(
      'Usage: fs-mcp-server <allowed-directory> [additional-directories...]',
    )
    process.exit(1)
  }
  const allowedDirs = await resolveAllowedDirectories(args)
  if (allowedDirs.length === 0) {
    console.error('Error: none of the specified directories are accessible')
    process.exit(1)
  }
  serveStdio(() => createServer(allowedDirs), {
    onerror: (error) => {
      console.error('Transport error:', error)
      process.exitCode = 1
    },
  })
  console.error(
    `FS MCP Server running on stdio. Allowed: ${allowedDirs.join(', ')}`,
  )
}

main().catch((error) => {
  console.error('Fatal error running server:', error)
  process.exit(1)
})
