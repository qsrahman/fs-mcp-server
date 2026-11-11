import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyFileEdits } from '../src/edit.js'
import { makeTempDirs, removeTempDirs } from './helpers.js'

let root: string

let outside: string

beforeEach(async () => ({ root, outside } = await makeTempDirs()))
afterEach(() => removeTempDirs(root, outside))

describe('applyFileEdits', () => {
  it('applies edits in order and returns a diff', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'hello world\n')
    const diff = await applyFileEdits(f, [
      { oldText: 'hello', newText: 'bye' },
      { oldText: 'bye world', newText: 'bye all' },
    ])
    expect(await fs.readFile(f, 'utf-8')).toBe('bye all\n')
    expect(diff).toContain('-hello world')
  })

  it('dryRun does not write; failed match writes nothing', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'a\nb\n')
    await applyFileEdits(f, [{ oldText: 'a', newText: 'z' }], true)
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nb\n')
    await expect(
      applyFileEdits(f, [
        { oldText: 'a', newText: 'z' },
        { oldText: 'missing', newText: 'q' },
      ]),
    ).rejects.toThrow('edit 2 of 2')
    expect(await fs.readFile(f, 'utf-8')).toBe('a\nb\n')
  })

  it('matches whole lines ignoring indentation and keeps the file indentation and CRLF', async () => {
    const f = path.join(root, 'e.txt')
    await fs.writeFile(f, 'if (x) {\r\n    foo()\r\n}\r\n')
    await applyFileEdits(f, [{ oldText: 'foo()', newText: 'bar()' }])
    expect(await fs.readFile(f, 'utf-8')).toBe('if (x) {\r\n    bar()\r\n}\r\n')
    await applyFileEdits(f, [{ oldText: '  bar()', newText: '  baz()' }])
    expect(await fs.readFile(f, 'utf-8')).toBe('if (x) {\r\n    baz()\r\n}\r\n')
  })

  it('rejects an empty oldText instead of prepending', async () => {
    const f = path.join(root, 'a.txt')
    await fs.writeFile(f, 'hello\n')
    await expect(
      applyFileEdits(f, [{ oldText: '', newText: 'X' }]),
    ).rejects.toThrow('empty')
    expect(await fs.readFile(f, 'utf-8')).toBe('hello\n')
  })

  it('refuses to edit a file that is not valid UTF-8, leaving its bytes alone', async () => {
    const f = path.join(root, 'b.bin')
    const bytes = Buffer.from([0x68, 0x69, 0x0a, 0xff, 0xfe, 0x0a])
    await fs.writeFile(f, bytes)
    await expect(
      applyFileEdits(f, [{ oldText: 'hi', newText: 'ho' }]),
    ).rejects.toThrow('UTF-8')
    expect((await fs.readFile(f)).equals(bytes)).toBe(true)
  })
})

describe('edit_file no-match error', () => {
  const edit = async (
    content: string,
    oldText: string,
    index = 0,
    count = 1,
  ) => {
    const f = path.join(root, 'm.txt')
    await fs.writeFile(f, content)
    const edits = Array.from({ length: count }, (_, i) =>
      i === index
        ? { oldText, newText: 'x' }
        : { oldText: content.split('\n')[0], newText: content.split('\n')[0] },
    )
    return applyFileEdits(f, edits).then(
      () => '',
      (e: Error) => e.message,
    )
  }

  it('names the edit, quotes the closest numbered lines and says nothing was applied', async () => {
    const message = await edit('alpha\nbeta gamma\ndelta\n', 'beta  gamma')
    expect(message).toContain('edit 1 of 1')
    expect(message).toContain('No edits were applied')
    expect(message).toContain('2: beta gamma')
    expect(message).toContain('First difference')
  })

  it('says so when no line resembles oldText, or the file is empty', async () => {
    expect(await edit('aaa\nbbb\n', 'zzzz')).toContain(
      'No line of the file resembles oldText',
    )
    expect(await edit('', 'zzzz')).toContain('The file is empty')
  })

  it('reports oldText that runs past the end of the file', async () => {
    expect(await edit('one\ntwo\n', 'two\nthree')).toContain(
      'runs past the end of the file',
    )
  })

  it('cuts a very long file line', async () => {
    const message = await edit('x'.repeat(2000) + '\n', 'x'.repeat(10) + 'y')
    expect(message).toContain('[... cut: the line has 2000 characters]')
  })

  it('caps the quoted region at 30 lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const message = await edit(
      lines.join('\n') + '\n',
      lines.slice(10, 70).join('\n') + '\nDIFF',
    )
    const quoted = message.match(/^\d+: /gm) ?? []
    expect(quoted.length).toBeLessThanOrEqual(30)
  })

  it('notes earlier edits when a later edit fails', async () => {
    expect(await edit('a1\nb2\nc3\n', 'b2x', 1, 2)).toContain(
      'after the earlier edits in this call',
    )
  })
})

