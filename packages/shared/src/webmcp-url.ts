export function validateUrlRegex(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('urlRegex must be a nonempty string')
  if (value.length > 2000 || !value.startsWith('^') || !value.endsWith('$'))
    throw new Error('urlRegex must start with ^, end with $, and contain at most 2000 characters')
  try { new RegExp(value) } catch (error) { throw new Error(`Invalid urlRegex: ${String(error)}`) }
  return value
}

/** Matching also verifies the complete match, including expressions with alternation. */
export function matchesToolUrl(pattern: string, href: string): boolean {
  const url = new URL(href)
  if (!['https:', 'http:'].includes(url.protocol)) return false
  const match = new RegExp(pattern).exec(url.href)
  return match !== null && match.index === 0 && match[0].length === url.href.length
}

