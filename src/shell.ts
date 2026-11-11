// Runs a shell command for the shell tool. Ported from tiny-code's shell tool.
// The command itself is NOT confined to the allowed directories; see README.
import { stripVTControlCharacters } from 'node:util'
import { execa } from 'execa'

export const DEFAULT_TIMEOUT_MS = 30_000
// execa's buffer cap: an oversized `cat` is why output is capped at all.
const MAX_BUFFER_CHARS = 10 * 1024 * 1024
const FORCE_KILL_DELAY_MS = 1_000
const MAX_OUTPUT_CHARS = 20_000
const HALF = MAX_OUTPUT_CHARS / 2

interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

// Output is bounded so it can't flood the context window. Binary output (cat on
// an image) is junk to the model and costs 6 bytes per NUL once JSON-escaped, so
// it becomes a note. Oversized text keeps its head and tail: a command's start
// and its failure, usually at the end, both matter. Terminal escape sequences
// (colors, cursor moves) are stripped: they are noise to a model and cost tokens.
function outputText(raw: string): string {
  const text = stripVTControlCharacters(raw)
  if (text.includes('\0')) {
    return `[binary output omitted: ${text.length} characters containing NUL bytes; inspect it with shell, for example: file <path> or xxd <path> | head]`
  }
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, HALF)}\n[... ${text.length - MAX_OUTPUT_CHARS} characters omitted; narrow the command to see the rest ...]\n${text.slice(-HALF)}`
}

/**
 * The result as the model reads it. Plain text, not JSON: JSON escapes every
 * newline and quote and adds a fixed frame, which costs tokens on every call.
 * A command that succeeded and printed only to stdout gives just that output;
 * the exit code is stated only when it is not 0, and stdout and stderr are
 * labelled only when both, or stderr alone, have something to say.
 */
export function formatResult(result: CommandResult): string {
  const { ok, stdout, stderr, exitCode } = result
  if (ok && !stderr) return stdout || '(no output)'
  return [
    ok ? '' : `exit code ${exitCode}`,
    stdout && `[stdout]\n${stdout}`,
    stderr && `[stderr]\n${stderr}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Run `command` in `cwd`. A non-zero exit is a result, not a thrown error. */
export async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await execa(command, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    // a cancelled request kills the command instead of letting it outlive the call
    cancelSignal: signal,
    maxBuffer: MAX_BUFFER_CHARS,
    reject: false,
    // Inherit the environment except the Brave Search key: a command the model
    // runs (or one a prompt injection in a web page or file talks it into)
    // could otherwise print or send the key anywhere.
    env: { BRAVE_API_KEY: undefined },
    // commands that read stdin would otherwise hang until the timeout
    stdin: 'ignore',
    // without this a timed-out shell's children keep the output pipe open and block us
    killDescendants: true,
    forceKillAfterDelay: FORCE_KILL_DELAY_MS,
  })

  const note = result.timedOut
    ? `command timed out after ${timeoutMs}ms`
    : result.isMaxBuffer
      ? `output exceeded ${MAX_BUFFER_CHARS} characters; command was killed`
      : result.exitCode === undefined
        ? result.signal
          ? `command was killed by ${result.signal}`
          : result.originalMessage
        : ''
  return {
    ok: !result.failed,
    stdout: outputText(result.stdout),
    stderr: [outputText(result.stderr), note].filter(Boolean).join('\n'),
    // a failed command never reports 0 (e.g. output overflow after a clean exit)
    exitCode: result.exitCode || (result.failed ? -1 : 0),
  }
}
