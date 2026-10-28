/**
 * Inline (word/char-level) diff helpers for Markdown prose.
 *
 * Implements the second pass of issue #96: for each modified line pair
 * (a removed line immediately matched with an added line), compute an
 * ordered fragment stream (removed/added/unchanged) using jsdiff:
 *
 * - CJK text (no whitespace tokenization) → `diffChars`
 * - Latin-only text → `diffWordsWithSpace`
 *
 * Lines longer than `MAX_INLINE_DIFF_LENGTH` skip the second pass
 * entirely and keep the whole-line added/removed styling — jsdiff is
 * synchronous and would freeze the reviewer's tab on huge lines.
 *
 * Code files never enter this path (content-type split is decided by the
 * caller via file extension). The fragment stream is mode-agnostic —
 * fusing into one track-changes row vs paired rows is a render-layer
 * decision (see LazyDiffViewer).
 */

import { diffChars, diffWordsWithSpace } from 'diff'

// ── Types ──────────────────────────────────────────────────────────────────

/** A piece of the fused content stream, in jsdiff output order */
export interface InlineFragment {
  type: 'equal' | 'removed' | 'added'
  value: string
}

/**
 * A hunk line from the existing line-level diff, narrowed to what the
 * fusion step needs (keeps this module independent of viewer internals).
 */
export interface FuseableLine {
  type: 'added' | 'removed'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

/** A modified line pair fused into a single track-changes row */
export interface FusedRow {
  kind: 'fused'
  fragments: InlineFragment[]
  /** Gutter shows the NEW line number only (the surviving line) */
  newLineNo: number
}

/** A pure-added / pure-removed line — falls back to full-line styling */
export interface PlainRow {
  kind: 'line'
  line: FuseableLine
}

export type DiffRow = FusedRow | PlainRow

// ── Strategy detection ─────────────────────────────────────────────────────

/**
 * CJK detection: Han, Hiragana/Katakana, Hangul.
 * `diffWords*` tokenizes on whitespace/punctuation, so a Chinese sentence
 * (no spaces) would collapse into a single token — CJK lines must use
 * char-level diffing instead.
 */
const CJK_PATTERN = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/

export function containsCJK(text: string): boolean {
  return CJK_PATTERN.test(text)
}

/**
 * Per-line-pair strategy: if EITHER side contains CJK, use char-level
 * diffing (mixed-language lines degrade to diffChars, which handles
 * Latin runs acceptably); otherwise use word-level with whitespace.
 */
export function detectInlineStrategy(
  oldLine: string,
  newLine: string,
): 'chars' | 'words' {
  return containsCJK(oldLine) || containsCJK(newLine) ? 'chars' : 'words'
}

// ── Fragment computation ───────────────────────────────────────────────────

/**
 * Maximum line length (in characters) that may enter the second-pass
 * inline diff.
 *
 * jsdiff runs synchronously on the main thread: diffing a single line with
 * tens of thousands of characters can burn seconds of CPU and freeze the
 * reviewer's tab. Lines above this bound skip inline splitting entirely
 * and keep the whole-line added/removed styling.
 */
export const MAX_INLINE_DIFF_LENGTH = 5000

/**
 * Wall-clock budget (milliseconds) for one inline diff.
 *
 * jsdiff's Myers implementation is O(N·D) — two lines that share no
 * comparable chunks are the worst case, and even a line under
 * `MAX_INLINE_DIFF_LENGTH` can take seconds to diff. `diffChars` /
 * `diffWordsWithSpace` accept a `timeout` and return `undefined` when the
 * budget is exhausted, which keeps the main thread responsive.
 */
export const INLINE_DIFF_TIMEOUT_MS = 200

/**
 * True when any of the given lines is too long to be diffed inline.
 * Callers MUST NOT invoke `diffChars` / `diffWordsWithSpace` for lines
 * that exceed the bound.
 */
export function exceedsInlineDiffLimit(...lines: string[]): boolean {
  return lines.some((line) => line.length > MAX_INLINE_DIFF_LENGTH)
}

/**
 * Whole-line fallback for a pair that must not be split inline.
 * The old side renders as one removed fragment, the new side as one
 * added fragment — the same styling as any other changed run, just
 * covering the entire line.
 */
function wholeLineFragments(oldLine: string, newLine: string): InlineFragment[] {
  return [
    { type: 'removed', value: oldLine },
    { type: 'added', value: newLine },
  ]
}

/**
 * Compute the ordered fragment stream for one modified line pair.
 * Fragments preserve jsdiff output order (removed before its added
 * counterpart), so rendering them in one content flow reads naturally.
 *
 * Over-limit lines never reach jsdiff — they degrade to a whole-line
 * removed/added pair (see `MAX_INLINE_DIFF_LENGTH`). Lines within the
 * limit that still exceed the time budget degrade the same way.
 */
export function computeInlineFragments(
  oldLine: string,
  newLine: string,
): InlineFragment[] {
  // Guard first: never hand an over-limit line to jsdiff.
  if (exceedsInlineDiffLimit(oldLine, newLine)) {
    return wholeLineFragments(oldLine, newLine)
  }

  const strategy = detectInlineStrategy(oldLine, newLine)
  const changes =
    strategy === 'chars'
      ? diffChars(oldLine, newLine, { timeout: INLINE_DIFF_TIMEOUT_MS })
      : diffWordsWithSpace(oldLine, newLine, { timeout: INLINE_DIFF_TIMEOUT_MS })

  // `undefined` means jsdiff hit the time budget — fall back to
  // whole-line styling instead of blocking the reviewer.
  if (!changes) {
    return wholeLineFragments(oldLine, newLine)
  }

  return changes.map((change) => ({
    type: change.added ? 'added' : change.removed ? 'removed' : 'equal',
    value: change.value,
  }))
}

// ── Hunk fusion ────────────────────────────────────────────────────────────

/**
 * Fuse a hunk's changed lines into render rows.
 *
 * The line-level pass emits each hunk as a removed block followed by an
 * added block. Index-aligned lines across the two blocks are treated as
 * modified pairs and fused; leftovers (count mismatch) stay as plain
 * rows and keep the existing full-line green/red styling.
 *
 * Runs only on changed line pairs and only for markdown files — the
 * caller memoizes the result per hunk.
 */
export function fuseHunkLines(lines: FuseableLine[]): DiffRow[] {
  const removed = lines.filter((l) => l.type === 'removed')
  const added = lines.filter((l) => l.type === 'added')
  const pairCount = Math.min(removed.length, added.length)

  const rows: DiffRow[] = []

  for (let i = 0; i < pairCount; i++) {
    rows.push({
      kind: 'fused',
      fragments: computeInlineFragments(removed[i].content, added[i].content),
      newLineNo: added[i].newLineNo ?? 0,
    })
  }

  // Leftovers keep their original relative order (removed block precedes
  // added block, per the line-level diff output).
  for (const line of removed.slice(pairCount)) {
    rows.push({ kind: 'line', line })
  }
  for (const line of added.slice(pairCount)) {
    rows.push({ kind: 'line', line })
  }

  return rows
}
