// Adapted from modelcontextprotocol/servers (src/filesystem); see THIRD_PARTY_NOTICES.md.
import { z } from 'zod'
import { applyFileEdits, fileEditSchema } from '../edit.js'
import {
  MAX_MULTI_READ_CHARS,
  friendlyFsError,
  readText,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../files.js'
import { validatePath } from '../paths.js'
import { READ_ANNOTATIONS, text, type RegisterTool } from './common.js'

const MAX_READ_PATHS = 50

/** Run `fn`, naming `shown` (the path as the client wrote it) in any fs error. */
async function guard<T>(shown: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyFsError(error, shown)
  }
}

export function registerFileTools(
  registerTool: RegisterTool,
  allowedDirs: readonly string[] | null,
) {
  const pathParam = z
    .string()
    .describe(
      allowedDirs
        ? 'Absolute path, or relative to the first allowed directory.'
        : "Absolute path, or relative to the server's working directory.",
    )
  const onlyWithin = allowedDirs
    ? ' Only works within allowed directories.'
    : ''

  registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        'Read a text file. Output is capped at about 100,000 characters; when a ' +
        'file is longer the result ends with the offset to continue from. Use ' +
        'offset and limit to read a range of lines, head for the first N lines, ' +
        'or tail for the last N lines (use only one of the three).' +
        onlyWithin,
      inputSchema: z.strictObject({
        path: pathParam,
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Line number to start reading from (1-based).'),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Most lines to return, counting from offset.'),
        head: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('If provided, returns only the first N lines of the file'),
        tail: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('If provided, returns only the last N lines of the file'),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async (args) => {
      const ranged = args.offset !== undefined || args.limit !== undefined
      if (
        [ranged, args.head !== undefined, args.tail !== undefined].filter(
          Boolean,
        ).length > 1
      ) {
        throw new Error(
          'Use only one of head, tail, or offset/limit, not a combination',
        )
      }
      const file = await validatePath(args.path, allowedDirs)
      return text(
        await guard(args.path, () =>
          args.tail !== undefined
            ? tailFile(file, args.tail)
            : readText(file, {
                offset: args.offset,
                limit: args.head ?? args.limit,
              }),
        ),
      )
    },
  )

  registerTool(
    'read_multiple_files',
    {
      title: 'Read Multiple Files',
      description:
        "Read the contents of multiple files simultaneously. Each file's " +
        'content is returned with its path as a reference. A failed read of ' +
        'one file does not stop the others. Output is capped at about 200,000 ' +
        'characters in total; a file that does not fit is cut, with the offset ' +
        'to continue from with read_file.' +
        onlyWithin,
      inputSchema: z.strictObject({
        paths: z
          .array(z.string())
          .min(1)
          .max(MAX_READ_PATHS)
          .describe('Paths of the files to read.'),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async (args) => {
      // One at a time, against a shared character budget, so the response and
      // the memory held while building it stay bounded.
      let remaining = MAX_MULTI_READ_CHARS
      const results: string[] = []
      for (const filePath of args.paths) {
        if (remaining <= 0) {
          results.push(
            `${filePath}: Skipped - the size limit for this call was reached; read it with read_file`,
          )
          continue
        }
        try {
          const file = await validatePath(filePath, allowedDirs)
          const content = await guard(filePath, () =>
            readText(file, { maxChars: remaining }),
          )
          remaining -= content.length
          results.push(`${filePath}:\n${content}\n`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results.push(`${filePath}: Error - ${message}`)
        }
      }
      return text(results.join('\n---\n'))
    },
  )

  registerTool(
    'write_file',
    {
      title: 'Write File',
      description:
        'Create a new file or completely overwrite an existing file, creating ' +
        'any missing parent directories. Overwrites without warning; to change ' +
        'part of an existing file use edit_file.' +
        onlyWithin,
      inputSchema: z.strictObject({
        path: pathParam,
        content: z
          .string()
          .describe('The complete new contents of the file, written as given.'),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const file = await validatePath(args.path, allowedDirs)
      await guard(args.path, () =>
        withFileLock(file, () => writeFileContent(file, args.content)),
      )
      return text(`Successfully wrote to ${args.path}`)
    },
  )

  registerTool(
    'edit_file',
    {
      title: 'Edit File',
      description:
        'Make line-based edits to a text file. Edits apply in order, each ' +
        'replacing oldText with newText. oldText must match exactly one place ' +
        '(include enough surrounding lines to be unique), or set replaceAll to ' +
        'replace every match. Line endings and leading/trailing whitespace on ' +
        'whole lines are ignored when there is no exact match. If any edit has ' +
        'no match or an ambiguous one, nothing is written. Returns a git-style ' +
        'diff.' +
        onlyWithin,
      inputSchema: z.strictObject({
        path: pathParam,
        edits: z
          .array(fileEditSchema)
          .min(1)
          .describe(
            'The replacements to make, applied in order. Each oldText must match exactly one place unless replaceAll is set.',
          ),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Preview changes using git-style diff format'),
      }),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const file = await validatePath(args.path, allowedDirs)
      return text(
        await guard(args.path, () =>
          withFileLock(file, () =>
            applyFileEdits(file, args.edits, args.dryRun, args.path),
          ),
        ),
      )
    },
  )
}
