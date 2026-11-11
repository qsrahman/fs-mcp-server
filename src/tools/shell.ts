import { z } from 'zod'
import { validatePath } from '../paths.js'
import { DEFAULT_TIMEOUT_MS, formatResult, runShell } from '../shell.js'
import { text, type RegisterTool } from './common.js'

export function registerShellTool(
  registerTool: RegisterTool,
  allowedDirs: readonly string[] | null,
) {
  registerTool(
    'shell',
    {
      title: 'Shell',
      description:
        'Run a shell command and return its output. A failed command starts with its exit code; ' +
        'stdout and stderr are labelled [stdout] and [stderr] when stderr has content. ' +
        'Use for tests, type checks, builds, git and similar. Do NOT use it to read, ' +
        'write or edit files (use the file tools), for interactive commands (stdin is ' +
        'closed), for commands that never exit (dev servers, watch modes), or for ' +
        'destructive ones (rm -rf, git reset --hard, force pushes) unless the user ' +
        'asked for them. Each call is a fresh process, so cd does not persist: use ' +
        (allowedDirs
          ? 'cwd, which must be inside the allowed directories (default: the first one). ' +
            'The command itself is not confined to them. '
          : "cwd (default: the server's working directory). ") +
        'The command and any processes ' +
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
            allowedDirs
              ? 'Directory to run the command in, inside the allowed directories. Defaults to the first allowed directory.'
              : "Directory to run the command in. Defaults to the server's working directory.",
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
        : (allowedDirs?.[0] ?? process.cwd())
      const result = await runShell(
        args.command,
        cwd,
        args.timeoutMs,
        ctx.mcpReq.signal,
      )
      // a non-zero exit is still a result; flag it so clients can see it failed
      return { ...text(formatResult(result)), isError: !result.ok }
    },
  )
}
