import { describe, expect, it } from 'vitest'
import {
  MAX_QUOTE_CHARS,
  QUOTE_TRUNCATION_MARKER,
  quoteLinesToText,
  toQuotedSelection,
} from '../selection-quote'

describe('toQuotedSelection', () => {
  it('keeps one entry per source line', () => {
    expect(toQuotedSelection('first line\nsecond line')).toEqual({
      lines: ['first line', 'second line'],
      truncated: false,
    })
  })

  it('drops leading/trailing blank lines and collapses runs of blanks', () => {
    expect(toQuotedSelection('\n\nfirst\n\n\nsecond\n\n')).toEqual({
      lines: ['first', '', 'second'],
      truncated: false,
    })
  })

  it('truncates at the limit and appends the marker', () => {
    const result = toQuotedSelection('a'.repeat(MAX_QUOTE_CHARS + 10))
    expect(result.truncated).toBe(true)
    expect(result.lines).toEqual(['a'.repeat(MAX_QUOTE_CHARS), QUOTE_TRUNCATION_MARKER])
  })
})

describe('quoteLinesToText', () => {
  it('prefixes every line with "> "', () => {
    expect(quoteLinesToText(['first line', 'second line'])).toBe('> first line\n> second line')
  })

  it('renders an empty line as a bare ">"', () => {
    expect(quoteLinesToText(['first', '', 'second'])).toBe('> first\n>\n> second')
  })
})
