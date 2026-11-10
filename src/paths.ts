// Path validation: every tool resolves its path through validatePath.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(1))
    : p
}

function isWithin(target: string, dirs: readonly string[]): boolean {
  // A root such as "/" already ends in a separator.
  return dirs.some(
    (dir) =>
      target === dir ||
      target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep),
  )
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
  // ENOENT also means a symlink whose target is missing; writing there would
  // fail later with a confusing error, so name it now.
  if ((await fs.lstat(absolute).catch(() => null))?.isSymbolicLink()) {
    throw new Error(`Broken symlink (its target does not exist): ${absolute}`)
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
