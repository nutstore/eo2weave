/**
 * Windowed random-access reading for the text-attachment preview.
 *
 * The preview keeps the attachment's File as a random-access source (via
 * Blob.slice) and materializes only a ~200k-character window into the Monaco
 * model. Windows are read as byte ranges and trimmed to UTF-8 character
 * boundaries, so every window boundary (startChar/startByte) is exact and
 * consecutive windows tile the file with no seams and no off-by-one
 * characters.
 *
 * No full-file index is built: byte↔char mapping is only tracked at window
 * boundaries, derived from the previous window's decoded text (re-encoding a
 * decoded suffix with TextEncoder yields its exact UTF-8 byte length).
 */

/** Target size of one preview window, in characters. */
export const WINDOW_CHARS = 200_000

/** Maximum byte length of a single UTF-8 code point. */
const MAX_UTF8_BYTES_PER_CHAR = 4

/**
 * Characters two adjacent windows share. The overlap holds the text around
 * the seam, so replacing a window never hides what the user was reading and
 * the last window always has enough content to scroll.
 */
export const OVERLAP_CHARS = 20_000

/** A file-like random-access byte source (the pieces of File we rely on). */
export type FileLike = Pick<File, 'size' | 'slice'>

/** A loaded window plus the exact offsets of both of its boundaries. */
export interface LoadedWindow {
  /** Character offset of the window's first character in the whole file. */
  startChar: number
  /** Character offset just past the window's last character. */
  endChar: number
  /** Byte offset of the window's first byte. */
  startByte: number
  /** Byte offset just past the window's last byte. */
  endByte: number
  /** The decoded window text. */
  text: string
  /** The window includes the beginning of the file. */
  atStart: boolean
  /** The window includes the end of the file. */
  atEof: boolean
}

/** Exact UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Decode bytes [byteStart, byteEnd) as UTF-8, dropping an incomplete trailing
 * code point instead of emitting U+FFFD for it. `decode(..., { stream: true })`
 * buffers the trailing partial sequence in the decoder state (fresh per call,
 * so nothing leaks) and only returns the complete code points.
 *
 * `ignoreBOM: true` keeps a leading BOM as a regular U+FEFF character, so
 * the decoder never silently changes the byte→text mapping; the BOM is
 * skipped explicitly (see `hasUtf8Bom`).
 */
async function decodeSlice(file: FileLike, byteStart: number, byteEnd: number): Promise<{ raw: string; buffer: ArrayBuffer }> {
  const buffer = await file.slice(byteStart, byteEnd).arrayBuffer()
  const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer, { stream: true })
  return { raw, buffer }
}

/** Whether an ArrayBuffer begins with a UTF-8 BOM (EF BB BF). */
function hasUtf8Bom(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 3) return false
  const bytes = new Uint8Array(buffer, 0, 3)
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/**
 * Cut `raw` down to at most `windowChars` code units without splitting a
 * surrogate pair or a CRLF pair at the cut: when the cut would leave a lone
 * high surrogate or a dangling CR at the tail, the pair is kept whole by
 * letting the window run one code unit past `windowChars` (the next window
 * starts after it, so nothing is duplicated or lost).
 */
function trimForwardBoundary(raw: string, windowChars: number): string {
  if (raw.length <= windowChars) return raw
  const text = raw.slice(0, windowChars)
  const last = text.charCodeAt(text.length - 1)
  const next = raw.charCodeAt(text.length)
  const splitsSurrogate = last >= 0xd800 && last <= 0xdbff
  const splitsCrLf = last === 0x0d && next === 0x0a
  return splitsSurrogate || splitsCrLf ? raw.slice(0, windowChars + 1) : text
}

/**
 * Keep the last `windowChars` code units of `body` without splitting a
 * surrogate pair or a CRLF pair at the kept region's head: when the head
 * would start on a lone low surrogate or a bare LF, the preceding high
 * surrogate / CR is pulled in from `body` (one code unit past `windowChars`).
 */
function extendBackwardBoundary(body: string, windowChars: number): string {
  if (body.length <= windowChars) return body
  const text = body.slice(-windowChars)
  const first = text.charCodeAt(0)
  const prev = body.charCodeAt(body.length - text.length - 1)
  const splitsSurrogate = first >= 0xdc00 && first <= 0xdfff
  const splitsCrLf = first === 0x0a && prev === 0x0d
  return splitsSurrogate || splitsCrLf ? body.slice(body.length - text.length - 1) : text
}

