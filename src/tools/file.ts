// Adapted from modelcontextprotocol/servers (src/filesystem); see THIRD_PARTY_NOTICES.md.
import { z } from 'zod'
import { applyFileEdits, fileEditSchema } from '../edit.js'
import {
  MAX_MULTI_READ_CHARS,
  friendlyFsError,
  listDirectory,
  searchFiles,
  readText,
  tailFile,
  withFileLock,
  writeFileContent,
} from '../files.js'
import { validatePath } from '../paths.js'
import { READ_ANNOTATIONS, text, type RegisterTool } from './common.js'

const MAX_READ_PATHS = 50

// Annotations for write operations (write_file and edit_file).
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
}

/** Run `fn`, naming `shown` (the path as the client wrote it) in any fs error. */
async function guard<T>(shown: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyFsError(error, shown)
  }
}

/** Format file result with prefix. */
function formatFileResult(filePath: string, content: string): string {
  return `${filePath}:\n${content}\n`
}

/** Format file error message. */
function formatFileError(filePath: string, message: string): string {
  return `${filePath}: Error - ${message}`
}

/** Format skipped file message (size limit reached). */
function formatFileSkipped(filePath: string): string {
  return `${filePath}: Skipped - the size limit for this call was reached; read it with read_file`
}

export function registerFileTools(
  registerTool: RegisterTool,
  allowedDirs: readonly string[] | null,
  { explore }: { explore: boolean },
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
        'Read a text file. Output is capped at about 100,000 characters; a longer ' +
        'file ends with the offset to continue from. Use offset and limit for a ' +
        'range of lines, head for the first N lines or tail for the last N (use ' +
        'only one of the three).' +
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
          .describe('Return only the first N lines.'),
        tail: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Return only the last N lines.'),
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
        'Read several files at once, each returned under its path; a failed read ' +
        'does not stop the others. Output is capped at about 200,000 characters ' +
        'in total: a file that does not fit is cut, with the offset to continue ' +
        'from with read_file.' +
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
          results.push(formatFileSkipped(filePath))
          continue
        }
        try {
          const file = await validatePath(filePath, allowedDirs)
          const content = await guard(filePath, () =>
            readText(file, { maxChars: remaining }),
          )
          remaining -= content.length
          results.push(formatFileResult(filePath, content))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          results.push(formatFileError(filePath, message))
        }
      }
      return text(results.join('\n---\n'))
    },
  )

  if (explore) {
    registerTool(
      'list_directory',
      {
        title: 'List Directory',
        description:
          'List a directory, one entry per line: directories (first) end in / and ' +
          'symbolic links in @. recursive includes subdirectories, with names ' +
          'relative to the directory; .git and node_modules are listed but not ' +
          'entered. At most 1000 entries; the result says when it stopped, so ' +
          'list a subdirectory for the rest.' +
          onlyWithin,
        inputSchema: z.strictObject({
          path: pathParam,
          recursive: z
            .boolean()
            .optional()
            .describe('Also list subdirectories (default false).'),
        }),
        annotations: READ_ANNOTATIONS,
      },
      async (args) => {
        const dir = await validatePath(args.path, allowedDirs)
        return text(
          await guard(args.path, () =>
            listDirectory(dir, args.recursive ?? false),
          ),
        )
      },
    )

    registerTool(
      'search_files',
      {
        title: 'Search Files',
        description:
          'Find files and directories by NAME, never by content. Matches a glob ' +
          "against each entry's path relative to `path` (case-sensitive, dot files " +
          "included): '*.ts' directly under `path`, '**/*.ts' at any depth. " +
          'Returns matching paths relative to `path`, one per line, directories ' +
          'ending in /. .git and node_modules are not entered (a directory with ' +
          'that name can still match). At most 1000 matches; the result says ' +
          'when it stopped.' +
          onlyWithin,
        inputSchema: z.strictObject({
          path: pathParam,
          pattern: z
            .string()
            .min(1)
            .max(500)
            .describe(
              "Glob for the entry's path relative to path, for example '**/*.ts' or '**/name'.",
            ),
          excludePatterns: z
            .array(z.string().min(1).max(500))
            .max(20)
            .optional()
            .describe(
              "Entries to skip, with their contents. Without '*', a name matched at any depth ('dist'); with '*', a glob matched as written, and one ending in '/**' also skips the directory itself.",
            ),
        }),
        annotations: READ_ANNOTATIONS,
      },
      async (args) => {
        const dir = await validatePath(args.path, allowedDirs)
        return text(
          await guard(args.path, () =>
            searchFiles(dir, args.pattern, args.excludePatterns),
          ),
        )
      },
    )
  }

  registerTool(
    'write_file',
    {
      title: 'Write File',
      description:
        'Create a file or completely overwrite one, creating missing parent ' +
        'directories. Overwrites without warning; to change part of a file use ' +
        'edit_file.' +
        onlyWithin,
      inputSchema: z.strictObject({
        path: pathParam,
        content: z
          .string()
          .describe('The complete new contents of the file, written as given.'),
      }),
      annotations: {
        ...WRITE_TOOL_ANNOTATIONS,
        idempotentHint: true,
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
        'Make line-based edits to a text file, applied in order: each replaces ' +
        'oldText with newText. oldText must match exactly one place (add ' +
        'surrounding lines to make it unique) unless replaceAll is set. When ' +
        'there is no exact match, line endings and leading/trailing whitespace ' +
        'on whole lines are ignored. If any edit has no match or an ambiguous ' +
        'one, nothing is written. Returns a git-style diff.' +
        onlyWithin,
      inputSchema: z.strictObject({
        path: pathParam,
        edits: z
          .array(fileEditSchema)
          .min(1)
          .describe('The replacements, applied in order.'),
        dryRun: z
          .boolean()
          .default(false)
          .describe('Preview changes using git-style diff format'),
      }),
      annotations: {
        ...WRITE_TOOL_ANNOTATIONS,
        idempotentHint: false,
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
