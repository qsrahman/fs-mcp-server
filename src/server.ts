import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { applyFileEdits } from './edit.js'
import {
  headFile,
  readFileContent,
  tailFile,
  writeFileContent,
} from './files.js'
import { validatePath } from './paths.js'

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

export interface ServerOptions {
  /** Serve only tools annotated `readOnlyHint: true`. */
  readOnly?: boolean
}

export function createServer(
  allowedDirs: readonly string[],
  { readOnly = false }: ServerOptions = {},
): McpServer {
  const server = new McpServer({ name: 'fs-mcp-server', version })

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
      annotations: READ_ANNOTATIONS,
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

  registerTool(
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
          .max(MAX_READ_PATHS)
          .describe('Paths of the files to read.'),
      }),
      annotations: READ_ANNOTATIONS,
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

  registerTool(
    'write_file',
    {
      title: 'Write File',
      description:
        'Create a new file or completely overwrite an existing file. ' +
        'Overwrites without warning. Only works within allowed directories.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
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

  registerTool(
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
              .min(1)
              .describe('Text to search for - must match exactly'),
            newText: z.string().describe('Text to replace with'),
          }),
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
      return text(await applyFileEdits(file, args.edits, args.dryRun))
    },
  )

  return server
}