/**
 * Load the window of at most `windowChars` characters that starts at the
 * character offset `startChar` / byte offset `startByte` (which must be an
 * exact character boundary — e.g. a previous window's end boundary, or 0/0).
 *
 * A leading UTF-8 BOM is consumed before the first window (the window starts
 * at byte 3): counting the BOM as content would leave `endByte` short of the
 * source bytes, so `atEof` could never become true and the file's tail would
 * be re-read and duplicated. The BOM is detected from the window's own
 * buffer — no extra read of the file.
 */
export async function readForwardWindow(
  file: FileLike,
  startChar: number,
  startByte: number,
  windowChars: number = WINDOW_CHARS,
): Promise<LoadedWindow> {
  if (file.size > 0 && startByte >= file.size) throw new Error('readForwardWindow: startByte past end of file')
  const { raw, buffer } = await decodeSlice(file, startByte, startByte + Math.min(windowChars * MAX_UTF8_BYTES_PER_CHAR + 1, file.size - startByte))
  const bom = startByte === 0 && hasUtf8Bom(buffer)
  const body = bom ? raw.slice(1) : raw
  const text = trimForwardBoundary(body, windowChars)
  // A BOM-only file decodes to an empty window; re-read past the BOM.
  if (bom && text.length === 0 && file.size > 3) return readForwardWindow(file, 0, 3, windowChars)
  const origin = bom ? 3 : startByte
  const endByte = origin + utf8ByteLength(text)
  const endChar = startChar + text.length
  return {
    startChar,
    startByte: origin,
    endChar,
    endByte,
    text,
    atStart: bom || origin <= 0,
    atEof: endByte >= file.size,
  }
}

/**
 * Load the window adjacent to `current`: the next one when scrolling down,
 * the previous one when scrolling up.
 *
 * The new window overlaps the current one by `OVERLAP_CHARS` around the seam,
 * so the text the user is reading when the swap fires is still in the model
 * afterwards — nothing is skipped at the seam. The overlap also gives the
 * last window enough content to be scrollable, so a short final window no
 * longer strands the user at EOF with no way back.
 */
export async function readAdjacentWindow(
  file: FileLike,
  current: LoadedWindow,
  direction: 'next' | 'prev',
  windowChars: number = WINDOW_CHARS,
): Promise<LoadedWindow> {
  if (direction === 'next') {
    // Start the new window `OVERLAP_CHARS` before the current one ends, so
    // the seam text is in both windows.
    const tail = await readBackwardWindow(file, current.endChar, current.endByte, OVERLAP_CHARS)
    return readForwardWindow(file, tail.startChar, tail.startByte, windowChars)
  }
  // The previous window ends where the current one starts; extend it
  // `OVERLAP_CHARS` past that boundary into the current window's head.
  const prev = await readBackwardWindow(file, current.startChar, current.startByte, windowChars)
  return readForwardWindow(file, prev.startChar, prev.startByte, windowChars + OVERLAP_CHARS)
}

/**
 * Load the window of at most `windowChars` characters that ends just before
 * the character offset `endChar` / byte offset `endByte` (the start boundary
 * of the window currently above, used when the user scrolls to the top edge).
 *
 * The byte read starts up to `windowChars * 4` bytes back, which is
 * guaranteed to cover the full window: any `windowChars` consecutive
 * characters occupy at most `windowChars * 4` bytes (the boundary-adjustment
 * pass keeps at most one extra code unit past that, still within budget). If
 * the read starts mid-sequence the decoder emits one leading U+FFFD, which is
 * dropped unconditionally — the kept suffix re-encodes to an exact byte
 * length, so the returned boundary offsets stay exact either way. A leading
 * BOM is dropped the same way, so the window starts at the first content
 * byte.
 */
export async function readBackwardWindow(
  file: FileLike,
  endChar: number,
  endByte: number,
  windowChars: number = WINDOW_CHARS,
): Promise<LoadedWindow> {
  if (endByte <= 0) throw new Error('readBackwardWindow: endByte before start of file')
  const rawStart = Math.max(0, endByte - windowChars * MAX_UTF8_BYTES_PER_CHAR)
  const { raw, buffer } = await decodeSlice(file, rawStart, endByte)
  const bom = rawStart === 0 && hasUtf8Bom(buffer)
  const body = rawStart > 0 && raw.length > 0 ? raw.slice(1) : bom ? raw.slice(1) : raw
  const text = extendBackwardBoundary(body, windowChars)
  const startByte = endByte - utf8ByteLength(text)
  const startChar = endChar - text.length
  return {
    startChar,
    startByte,
    endChar,
    endByte,
    text,
    atStart: startByte <= 0 || (bom && startByte <= 3),
    atEof: endByte >= file.size,
  }
}
