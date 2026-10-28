/**
 * Unit tests for inline (word/char-level) diff fusion — issue #96.
 *
 * Covers: CJK → diffChars segmentation, Latin → diffWordsWithSpace,
 * mixed-language degradation, fragment-stream ordering, code-file
 * non-interference, pure add/remove fallback, and long-line (200+ chars)
 * fragment integrity.
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  containsCJK,
  detectInlineStrategy,
  computeInlineFragments,
  fuseHunkLines,
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
    const rows = fuseHunkLines([
      { type: 'added', content: 'line one', newLineNo: 5 },
      { type: 'added', content: 'line two', newLineNo: 6 },
    ])
    expect(rows.every((r) => r.kind === 'line')).toBe(true)
  })

  it('falls back to all-plain rows for pure removals', () => {
    const rows = fuseHunkLines([
      { type: 'removed', content: 'line one', oldLineNo: 5 },
    ])
    expect(rows.every((r) => r.kind === 'line')).toBe(true)
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
})