describe('edit arguments and output', () => {
  it('rejects an empty edits list instead of rewriting the file', async () => {
    const f = path.join(root, 'n.txt')
    await fs.writeFile(f, 'a\r\nb\nc\n')
    await expect(applyFileEdits(f, [])).rejects.toThrow(
      'edits must not be empty',
    )
    expect(await fs.readFile(f, 'utf-8')).toBe('a\r\nb\nc\n')
  })

  it('names the file in the diff header as the caller spelled it', async () => {
    const f = path.join(root, 'd.txt')
    await fs.writeFile(f, 'one\n')
    const diff = await applyFileEdits(
      f,
      [{ oldText: 'one', newText: 'two' }],
      true,
      'notes/d.txt',
    )
    expect(diff).toContain('--- notes/d.txt')
    expect(diff).not.toContain(root)
  })

  it('keeps the diff free of Index, underline and label noise', async () => {
    const f = path.join(root, 'noise.txt')
    await fs.writeFile(f, 'one\ntwo\n')
    const diff = await applyFileEdits(
      f,
      [{ oldText: 'two', newText: 'TWO' }],
      true,
      'a.txt',
    )
    expect(diff).toBe(
      '```diff\n--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n```\n\n',
    )
  })
})

describe('ambiguous matches and replaceAll', () => {
  const run = async (content: string, edit: object, dryRun = false) => {
    const f = path.join(root, 'amb.txt')
    await fs.writeFile(f, content)
    const outcome = await applyFileEdits(f, [edit as never], dryRun).then(
      () => 'ok',
      (error: Error) => error.message,
    )
    return { outcome, after: await fs.readFile(f, 'utf-8') }
  }

  it('refuses an exact oldText that matches more than once, naming the lines', async () => {
    const { outcome, after } = await run('a=1\nb=1\na=1\n', {
      oldText: 'a=1',
      newText: 'a=2',
    })
    expect(outcome).toContain('matches 2 places (lines 1, 3)')
    expect(outcome).toContain('replaceAll')
    expect(after).toBe('a=1\nb=1\na=1\n')
  })

  it('lists at most ten lines', async () => {
    const { outcome } = await run('x\n'.repeat(25), {
      oldText: 'x',
      newText: 'y',
    })
    expect(outcome).toContain(
      'matches 25 places (lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ...)',
    )
  })

  it('replaces every exact match with replaceAll, literally', async () => {
    const { outcome, after } = await run('a=1\nb=1\na=1\n', {
      oldText: 'a=1',
      newText: '$&a=1$1',
      replaceAll: true,
    })
    expect(outcome).toBe('ok')
    expect(after).toBe('$&a=1$1\nb=1\n$&a=1$1\n')
  })

  it('accepts an oldText made unique by surrounding lines', async () => {
    const { outcome, after } = await run('a=1\nb=1\na=1\n', {
      oldText: 'b=1\na=1',
      newText: 'b=1\na=2',
    })
    expect(outcome).toBe('ok')
    expect(after).toBe('a=1\nb=1\na=2\n')
  })

  it('applies the same rule to whole-line matches that ignore indentation', async () => {
    const file = 'if (a) {\n    go()\n}\nif (b) {\n        go()\n}\n'
    const ambiguous = await run(file, {
      oldText: '\tgo()',
      newText: '\tstop()',
    })
    expect(ambiguous.outcome).toContain('matches 2 places (lines 2, 5)')
    expect(ambiguous.after).toBe(file)
    const all = await run(file, {
      oldText: '\tgo()',
      newText: '\tstop()',
      replaceAll: true,
    })
    expect(all.outcome).toBe('ok')
    expect(all.after).toBe(
      'if (a) {\n    stop()\n}\nif (b) {\n        stop()\n}\n',
    )
  })

  it('does not write on dryRun and reports which edit was ambiguous', async () => {
    const f = path.join(root, 'two.txt')
    await fs.writeFile(f, 'p\nq\np\n')
    await expect(
      applyFileEdits(f, [
        { oldText: 'q', newText: 'Q' },
        { oldText: 'p', newText: 'P' },
      ]),
    ).rejects.toThrow('Edit 2 of 2')
    expect(await fs.readFile(f, 'utf-8')).toBe('p\nq\np\n')
  })
})

