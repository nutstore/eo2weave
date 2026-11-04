/**
 * Windowed random-access reading for the text-attachment preview.
 *
 * The preview keeps the attachment's File as a random-access source (via
 * Blob.slice) and materializes only a ~200k-character window into the Monaco
 * model. Windows are cut in *byte* space: the reader walks the UTF-8
 * sequences of the bytes it read and stops on a sequence boundary, so every
 * window boundary is exact and expressed in source-file bytes. A BOM,
 * malformed UTF-8 or a truncated trailing sequence therefore cannot shift the
 * offsets, a cut can never split a surrogate pair, and a CRLF pair is never
 * split across a seam.
 *
 * Three offsets are tracked at every boundary, because three different
 * consumers need three different units:
 * - `byte`:  source bytes, used to slice the file.
 * - `char`:  UTF-16 code units, the unit the Monaco model and the `value`
 *            prop use.
 * - `point`: Unicode code points, the unit the character range shown to the
 *            user counts in (an emoji is one character, not two).
 */

/** Target size of one preview window, in UTF-16 code units. */
export const WINDOW_CHARS = 200_000

/**
 * Characters two adjacent windows share. The overlap holds the text around
 * the seam, so replacing a window never hides what the user was reading and
 * the last window always has enough content to scroll.
 */
export const OVERLAP_CHARS = 20_000

/** Maximum byte length of a single UTF-8 code point. */
const MAX_UTF8_BYTES_PER_CHAR = 4

/** Bytes read beyond the worst-case window size, so the reader can see the
 * sequence that follows the cut (needed to keep a CRLF pair together). */
const READ_SLACK_BYTES = 8

/** Bytes read before the backward window's budget, so the sequence that
 * contains the (arbitrary) read start is visible and can be skipped. */
const BACKWARD_CONTEXT_BYTES = 4

/** A file-like random-access byte source (the pieces of File we rely on). */
export type FileLike = Pick<File, 'size' | 'slice'>

/** A loaded window plus the exact offsets of both of its boundaries. */
export interface LoadedWindow {
  /** Character offset of the window's first character (UTF-16 code units). */
  startChar: number
  /** Code point offset of the window's first character (emoji count as one). */
  startPoint: number
  /** Character offset just past the window's last character (UTF-16 units). */
  endChar: number
  /** Code point offset just past the window's last character. */
  endPoint: number
  /** Byte offset of the window's first byte (source bytes; a BOM is skipped). */
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

/** Byte and UTF-16 code-unit length of one decoded UTF-8 sequence. */
interface Utf8Step {
  /** Bytes consumed by the sequence. */
  bytes: number
  /** UTF-16 code units the sequence decodes to (2 for astral code points). */
  units: number
  /** The sequence is incomplete: it continues past the end of the read. */
  truncated: boolean
}

/**
 * Walk one UTF-8 sequence at `bytes[i]`, following the WHATWG "maximal
 * subpart" error rule so the byte accounting matches TextDecoder exactly: a
 * valid sequence consumes its own bytes and decodes to one code point; an
 * invalid sequence consumes its maximal valid prefix plus the first offending
 * byte and decodes to exactly one U+FFFD; a sequence cut short by the end of
 * the read consumes the valid prefix it has and is marked `truncated`.
 *
 * Because every step is all-or-nothing, cutting between steps never splits a
 * sequence and a valid range never yields a lone surrogate. Every step is
 * also exactly one code point, so the code point count follows from it.
 */
function utf8Step(bytes: Uint8Array, i: number, end: number): Utf8Step {
  const b0 = bytes[i]!
  if (b0 < 0x80) return { bytes: 1, units: 1, truncated: false }
  let need: number
  let min = 0x80
  let max = 0xbf
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    need = 1
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    need = 2
    if (b0 === 0xe0) min = 0xa0
    else if (b0 === 0xed) max = 0x9f
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    need = 3
    if (b0 === 0xf0) min = 0x90
    else if (b0 === 0xf4) max = 0x8f
  } else {
    // Stray continuation byte or impossible octet → one U+FFFD.
    return { bytes: 1, units: 1, truncated: false }
  }
  let consumed = 1
  for (let k = 0; k < need; k++) {
    const j = i + consumed
    if (j >= end) return { bytes: consumed, units: 1, truncated: true }
    const b = bytes[j]!
    if (b < min || b > max) return { bytes: consumed, units: 1, truncated: false }
    consumed++
    min = 0x80
    max = 0xbf
  }
  return { bytes: consumed, units: b0 >= 0xf0 ? 2 : 1, truncated: false }
}

