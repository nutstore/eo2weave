/** Cap on characters read into a text/markdown preview and handed to the renderer. */
export const MAX_PREVIEW_CHARS = 1_000_000
/** Cap on bytes read from a file for a text/markdown preview. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

/**
 * Cap text to MAX_PREVIEW_CHARS, backing off one code unit when the cut
 * would split a UTF-16 surrogate pair (e.g. an emoji astral character).
 */
export function capPreviewText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PREVIEW_CHARS) return { text, truncated: false }
  let cut = MAX_PREVIEW_CHARS
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  }
  return { text: text.slice(0, cut), truncated: true }
}

/**
 * Read a preview-sized slice of the file: at most MAX_PREVIEW_BYTES from disk
 * and at most MAX_PREVIEW_CHARS handed to the renderer.
 */
export async function readBoundedPreview(file: File): Promise<{ text: string; truncated: boolean }> {
  const raw = await (file.size > MAX_PREVIEW_BYTES ? file.slice(0, MAX_PREVIEW_BYTES).text() : file.text())
  return capPreviewText(raw)
}
