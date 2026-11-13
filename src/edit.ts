// Adapted from modelcontextprotocol/servers (src/filesystem) and changed; see
// THIRD_PARTY_NOTICES.md for its licence.
// The edit_file engine: ordered text replacements with a whitespace-tolerant
// fallback, a git-style diff, and a descriptive error when nothing matches.
import { isUtf8 } from 'node:buffer'
import fs from 'node:fs/promises'
import { FILE_HEADERS_ONLY, createTwoFilesPatch } from 'diff'
import { z } from 'zod'
import { normalizeLineEndings, writeFileContent } from './files.js'

// The tool's input schema and the engine's argument type, defined once.
export const fileEditSchema = z.strictObject({
  oldText: z
    .string()
    .min(1)
    .describe('Text to find, copied exactly from the file.'),
  newText: z
    .string()
    .describe('Replacement text; empty to delete the matched text.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      'Replace every match of oldText. By default oldText must match exactly one place.',
    ),
})
type FileEdit = z.infer<typeof fileEditSchema>

// Utility helpers

/** Count occurrences of a pattern in text using regex. */
function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches?.length ?? 0
}

/** Detect whether file uses CRLF line endings (vs LF). */
function usesCRLF(content: string): boolean {
  const crlfCount = countMatches(content, /\r\n/g)
  const lfCount = countMatches(content, /(?<!\r)\n/g)
  return crlfCount > lfCount
}

/** Strip all whitespace from a line for comparison. */
function removeWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}

/** Clip a line at a character limit for display in error messages. */
function clipLine(
  line: string,
  maxChars: number = MISMATCH_MAX_LINE_CHARS,
): { clipped: string; wasCut: boolean } {
  if (line.length <= maxChars) {
    return { clipped: line, wasCut: false }
  }
  return {
    clipped:
      line.slice(0, maxChars) +
      ` [... cut: the line has ${line.length} characters]`,
    wasCut: true,
  }
}

