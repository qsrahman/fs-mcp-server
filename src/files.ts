// Adapted from modelcontextprotocol/servers (src/filesystem) and changed; see
// THIRD_PARTY_NOTICES.md for its licence.
// Reads and writes of single files. Callers pass paths from validatePath.
import fs, { type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { FsTimeoutError, withFsTimeout } from './paths.js'

// File reading constants
const TAIL_CHUNK_BYTES = 64 * 1024
const BINARY_SNIFF_BYTES = 8192
const LF_BYTE = 0x0a // newline character for binary scanning

// How much text one read returns. This protects the model's context window,
// not memory: 100,000 characters is about 25k tokens. Longer output is cut at
// a line boundary and says where to continue.
const MAX_READ_CHARS = 100_000
// The same, for all files of one read_multiple_files call together.
export const MAX_MULTI_READ_CHARS = 200_000

// Regex patterns for text processing
const CRLF_REGEX = /\r\n/g
const TRAILING_NEWLINE_REGEX = /\n$/

export const normalizeLineEndings = (text: string) =>
  text.replace(CRLF_REGEX, '\n')

// Friendly error messages for common file system error codes.
const ERROR_MESSAGES: Record<string, (shown: string) => string> = {
  ENOENT: (shown) => `File not found: ${shown}`,
  EISDIR: (shown) => `${shown} is a directory, not a file`,
  ENOTADIR: (shown) =>
    `${shown} is a file, not a directory; read it with read_file`,
  ENOTDIR: (shown) => `A parent of ${shown} is not a directory`,
  EACCES: (shown) => `Permission denied: ${shown}`,
  EPERM: (shown) => `Permission denied: ${shown}`,
  EBINARY: (shown) =>
    `${shown} looks like a binary file or is not valid UTF-8 text`,
}

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
  const builder = ERROR_MESSAGES[(error as NodeJS.ErrnoException)?.code ?? '']
  return builder
    ? new Error(builder(shown), { cause: error })
    : (error as Error)
}

/**
 * Truncate a line at a character limit for display, with an indicator if cut.
 * Used when a single line exceeds the read budget.
 */
function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  return `${line.slice(0, maxChars)} [... line cut: it has ${line.length} characters]`
}

/**
 * Build a continuation message for partial file reads, indicating where to continue.
 */
function buildContinuationMessage(
  text: string,
  offset: number,
  nextOffset: number,
): string {
  return `${text}\n[... showing lines ${offset}-${nextOffset - 1}; more lines follow. Continue with read_file offset=${nextOffset}]`
}

/**
 * Whether the start of a file looks like UTF-8 text: no NUL bytes and valid
 * UTF-8. A start cut off mid-file may end inside a multi-byte character; the
 * decoder in streaming mode treats that as incomplete, not invalid.
 */
function looksLikeText(start: Buffer, wholeFile: boolean): boolean {
  if (start.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(start, {
      stream: !wholeFile,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Open a file once for reading, refusing a directory (EISDIR) and a file that
 * does not look like UTF-8 text (EBINARY). The caller reads through the handle,
 * so the file checked is the file read, and closes it.
 */
async function openTextFile(
  filePath: string,
): Promise<{ handle: FileHandle; size: number }> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stats = await handle.stat()
    // Named here, before any read: reading a directory fails with a less helpful error.
    if (stats.isDirectory()) throw codedError('EISDIR')
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stats.size))
    await handle.read(sniff, 0, sniff.length, 0) // positional: the file offset stays at 0
    if (!looksLikeText(sniff, sniff.length === stats.size)) {
      throw codedError('EBINARY')
    }
    return { handle, size: stats.size }
  } catch (error) {
    await handle.close()
    throw error
  }
}

interface ReadOptions {
  /** Line to start from, 1-based. */
  offset?: number
  /** Most lines to return. */
  limit?: number
  /** Most characters to return. */
  maxChars?: number
}

/**
 * Read lines from a file handle using readline, collecting them with a character budget.
 * Returns collected lines and the next offset if more lines remain.
 */
