import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Two fresh, realpath'd temp directories: one to allow, one outside it. */
export async function makeTempDirs() {
  const make = async (prefix: string) =>
    fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
  return { root: await make('fs-mcp-'), outside: await make('fs-mcp-out-') }
}

export async function removeTempDirs(...dirs: string[]) {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true })
}
