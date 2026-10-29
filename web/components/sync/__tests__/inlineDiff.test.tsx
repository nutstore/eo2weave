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

// ── A11y sweep constants (module scope: shared by the ancestor and
// descendant passes of the accessibility sweep test below) ──────────────────

// Atomic / name-replacing ARIA roles: AT announces the role's accessible
// name INSTEAD of the subtree text. The list includes the whole
// name-from-content widget family (checkbox/radio/switch/menuitem*,
// option, tab, treeitem, button, link, …) and inherently atomic roles
// (img, progressbar, meter, …). Structural CONTAINER roles (menu,
// menubar, gridcell, rowheader, columnheader) and separator are NOT here:
// their descendants stay exposed to AT, so they live in
// TEXT_KEEPING_ROLES below — a role belongs here only when it suppresses
// descendant exposure, not merely because it is interactive or
// "single-value".
const REPLACEMENT_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'progressbar',
  'meter',
  'scrollbar',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'tooltip',
  'treeitem',
  'img',
])
// Roles that PRESERVE descendant text in the accessibility tree: live
// regions (status/alert/log/marquee/timer) announce their CONTENT — that
// is their entire purpose — and semantic text roles (code, heading,
// term, time, caption, cell) expose their subtree text. Structural
// container roles (menu, menubar, gridcell, rowheader, columnheader)
// belong here too: they organize descendants but never replace their
// text with an accessible name, so diff fragments inside them remain
// announced and must not be rejected. `separator` is also text-keeping
// in the only case this sweep can observe: children-presentational
// semantics apply to the separator's own rendering, while a separator
// that CONTAINS content — which is exactly what an ancestor wrapping a
// diff fragment is — keeps that text exposed (an empty separator has no
// text to hide in the first place).
const TEXT_KEEPING_ROLES = new Set([
  'status',
  'alert',
  'log',
  'marquee',
  'timer',
  'caption',
  'code',
  'heading',
  'term',
  'time',
  'cell',
  'menu',
  'menubar',
  'gridcell',
  'rowheader',
  'columnheader',
  'separator',
])
// Native tags with the same implicit atomic / name-replacing behavior when
// no explicit `role` overrides them. Text-preserving wrappers (`pre`,
// `code`, `blockquote`, headings, `dt`/`dd`, `figcaption`) keep descendant
// text in the a11y tree — they are semantic emphasis, not replacements —
// so they are deliberately excluded (see NODE_TEXT_KEEPING_TAGS below).
// The same applies to the text-bearing native elements `time`, `data`,
// `output`, `td` and `th`: each exposes its CONTENT to AT (`<time>` and
// `<data>` wrap the text they annotate, `<output>` and table header/data
// cells render their subtree), so a diff fragment inside them stays
// announced — they are text-keeping, not name-replacements, and live in
// NODE_TEXT_KEEPING_TAGS below.
const IMPLICIT_REPLACEMENT_TAGS = new Set([
  'button',
  'a',
  'option',
  'img',
  'progress',
  'meter',
  'select',
  'textarea',
  'input',
  'label',
  'summary',
  'optgroup',
])
// Unroled native tags whose implicit `generic` role keeps their text in
// the accessibility tree: inline semantic emphasis and neutral wrappers.
// A diff fragment may legitimately be wrapped in any of these. The
// text-bearing natives `time`, `data`, `output`, `td` and `th` belong
// here: their implicit roles (`time`, `data`, `status` for `output`,
// `cell`/`columnheader` for `td`/`th`) all expose their subtree text.
const NODE_TEXT_KEEPING_TAGS = new Set([
  'span',
  'em',
  'strong',
  'mark',
  'i',
  'b',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'abbr',
  'bdi',
  'bdo',
  'q',
  'cite',
  'dfn',
  'kbd',
  'samp',
  'var',
  'code',
  'blockquote',
  'pre',
  'figcaption',
  'caption',
  'dt',
  'dd',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'del',
  'ins',
  'time',
  'data',
  'output',
  'td',
  'th',
])
// Explicit roles that KEEP descendant text in the accessibility tree.
// Used by the descendant pass (every node role must be in this set) and
// by the ancestor pass (a text-keeping token stops fallback resolution —
// see resolveAncestorIsReplacement below). Includes the diff roles
// themselves (deletion/insertion expose the semantics AND the text),
// inline emphasis (mark/sub/sup), presentational roles (which strip the
// node's own semantics but keep the text), neutral containers, and
// TEXT_KEEPING_ROLES.
const NODE_TEXT_KEEPING_ROLES = new Set([
  'deletion',
  'insertion',
  'mark',
  'sub',
  'sup',
  'presentation',
  'none',
  'generic',
  'group',
  'figure',
  'list',
  'listitem',
  'region',
  'table',
  'row',
  'cell',
  ...TEXT_KEEPING_ROLES,
])
// Tailwind utility class-name TOKENS that REMOVE content from assistive
// technology. Matching is token-exact (whole class token, or the token
// after a `variant:` prefix) instead of substring/regex so that
// text-preserving utilities are never flagged:
// - `overflow-hidden` / `overflow-x-hidden` / `overflow-y-hidden` clip
//   painting but keep the text in the a11y tree;
// - `border-collapse` is a table-borders utility, not hiding;
// - `contents` (display:contents) removes only the element's own box —
//   its TEXT is promoted to the a11y tree, so it preserves exposure.
// Responsive/conditional variants (`md:hidden`, `hover:invisible`) still
// hide in production, so a token ending in `:<token>` is rejected too.
// `sr-only` is deliberately NOT rejected: it visually hides text but
// keeps it EXPOSED to assistive technology, and `not-sr-only` /
// `sr-only-focusable` restore or extend that exposure.
const HIDING_CLASS_TOKENS = new Set([
  'hidden',
  'invisible',
  'collapse',
  'content-hidden',
  'of-hidden',
])
// Tailwind's important modifier comes in two syntaxes: trailing `!` in
// v4 (`hidden!`, `md:hidden!`) and leading `!` in v3 (`!hidden`,
// `!md:hidden`). Normalize BOTH away before matching so an
// important-prefixed hiding utility can never slip past the token
// check, while a NON-hiding utility carrying `!` (`!overflow-hidden`)
// is still judged by its bare token name.
const normalizeUtilityToken = (token: string): string => {
  // Split off any responsive/state variant prefix (`md:hidden!` →
  // `hidden!`), then remove leading and trailing `!` markers. The split
  // colon must be OUTSIDE arbitrary-property brackets: a class like
  // `dark:[color:hover:red]` or `[--x:1]` carries colons INSIDE the
  // bracket that are part of the property syntax, not variant
  // separators — splitting there would leave only the trailing value
  // (`red]`) and the hiding class check would test the wrong token.
  // Only a colon at bracket depth 0 separates variants.
  let depth = 0
  let splitAt = -1
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ':' && depth === 0) splitAt = i
  }
  const bare = splitAt === -1 ? token : token.slice(splitAt + 1)
  return bare.replace(/^!+/, '').replace(/!+$/, '')
}
// Tailwind arbitrary-property classes bypass the class-name check above:
// `[display:none]` / `[visibility:hidden]` / `[content-visibility:hidden]`
// (optionally with the trailing `!` / `!important` marker) hide or remove
// content in production even though no computed stylesheet is loaded in
// this environment. The important modifier may also be a LEADING `!`
// (`![display:none]`, v3 syntax) — so the class string is normalized the
// same way as utility tokens before matching. The property list is
// closed — only the three subtree-removing declarations — so unrelated
// arbitrary properties (`[text-decoration-thickness:1.5px]`, `[--x:1]`)
// are never flagged.
const ARBITRARY_HIDING_CLASS_PATTERN =
  /\[\s*(?:display|visibility|content-visibility)\s*:\s*(?:none|hidden)\b(?:\s*!)?[^\]]*\]/i
