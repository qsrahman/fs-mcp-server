import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runShell } from '../src/shell.js'

let dir: string

beforeEach(async () => {
  dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-sh-')),
  )
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const run = (command: string, timeoutMs?: number) =>
  runShell(command, dir, timeoutMs)

describe('runShell', () => {
  it('returns stdout on success', async () => {
    expect(await run(`node -e "process.stdout.write('hello')"`)).toMatchObject({
      ok: true,
      stdout: 'hello',
      exitCode: 0,
    })
  })

  it('reports a non-zero exit without throwing', async () => {
    expect(await run('node -e "process.exit(3)"')).toMatchObject({
      ok: false,
      exitCode: 3,
    })
  })

  it('runs in the given directory', async () => {
    const result = await run('node -e "process.stdout.write(process.cwd())"')
    expect(await fs.realpath(result.stdout)).toBe(dir)
  })

  it('explains a failure to start instead of returning an empty error', async () => {
    const result = await runShell('echo hi', path.join(dir, 'no-such-dir'))
    expect(result).toMatchObject({ ok: false, exitCode: -1 })
    expect(result.stderr).toContain('cwd')
  })

  it('reports the signal when a command is killed by one', async () => {
    const result = await run('kill -9 $$')
    expect(result).toMatchObject({ ok: false, exitCode: -1 })
    expect(result.stderr).toContain('SIGKILL')
  })

  it('preserves leading whitespace in output', async () => {
    expect((await run(`printf '  indented\\nx\\n'`)).stdout).toBe(
      '  indented\nx',
    )
  })

  it('closes stdin so commands that read it do not hang', async () => {
    const start = Date.now()
    expect(await run('cat', 10_000)).toMatchObject({ ok: true, exitCode: 0 })
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('cancels a running command when the signal aborts', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const pending = runShell('sleep 30', dir, 60_000, controller.signal)
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.ok).toBe(false)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('timeouts', () => {
  it('kills a command that exceeds timeoutMs', async () => {
    const start = Date.now()
    const result = await run('node -e "setTimeout(() => {}, 10000)"', 200)
    expect(Date.now() - start).toBeLessThan(5000)
    expect(result).toMatchObject({ ok: false, exitCode: -1 })
    expect(result.stderr).toContain('timed out after 200ms')
  })

  it('kills processes the command started', async () => {
    const result = await run('sleep 60 & echo $! > pid; wait', 300)
    expect(result.stderr).toContain('timed out after 300ms')
    const pid = Number(await fs.readFile(path.join(dir, 'pid'), 'utf-8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 20 && alive(); i++) await sleep(50)
    expect(alive()).toBe(false)
  })

  it('force-kills a command that ignores SIGTERM without waiting long', async () => {
    const start = Date.now()
    const result = await run("trap '' TERM; sleep 30", 200)
    expect(result.ok).toBe(false)
    expect(Date.now() - start).toBeLessThan(3000)
  })
})

describe('output limits', () => {
  it('truncates huge stdout and stderr but keeps the timeout note', async () => {
    const result = await run(
      `node -e "process.stdout.write('a'.repeat(100000)); process.stderr.write('b'.repeat(100000)); setTimeout(() => {}, 10000)"`,
      1000,
    )
    expect(result.stdout.length).toBeLessThan(21_000)
    expect(result.stdout).toContain('characters omitted')
    expect(result.stderr).toContain('characters omitted')
    expect(result.stderr).toContain('timed out after 1000ms')
  })

  it('keeps the start and end of oversized output and leaves output that fits alone', async () => {
    const big = await run(
      `node -e "process.stdout.write('HEAD' + 'a'.repeat(50000) + 'MIDDLE' + 'b'.repeat(50000) + 'TAIL')"`,
    )
    expect(big.stdout).toMatch(/^HEAD/)
    expect(big.stdout).toMatch(/TAIL$/)
    expect(big.stdout).not.toContain('MIDDLE')
    const fits = await run(`node -e "process.stdout.write('a'.repeat(20000))"`)
    expect(fits.stdout).toHaveLength(20_000)
  })

  it('explains why when output exceeds the buffer limit', async () => {
    const result = await run(
      `node -e "process.stdout.write('a'.repeat(11 * 1024 * 1024))"`,
    )
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('output exceeded')
    expect(result.stderr).not.toContain('timed out')
  })

  it('replaces binary stdout and stderr with a short note', async () => {
    const out = await run("printf 'abc\\000def'")
    expect(out.ok).toBe(true)
    expect(out.stdout).toContain('binary output omitted')
    expect(out.stdout).not.toContain('abc')
    const err = await run("printf 'x\\000y' >&2; sleep 5", 300)
    expect(err.stderr).toContain('binary output omitted')
    expect(err.stderr).toContain('timed out after 300ms')
  })

  it('stays small however much binary the command produces', async () => {
    const result = await run('head -c 30000000 /dev/zero', 30_000)
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('output exceeded')
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  })

  it('strips terminal escape sequences from stdout and stderr', async () => {
    const result = await run(
      "printf '\\033[31mred\\033[0m \\033[1;32mgreen\\033[0m'; printf '\\033[2Kerr' >&2",
    )
    expect(result.stdout).toBe('red green')
    expect(result.stderr).toBe('err')
  })

  it('leaves ordinary output alone', async () => {
    expect((await run("printf 'plain text\\n'")).stdout).toBe('plain text')
  })
})