/** Whether `bytes[i]` is a UTF-8 continuation byte (10xxxxxx). */
function isContinuationByte(bytes: Uint8Array, i: number): boolean {
  const b = bytes[i]!
  return b >= 0x80 && b <= 0xbf
}

/** Whether the buffer starts with a UTF-8 BOM (EF BB BF). */
function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/**
 * Load the window of at most `windowChars` code units that starts at
 * `start` (which must be an exact character boundary — e.g. a previous
 * window's end boundary, or the start of the file).
 *
 * The cut is placed between whole UTF-8 sequences, so it never splits a
 * surrogate pair and the byte length of the kept text is exact even when the
 * file contains malformed UTF-8 or ends with a truncated sequence.
 */
export async function readForwardWindow(
  file: FileLike,
  startChar: number,
  startByte: number,
  windowChars: number = WINDOW_CHARS,
  startPoint: number = 0,
): Promise<LoadedWindow> {
  if (file.size > 0 && startByte >= file.size) throw new Error('readForwardWindow: startByte past end of file')
  if (startChar < 0 || startPoint < 0) throw new Error('readForwardWindow: boundary offsets must not be negative')
  if (startByte === 0 && (startChar !== 0 || startPoint !== 0)) throw new Error('readForwardWindow: a read at byte 0 must carry zero character offsets')
  const readBytes = Math.min(windowChars * MAX_UTF8_BYTES_PER_CHAR + READ_SLACK_BYTES, file.size - startByte)
  const raw = new Uint8Array(await file.slice(startByte, startByte + readBytes).arrayBuffer())
  const rangeEndsAtEof = startByte + readBytes >= file.size
  // A BOM is a byte-order mark, not content: skip it in byte space so every
  // offset stays in source-byte coordinates (only a read at the physical
  // start of the file can meet one).
  const bom = startByte === 0 && hasUtf8Bom(raw)
  const from = bom ? 3 : 0
  // Walk the sequences of the read range and stop on a sequence boundary.
  let units = 0
  let points = 0
  let cut = from
  let lastStart = from
  let i = from
  while (i < raw.length) {
    const step = utf8Step(raw, i, raw.length)
    // A sequence cut short by the read continues in the next window: stop in
    // front of it instead of decoding it as a replacement character.
    if (step.truncated && !rangeEndsAtEof) break
    if (units > 0 && units + step.units > windowChars) break
    units += step.units
    points += 1
    lastStart = i
    i += step.bytes
    cut = i
  }
  // Never cut between '\r' and '\n': move the cut in front of the CR so the
  // pair stays whole and decodes as a single line break in the next window.
  if (points > 1 && cut < raw.length && raw[cut] === 0x0a && raw[cut - 1] === 0x0d) {
    cut = lastStart
    units -= 1
    points -= 1
  }
  const trimmed = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(from, cut))
  const endByte = startByte + cut
  // An interior U+FEFF is content: TextDecoder's default BOM handling strips
  // a leading one, which would silently drop a character the offsets count.
  // ignoreBOM keeps every decoded code point, and the file's own leading BOM
  // was already consumed in byte space above (`from`), so it cannot resurface.
  const text = bom ? trimmed.replace(/^\uFEFF/, '') : trimmed
  return {
    startChar,
    startPoint,
    endChar: startChar + units,
    endPoint: startPoint + points,
    startByte: startByte + from,
    endByte,
    text,
    atStart: startByte <= (bom ? 3 : 0),
    atEof: endByte >= file.size,
  }
}

/**
 * Load the window of at most `windowChars` code units that ends at `end` (the
 * start boundary of the window currently above, used when the user scrolls
 * to the top edge).
 *
 * The byte read starts up to `windowChars * 4` bytes back, which is
 * guaranteed to cover the full window: any `windowChars` consecutive
 * characters occupy at most `windowChars * 4` bytes. The read start is an
 * arbitrary byte offset, so it is aligned to the sequence boundary that
 * contains it: the sequence is skipped whole, and the kept text is never
 * corrupted by the cut.
 */