const hasHidingClass = (className: string): boolean =>
  className
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => {
      const bare = normalizeUtilityToken(token)
      if ([...HIDING_CLASS_TOKENS].some((t) => bare === t)) return true
      // An arbitrary-property class with a leading `!` (`![display:none]`,
      // `!md:[display:none]`) hides the subtree while evading the
      // pattern above; normalize the modifier away before matching.
      return ARBITRARY_HIDING_CLASS_PATTERN.test(bare)
    })

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
    const removed = fragments
      .filter((f) => f.type === 'removed')
      .map((f) => f.value)
      .join('')
    const added = fragments
      .filter((f) => f.type === 'added')
      .map((f) => f.value)
      .join('')
    const old = fragments.map((f) => (f.type === 'added' ? '' : f.value)).join('')
    const neu = fragments.map((f) => (f.type === 'removed' ? '' : f.value)).join('')
    expect(old).toBe(oldLine)
    expect(neu).toBe(newLine)
    expect(removed.length).toBeGreaterThan(0)
    expect(added.length).toBeGreaterThan(0)
  })

  it('uses word-level segments for Latin text', () => {
    const fragments = computeInlineFragments('The quick brown fox', 'The quick red fox')
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
    const removed = fragments
      .filter((f) => f.type === 'removed')
      .map((f) => f.value)
      .join('')
    const added = fragments
      .filter((f) => f.type === 'added')
      .map((f) => f.value)
      .join('')
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

    const removed = fragments
      .filter((f) => f.type === 'removed')
      .map((f) => f.value)
      .join('')
    const added = fragments
      .filter((f) => f.type === 'added')
      .map((f) => f.value)
      .join('')
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
    const oldLine =
      prefix + 'original' + ' trailing context that also pads the line beyond wrap width.'
    const newLine =
      prefix + 'revised' + ' trailing context that also pads the line beyond wrap width.'
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
      budget
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
      expect.objectContaining({ timeout: expect.any(Number) })
    )
    expect(
      (vi.mocked(diffWordsWithSpace).mock.calls[0]?.[2] as { timeout: number } | undefined)?.timeout
    ).toBeLessThanOrEqual(INLINE_DIFF_TIMEOUT_MS)
  })

  it('falls back to whole-line fragments when jsdiff times out', () => {
    const budget = createInlineDiffBudget(60_000)
    // jsdiff returns `undefined` when the per-call timeout is hit.
    vi.mocked(diffWordsWithSpace).mockReturnValueOnce(
      undefined as unknown as ReturnType<typeof diffWordsWithSpace>
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
    render(<LazyDiffViewer original={original} modified={modified} path="notes.md" />)
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
    render(<LazyDiffViewer original={original} modified={modified} path="notes.md" />)

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
    render(<LazyDiffViewer original={original} modified={modified} path="notes.md" />)

    // Removed/added fragments must expose their semantics to AT. The
    // renderer emits the semantic <del>/<ins> elements (implicit
    // `deletion`/`insertion` roles); if it ever falls back to bare
    // <span>s it MUST set role="deletion"/"insertion" explicitly, so the
    // assertion below accepts either but rejects a bare span with no
    // a11y role — a screen reader could not tell deleted from inserted
    // text.
    const removed = screen.getAllByTestId('track-changes-removed')
    expect(removed.length).toBeGreaterThan(0)
    for (const fragment of removed) {
      expect(fragment.tagName === 'DEL' || fragment.getAttribute('role') === 'deletion').toBe(true)
    }

    const added = screen.getAllByTestId('track-changes-added')
    expect(added.length).toBeGreaterThan(0)
    for (const fragment of added) {
      expect(fragment.tagName === 'INS' || fragment.getAttribute('role') === 'insertion').toBe(true)
    }

    // The fragments must actually be VISIBLE to the accessibility tree —
    // tagName/role alone would still pass if the content were hidden with
    // aria-hidden="true", display:none, visibility:hidden or the hidden
    // attribute, none of which a screen reader can see. getByRole computes
    // roles from the accessibility tree and skips hidden elements, so these
    // queries double as the visibility guard against that regression.
    expect(screen.getAllByRole('deletion')).toEqual(removed)
    expect(screen.getAllByRole('insertion')).toEqual(added)

    // The expected fragment stream comes from `computeInlineFragments`,
    // independent of the rendered DOM, so the assertions below compare the
    // DOM-exposed text against an oracle rather than the fragment's own
    // textContent (which a hidden descendant would trivially satisfy).
    // `brown fox`/`red fox` is a modified pair (inline fragments); the
    // `removed`/`added entirely` lines fall back to whole-line styling.
    const pairFragments = computeInlineFragments('The quick brown fox', 'The quick red fox')
    const expectedRemoved = pairFragments
      .filter((f) => f.type === 'removed')
      .map((f) => f.value)
      .join('')
    const expectedAdded = pairFragments
      .filter((f) => f.type === 'added')
      .map((f) => f.value)
      .join('')
    // The whole-line removal/addition rows render exactly one <del>/<ins>
    // carrying the full line text — include them in the oracle.
    expect([...removed.map((n) => n.textContent)]).toEqual([expectedRemoved, 'removed'])
    expect([...added.map((n) => n.textContent)]).toEqual([expectedAdded, 'added'])

    // Direct hiding mechanisms on the fragment itself stay cheap to check
    // here; deeper hypotheticals (CSSOM-hidden descendants, inert, clip
    // tricks) are covered for real by the browser e2e suite — axe-core
    // audits the actual computed styles and accessibility tree in
    // tests/e2e/a11y/track-changes-a11y.spec.ts (issue #109).
    for (const fragment of [...removed, ...added]) {
      expect(fragment.hasAttribute('hidden')).toBe(false)
      expect(fragment.getAttribute('aria-hidden')).not.toBe('true')
      expect(fragment.style.display).not.toBe('none')
      expect(fragment.style.visibility).not.toBe('hidden')
      expect(fragment.textContent!.length).toBeGreaterThan(0)
      // The ancestors matter as much as the descendants: an `inert`,
      // `hidden` or `aria-hidden="true"` ANCESTOR hides the whole subtree
      // for AT, and an ancestor that is an atomic text replacement
      // announces its own name instead of the subtree text. `document.body`
      // is included: an `inert`/`hidden` body hides every fragment, and the
      // loop must not stop just before it.
      for (let ancestor = fragment.parentElement; ancestor; ancestor = ancestor.parentElement) {
        expect(ancestor.hasAttribute('inert')).toBe(false)
        expect(ancestor.hasAttribute('hidden')).toBe(false)
        // `aria-hidden="false"` (or absent) keeps content exposed; only
        // the literal "true" hides it (matched case-insensitively).
        expect((ancestor.getAttribute('aria-hidden') ?? '').toLowerCase()).not.toBe('true')
        // Ancestor roles: a role (or unroled native tag) that makes the
        // subtree a text REPLACEMENT for AT is rejected outright — an
        // atomic ancestor (button, img, menuitem…) announces its own
        // accName (or nothing) INSTEAD of walking the subtree, so the diff
        // deletion/insertion semantics are lost even when the ancestor
        // carries NO naming attribute (AT suppresses or flattens the
        // fragment's semantics either way). Naming attributes alone do not
        // make an ancestor atomic, and their absence does not rescue an
        // atomic one — so the ROLE is the failing assertion, and the
        // explicit naming attributes are checked separately below so the
        // failure message names the cause when a named generic wrapper is
        // the problem.
        // `figure` is deliberately NOT here: it is a nameable
        // group-style container that keeps its descendants in the
        // accessibility tree (the name is announced in addition to the
        // content), so a named figure with diff text inside is valid.
        const ancestorRoleAttr = ancestor.getAttribute('role')
        // The `role` attribute is a SPACE-SEPARATED fallback list
        // (`role="gridcell button"`): AT picks the FIRST token it knows.
        // Comparing the whole attribute string to the list would miss an
        // effective replacement token hidden after a text-keeping or
        // unknown one, so resolve token by token, in order:
        // - a token with replacement semantics wins immediately — the
        //   subtree text is suppressed;
        // - a token with text-keeping semantics (including
        //   `presentation`/`none`, which strip the node's own semantics
        //   but KEEP the text) stops the fallback — the effective role
        //   keeps the text exposed;
        // - an unknown token means AT would fall through to the next
        //   token, and ultimately to the native tag's implicit role — so
        //   the loop continues.
        // When the attribute is absent, null, or entirely unknown, the
        // NATIVE semantics apply: an implicit-replacement tag (`button`,
        // `img`, …) is a replacement, everything else keeps its text.
        // A focusable native control (`<button role="presentation">`,
        // `<input role="bogus">`) RETAINS its semantics per the ARIA in
        // HTML spec — presentational-role conflict resolution — so its
        // implicit tag must still be checked when the explicit role does
        // not change the outcome.
        const roleTokens =
          ancestorRoleAttr === null ? [] : ancestorRoleAttr.trim().split(/\s+/).filter(Boolean)
        let ancestorIsReplacement: boolean
        if (roleTokens.length === 0) {
          ancestorIsReplacement = IMPLICIT_REPLACEMENT_TAGS.has(ancestor.tagName.toLowerCase())
        } else {
          let resolved: boolean | null = null
          for (const token of roleTokens) {
            if (REPLACEMENT_ROLES.has(token)) {
              resolved = true
              break
            }
            if (NODE_TEXT_KEEPING_ROLES.has(token)) {
              resolved = false
              break
            }
          }
          // No recognized token: the explicit role is ignored/invalid and
          // the native tag's semantics remain in effect.
          ancestorIsReplacement =
            resolved === null
              ? IMPLICIT_REPLACEMENT_TAGS.has(ancestor.tagName.toLowerCase())
              : resolved
        }
        expect(ancestorIsReplacement).toBe(false)
        // A text-PRESERVING ancestor (group/figure-style) may still carry
        // a name whose name source would turn it into a labelled
        // replacement for AT: `aria-label`/`aria-labelledby`/`title`
        // override name-from-content. On text-keeping elements
        // `aria-label`/`title` merely supplement the subtree text, so
        // those are allowed there — but `aria-labelledby` NAMES the
        // element from other nodes regardless of role, and a labelled
        // node is announced BY its name wherever the label applies, so it
        // is rejected on every ancestor (and on every diff fragment /
        // text-preserving descendant in the descendant pass below)
        // independently of the replacement classification.
        expect(ancestor.getAttribute('aria-labelledby')).toBeNull()
        if (ancestorIsReplacement) {
          expect(ancestor.getAttribute('aria-label')).toBeNull()
          expect(ancestor.getAttribute('title')).toBeNull()
        }
        // Computed-style guard on ancestors too: a hidden ancestor hides
        // everything below it even when the fragment itself is clean.
        // `visibility` is inheritable-with-override: a descendant that
        // re-declares `visibility: visible` under a `visibility: hidden`
        // ancestor IS rendered and exposed, so a hidden ancestor alone is
        // not a violation. What matters is that every text-bearing node
        // (fragment + descendants) is VISIBLY rendered: either it carries
        // its own `visibility: visible`, or its nearest visibility-
        // declaring ancestor is visible. That effective-visibility check
        // happens below, once the full node set is known. `display: none`
        // and `content-visibility: hidden` are NOT overridable — they
        // unconditionally remove the subtree — so they stay forbidden on
        // every ancestor.
        // happy-dom cannot resolve the production Tailwind stylesheet, so
        // utility-class hiding is checked by CLASS NAME instead (see
        // hasHidingClass / HIDING_CLASS_TOKENS at module scope): only
        // classes that REMOVE content from AT are rejected, matched as
        // whole class tokens so `overflow-hidden`, `overflow-x-hidden`,
        // `border-collapse` and `contents` never produce false positives.
        expect(hasHidingClass(ancestor.className)).toBe(false)
        const ancestorComputed = window.getComputedStyle(ancestor)
        expect(ancestorComputed.display).not.toBe('none')
        expect(ancestorComputed.contentVisibility).not.toBe('hidden')
      }
      for (const node of [fragment, ...fragment.querySelectorAll<HTMLElement>('*')]) {
        // `aria-hidden="false"` is valid and keeps content exposed; only
        // the literal "true" hides a node. Match case-insensitively so
        // `aria-hidden="TRUE"` cannot slip through.
        expect((node.getAttribute('aria-hidden') ?? '').toLowerCase()).not.toBe('true')
        // `hidden` and `inert` both remove a subtree from the a11y tree.
        expect(node.hasAttribute('hidden')).toBe(false)
        expect(node.hasAttribute('inert')).toBe(false)
        // Descendant roles: a role or native tag that makes a node a text
        // REPLACEMENT for AT is rejected regardless of whether an
        // accessible name is present — atomic roles (img, button with a
        // label, checkbox, etc.) make AT announce the name INSTEAD of the
        // diff text, and named or not, the fragment text then goes
        // unannounced. The role check is deliberately UNGATED on the
        // presence of an explicit ARIA label: a labelled AND an unlabelled
        // atomic descendant both suppress the subtree text, so both must
        // fail. `title` counts too — it is an accessible-name fallback for
        // many roles, so a title-named atomic element hides the diff text
        // just like an aria-label would. Container roles that keep the
        // text exposed are allowed; `presentation`/`none` strip the
        // node's own semantics but keep the text, so they are allowed too.
        const nodeRole = node.getAttribute('role')
        // Name-replacing roles: AT announces the accessible name INSTEAD of
        // the subtree text, so a NODE with one of these roles (or an
        // implicit-replacement native tag) is rejected regardless of naming
        // — text goes unannounced either way. Only on these roles do the
        // name-attribute assertions below apply; group-style containers
        // whose names SUPPLEMENT the content (figure, group, region…) are
        // exempt from the name-attribute rejection.
        // Text-keeping roles KEEP descendant text in the accessibility
        // tree: the diff fragment roles themselves (deletion/insertion
        // expose the semantics AND the text, which is the whole point),
        // inline semantic emphasis (mark/sub/sup), plus neutral and
        // container roles. `figure`/`group`-style nameable groups belong
        // here too: their name is announced in ADDITION to the content,
        // so a labelled figure/group with diff text inside is valid.
        // TEXT_KEEPING_ROLES (status/alert/log/marquee/timer, code,
        // heading, term, time, caption, cell, menu/menubar/gridcell/
        // rowheader/columnheader, separator) are here for the same
        // reason: those roles EXPOSE their subtree text instead of
        // replacing it with a name, so valid diff markup using them
        // passes. Any other explicit role is rejected — an allow-list
        // cannot be snuck past by an unlisted replacement role.
        if (nodeRole !== null) {
          expect(NODE_TEXT_KEEPING_ROLES.has(nodeRole)).toBe(true)
        }
        // IMPLICIT native roles count as well: an element can be atomic
        // for AT without any `role` attribute (e.g. `<img>`, `<button>`,
        // `<option>`, `<progress>`) — the tag-based replacement list
        // catches those where an explicit-role check would not.
        // Text-preserving native wrappers (`code`, `blockquote`, `pre`,
        // headings, `dt`/`dd`, `figcaption`, `caption`) KEEP their text in
        // the a11y tree — they are semantic emphasis, not replacements —
        // so a diff fragment inside an unroled `<code>`/`<blockquote>`/
        // `<pre>`/`<h1>`… is valid and must not be rejected. Unroled
        // generic inline text-preserving elements (`span`, `em`, `mark`,
        // …) belong here as well (see the module-scope NODE_TEXT_KEEPING_TAGS).
        const nodeIsImplicitReplacement =
          nodeRole === null && IMPLICIT_REPLACEMENT_TAGS.has(node.tagName.toLowerCase())
        expect(nodeIsImplicitReplacement).toBe(false)
        if (nodeRole === null) {
          expect(NODE_TEXT_KEEPING_TAGS.has(node.tagName.toLowerCase())).toBe(true)
        }
        // A name from ANY source makes the node a labelled atomic
        // replacement for AT — but ONLY where the node's role makes the
        // name REPLACE the content: on a group-style container (figure,
        // group, region, list…) `aria-label` and `title` are announced
        // IN ADDITION to the subtree text, so a named figure with diff
        // text inside stays valid. For text-replacing roles, the name is
        // the only thing AT announces — the diff text vanishes — so any
        // name source is rejected there. For explicit roles that keep
        // text, generic containers without names, the `aria-label`/`title`
        // attributes are still forbidden: an unroled wrapper with an
        // `aria-label` is a wrapper being used AS a label, and hiding the
        // diff text inside a plain span is exactly the regression this
        // suite guards against.
        // `aria-labelledby` is DIFFERENT: it names the element from OTHER
        // nodes and the referenced name REPLACES the element's contents
        // wherever a name applies — including on text-preserving roles
        // and plain generic wrappers, where AT announces the referenced
        // text instead of the subtree. It is therefore checked on EVERY
        // diff fragment and descendant, independently of the
        // `nameReplacesContents` classification.
        const nameReplacesContents =
          (nodeRole !== null && REPLACEMENT_ROLES.has(nodeRole)) || nodeIsImplicitReplacement
        expect(node.getAttribute('aria-labelledby')).toBeNull()
        if (nameReplacesContents) {
          expect(node.getAttribute('aria-label')).toBeNull()
          expect(node.getAttribute('title')).toBeNull()
        }
        expect(node.style.display).not.toBe('none')
        expect(node.style.visibility).not.toBe('collapse')
        expect(node.style.contentVisibility).not.toBe('hidden')
        // Computed-style guard: the inline `style` checks above only see
        // inline declarations, so also read each node's computed display
        // and content-visibility. happy-dom (this suite's test
        // environment) resolves class-based rules from stylesheets in the
        // document — including any stylesheet the test injects — but it
        // is NOT a full CSS engine and the app's production Tailwind
        // stylesheet is not loaded here, so production-only hiding
        // classes (e.g. Tailwind `hidden`) are detected by the
        // class-name assertions below plus build-time review, not by
        // getComputedStyle. The check complements rather than replaces
        // the markup assertions.
        // `opacity: 0` is deliberately not checked: it does not remove
        // content from the accessibility tree. `content-visibility:
        // hidden` is rejected like `display: none`: the subtree is
        // skipped for rendering and AT.
        // EFFECTIVE visibility instead of per-node values: `visibility`
        // is inheritable-with-override, so `visibility: hidden` on a
        // wrapper does NOT hide a descendant that re-declares
        // `visibility: visible` — browsers render and expose it. The
        // correct question for a text-bearing node is "is THIS node
        // visibly rendered", which is exactly what the computed
        // visibility of the node itself answers: happy-dom computes the
        // inherited value, so an un-overridden descendant of a hidden
        // wrapper resolves to `hidden` and fails here, while an explicit
        // override resolves to `visible` and passes. `collapse` is
        // treated like `hidden` for non-table content.
        const computed = window.getComputedStyle(node)
        expect(computed.display).not.toBe('none')
        expect(computed.visibility === 'hidden' || computed.visibility === 'collapse').toBe(false)
        expect(computed.contentVisibility).not.toBe('hidden')
        // Utility-class hiding by CLASS NAME: computed style cannot see
        // the production Tailwind stylesheet in this environment, so a
        // Tailwind `hidden` / `invisible` / `collapse` class on the
        // fragment or a descendant would escape the computed-style
        // assertions — as would an arbitrary-property class like
        // `[display:none]`. Reject the utilities that REMOVE content from
        // AT via the shared token-exact matcher (see module scope), which
        // never flags text-preserving utilities such as `overflow-hidden`,
        // `overflow-x-hidden`, `border-collapse` or `contents`. `sr-only`
        // is deliberately NOT rejected — it visually hides text but keeps
        // it exposed to assistive technology.
        expect(hasHidingClass(node.className)).toBe(false)
      }
    }
  })

  it('gives unchanged fragments an explicit foreground color', () => {
    render(<LazyDiffViewer original={original} modified={modified} path="notes.md" />)

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
      />
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
    render(<LazyDiffViewer original={orig} modified={mod} path="notes.md" />)
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
      />
    )
    expect(screen.getAllByText('−')).toHaveLength(2)
    expect(screen.queryByText('~')).toBeNull()
  })

  it('renders code files with the existing line-level view (no fusion)', () => {
    render(<LazyDiffViewer original={original} modified={modified} path="src/example.ts" />)
    // Line-level: paired −/+ rows for each modified line, no fused marker.
    expect(screen.getAllByText('−')).toHaveLength(2)
    expect(screen.getAllByText('+')).toHaveLength(2)
    expect(screen.queryByText('~')).toBeNull()
  })

  it('detects .mdx as markdown too', () => {
    render(
      <LazyDiffViewer original={'alpha beta'} modified={'alpha gamma'} path="docs/guide.mdx" />
    )
    expect(screen.queryByText('−')).toBeNull()
    expect(screen.getByText('~')).toBeDefined()
  })

  it('renders 200+ char markdown line with the edit highlight intact', () => {
    const prefix = 'Long prose line that keeps going and going for wrap testing. '.repeat(4)
    render(
      <LazyDiffViewer original={prefix + 'original'} modified={prefix + 'revised'} path="long.md" />
    )
    expect(screen.getByText('original')).toBeDefined()
    expect(screen.getByText('revised')).toBeDefined()

    // The unchanged context must survive too — a renderer that dropped
    // the equal fragments would still satisfy the two assertions above.
    const rows = screen.getAllByTestId('track-changes-line')
    expect(rows).toHaveLength(1)
    const equal = rows[0].querySelectorAll('[data-testid="track-changes-equal"]')
    expect(equal.length).toBeGreaterThan(0)
    const equalText = Array.from(equal)
      .map((e) => e.textContent)
      .join('')
    expect(equalText).toContain('Long prose line that keeps going')
    // The whole unchanged prefix is preserved, not just its start.
    expect(equalText).toBe(prefix)
  })

  it('renders an over-limit markdown line as one whole-line fused row', () => {
    // A huge line must still render (as whole-line added/removed styling)
    // as ONE fused row.
    const oldLine = 'a'.repeat(MAX_INLINE_DIFF_LENGTH + 100)
    const newLine = 'b'.repeat(MAX_INLINE_DIFF_LENGTH + 100)

    render(<LazyDiffViewer original={oldLine} modified={newLine} path="huge.md" />)

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
      />
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
      />
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
    expect(row.parentElement!.querySelectorAll('[data-testid="track-changes-line"]')).toHaveLength(
      1
    )
  })

  it('routes clicks on the original gutter cell to the original side', () => {
    const onLineSelectForComment = vi.fn()
    render(
      <LazyDiffViewer
        original={'alpha beta\nkept'}
        modified={'alpha gamma\nkept'}
        path="notes.md"
        onLineSelectForComment={onLineSelectForComment}
      />
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
