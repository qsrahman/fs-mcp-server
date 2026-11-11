import { readFileSync, realpathSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { applyFileEdits, fileEditSchema } from './edit.js'
import {
  MAX_MULTI_READ_CHARS,
  friendlyFsError,
  readText,
  tailFile,
  withFileLock,
  writeFileContent,
} from './files.js'
import { validatePath } from './paths.js'
import { DEFAULT_TIMEOUT_MS, runShell } from './shell.js'

// package.json sits one level above both src/ and dist/.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { version: string }

const text = (content: string) => ({
  content: [{ type: 'text' as const, text: content }],
})

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

const MAX_READ_PATHS = 50

// The SDK rejects a call whose arguments hold more array elements and object
// members than this, before any handler runs. Strings do not count, so file
// contents are unaffected. An edit is about three of these, so this allows
// roughly 1,600 edits in one call, far more than a model sends.
export const MAX_TOOL_INPUT_ELEMENTS = 5_000

const pathParam = z
  .string()
  .describe('Absolute path, or relative to the first allowed directory.')

/** Run `fn`, naming `shown` (the path as the client wrote it) in any fs error. */
async function guard<T>(shown: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw friendlyFsError(error, shown)
  }
}

/** What the client reads once, at initialize, before its first tool call. */
function serverInstructions(
  allowedDirs: readonly string[],
  readOnly: boolean,
  enableShell: boolean,
): string {
  // The allowed list holds a directory under both spellings (as given and
  // realpath'd); show each directory once.
  const real = (dir: string) => {
    try {
      return realpathSync(dir)
    } catch {
      return dir
    }
  }
  const dirs = [...new Set(allowedDirs.map(real))]
  return [
    `File access is limited to: ${dirs.join(', ')}. Relative paths resolve against ${dirs[0]}.`,
    '- Read a file before changing it. Long files are returned in parts of about 100,000 characters; use read_file offset and limit to move through one, or head and tail for its ends.',
    ...(readOnly
      ? []
      : [
          '- Change an existing file with edit_file (small, exact replacements) rather than rewriting it with write_file. Run edit_file with dryRun first when unsure.',
          '- write_file replaces the whole file and creates missing directories.',
        ]),
    ...(enableShell && !readOnly
      ? ['- The shell tool is not limited to the directories above.']
      : []),
  ].join('\n')
}

export interface ServerOptions {
  /** Serve only tools annotated `readOnlyHint: true`. */
  readOnly?: boolean
  /**
   * Register the shell tool. Off by default: a command can read and write
   * anywhere the server process can, so it is not confined to the allowed
   * directories.
   */
  enableShell?: boolean
}

export function createServer(
  allowedDirs: readonly string[],
  { readOnly = false, enableShell = false }: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'fs-mcp-server', version },
    {
      instructions: serverInstructions(allowedDirs, readOnly, enableShell),
      // The tool list is fixed for the life of the process, so never announce
      // changes (clients may open a notification stream for them) and let a
      // 2026-07-28 client reuse the list for a few minutes. `private`: a
      // client's copy is not shared with other users.
      capabilities: { tools: { listChanged: false } },
      cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    },
  )

  // Keyed on the annotation, not a list of write tools, so a new tool is
  // withheld unless it declares itself read-only. A withheld tool is removed
  // before any client connects, so it is absent from tools/list.
  const registerTool = ((
    name: string,
    config: Parameters<typeof server.registerTool>[1],
    handler: Parameters<typeof server.registerTool>[2],
  ) => {
    const tool = server.registerTool(name, config, handler)
    if (readOnly && config.annotations?.readOnlyHint !== true) tool.remove()
    return tool
  }) as typeof server.registerTool

  registerTool(
    'read_file',
    {
      title: 'Read File',
      description:
        'Read a text file. Output is capped at about 100,000 characters; when a ' +
        'file is longer the result ends with the offset to continue from. Use ' +
        'offset and limit to read a range of lines, head for the first N lines, ' +
        'or tail for the last N lines (use only one of the three). Only works ' +
        'within allowed directories.',
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
          .min(0)
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
        'to continue from with read_file. Only works within allowed directories.',
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
        'part of an existing file use edit_file. Only works within allowed directories.',
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
        'diff. Only works within allowed directories.',
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

  if (enableShell) {
    registerTool(
      'shell',
      {
        title: 'Shell',
        description:
          'Run a shell command and return its stdout, stderr and exit code as JSON. ' +
          'Use for tests, type checks, builds, git and similar. Do NOT use it to read, ' +
          'write or edit files (use the file tools), for interactive commands (stdin is ' +
          'closed), for commands that never exit (dev servers, watch modes), or for ' +
          'destructive ones (rm -rf, git reset --hard, force pushes) unless the user ' +
          'asked for them. Each call is a fresh process, so cd does not persist: use ' +
          'cwd, which must be inside the allowed directories (default: the first one). ' +
          'The command itself is not confined to them. The command and any processes ' +
          'it started are killed after timeoutMs. Past 20000 characters stdout and ' +
          'stderr each keep their start and end and omit the middle; binary output is ' +
          'replaced by a short note.',
        inputSchema: z.strictObject({
          command: z
            .string()
            .min(1)
            .describe(
              "The command to run, for example 'ls -lh' or 'git status'.",
            ),
          cwd: z
            .string()
            .optional()
            .describe(
              'Directory to run the command in, inside the allowed directories. Defaults to the first allowed directory.',
            ),
          timeoutMs: z
            .int()
            .min(0)
            .optional()
            .describe(
              `Kill the command after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; 0 disables the timeout.`,
            ),
        }),
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) => {
        const cwd = args.cwd
          ? await validatePath(args.cwd, allowedDirs)
          : allowedDirs[0]
        const result = await runShell(
          args.command,
          cwd,
          args.timeoutMs,
          ctx.mcpReq.signal,
        )
        // a non-zero exit is still a result; flag it so clients can see it failed
        return { ...text(JSON.stringify(result, null, 2)), isError: !result.ok }
      },
    )
  }

  return server
}
