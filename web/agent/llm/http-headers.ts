/**
 * HTTP headers only accept ISO-8859-1 (Latin-1) single-byte characters.
 *
 * If a header value contains a non-Latin-1 character (Chinese characters,
 * full-width punctuation, emoji, etc.), the browser throws an opaque error
 * when constructing the Request object:
 *
 *   "Failed to execute 'fetch' on 'Window': Failed to read the 'headers'
 *    property from 'RequestInit': String contains non ISO-8859-1 code point."
 *
 * The request never goes out and the user is left with a cryptic message.
 *
 * This helper detects such characters *early* and throws a clear, actionable
 * error pointing at the offending header — most commonly the API key was
 * pasted with a Chinese comma / quote / full-width space mixed in.
 */

// Matches any character outside the Latin-1 range (U+0000 – U+00FF).
// eslint-disable-next-line no-control-regex -- intentional: control chars are part of Latin-1 (U+0000-U+00FF) and are accepted; only non-Latin-1 code points are rejected
const NON_LATIN1_RE = /[^\u0000-\u00ff]/

/**
 * Assert that every value in `headers` is ISO-8859-1 safe.
 *
 * @param headers  The headers object about to be passed to `fetch()`.
 * @param context  Short human-readable label shown in the error, e.g.
 *                 "LLM request headers" or "model list request".
 * @throws Error with a descriptive message naming the offending header and
 *         the non-ASCII characters found.
 */
export function assertHeaderAscii(
  headers: Record<string, string>,
  context = 'request headers'
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    if (!NON_LATIN1_RE.test(value)) continue

    // Collect distinct offending characters for a helpful diagnostic.
    const badChars = Array.from(
      new Set(Array.from(value).filter((ch) => NON_LATIN1_RE.test(ch)))
    )
    const preview = badChars.slice(0, 5).map((c) => `"${c}"`).join(', ')

    throw new Error(
      `Invalid ${context}: header "${key}" contains non-ASCII characters ` +
        `(${preview}). HTTP headers only allow Latin-1 characters. ` +
        `This usually means the API key or custom header value was pasted ` +
        `with Chinese punctuation, full-width spaces, or emoji mixed in — ` +
        `please re-enter it using only ASCII characters.`
    )
  }
}
