// The edit_file engine: ordered text replacements with a whitespace-tolerant
// fallback, a git-style diff, and a descriptive error when nothing matches.
import fs from 'node:fs/promises'
import { createTwoFilesPatch } from 'diff'
import { normalizeLineEndings, writeFileContent } from './files.js'

export interface FileEdit {
  oldText: string
  newText: string
}

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

// What the no-match error shows. A model that sent oldText which
// differs from the file in a way the matcher does not tolerate (whitespace
// inside a line, a typo, stale content) needs the file's real text to retry
// with, so the error quotes the closest run of lines with their line
// numbers. Finding it compares oldText against the lines at every position
// of the file, so it is skipped past a fixed budget of bigram lookups rather
// than stalling the error on a huge file or a huge oldText.
const MISMATCH_WORK_LIMIT = 10_000_000
const MISMATCH_CONTEXT_LINES = 2
const MISMATCH_MAX_REGION_LINES = 30
// A quoted file line is cut at this many characters, so a long line (minified
// code, one-line JSON) cannot blow the error up to the size of the file.
const MISMATCH_MAX_LINE_CHARS = 500

interface LineGrams {
  grams: Map<string, number>
  size: number
}

/** A line's character bigrams with all whitespace removed, for similarity. */
function lineGrams(line: string): LineGrams {
  const text = line.replace(/\s+/g, '')
  const grams = new Map<string, number>()
  if (text.length === 1) grams.set(text, 1)
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let size = 0
  for (const count of grams.values()) size += count
  return { grams, size }
}

/** Dice similarity of two lines' bigrams: 1 for two blank lines, 0 for nothing shared. */
function lineSimilarity(a: LineGrams, b: LineGrams): number {
  if (a.size + b.size === 0) return 1
  let shared = 0
  for (const [gram, count] of a.grams) {
    shared += Math.min(count, b.grams.get(gram) ?? 0)
  }
  return (2 * shared) / (a.size + b.size)
}

/**
 * The error message for an edit that matched nowhere in `content` (the file
 * as the earlier edits in the same call left it). It names the edit, says
 * what the matcher tolerates, and quotes the run of file lines most similar
 * to oldText, numbered, with the first line that differs shown quoted so
 * whitespace is visible. It only reports: it never changes what matches.
 */
function describeEditMismatch(
  content: string,
  oldText: string,
  editIndex: number,
  editCount: number,
): string {
  const oldLines = normalizeLineEndings(oldText).split('\n')
  // The lines as the matcher sees them, so a terminal newline in oldText
  // lines up with the file's. The empty element after a terminal newline is
  // not a line of the file, so it is left out of what is counted and shown.
  const fileLines = content.split('\n')
  const lineCount = content.endsWith('\n')
    ? fileLines.length - 1
    : content === ''
      ? 0
      : fileLines.length

  const parts = [
    `Could not find exact match for edit ${editIndex + 1} of ${editCount}. ` +
      "oldText must match the file's text exactly; only line endings, and " +
      'leading and trailing whitespace on whole lines, may differ. ' +
      'No edits were applied.',
    `oldText:\n${oldText}`,
  ]

  if (lineCount === 0) {
    parts.push('The file is empty.')
    return parts.join('\n\n')
  }

  const oldGrams = oldLines.map(lineGrams)
  let oldWork = 0
  for (const line of oldGrams) oldWork += line.grams.size + 1
  if (fileLines.length * oldWork > MISMATCH_WORK_LIMIT) {
    parts.push(
      `The file has ${lineCount} lines, too many to search for the closest ` +
        'text to this oldText. Read the file and copy oldText from it exactly.',
    )
    return parts.join('\n\n')
  }

  // Every starting line is scored, including those near the end where fewer
  // lines than oldText has remain, so a near match at the end of the file is
  // still found. The earliest start wins a tie. A start is always a real
  // line, never the empty element after a terminal newline.
  const fileGrams = fileLines.map(lineGrams)
  let best = 0
  let bestScore = 0
  for (let i = 0; i < lineCount; i++) {
    const width = Math.min(oldLines.length, fileLines.length - i)
    let score = 0
    for (let j = 0; j < width; j++) {
      score += lineSimilarity(oldGrams[j], fileGrams[i + j])
    }
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }

  if (bestScore === 0) {
    parts.push(
      'No line of the file resembles oldText. Read the file and copy ' +
        'oldText from it exactly.',
    )
    return parts.join('\n\n')
  }

  const start = Math.min(
    Math.max(0, best - MISMATCH_CONTEXT_LINES),
    lineCount - 1,
  )
  const end = Math.min(
    lineCount,
    best + oldLines.length + MISMATCH_CONTEXT_LINES,
    start + MISMATCH_MAX_REGION_LINES,
  )
  let clipped = false
  const clip = (line: string): string => {
    if (line.length <= MISMATCH_MAX_LINE_CHARS) return line
    clipped = true
    return (
      line.slice(0, MISMATCH_MAX_LINE_CHARS) +
      ` [... cut: the line has ${line.length} characters]`
    )
  }
  const numbered = fileLines
    .slice(start, end)
    .map((line, k) => `${start + k + 1}: ${clip(line)}`)
  const after = editIndex > 0 ? ', after the earlier edits in this call' : ''
  parts.push(
    `Closest text in the file (lines ${start + 1}-${end} of ` +
      `${lineCount}${after}):\n${numbered.join('\n')}`,
  )

  // Some line differs beyond leading and trailing whitespace, or oldText runs
  // past the file's end: otherwise the line-by-line matcher would have
  // matched here. Math.max only keeps the index a valid one.
  const differs = Math.max(
    0,
    oldLines.findIndex(
      (line, j) =>
        best + j >= lineCount || line.trim() !== fileLines[best + j].trim(),
    ),
  )
  parts.push(
    best + differs >= lineCount
      ? `oldText line ${differs + 1} (${JSON.stringify(clip(oldLines[differs]))}) ` +
          `runs past the end of the file, which ends at line ${lineCount}.`
      : `First difference, oldText line ${differs + 1} against file line ` +
          `${best + differs + 1}:\n` +
          `  oldText: ${JSON.stringify(clip(oldLines[differs]))}\n` +
          `  file:    ${JSON.stringify(clip(fileLines[best + differs]))}`,
  )
  parts.push(
    clipped
      ? 'Some lines above were cut. Read the file to copy oldText from it ' +
          'exactly.'
      : 'Retry with oldText copied exactly from the file, without the ' +
          'line-number prefixes.',
  )
  return parts.join('\n\n')
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
  const bytes = await fs.readFile(filePath)
  const raw = bytes.toString('utf-8')
  // Decoding replaces invalid bytes with U+FFFD, and writing back would make
  // that permanent.
  if (!Buffer.from(raw, 'utf-8').equals(bytes)) {
    throw new Error(`Refusing to edit: not valid UTF-8 text: ${filePath}`)
  }
  if (edits.some((edit) => edit.oldText === '')) {
    throw new Error('oldText must not be empty')
  }
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
        describeEditMismatch(modified, edit.oldText, index, edits.length),
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
