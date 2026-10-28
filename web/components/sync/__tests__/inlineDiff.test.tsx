/**
 * Unit tests for inline (word/char-level) diff fusion — issue #96.
 *
 * Covers: CJK → diffChars segmentation, Latin → diffWordsWithSpace,
 * mixed-language degradation, fragment-stream ordering, code-file
 * non-interference, pure add/remove fallback, and long-line (200+ chars)
 * fragment integrity.
 *
 * The `diff` module is mocked so the suite can assert that over-long lines
 * never reach jsdiff at all (the second pass must not block the reviewer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>()
  return {
    ...actual,
    diffChars: vi.fn(actual.diffChars),
    diffWordsWithSpace: vi.fn(actual.diffWordsWithSpace),
  }
})

import { diffChars, diffWordsWithSpace } from 'diff'
import {
  containsCJK,
  detectInlineStrategy,
  computeInlineFragments,
  fuseHunkLines,
  exceedsInlineDiffLimit,
  MAX_INLINE_DIFF_LENGTH,
} from '../inlineDiff'
import LazyDiffViewer from '../LazyDiffViewer'

// ── Strategy detection ─────────────────────────────────────────────────────

describe('containsCJK', () => {
  it('detects Han characters', () => {
    expect(containsCJK('这是中文')).toBe(true)
  })

  it('detects Hiragana/Katakana', () => {
    expect(containsCJK('ひらがなカタカナ')).toBe(true)
  })

  it('detects Hangul', () => {
    expect(containsCJK('한국어')).toBe(true)
  })

  it('returns false for Latin-only text', () => {
    expect(containsCJK('plain english text')).toBe(false)
  })
})

describe('detectInlineStrategy', () => {
  it('uses chars when the old line contains CJK', () => {
    expect(detectInlineStrategy('旧文本', 'new text')).toBe('chars')
  })

  it('uses chars when the new line contains CJK', () => {
    expect(detectInlineStrategy('old text', '新文本')).toBe('chars')
  })

  it('uses words for Latin-only pairs', () => {
    expect(detectInlineStrategy('old text', 'new text')).toBe('words')
  })
})

// ── Fragment computation ───────────────────────────────────────────────────

describe('computeInlineFragments', () => {
  beforeEach(() => {
    vi.mocked(diffChars).mockClear()
    vi.mocked(diffWordsWithSpace).mockClear()
  })

  it('segments CJK sentences at char level (no whole-sentence collapse)', () => {
    // A diffWords* tokenizer would collapse the spaceless Chinese sentence
    // into a single token; diffChars must isolate the edited run.
    const oldLine = '今天天气很好'
    const newLine = '今天气候很好'
    const fragments = computeInlineFragments(oldLine, newLine)
    const changed = fragments.filter((f) => f.type !== 'equal')
    // The differing run is tiny, not the whole sentence.
    const changedChars = changed.reduce((sum, f) => sum + f.value.length, 0)
    expect(changedChars).toBeLessThan(oldLine.length)

    // Reconstruction preserves both sides exactly.
    const removed = fragments.filter((f) => f.type === 'removed').map((f) => f.value).join('')
    const added = fragments.filter((f) => f.type === 'added').map((f) => f.value).join('')
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
    expect(removed.length).toBeGreaterThan(0)
    expect(added.length).toBeGreaterThan(0)
  })

  it('uses word-level segments for Latin text', () => {
    const fragments = computeInlineFragments(
      'The quick brown fox',
      'The quick red fox',
    )
    // Word-level diff keeps 'brown' → 'red' as whole-word fragments.
    expect(fragments).toEqual([
      { type: 'equal', value: 'The quick ' },
      { type: 'removed', value: 'brown' },
      { type: 'added', value: 'red' },
      { type: 'equal', value: ' fox' },
    ])
  })

  it('degrades mixed-language lines to char-level diffing', () => {
    const oldLine = 'use the update button 更新'
    const newLine = 'use the refresh button 更新'
    const fragments = computeInlineFragments(oldLine, newLine)
    const removed = fragments.filter((f) => f.type === 'removed').map((f) => f.value).join('')
    // diffChars splits inside the word — reconstruct via fragment mapping
    // to verify the streams rebuild both sides exactly.
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
    expect(removed).toContain('updat')
    // The CJK tail survives untouched as an equal fragment.
    expect(fragments.some((f) => f.type === 'equal' && f.value.includes('更新'))).toBe(true)
  })

  it('emits fragments in jsdiff order (removed before its added counterpart)', () => {
    const fragments = computeInlineFragments('alpha beta', 'alpha gamma')
    const types = fragments.filter((f) => f.type !== 'equal').map((f) => f.type)
    // Within the changed region, removed precedes added.
    expect(types).toEqual(['removed', 'added'])
  })

  it('handles 200+ char lines: the edit stays isolated and fragments reconstruct both sides', () => {
    const prefix = 'This is a long introductory sentence that pads the line. '.repeat(4) // ~240 chars
    const oldLine = prefix + 'original' + ' trailing context that also pads the line beyond wrap width.'
    const newLine = prefix + 'revised' + ' trailing context that also pads the line beyond wrap width.'
    expect(oldLine.length).toBeGreaterThan(200)

    const fragments = computeInlineFragments(oldLine, newLine)
    // The single-word edit is isolated — not the whole 200+ line.
    const changed = fragments.filter((f) => f.type !== 'equal')
    expect(changed.map((f) => f.value)).toEqual(['original', 'revised'])

    // Reconstruction is exact, so wrapped rendering keeps every span.
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
  })
})

// ── Over-limit lines (issue #96 Sourcery review — freeze guard) ───────────

describe('computeInlineFragments over-limit guard', () => {
  beforeEach(() => {
    vi.mocked(diffChars).mockClear()
    vi.mocked(diffWordsWithSpace).mockClear()
  })

  it('never calls jsdiff for lines above the length limit', () => {
    const oldLine = 'x'.repeat(MAX_INLINE_DIFF_LENGTH + 1)
    const newLine = 'y'.repeat(MAX_INLINE_DIFF_LENGTH + 1)

    computeInlineFragments(oldLine, newLine)

    // The whole point: the second pass must not run on huge lines.
    expect(vi.mocked(diffChars)).not.toHaveBeenCalled()
    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled()
  })

  it('does not call jsdiff when only one side exceeds the limit', () => {
    const oldLine = 'short line'
    const newLine = 'z'.repeat(MAX_INLINE_DIFF_LENGTH + 1)

    computeInlineFragments(oldLine, newLine)

    expect(vi.mocked(diffChars)).not.toHaveBeenCalled()
    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled()
  })

  it('degrades an over-limit line to whole-line removed/added fragments', () => {
    const oldLine = 'x'.repeat(MAX_INLINE_DIFF_LENGTH + 1)
    const newLine = 'y'.repeat(MAX_INLINE_DIFF_LENGTH + 1)

    const fragments = computeInlineFragments(oldLine, newLine)

    // Exactly two fragments: the whole old line, then the whole new line.
    expect(fragments).toEqual([
      { type: 'removed', value: oldLine },
      { type: 'added', value: newLine },
    ])
    // Both sides are preserved verbatim.
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
  })

  it('still diffs lines exactly at the limit (boundary is inclusive)', () => {
    const oldLine = 'x'.repeat(MAX_INLINE_DIFF_LENGTH)
    const newLine = 'y'.repeat(MAX_INLINE_DIFF_LENGTH)

    computeInlineFragments(oldLine, newLine)

    // At the limit the normal second pass still applies. (Latin-only
    // content → word-level strategy.)
    expect(vi.mocked(diffWordsWithSpace)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(diffChars)).not.toHaveBeenCalled()
  })

  it('exceedsInlineDiffLimit reports the bound correctly', () => {
    expect(exceedsInlineDiffLimit('a'.repeat(MAX_INLINE_DIFF_LENGTH))).toBe(false)
    expect(exceedsInlineDiffLimit('a'.repeat(MAX_INLINE_DIFF_LENGTH + 1))).toBe(true)
    expect(exceedsInlineDiffLimit('short', 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 1))).toBe(true)
  })

  it('does not freeze the caller on an adversarial over-limit line', () => {
    // The pathological shape for jsdiff: two long lines sharing no chunks.
    // Before the guard this took multiple seconds on the main thread.
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 500)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 500)

    const started = Date.now()
    const fragments = computeInlineFragments(oldLine, newLine)
    const elapsed = Date.now() - started

    expect(fragments).toHaveLength(2)
    expect(elapsed).toBeLessThan(1000)
  })

  it('keeps a fused row for an over-limit pair (whole-line styling, not dropped)', () => {
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 1)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 1)

    const rows = fuseHunkLines([
      { type: 'removed', content: oldLine, oldLineNo: 1 },
      { type: 'added', content: newLine, newLineNo: 1 },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('fused')
    if (rows[0].kind === 'fused') {
      expect(rows[0].fragments).toEqual([
        { type: 'removed', value: oldLine },
        { type: 'added', value: newLine },
      ])
    }
  })
})

// ── Hunk fusion ────────────────────────────────────────────────────────────

describe('fuseHunkLines', () => {
  it('fuses index-aligned removed/added pairs into a single row', () => {
    const rows = fuseHunkLines([
      { type: 'removed', content: 'old text here', oldLineNo: 3 },
      { type: 'added', content: 'new text here', newLineNo: 3 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('fused')
    if (rows[0].kind === 'fused') {
      expect(rows[0].newLineNo).toBe(3)
      expect(rows[0].fragments).toEqual([
        { type: 'removed', value: 'old' },
        { type: 'added', value: 'new' },
        { type: 'equal', value: ' text here' },
      ])
    }
  })

  it('keeps surplus lines as plain rows when counts mismatch', () => {
    const rows = fuseHunkLines([
      { type: 'removed', content: 'matched old', oldLineNo: 1 },
      { type: 'removed', content: 'orphan old', oldLineNo: 2 },
      { type: 'added', content: 'matched new', newLineNo: 1 },
    ])
    const fused = rows.filter((r) => r.kind === 'fused')
    const plain = rows.filter((r) => r.kind === 'line')
    expect(fused).toHaveLength(1)
    expect(plain).toHaveLength(1)
    // Leftover removed keeps full-line styling data.
    expect(plain[0].kind === 'line' && plain[0].line.content).toBe('orphan old')
  })

  it('falls back to all-plain rows for pure additions', () => {
    const input = [
      { type: 'added' as const, content: 'line one', newLineNo: 5 },
      { type: 'added' as const, content: 'line two', newLineNo: 6 },
    ]
    const rows = fuseHunkLines(input)

    expect(rows.every((r) => r.kind === 'line')).toBe(true)
    // No input line may be dropped: `every` is vacuously true for an
    // empty array, so the row count and the per-row content are asserted.
    expect(rows).toHaveLength(input.length)
    expect(rows.map((r) => (r.kind === 'line' ? r.line.content : null))).toEqual([
      'line one',
      'line two',
    ])
    expect(rows.map((r) => (r.kind === 'line' ? r.line.newLineNo : null))).toEqual([5, 6])
  })

  it('falls back to all-plain rows for pure removals', () => {
    const input = [
      { type: 'removed' as const, content: 'line one', oldLineNo: 5 },
      { type: 'removed' as const, content: 'line two', oldLineNo: 6 },
    ]
    const rows = fuseHunkLines(input)

    expect(rows.every((r) => r.kind === 'line')).toBe(true)
    // Same anti-vacuous-truth guard as the pure-addition case.
    expect(rows).toHaveLength(input.length)
    expect(rows.map((r) => (r.kind === 'line' ? r.line.content : null))).toEqual([
      'line one',
      'line two',
    ])
    expect(rows.map((r) => (r.kind === 'line' ? r.line.oldLineNo : null))).toEqual([5, 6])
  })
})

// ── Content-type split (component level) ───────────────────────────────────

describe('LazyDiffViewer content-type split', () => {
  const original = 'The quick brown fox\nkept line\nremoved entirely'
  const modified = 'The quick red fox\nkept line\nadded entirely'

  it('renders a single fused track-changes row for markdown modified pairs', () => {
    render(
      <LazyDiffViewer
        original={original}
        modified={modified}
        path="notes.md"
      />,
    )
    // The fused row contains both sides in one content flow.
    const row = screen.getByText('red')
    expect(row).toBeDefined()
    expect(row.textContent).toBe('red')
    expect(screen.getByText('brown')).toBeDefined()
    // Both modified pairs fuse (line 1 and line 3), each with its own gutter.
    expect(screen.getAllByText('~')).toHaveLength(2)
    // Fused rows are NOT full-line green/red — no '−'/'+' markers for the pairs.
    expect(screen.queryByText('−')).toBeNull()
    expect(screen.queryByText('+')).toBeNull()
  })

  it('keeps the removed and added fragments in the SAME track-changes row', () => {
    render(
      <LazyDiffViewer
        original={original}
        modified={modified}
        path="notes.md"
      />,
    )

    // The fixture has two fused rows; check the first one.
    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows.length).toBeGreaterThan(0)
    const firstRow = rows[0]

    const removed = firstRow.querySelector('[data-testid="track-changes-removed"]')
    const added = firstRow.querySelector('[data-testid="track-changes-added"]')
    expect(removed).not.toBeNull()
    expect(added).not.toBeNull()

    // Both fragments must live under the same row container — rendering
    // them in two separate rows would still satisfy the text/gutter
    // assertions above, so the shared ancestor is asserted explicitly.
    const removedRow = removed!.closest('[data-testid="track-changes-line"]')
    const addedRow = added!.closest('[data-testid="track-changes-line"]')
    expect(removedRow).not.toBeNull()
    expect(addedRow).not.toBeNull()
    expect(removedRow).toBe(addedRow)
    expect(removedRow).toBe(firstRow)

    // They also share the SAME content-flow parent — a renderer that
    // splits the fragments into sibling rows (or sibling content boxes)
    // must fail here.
    expect(removed!.parentElement).toBe(added!.parentElement)

    // And they are different fragments of that one row.
    expect(removed).not.toBe(added)
  })

  it('gives unchanged fragments an explicit foreground color', () => {
    render(
      <LazyDiffViewer
        original={original}
        modified={modified}
        path="notes.md"
      />,
    )

    const equal = screen.getAllByTestId('track-changes-equal')
    expect(equal.length).toBeGreaterThan(0)

    for (const fragment of equal) {
      // The row surface is a dark tint in BOTH themes, so unchanged text
      // must carry its own foreground instead of inheriting the theme's
      // (near-black in light mode) foreground color.
      const className = fragment.className
      expect(className).toMatch(/text-(neutral|foreground)/)
      // Tailwind's `text-neutral-100` resolves to a light value in light
      // mode (#F3F4F6) and in dark mode (#E8ECEF).
      expect(className).toContain('text-neutral-100')
    }
  })

  it('keeps full-line −/+ markers for pure-removed/pure-added blocks in markdown', () => {
    render(
      <LazyDiffViewer
        original={'kept\nremove me a\nremove me b'}
        modified={'kept\nbrand new line'}
        path="notes.md"
      />,
    )
    // 2 removed vs 1 added: one pair fuses only if adjacent — here the diff
    // yields a pure-removed block, so full-line styling applies.
    expect(screen.getAllByText('−').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps full-line +/− markers when a markdown hunk has count mismatch', () => {
    // One hunk with a pure added block (2 added, 0 removed) + a second hunk
    // with a 1:1 modified pair that fuses.
    const orig = 'alpha beta\nkept\nold one'
    const mod = 'alpha gamma\nkept\nnew one\npure add a\npure add b'
    render(
      <LazyDiffViewer
        original={orig}
        modified={mod}
        path="notes.md"
      />,
    )
    // Pure-added block keeps full-line '+' markers; the fused pair shows none.
    expect(screen.getAllByText('+')).toHaveLength(2)
    expect(screen.queryByText('−')).toBeNull()
  })

  it('keeps full-line −/＋ markers for a pure-removed markdown block', () => {
    render(
      <LazyDiffViewer
        original={'kept\nremove me a\nremove me b'}
        modified={'kept'}
        path="notes.md"
      />,
    )
    expect(screen.getAllByText('−')).toHaveLength(2)
    expect(screen.queryByText('~')).toBeNull()
  })

  it('renders code files with the existing line-level view (no fusion)', () => {
    render(
      <LazyDiffViewer
        original={original}
        modified={modified}
        path="src/example.ts"
      />,
    )
    // Line-level: paired −/+ rows for each modified line, no fused marker.
    expect(screen.getAllByText('−')).toHaveLength(2)
    expect(screen.getAllByText('+')).toHaveLength(2)
    expect(screen.queryByText('~')).toBeNull()
  })

  it('detects .mdx as markdown too', () => {
    render(
      <LazyDiffViewer
        original={'alpha beta'}
        modified={'alpha gamma'}
        path="docs/guide.mdx"
      />,
    )
    expect(screen.queryByText('−')).toBeNull()
    expect(screen.getByText('~')).toBeDefined()
  })

  it('renders 200+ char markdown line with the edit highlight intact', () => {
    const prefix = 'Long prose line that keeps going and going for wrap testing. '.repeat(4)
    render(
      <LazyDiffViewer
        original={prefix + 'original'}
        modified={prefix + 'revised'}
        path="long.md"
      />,
    )
    expect(screen.getByText('original')).toBeDefined()
    expect(screen.getByText('revised')).toBeDefined()
  })

  it('renders an over-limit markdown line as one whole-line pair without freezing', () => {
    // A huge line must still render (as whole-line added/removed styling)
    // and must not block the main thread.
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 100)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 100)

    const started = Date.now()
    render(
      <LazyDiffViewer
        original={oldLine}
        modified={newLine}
        path="huge.md"
      />,
    )
    const elapsed = Date.now() - started

    // The row is rendered...
    expect(screen.getAllByTestId('track-changes-line').length).toBeGreaterThan(0)
    // ...with the whole line as one removed fragment and one added fragment.
    const removed = screen.getByTestId('track-changes-removed')
    const added = screen.getByTestId('track-changes-added')
    expect(removed.textContent).toBe(oldLine)
    expect(added.textContent).toBe(newLine)
    // ...and it did not take seconds.
    expect(elapsed).toBeLessThan(5000)
  })
})
