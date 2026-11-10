// File operations behind the read_text_file, read_multiple_files, write_file
// and edit_file tools. Ported from the reference filesystem server
// (modelcontextprotocol/servers, src/filesystem), trimmed to the essentials.
import fs from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'

export interface FileEdit {
  oldText: string
  newText: string
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

function isWithin(target: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => target === dir || target.startsWith(dir + path.sep))
}

/**
 * Resolve `requested` to a real path inside the allowed directories, or throw.
 * Symlinks are resolved first, so a link pointing outside is refused. A path
 * that does not exist yet is accepted if its parent directory is allowed.
 * `allowedDirs` must already be realpath'd (see resolveAllowedDirectories).
 */
export async function validatePath(
  requested: string,
  allowedDirs: readonly string[],
): Promise<string> {
  if (requested.includes('\0')) throw new Error('Access denied - invalid path')
  const absolute = path.resolve(allowedDirs[0] ?? '/', expandHome(requested))
  if (!isWithin(absolute, allowedDirs)) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${allowedDirs.join(', ')}`,
    )
  }
  try {
    const real = await fs.realpath(absolute)
    if (!isWithin(real, allowedDirs)) {
      throw new Error(
        `Access denied - symlink target outside allowed directories: ${real}`,
      )
    }
    return real
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // New file: the parent must exist and be allowed.
  const parent = path.dirname(absolute)
  let realParent: string
  try {
    realParent = await fs.realpath(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Parent directory does not exist: ${parent}`)
    }
    throw error
  }
  if (!isWithin(realParent, allowedDirs)) {
    throw new Error(
      `Access denied - parent directory outside allowed directories: ${realParent}`,
    )
  }
  return path.join(realParent, path.basename(absolute))
}

const normalizeLineEndings = (text: string) => text.replace(/\r\n/g, '\n')

export function readFileContent(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

export async function headFile(filePath: string, n: number): Promise<string> {
  const lines: string[] = []
  const rl = createInterface({
    input: createReadStream(filePath, 'utf-8'),
    crlfDelay: Infinity,
  })
  try {
    for await (const line of rl) {
      if (lines.length >= n) break
      lines.push(line)
    }
  } finally {
    rl.close()
  }
  return lines.join('\n')
}

export async function tailFile(filePath: string, n: number): Promise<string> {
  if (n === 0) return '' // slice(-0) would return every line
  const text = normalizeLineEndings(await readFileContent(filePath)).replace(
    /\n$/,
    '',
  )
  return text === '' ? '' : text.split('\n').slice(-n).join('\n')
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

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

/**
 * Apply edits in order, each replacing the first match of oldText. Falls back
 * to matching whole lines ignoring leading/trailing whitespace, in which case
 * the replacement takes the file's indentation. Returns a git-style diff.
 * Nothing is written if any edit fails to match, or when dryRun is set.
 */
export async function applyFileEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun = false,
): Promise<string> {
  const raw = await readFileContent(filePath)
  const crlf =
    (raw.match(/\r\n/g)?.length ?? 0) > (raw.match(/(?<!\r)\n/g)?.length ?? 0)
  const original = normalizeLineEndings(raw)

  let modified = original
  for (const [index, edit] of edits.entries()) {
    const oldText = normalizeLineEndings(edit.oldText)
    const newText = normalizeLineEndings(edit.newText)

    if (modified.includes(oldText)) {
      modified = modified.replace(oldText, () => newText)
      continue
    }

    const oldLines = oldText.split('\n')
    const newLines = newText.split('\n')
    const lines = modified.split('\n')
    let matched = false
    for (let i = 0; i <= lines.length - oldLines.length; i++) {
      if (!oldLines.every((l, j) => l.trim() === lines[i + j].trim())) continue
      const replacement = newLines.map((line, j) => {
        const k = Math.min(j, oldLines.length - 1)
        const body = line.trimStart()
        if (body === '') return line
        const delta = indentOf(line).length - indentOf(oldLines[k]).length
        const fileIndent = indentOf(lines[i + k])
        const indent =
          delta >= 0
            ? fileIndent + indentOf(line).slice(indentOf(line).length - delta)
            : fileIndent.slice(0, Math.max(0, fileIndent.length + delta))
        return indent + body
      })
      lines.splice(i, oldLines.length, ...replacement)
      modified = lines.join('\n')
      matched = true
      break
    }
    if (!matched) {
      throw new Error(
        `Could not find exact match for edit ${index + 1} of ${edits.length}: ${edit.oldText}\nNo edits were applied.`,
      )
    }
  }

  const diff = createTwoFilesPatch(
    filePath,
    filePath,
    original,
    modified,
    'original',
    'modified',
  )

  if (!dryRun) {
    await writeFileContent(
      filePath,
      crlf ? modified.replace(/\n/g, '\r\n') : modified,
    )
  }

  // Fence long enough not to collide with backticks inside the diff.
  let fence = '```'
  while (diff.includes(fence)) fence += '`'
  return `${fence}diff\n${diff}${fence}\n\n`
}
