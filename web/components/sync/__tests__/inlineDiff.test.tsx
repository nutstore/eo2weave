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
  createInlineDiffBudget,
  MAX_INLINE_DIFF_LENGTH,
  INLINE_DIFF_TIMEOUT_MS,
} from '@/components/sync/inlineDiff'
import LazyDiffViewer from '@/components/sync/LazyDiffViewer'

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

  it('detects Han characters in Extension A', () => {
    // U+3400–U+4DBF (Extension A)
    expect(containsCJK('㐀㐁')).toBe(true)
  })

  it('detects Han characters in the supplementary planes', () => {
    // U+20000–U+2A6DF (Extension B) and U+30000–U+3134F (Extension G)
    expect(containsCJK('\u{20000}')).toBe(true)
    expect(containsCJK('\u{30000}')).toBe(true)
  })

  it('detects CJK compatibility ideographs', () => {
    // U+F900–U+FAFF
    expect(containsCJK('豈')).toBe(true)
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
    // Reconstruction alone (and a `toContain` on the removed text) would
    // also pass if the wrong strategy were used — a word-level diff of
    // these lines yields removed='update' / added='refresh', which still
    // reconstructs both sides and still contains 'updat'. So the exact
    // fragment boundaries are asserted instead: char-level diffing splits
    // INSIDE the latin words ('updat' / 'r'+'fresh'), while a word-level
    // diff would emit the whole words as single fragments.
    const oldLine = 'use the update button 更新'
    const newLine = 'use the refresh button 更新'
    const fragments = computeInlineFragments(oldLine, newLine)
    const removed = fragments.filter((f) => f.type === 'removed').map((f) => f.value).join('')
    const added = fragments.filter((f) => f.type === 'added').map((f) => f.value).join('')
    // The changed run is cut inside the word, not at the word boundary.
    expect(removed).toBe('updat')
    expect(added).toBe('rfresh')
    // A word-level diff would have produced whole-word fragments.
    expect(removed).not.toBe('update')
    expect(added).not.toBe('refresh')
    // ...and the changed run is split into more than one added fragment,
    // which only happens at character granularity.
    expect(fragments.filter((f) => f.type === 'added')).toHaveLength(2)

    // Reconstruction still preserves both sides exactly.
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
    // The CJK tail survives untouched as an equal fragment.
    expect(fragments.some((f) => f.type === 'equal' && f.value.includes('更新'))).toBe(true)
  })

  it('uses char-level diffing for a mixed-language line, not word-level', () => {
    // Reconstruction alone would also pass if the wrong strategy were
    // used, so the fragment boundaries are asserted explicitly: word-level
    // diffing emits whole-word fragments ('update' / 'refresh'), while
    // char-level diffing splits inside the word.
    const oldLine = 'use the update button 更新'
    const newLine = 'use the refresh button 更新'

    const fragments = computeInlineFragments(oldLine, newLine)

    const removed = fragments.filter((f) => f.type === 'removed').map((f) => f.value).join('')
    const added = fragments.filter((f) => f.type === 'added').map((f) => f.value).join('')
    // The changed run is cut inside the word, not at the word boundary.
    expect(removed).toBe('updat')
    expect(added).toBe('rfresh')
    // A word-level diff would have produced whole-word fragments.
    expect(removed).not.toBe('update')
    expect(added).not.toBe('refresh')
    // ...and the changed run is split into more than one fragment, which
    // only happens at character granularity.
    expect(fragments.filter((f) => f.type === 'added')).toHaveLength(2)
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

  it('does not hand an adversarial over-limit line to jsdiff', () => {
    // The pathological shape for jsdiff: two long lines sharing no chunks.
    // Before the guard this took multiple seconds on the main thread.
    // The guarantee is asserted structurally (jsdiff is never called)
    // rather than by wall-clock timing, which would flake on a loaded
    // CI machine.
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 500)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 500)

    const fragments = computeInlineFragments(oldLine, newLine)

    expect(fragments).toHaveLength(2)
    expect(vi.mocked(diffChars)).not.toHaveBeenCalled()
    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled()
  })

  it('shares one time budget across all pairs of a diff', () => {
    // A budget that is already spent must stop further inline diffing
    // instead of giving every pair a fresh allowance.
    const budget = createInlineDiffBudget(0)

    const fragments = computeInlineFragments('alpha beta', 'alpha gamma', budget)

    // The budget is spent → whole-line fallback, jsdiff not called.
    expect(fragments).toEqual([
      { type: 'removed', value: 'alpha beta' },
      { type: 'added', value: 'alpha gamma' },
    ])
    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled()
  })

  it('passes the shared budget through fuseHunkLines so pairs share it', () => {
    // Budget already spent → both pairs degrade to whole-line styling.
    const budget = createInlineDiffBudget(0)
    const rows = fuseHunkLines(
      [
        { type: 'removed', content: 'alpha beta', oldLineNo: 1 },
        { type: 'added', content: 'alpha gamma', newLineNo: 1 },
        { type: 'removed', content: 'delta epsilon', oldLineNo: 2 },
        { type: 'added', content: 'delta zeta', newLineNo: 2 },
      ],
      budget,
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'fused')).toBe(true)
    // The budget is exhausted → each fused row must carry the whole-line
    // fallback fragments, not empty fragments.
    expect(rows.map((r) => (r.kind === 'fused' ? r.fragments : null))).toEqual([
      [
        { type: 'removed', value: 'alpha beta' },
        { type: 'added', value: 'alpha gamma' },
      ],
      [
        { type: 'removed', value: 'delta epsilon' },
        { type: 'added', value: 'delta zeta' },
      ],
    ])
    expect(vi.mocked(diffWordsWithSpace)).not.toHaveBeenCalled()
  })

  it('uses the shared budget when it still has time left', () => {
    const budget = createInlineDiffBudget(60_000)

    const fragments = computeInlineFragments('alpha beta', 'alpha gamma', budget)

    // Normal inline diffing still happens.
    expect(fragments).toEqual([
      { type: 'equal', value: 'alpha ' },
      { type: 'removed', value: 'beta' },
      { type: 'added', value: 'gamma' },
    ])
    expect(vi.mocked(diffWordsWithSpace)).toHaveBeenCalledTimes(1)
    // The call must still carry a per-pair timeout bound — a regression that
    // drops the option would let an under-limit pair block unbounded.
    expect(vi.mocked(diffWordsWithSpace)).toHaveBeenCalledWith(
      'alpha beta',
      'alpha gamma',
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
    expect(
      (vi.mocked(diffWordsWithSpace).mock.calls[0]?.[2] as { timeout: number } | undefined)
        ?.timeout,
    ).toBeLessThanOrEqual(INLINE_DIFF_TIMEOUT_MS)
  })

  it('falls back to whole-line fragments when jsdiff times out', () => {
    const budget = createInlineDiffBudget(60_000)
    // jsdiff returns `undefined` when the per-call timeout is hit.
    vi.mocked(diffWordsWithSpace).mockReturnValueOnce(
      undefined as unknown as ReturnType<typeof diffWordsWithSpace>,
    )

    const fragments = computeInlineFragments('alpha beta', 'alpha gamma', budget)

    // The timed-out diff degrades to whole-line styling, not garbage output.
    expect(fragments).toEqual([
      { type: 'removed', value: 'alpha beta' },
      { type: 'added', value: 'alpha gamma' },
    ])
    expect(vi.mocked(diffWordsWithSpace)).toHaveBeenCalledTimes(1)
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

  it('exposes removed and added fragments to assistive technology', () => {
    render(
      <LazyDiffViewer
        original={original}
        modified={modified}
        path="notes.md"
      />
    )

    // Removed fragments render as semantic <del> (implicit `deletion` role),
    // added fragments as semantic <ins> (implicit `insertion` role), so a
    // screen reader can distinguish deleted from inserted text.
    const removed = screen.getAllByTestId('track-changes-removed')
    expect(removed.length).toBeGreaterThan(0)
    for (const fragment of removed) {
      expect(fragment.tagName).toBe('DEL')
      expect(fragment.getAttribute('role')).toBeNull()
    }

    const added = screen.getAllByTestId('track-changes-added')
    expect(added.length).toBeGreaterThan(0)
    for (const fragment of added) {
      expect(fragment.tagName).toBe('INS')
      expect(fragment.getAttribute('role')).toBeNull()
    }

    // The fragments must actually be VISIBLE to the accessibility tree —
    // tagName/role alone would still pass if the content were hidden with
    // aria-hidden="true", display:none, visibility:hidden or the hidden
    // attribute, none of which a screen reader can see. getByRole computes
    // roles from the accessibility tree and skips hidden elements, so these
    // queries double as the visibility guard against that regression.
    expect(screen.getAllByRole('deletion')).toEqual(removed)
    expect(screen.getAllByRole('insertion')).toEqual(added)
    for (const fragment of [...removed, ...added]) {
      expect(fragment.getAttribute('aria-hidden')).toBeNull()
      expect(fragment.hasAttribute('hidden')).toBe(false)
      expect(fragment.style.display).not.toBe('none')
      expect(fragment.style.visibility).not.toBe('hidden')
    }
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

    // The unchanged context must survive too — a renderer that dropped
    // the equal fragments would still satisfy the two assertions above.
    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows).toHaveLength(1)
    const equal = rows[0].querySelectorAll('[data-testid="track-changes-equal"]')
    expect(equal.length).toBeGreaterThan(0)
    const equalText = Array.from(equal).map((e) => e.textContent).join('')
    expect(equalText).toContain('Long prose line that keeps going')
    // The whole unchanged prefix is preserved, not just its start.
    expect(equalText).toBe(prefix)
  })

  it('renders an over-limit markdown line as one whole-line fused row', () => {
    // A huge line must still render (as whole-line added/removed styling)
    // as ONE fused row.
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 100)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 100)

    render(
      <LazyDiffViewer
        original={oldLine}
        modified={newLine}
        path="huge.md"
      />,
    )

    // The row is rendered...
    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows).toHaveLength(1)
    // ...with the whole line as one removed fragment and one added fragment.
    const removed = rows[0].querySelector('[data-testid="track-changes-removed"]')
    const added = rows[0].querySelector('[data-testid="track-changes-added"]')
    expect(removed).not.toBeNull()
    expect(added).not.toBeNull()
    expect(removed!.textContent).toBe(oldLine)
    expect(added!.textContent).toBe(newLine)
    // ...and both fragments belong to the SAME track-changes row — an
    // over-limit pair must stay one fused row, not two.
    expect(removed!.closest('[data-testid="track-changes-line"]')).toBe(rows[0])
    expect(added!.closest('[data-testid="track-changes-line"]')).toBe(rows[0])
    expect(removed!.parentElement).toBe(added!.parentElement)
  })

  it('keeps the selection highlight visible on a selected fused row', () => {
    // The fused row paints its own opaque surface, so the selection fill
    // has to be rendered by the row itself — a caller-applied fill would
    // be hidden behind it.
    render(
      <LazyDiffViewer
        original={'alpha beta\nkept'}
        modified={'alpha gamma\nkept'}
        path="notes.md"
        selectedTarget={{ side: 'modified', startLine: 1, endLine: 1 }}
      />,
    )

    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows.length).toBeGreaterThan(0)
    // The selected row carries the selection marker...
    const selected = rows.filter((r) => r.getAttribute('data-selected') === 'true')
    expect(selected).toHaveLength(1)
    // ...and it paints a selection overlay of its own.
    const overlay = selected[0].querySelector('[data-testid="track-changes-selection"]')
    expect(overlay).not.toBeNull()
  })

  it('shows comment markers in the gutter of a fused row', () => {
    // The comment indicator belongs in the row's gutter, aligned with the
    // other gutter cells — not in a separate row below the content.
    render(
      <LazyDiffViewer
        original={'alpha beta\nkept'}
        modified={'alpha gamma\nkept'}
        path="notes.md"
        comments={[
          { side: 'original', startLine: 1, endLine: 1 },
          { side: 'modified', startLine: 1, endLine: 1 },
        ]}
      />,
    )

    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows).toHaveLength(1)
    const row = rows[0]

    // The original-side marker lives inside the ORIGINAL gutter cell.
    const oldCell = row.querySelector('[data-testid="track-changes-old-line-no"]')
    expect(oldCell).not.toBeNull()
    const oldMarker = oldCell!.querySelector('[data-testid="track-changes-old-comment"]')
    expect(oldMarker).not.toBeNull()

    // The modified-side marker lives inside the NEW gutter cell.
    const newCell = row.querySelector('[data-testid="track-changes-new-line-no"]')
    expect(newCell).not.toBeNull()
    const newMarker = newCell!.querySelector('[data-testid="track-changes-new-comment"]')
    expect(newMarker).not.toBeNull()

    // Both markers are inside the row, not in a sibling row below it.
    expect(row.contains(oldMarker)).toBe(true)
    expect(row.contains(newMarker)).toBe(true)
    // No separate comment row was rendered underneath.
    expect(row.parentElement!.querySelectorAll('[data-testid="track-changes-line"]')).toHaveLength(1)
  })

  it('routes clicks on the original gutter cell to the original side', () => {
    const onLineSelectForComment = vi.fn()
    render(
      <LazyDiffViewer
        original={'alpha beta\nkept'}
        modified={'alpha gamma\nkept'}
        path="notes.md"
        onLineSelectForComment={onLineSelectForComment}
      />,
    )

    const rows = screen.getAllByTestId('track-changes-line')
    const oldCell = rows[0].querySelector('[data-testid="track-changes-old-line-no"]')!
    const newCell = rows[0].querySelector('[data-testid="track-changes-new-line-no"]')!

    // The original gutter cell reports the ORIGINAL side...
    oldCell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onLineSelectForComment).toHaveBeenCalledTimes(1)
    expect(onLineSelectForComment.mock.calls[0][0]).toMatchObject({ side: 'original' })

    // ...and the new gutter cell reports the MODIFIED side.
    newCell.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onLineSelectForComment).toHaveBeenCalledTimes(2)
    expect(onLineSelectForComment.mock.calls[1][0]).toMatchObject({ side: 'modified' })
  })

  it('keeps the original line number on a fused row', () => {
    const rows = fuseHunkLines([
      { type: 'removed', content: 'old text here', oldLineNo: 3 },
      { type: 'added', content: 'new text here', newLineNo: 7 },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('fused')
    if (rows[0].kind === 'fused') {
      // Both line numbers are retained — the gutter shows the new one, but
      // original-side comments and selections need the old one.
      expect(rows[0].newLineNo).toBe(7)
      expect(rows[0].oldLineNo).toBe(3)
    }
  })
})
