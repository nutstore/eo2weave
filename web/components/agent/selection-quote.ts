/**
 * Selection → quote helpers.
 *
 * A quote is carried as literal markdown blockquote text: every line is
 * prefixed with "> ". Text is the contract — what the user sees in the
 * composer is exactly what the model receives, with no structured metadata
 * and no source label.
 */

/** Hard cap on the raw selection, in characters. */
export const MAX_QUOTE_CHARS = 4000

/** Appended when a selection had to be cut at MAX_QUOTE_CHARS. */
export const QUOTE_TRUNCATION_MARKER = '…(truncated)'

export interface QuotedSelection {
  /** Selection lines, without the "> " prefix. */
  lines: string[]
  truncated: boolean
}

/**
 * Normalize a raw selection into quote lines.
 *
 * Trims trailing whitespace per line, drops leading/trailing blank lines and
 * collapses runs of blank lines, so a selection taken across block boundaries
 * does not produce a wall of bare ">" lines.
 */
export function toQuotedSelection(raw: string, limit: number = MAX_QUOTE_CHARS): QuotedSelection {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const truncated = normalized.length > limit
  const body = (truncated ? normalized.slice(0, limit) : normalized)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))

  const lines: string[] = []
  for (const line of body) {
    if (!line && (lines.length === 0 || lines[lines.length - 1] === '')) continue
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  if (truncated) lines.push(QUOTE_TRUNCATION_MARKER)
  return { lines, truncated }
}

/** Prefix each line the way the composer and the model must see it. */
export function quoteLinesToText(lines: string[]): string {
  return lines.map((line) => (line ? `> ${line}` : '>')).join('\n')
}
