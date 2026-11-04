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
 */
async function decodeSlice(file: FileLike, byteStart: number, byteEnd: number): Promise<string> {
  const bytes = await file.slice(byteStart, byteEnd).arrayBuffer()
  return new TextDecoder('utf-8').decode(bytes, { stream: true })
}

/**
 * Load the window of at most `windowChars` characters that starts at the
 * character offset `startChar` / byte offset `startByte` (which must be an
 * exact character boundary — e.g. a previous window's end boundary, or 0/0).
 */
export async function readForwardWindow(
  file: FileLike,
  startChar: number,
  startByte: number,
  windowChars: number = WINDOW_CHARS,
): Promise<LoadedWindow> {
  if (file.size > 0 && startByte >= file.size) throw new Error('readForwardWindow: startByte past end of file')
  const readBytes = Math.min(windowChars * MAX_UTF8_BYTES_PER_CHAR, file.size - startByte)
  const raw = await decodeSlice(file, startByte, startByte + readBytes)
  const text = raw.length > windowChars ? raw.slice(0, windowChars) : raw
  const endByte = startByte + utf8ByteLength(text)
  const endChar = startChar + text.length
  return {
    startChar,
    startByte,
    endChar,
    endByte,
    text,
    atStart: startByte <= 0,
    atEof: endByte >= file.size,
  }
}

/**
 * Load the window of at most `windowChars` characters that ends just before
 * the character offset `endChar` / byte offset `endByte` (the start boundary
 * of the window currently above, used when the user scrolls to the top edge).
 *
 * The byte read starts up to `windowChars * 4` bytes back, which is
 * guaranteed to cover the full window: any `windowChars` consecutive
 * characters occupy at most `windowChars * 4` bytes. If the read starts
 * mid-sequence the decoder emits one leading U+FFFD, which is dropped
 * unconditionally — the kept suffix re-encodes to an exact byte length, so
 * the returned boundary offsets stay exact either way.
 */
export async function readBackwardWindow(
  file: FileLike,
  endChar: number,
  endByte: number,
  windowChars: number = WINDOW_CHARS,
): Promise<LoadedWindow> {
  if (endByte <= 0) throw new Error('readBackwardWindow: endByte before start of file')
  const rawStart = Math.max(0, endByte - windowChars * MAX_UTF8_BYTES_PER_CHAR)
  const raw = await decodeSlice(file, rawStart, endByte)
  const body = rawStart > 0 && raw.length > 0 ? raw.slice(1) : raw
  const text = body.length > windowChars ? body.slice(-windowChars) : body
  const startByte = endByte - utf8ByteLength(text)
  const startChar = endChar - text.length
  return {
    startChar,
    startByte,
    endChar,
    endByte,
    text,
    atStart: startByte <= 0,
    atEof: endByte >= file.size,
  }
}