describe('whitespace-tolerant matching and reindenting', () => {
  const file = 'function f() {\n    if (x) {\n        y()\n    }\n}\n'
  const edit = async (content: string, oldText: string, newText: string) => {
    const f = path.join(root, 'r.txt')
    await fs.writeFile(f, content)
    await applyFileEdits(f, [{ oldText, newText }])
    return fs.readFile(f, 'utf-8')
  }

  it('places a replacement at the file indentation when the edit is unindented', async () => {
    expect(await edit(file, 'if (x) {\ny()\n}', 'if (x) {\nz()\n}')).toBe(
      'function f() {\n    if (x) {\n        z()\n    }\n}\n',
    )
  })

  it('keeps an indent increase relative to the matched line', async () => {
    expect(
      await edit(
        file,
        '  if (x) {\n    y()\n  }',
        '  if (x) {\n      z()\n  }',
      ),
    ).toBe('function f() {\n    if (x) {\n          z()\n    }\n}\n')
  })

  it('applies an indent decrease relative to the matched line', async () => {
    expect(
      await edit(file, '  if (x) {\n    y()\n  }', '  if (x) {\n  z()\n  }'),
    ).toBe('function f() {\n    if (x) {\n      z()\n    }\n}\n')
  })

  it('never dedents below column 0', async () => {
    expect(await edit('a\n  b\n', '      b', 'b')).toBe('a\nb\n')
  })

  it('keeps blank lines in the replacement as given', async () => {
    const out = await edit(file, 'y()', 'y()\n\nq()')
    expect(out).toContain('        y()\n\n')
  })

  it('maps a space-indented edit onto a tab-indented file', async () => {
    expect(
      await edit(
        'a() {\n\tif (x) {\n\t\ty()\n\t}\n}\n',
        'if (x) {\n  y()\n}',
        'if (x) {\n  z()\n}',
      ),
    ).toBe('a() {\n\tif (x) {\n\t\tz()\n\t}\n}\n')
  })

  it('indents a line added at the end of a block like the line before it', async () => {
    expect(
      await edit(file, 'if (x) {\n  y()\n}', 'if (x) {\n  y()\n  w()\n}'),
    ).toBe('function f() {\n    if (x) {\n        y()\n        w()\n    }\n}\n')
  })

  it('indents several added lines, including nested ones, from the line before', async () => {
    expect(
      await edit(
        file,
        'if (x) {\n    y()\n}',
        'if (x) {\n    y()\n    if (z) {\n        w()\n    }\n}',
      ),
    ).toBe(
      'function f() {\n    if (x) {\n        y()\n        if (z) {\n            w()\n        }\n    }\n}\n',
    )
  })

  it('indents an added line next to a changed one like its neighbour', async () => {
    expect(
      await edit(file, 'if (x) {\n  y()\n}', 'if (x) {\n  z()\n  w()\n}'),
    ).toBe('function f() {\n    if (x) {\n        z()\n        w()\n    }\n}\n')
  })

  it('indents a line added above an existing one from the line before it', async () => {
    expect(
      await edit(file, 'if (x) {\n    y()\n}', 'if (x) {\n    w()\n    y()\n}'),
    ).toBe('function f() {\n    if (x) {\n        w()\n        y()\n    }\n}\n')
  })

  it('indents a line added before the first matched line from that line', async () => {
    // the tab makes this a whitespace-tolerant match, not an exact one
    expect(await edit(file, '\ty()', '\tw()\n\ty()')).toBe(
      'function f() {\n    if (x) {\n        w()\n        y()\n    }\n}\n',
    )
  })

  it('keeps the file indentation of the lines around a removed line', async () => {
    expect(
      await edit(
        'if (x) {\n    a()\n    b()\n}\n',
        'if (x) {\n a()\n b()\n}',
        'if (x) {\n b()\n}',
      ),
    ).toBe('if (x) {\n    b()\n}\n')
  })
})