async function readLinesFromHandle(
  handle: FileHandle,
  startLine: number,
  limitLines: number,
  maxChars: number,
): Promise<{ lines: string[]; nextOffset?: number; totalLines: number }> {
  const input = handle.createReadStream({ encoding: 'utf-8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  const lines: string[] = []
  let chars = 0
  let lineNumber = 0
  let nextOffset: number | undefined
  try {
    for await (const line of rl) {
      lineNumber++
      if (lineNumber < startLine) continue
      if (
        lines.length >= limitLines ||
        (lines.length > 0 && chars + line.length + 1 > maxChars)
      ) {
        nextOffset = lineNumber
        break
      }
      // A single line longer than the whole budget is cut, not skipped.
      const shown = truncateLine(line, maxChars)
      lines.push(shown)
      chars += shown.length + 1
    }
  } finally {
    rl.close()
    // rl.close() leaves the stream open on an early exit; destroying it
    // stops the pending read before the handle is closed below.
    input.destroy()
  }
  return { lines, nextOffset, totalLines: lineNumber }
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
  const { handle, size } = await openTextFile(filePath)
  try {
    if (offset === 1 && limit === Infinity && size <= maxChars) {
      return await handle.readFile('utf-8')
    }

    const { lines, nextOffset, totalLines } = await readLinesFromHandle(
      handle,
      offset,
      limit,
      maxChars,
    )

    if (lines.length === 0 && nextOffset === undefined && offset > 1) {
      return `[offset ${offset} is past the end of the file, which has ${totalLines} lines]`
    }
    const text = lines.join('\n')
    return nextOffset === undefined
      ? text
      : buildContinuationMessage(text, offset, nextOffset)
  } finally {
    await handle.close()
  }
}

/** The last `n` lines of a file (line endings become LF), capped at maxChars. */
export async function tailFile(
  filePath: string,
  n: number,
  maxChars = MAX_READ_CHARS,
): Promise<string> {
  if (n === 0) return '' // slice(-0) would return every line
  const { handle, size } = await openTextFile(filePath)
  try {
    // Read backwards in chunks until n + 1 newlines are in hand (n lines plus
    // the break before the first of them; a final newline ends a line, so it
    // is not one of the n), or until more bytes than the cap could use.
    let position = size
    const chunks: Buffer[] = []
    let newlines = 0
    let bytes = 0
    while (position > 0 && newlines <= n && bytes < maxChars * 4) {
      const length = Math.min(TAIL_CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, position)
      chunks.unshift(chunk)
      bytes += length
      for (const byte of chunk) if (byte === LF_BYTE) newlines++
    }
    const text = normalizeLineEndings(
      Buffer.concat(chunks).toString('utf-8'),
    ).replace(TRAILING_NEWLINE_REGEX, '')
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

// How many entries one listing returns: a listing is for orientation, and a
// longer one costs context without helping the model choose where to look.
const MAX_LIST_ENTRIES = 1000
// Listed, but never entered by a recursive listing: they would use up the
// entries on files nobody asked about.
const NOT_ENTERED = new Set(['.git', 'node_modules'])

/**
 * The entries of a directory, one per line: directories end in "/" and symbolic
 * links in "@" (a link is never followed). Directories come first, then files,
 * each sorted by name. A recursive listing goes breadth first, so the shallow
 * entries are the ones kept when the cap cuts it, and names are relative to
 * `dir`.
 */
export async function listDirectory(
  dir: string,
  recursive: boolean,
): Promise<string> {
  const lines: string[] = []
  const queue = ['']
  let unreadable = false
  for (let next = 0; next < queue.length; next++) {
    const prefix = queue[next]
    let entries
    try {
      const where = path.join(dir, prefix)
      // Only stops waiting (see paths.ts): a directory on a stalled cloud or
      // network drive must not hold the call forever.
      entries = await withFsTimeout(
        fs.readdir(where, { withFileTypes: true }),
        'readdir',
        where,
      )
    } catch (error) {
      if (error instanceof FsTimeoutError) throw error
      if (prefix !== '') {
        unreadable = true
        continue
      }
      throw (error as NodeJS.ErrnoException).code === 'ENOTDIR'
        ? codedError('ENOTADIR')
        : error
    }
    entries.sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    for (const entry of entries) {
      if (lines.length >= MAX_LIST_ENTRIES) {
        lines.push(
          `[... the listing stopped after ${MAX_LIST_ENTRIES} entries; list a subdirectory to see more]`,
        )
        return lines.join('\n')
      }
      const name = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        lines.push(`${name}/`)
        if (recursive && !NOT_ENTERED.has(entry.name)) queue.push(`${name}/`)
      } else {
        lines.push(entry.isSymbolicLink() ? `${name}@` : name)
      }
    }
  }
  if (unreadable) lines.push('[some subdirectories could not be read]')
  return lines.length > 0 ? lines.join('\n') : '(empty)'
}

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
 * nearest existing ancestor that validatePath already checked, so with allowed
 * directories they stay inside them.
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