function indentOf(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

/** `base` indentation moved by `delta` columns, adding the edit's own indent characters. */
function shiftIndent(base: string, editIndent: string, delta: number): string {
  return delta >= 0
    ? base + editIndent.slice(editIndent.length - delta)
    : base.slice(0, Math.max(0, base.length + delta))
}

/**
 * Indent the replacement lines of a whitespace-tolerant match. `fileLines` are
 * the file lines that matched `oldLines`.
 *
 * The edit's lines are lined up with the matched ones by their common leading
 * and trailing lines (the unchanged context around a change):
 * - a line with a counterpart in oldLines takes that file line's indentation,
 *   plus or minus how much the edit indents it more or less than the old line;
 * - a line the edit adds takes the indentation of the output line before it,
 *   plus or minus how much the edit indents it more or less than the line
 *   before it in the edit. (Anchoring it to oldText's last line instead put a
 *   line added to a block at the closing brace's level.)
 * A blank line is kept as given, and an indent never goes below column 0.
 */
function reindentReplacement(
  oldLines: string[],
  newLines: string[],
  fileLines: string[],
): string[] {
  const trimmed = (lines: string[], n: number) => lines[n].trim()
  const shared = Math.min(oldLines.length, newLines.length)
  let head = 0
  while (head < shared && trimmed(oldLines, head) === trimmed(newLines, head)) {
    head++
  }
  let tail = 0
  while (
    tail < shared - head &&
    trimmed(oldLines, oldLines.length - 1 - tail) ===
      trimmed(newLines, newLines.length - 1 - tail)
  ) {
    tail++
  }
  const changedOld = oldLines.length - head - tail

  // The old line a new line corresponds to, if it has one.
  const counterpart = (j: number): number | undefined => {
    if (j < head) return j
    if (j >= newLines.length - tail)
      return oldLines.length - (newLines.length - j)
    if (j - head < changedOld) return j
    return undefined
  }

  let previousEdit = -1 // indent width of the last non-blank line in the edit
  let previousOut = '' // and the indentation it was given
  return newLines.map((line, j) => {
    const body = line.trimStart()
    if (body === '') return line
    const editIndent = indentOf(line)
    const k = counterpart(j)
    const indent =
      k === undefined && previousEdit >= 0
        ? shiftIndent(previousOut, editIndent, editIndent.length - previousEdit)
        : shiftIndent(
            indentOf(fileLines[k ?? 0]),
            editIndent,
            editIndent.length - indentOf(oldLines[k ?? 0]).length,
          )
    previousEdit = editIndent.length
    previousOut = indent
    return indent + body
  })
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
  const text = removeWhitespace(line)
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

/** Find the file region most similar to oldText by bigram comparison. */
function findBestMatch(
  fileGrams: LineGrams[],
  oldGrams: LineGrams[],
  lineCount: number,
): { best: number; bestScore: number } {
  let best = 0
  let bestScore = 0
  for (let i = 0; i < lineCount; i++) {
    const width = Math.min(oldGrams.length, fileGrams.length - i)
    let score = 0
    for (let j = 0; j < width; j++) {
      score += lineSimilarity(oldGrams[j], fileGrams[i + j])
    }
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  }
  return { best, bestScore }
}

/** Format file lines with line numbers for error display. */
function formatContextLines(
  fileLines: string[],
  start: number,
  end: number,
): { formatted: string; wasCut: boolean } {
  let wasCut = false
  const numbered = fileLines.slice(start, end).map((line, k) => {
    const { clipped, wasCut: cut } = clipLine(line)
    wasCut = wasCut || cut
    return `${start + k + 1}: ${clipped}`
  })
  return { formatted: numbered.join('\n'), wasCut }
}

/** Format the first difference between oldText and the file. */
function formatDifference(
  oldLines: string[],
  fileLines: string[],
  best: number,
  lineCount: number,
): { message: string; wasCut: boolean } {
  const differs = Math.max(
    0,
    oldLines.findIndex(
      (line, j) =>
        best + j >= lineCount || line.trim() !== fileLines[best + j].trim(),
    ),
  )
  const oldDiffLine = clipLine(oldLines[differs])
  if (best + differs >= lineCount) {
    // There is no file line to show: the file ends before oldText does.
    return {
      message:
        `oldText line ${differs + 1} (${JSON.stringify(oldDiffLine.clipped)}) ` +
        `runs past the end of the file, which ends at line ${lineCount}.`,
      wasCut: oldDiffLine.wasCut,
    }
  }
  const fileDiffLine = clipLine(fileLines[best + differs])
  const message =
    `First difference, oldText line ${differs + 1} against file line ` +
    `${best + differs + 1}:\n` +
    `  oldText: ${JSON.stringify(oldDiffLine.clipped)}\n` +
    `  file:    ${JSON.stringify(fileDiffLine.clipped)}`
  return {
    message,
    wasCut: oldDiffLine.wasCut || fileDiffLine.wasCut,
  }
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

  const fileGrams = fileLines.map(lineGrams)
  const { best, bestScore } = findBestMatch(fileGrams, oldGrams, lineCount)

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
  const { formatted, wasCut: contextCut } = formatContextLines(
    fileLines,
    start,
    end,
  )
  const after = editIndex > 0 ? ', after the earlier edits in this call' : ''
  parts.push(
    `Closest text in the file (lines ${start + 1}-${end} of ` +
      `${lineCount}${after}):\n${formatted}`,
  )

  const { message, wasCut: diffCut } = formatDifference(
    oldLines,
    fileLines,
    best,
    lineCount,
  )
  parts.push(message)
  const wasCut = contextCut || diffCut
  parts.push(
    wasCut
      ? 'Some lines above were cut. Read the file to copy oldText from it ' +
          'exactly.'
      : 'Retry with oldText copied exactly from the file, without the ' +
          'line-number prefixes.',
  )
  return parts.join('\n\n')
}

/** Offsets of the non-overlapping occurrences of `needle` in `text`. */
function exactMatches(text: string, needle: string): number[] {
  const found: number[] = []
  for (
    let at = text.indexOf(needle);
    at !== -1;
    at = text.indexOf(needle, at + needle.length)
  ) {
    found.push(at)
  }
  return found
}

/** Start lines of the non-overlapping runs of `file` lines equal to `wanted` once trimmed. */
function lineMatches(file: string[], wanted: string[]): number[] {
  const found: number[] = []
  for (let i = 0; i <= file.length - wanted.length; i++) {
    if (wanted.every((line, j) => line.trim() === file[i + j].trim())) {
      found.push(i)
      i += wanted.length - 1
    }
  }
  return found
}

function ambiguousEdit(lines: number[], index: number, count: number): Error {
  const shown =
    lines.slice(0, 10).join(', ') + (lines.length > 10 ? ', ...' : '')
  return new Error(
    `Edit ${index + 1} of ${count}: oldText matches ${lines.length} places (lines ${shown}). ` +
      'Add surrounding lines to oldText so it matches once, or set replaceAll to true to ' +
      'replace every match. No edits were applied.',
  )
}

/**
 * Apply edits in order, each replacing the single match of oldText (or every
 * match with replaceAll). Without an exact match, falls back to matching whole
 * lines ignoring leading/trailing whitespace, in which case the replacement
 * takes the file's indentation. Returns a git-style diff. Nothing is written if
 * any edit has no match or an ambiguous one, or when dryRun is set.
 */
export async function applyFileEdits(
  filePath: string,
  edits: FileEdit[],
  dryRun = false,
  // The path shown in the diff header; the caller's own spelling rather than
  // the resolved real path.
  displayPath = filePath,
): Promise<string> {
  const bytes = await fs.readFile(filePath)
  const raw = bytes.toString('utf-8')
  // Decoding replaces invalid bytes with U+FFFD, and writing back would make
  // that permanent.
  if (!isUtf8(bytes)) {
    throw new Error(`Refusing to edit: not valid UTF-8 text: ${filePath}`)
  }
  if (edits.length === 0) throw new Error('edits must not be empty')
  if (edits.some((edit) => edit.oldText === '')) {
    throw new Error('oldText must not be empty')
  }
  const crlf = usesCRLF(raw)
  const original = normalizeLineEndings(raw)

  let modified = original
  for (const [index, edit] of edits.entries()) {
    const oldText = normalizeLineEndings(edit.oldText)
    const newText = normalizeLineEndings(edit.newText)

    const exact = exactMatches(modified, oldText)
    if (exact.length > 0) {
      if (exact.length > 1 && !edit.replaceAll) {
        const lineOf = (at: number) => modified.slice(0, at).split('\n').length
        throw ambiguousEdit(exact.map(lineOf), index, edits.length)
      }
      modified = edit.replaceAll
        ? modified.replaceAll(oldText, () => newText)
        : modified.replace(oldText, () => newText)
      continue
    }

    // No exact match: match whole lines ignoring leading and trailing whitespace.
    const oldLines = oldText.split('\n')
    const newLines = newText.split('\n')
    const lines = modified.split('\n')
    const starts = lineMatches(lines, oldLines)
    if (starts.length === 0) {
      throw new Error(
        describeEditMismatch(modified, edit.oldText, index, edits.length),
      )
    }
    if (starts.length > 1 && !edit.replaceAll) {
      throw ambiguousEdit(
        starts.map((start) => start + 1),
        index,
        edits.length,
      )
    }
    // Last match first, so the line numbers of the earlier ones stay valid.
    for (const start of (edit.replaceAll
      ? starts
      : starts.slice(0, 1)
    ).reverse()) {
      const replacement = reindentReplacement(
        oldLines,
        newLines,
        lines.slice(start, start + oldLines.length),
      )
      lines.splice(start, oldLines.length, ...replacement)
    }
    modified = lines.join('\n')
  }

  const diff = createTwoFilesPatch(
    displayPath,
    displayPath,
    original,
    modified,
    undefined,
    undefined,
    // Just the two file lines: the "Index:" and "====" lines carry nothing.
    { headerOptions: FILE_HEADERS_ONLY },
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