export async function readBackwardWindow(
  file: FileLike,
  endChar: number,
  endByte: number,
  windowChars: number = WINDOW_CHARS,
  endPoint: number = 0,
): Promise<LoadedWindow> {
  if (endByte <= 0) throw new Error('readBackwardWindow: endByte before start of file')
  if (endChar < 0 || endPoint < 0) throw new Error('readBackwardWindow: boundary offsets must not be negative')
  if (endByte === file.size && (endChar !== file.size || endPoint !== file.size)) {
    throw new Error('readBackwardWindow: an endByte at EOF must carry the file-length character offsets')
  }
  const budgetStart = Math.max(0, endByte - (windowChars * MAX_UTF8_BYTES_PER_CHAR + READ_SLACK_BYTES))
  // Read a few bytes before the budget so the sequence that contains the
  // arbitrary read start is visible.
  const from = Math.max(0, budgetStart - BACKWARD_CONTEXT_BYTES)
  const raw = new Uint8Array(await file.slice(from, endByte).arrayBuffer())
  const bom = from === 0 && hasUtf8Bom(raw)
  // Align to a sequence boundary. The read start is an arbitrary byte offset,
  // so it can land inside a sequence: walk back over the continuation bytes
  // to that sequence's lead byte, so it is consumed whole instead of being
  // decoded as a replacement character. A BOM is skipped the same way — it is
  // a marker, not content.
  let aligned = Math.min(budgetStart - from, raw.length)
  if (bom) aligned = Math.max(aligned, 3)
  else while (aligned > 0 && isContinuationByte(raw, aligned)) aligned--
  // Walk the sequences once, recording their boundaries, then pick the latest
  // boundary that still leaves at most `windowChars` code units in the window.
  const bounds: number[] = [aligned]
  const unitsAt: number[] = [0]
  const pointsAt: number[] = [0]
  let j = aligned
  let units = 0
  let points = 0
  while (j < raw.length) {
    const step = utf8Step(raw, j, raw.length)
    j += step.bytes
    units += step.units
    points += 1
    bounds.push(j)
    unitsAt.push(units)
    pointsAt.push(points)
  }
  // Advance to the latest boundary whose remaining text still fits the
  // budget (the window shrinks as k grows).
  let k = 0
  while (k + 1 < bounds.length && units - unitsAt[k]! > windowChars) k++
  // A budget too small for even one character would yield an empty window
  // and silently drop the content: keep one whole character instead.
  if (k === bounds.length - 1 && bounds.length > 1) k--
  // Never start between '\r' and '\n': pull the CR into this window so the
  // pair decodes as a single line break here.
  if (k > 0 && bounds[k]! < raw.length && raw[bounds[k]!] === 0x0a && raw[bounds[k]! - 1] === 0x0d) k--
  const head = bounds[k]!
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(head, raw.length))
  return {
    startChar: endChar - (units - unitsAt[k]!),
    startPoint: endPoint - (points - pointsAt[k]!),
    startByte: from + head,
    endChar,
    endPoint,
    endByte,
    text,
    atStart: (from + head) <= (bom ? 3 : 0),
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
    const tail = await readBackwardWindow(file, current.endChar, current.endByte, OVERLAP_CHARS, current.endPoint)
    return readForwardWindow(file, tail.startChar, tail.startByte, windowChars, tail.startPoint)
  }
  // The previous window ends where the current one starts; extend it
  // `OVERLAP_CHARS` past that boundary into the current window's head.
  const prev = await readBackwardWindow(file, current.startChar, current.startByte, windowChars, current.startPoint)
  const back = await readForwardWindow(file, prev.startChar, prev.startByte, windowChars + OVERLAP_CHARS, prev.startPoint)
  // A backward window that reached the start of the file knows it, even when
  // a BOM sits between byte 0 and the first content byte: without this the
  // window reports atStart: false and the top-edge handler keeps reloading
  // the first window forever.
  if (prev.atStart) return { ...back, atStart: true }
  return back
}
