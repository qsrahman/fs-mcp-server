// Reads and writes of single files. Callers pass paths from validatePath.
import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

const TAIL_CHUNK_BYTES = 64 * 1024

export const normalizeLineEndings = (text: string) =>
  text.replace(/\r\n/g, '\n')

// A whole-file read is returned in one response, so it is bounded; head and
// tail read only part of a file and have no such limit.
export const MAX_READ_BYTES = 10 * 1024 * 1024

export async function readFileContent(filePath: string): Promise<string> {
  const { size } = await fs.stat(filePath)
  if (size > MAX_READ_BYTES) {
    throw new Error(
      `File is ${size} bytes, over the ${MAX_READ_BYTES} byte read limit. ` +
        'Use head or tail to read part of it.',
    )
  }
  return fs.readFile(filePath, 'utf-8')
}

export async function headFile(filePath: string, n: number): Promise<string> {
  const lines: string[] = []
  const input = createReadStream(filePath, 'utf-8')
  const rl = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (lines.length >= n) break
      lines.push(line)
    }
  } finally {
    rl.close()
    // rl.close() leaves the stream (and its file descriptor) open on an early exit.
    input.destroy()
  }
  return lines.join('\n')
}

export async function tailFile(filePath: string, n: number): Promise<string> {
  if (n === 0) return '' // slice(-0) would return every line
  const handle = await fs.open(filePath, 'r')
  try {
    // Read backwards in chunks until n + 1 newlines are in hand: n lines plus
    // the break before the first of them (a final newline ends a line, so it
    // is not one of the n).
    let position = (await handle.stat()).size
    const chunks: Buffer[] = []
    let newlines = 0
    while (position > 0 && newlines <= n) {
      const size = Math.min(TAIL_CHUNK_BYTES, position)
      position -= size
      const chunk = Buffer.alloc(size)
      await handle.read(chunk, 0, size, position)
      chunks.unshift(chunk)
      for (const byte of chunk) if (byte === 0x0a) newlines++
    }
    const text = normalizeLineEndings(
      Buffer.concat(chunks).toString('utf-8'),
    ).replace(/\n$/, '')
    return text === '' ? '' : text.split('\n').slice(-n).join('\n')
  } finally {
    await handle.close()
  }
}

/**
 * Create or overwrite a file. Exclusive creation never writes through a
 * symlink; an existing entry must be a regular file, opened with O_NOFOLLOW.
 */
export async function writeFileContent(
  filePath: string,
  content: string,
): Promise<void> {
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
