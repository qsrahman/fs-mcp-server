// Reads and writes of single files. Callers pass paths from validatePath.
import fs from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { constants, createReadStream } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

const TAIL_CHUNK_BYTES = 64 * 1024
const BINARY_SNIFF_BYTES = 8192

// How much text one read returns. This protects the model's context window,
// not memory: 100,000 characters is about 25k tokens. Longer output is cut at
// a line boundary and says where to continue.
export const MAX_READ_CHARS = 100_000
// The same, for all files of one read_multiple_files call together.
export const MAX_MULTI_READ_CHARS = 200_000

export const normalizeLineEndings = (text: string) =>
  text.replace(/\r\n/g, '\n')

/** An error carrying a Node-style `code`, which friendlyFsError understands. */
function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

/**
 * Rewrite a low-level fs error into one an agent can act on, naming the path as
 * the caller spelled it. Errors without a known code (such as the access-denied
 * errors from validatePath) pass through unchanged.
 */
export function friendlyFsError(error: unknown, shown: string): Error {
  const messages: Record<string, string> = {
    ENOENT: `File not found: ${shown}`,
    EISDIR: `${shown} is a directory, not a file`,
    ENOTDIR: `A parent of ${shown} is not a directory`,
    EACCES: `Permission denied: ${shown}`,
    EPERM: `Permission denied: ${shown}`,
    EBINARY: `${shown} looks like a binary file or is not valid UTF-8 text`,
  }
  const message = messages[(error as NodeJS.ErrnoException)?.code ?? '']
  return message ? new Error(message, { cause: error }) : (error as Error)
}

/**
 * Whether the start of a file looks like UTF-8 text: no NUL bytes and valid
 * UTF-8. A start cut off mid-file may end inside a multi-byte character, so up
 * to three trailing bytes are allowed to be incomplete.
 */
function looksLikeText(start: Buffer, wholeFile: boolean): boolean {
  if (start.includes(0)) return false
  if (isUtf8(start)) return true
  return (
    !wholeFile &&
    [1, 2, 3].some((cut) => isUtf8(start.subarray(0, start.length - cut)))
  )
}

/** Throw EISDIR for a directory and EBINARY for a file that does not look like UTF-8 text. */
async function assertTextFile(filePath: string): Promise<{ size: number }> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (stats.isDirectory()) throw codedError('EISDIR')
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stats.size))
    await handle.read(sniff, 0, sniff.length, 0)
    if (!looksLikeText(sniff, sniff.length === stats.size)) {
      throw codedError('EBINARY')
    }
    return { size: stats.size }
  } finally {
    await handle.close()
  }
}

export interface ReadOptions {
  /** Line to start from, 1-based. */
  offset?: number
  /** Most lines to return. */
  limit?: number
  /** Most characters to return. */
  maxChars?: number
}

/**
 * Read a text file, or a range of its lines. A file that fits within maxChars
 * is returned byte for byte; anything else is read line by line (line endings
 * become LF) and stops at `limit` lines or `maxChars` characters, whichever
 * comes first. When lines remain, the text ends with a note giving the offset
 * to continue from.
 */
export async function readText(
  filePath: string,
  { offset = 1, limit = Infinity, maxChars = MAX_READ_CHARS }: ReadOptions = {},
): Promise<string> {
  const { size } = await assertTextFile(filePath)
  if (offset === 1 && limit === Infinity && size <= maxChars) {
    return fs.readFile(filePath, 'utf-8')
  }

  const input = createReadStream(filePath, 'utf-8')
  const rl = createInterface({ input, crlfDelay: Infinity })
  const lines: string[] = []
  let chars = 0
  let lineNumber = 0
  let nextOffset: number | undefined
  try {
    for await (const line of rl) {
      lineNumber++
      if (lineNumber < offset) continue
      if (
        lines.length >= limit ||
        (lines.length > 0 && chars + line.length + 1 > maxChars)
      ) {
        nextOffset = lineNumber
        break
      }
      // A single line longer than the whole budget is cut, not skipped.
      const shown =
        line.length > maxChars
          ? `${line.slice(0, maxChars)} [... line cut: it has ${line.length} characters]`
          : line
      lines.push(shown)
      chars += shown.length + 1
    }
  } finally {
    rl.close()
    // rl.close() leaves the stream (and its file descriptor) open on an early exit.
    input.destroy()
  }

  if (lines.length === 0 && nextOffset === undefined && offset > 1) {
    return `[offset ${offset} is past the end of the file, which has ${lineNumber} lines]`
  }
  const text = lines.join('\n')
  return nextOffset === undefined
    ? text
    : `${text}\n[... showing lines ${offset}-${nextOffset - 1}; more lines follow. Continue with read_file offset=${nextOffset}]`
}

/** The last `n` lines of a file (line endings become LF), capped at maxChars. */
export async function tailFile(
  filePath: string,
  n: number,
  maxChars = MAX_READ_CHARS,
): Promise<string> {
  if (n === 0) return '' // slice(-0) would return every line
  await assertTextFile(filePath)
  const handle = await fs.open(filePath, 'r')
  try {
    // Read backwards in chunks until n + 1 newlines are in hand (n lines plus
    // the break before the first of them; a final newline ends a line, so it
    // is not one of the n), or until more bytes than the cap could use.
    let position = (await handle.stat()).size
    const chunks: Buffer[] = []
    let newlines = 0
    let bytes = 0
    while (position > 0 && newlines <= n && bytes < maxChars * 4) {
      const size = Math.min(TAIL_CHUNK_BYTES, position)
      position -= size
      const chunk = Buffer.alloc(size)
      await handle.read(chunk, 0, size, position)
      chunks.unshift(chunk)
      bytes += size
      for (const byte of chunk) if (byte === 0x0a) newlines++
    }
    const text = normalizeLineEndings(
      Buffer.concat(chunks).toString('utf-8'),
    ).replace(/\n$/, '')
    const lines = text === '' ? [] : text.split('\n')
    // Unless the start of the file was reached, the first line is partial.
    if (position > 0) lines.shift()
    const result = lines.slice(-n).join('\n')
    return result.length > maxChars
      ? `[... showing only the last ${maxChars} characters ...]\n${result.slice(-maxChars)}`
      : result
  } finally {
    await handle.close()
  }
}

const queues = new Map<string, Promise<unknown>>()

/**
 * Run `fn` after every earlier call with the same key has finished, so two
 * read-modify-write operations on one file cannot overlap and lose an update.
 * Key on the path validatePath returned, which is the file's real path.
 */
export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn)
  // The stored tail never rejects, so one failure does not block later calls.
  const tail = run.catch(() => {})
  queues.set(key, tail)
  try {
    return await run
  } finally {
    if (queues.get(key) === tail) queues.delete(key)
  }
}

/**
 * Create or overwrite a file, creating any missing parent directories.
 * Exclusive creation never writes through a symlink; an existing entry must be
 * a regular file, opened with O_NOFOLLOW. The directories are made below the
 * nearest existing ancestor that validatePath already checked, so they stay
 * inside the allowed directories.
 */
export async function writeFileContent(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!(await fs.lstat(filePath)).isFile()) {
    throw new Error(`Refusing to write: not a regular file: ${filePath}`)
  }
  // Overwrite in place (not rename) to keep the inode, permissions and links.
  const { O_WRONLY, O_TRUNC, O_NOFOLLOW = 0 } = constants
  const handle = await fs.open(filePath, O_WRONLY | O_TRUNC | O_NOFOLLOW)
  try {
    await handle.writeFile(content, 'utf-8')
  } finally {
    await handle.close()
  }
}
