import { describe, expect, it } from 'vitest'
import { readAdjacentWindow, readBackwardWindow, readForwardWindow, utf8ByteLength, WINDOW_CHARS, type LoadedWindow } from '@/components/agent/text-preview-window'

/** Build a File-like from a string. */
function makeFile(content: string): File {
  return new File([content], 'test.txt', { type: 'text/plain' })
}

/** Load the whole file as exact consecutive windows, starting from (0, 0). */
async function tileForward(file: File, windowChars = WINDOW_CHARS): Promise<LoadedWindow[]> {
  const windows: LoadedWindow[] = []
  let startChar = 0
  let startByte = 0
  while (true) {
    const win = await readForwardWindow(file, startChar, startByte, windowChars)
    windows.push(win)
    if (win.atEof) return windows
    startChar = win.endChar
    startByte = win.endByte
  }
}

describe('text-preview-window', () => {
  it('reports exact UTF-8 byte lengths for multi-byte characters', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('中文')).toBe(6)
    expect(utf8ByteLength('🚀')).toBe(4)
  })

  it('reads a small file as a single window covering it exactly', async () => {
    const content = 'hello 世界 🚀\nsecond line'
    const file = makeFile(content)
    const win = await readForwardWindow(file, 0, 0)
    expect(win.text).toBe(content)
    expect(win.startChar).toBe(0)
    expect(win.startByte).toBe(0)
    expect(win.endChar).toBe(content.length)
    expect(win.endByte).toBe(file.size)
    expect(win.atStart).toBe(true)
    expect(win.atEof).toBe(true)
  })

  it('splits a large ASCII file into exact consecutive windows', async () => {
    const content = 'ab'.repeat(WINDOW_CHARS * 3 + 7) // 1_200_014 chars = 6 full windows + remainder
    const file = makeFile(content)
    const windows = await tileForward(file)
    expect(windows.length).toBe(7)
    expect(windows.map((w) => w.text.length)).toEqual([WINDOW_CHARS, WINDOW_CHARS, WINDOW_CHARS, WINDOW_CHARS, WINDOW_CHARS, WINDOW_CHARS, 14])
    // Boundaries tile the file with no gaps or overlaps.
    expect(windows[0].endChar).toBe(windows[1].startChar)
    expect(windows[1].endChar).toBe(windows[2].startChar)
    expect(windows[2].endChar).toBe(windows[3].startChar)
    expect(windows[5].endChar).toBe(windows[6].startChar)
    expect(windows[0].endByte).toBe(windows[1].startByte)
    expect(windows[1].endByte).toBe(windows[2].startByte)
    expect(windows[5].endByte).toBe(windows[6].startByte)
    const whole = windows.map((w) => w.text).join('')
    expect(whole).toBe(content)
    expect(windows[0].atStart).toBe(true)
    expect(windows[windows.length - 1].atEof).toBe(true)
    expect(windows[1].atStart).toBe(false)
    expect(windows[1].atEof).toBe(false)
  })

  it('splits a CJK file into exact consecutive windows across multi-byte boundaries', async () => {
    // Each '中' is 3 bytes, so a 200k-char window boundary falls mid-sequence
    // in raw byte terms; the boundary trim must land on real characters.
    const content = '中文内容'.repeat(WINDOW_CHARS)
    const file = makeFile(content)
    const windows = await tileForward(file)
    const whole = windows.map((w) => w.text).join('')
    expect(whole).toBe(content)
    for (const win of windows) {
      expect(win.text.length).toBeLessThanOrEqual(WINDOW_CHARS)
      expect(win.startByte + utf8ByteLength(win.text)).toBe(win.endByte)
    }
    expect(windows[0].endChar).toBe(windows[1].startChar)
  })

  it('splits an emoji file where 4-byte sequences straddle window boundaries', async () => {
    const content = '🚀'.repeat(WINDOW_CHARS + 3)
    const file = makeFile(content)
    const windows = await tileForward(file)
    const whole = windows.map((w) => w.text).join('')
    expect(whole).toBe(content)
    expect(windows[0].text.length).toBe(WINDOW_CHARS)
  })

  it('keeps boundaries exact when byte windows align with surrogate-pair straddles', async () => {
    // 1-2 code units per char: window boundary can split a surrogate pair in
    // raw JS-string terms; slicing to windowChars must keep whole characters.
    const content = 'a🚀b'.repeat(WINDOW_CHARS)
    const file = makeFile(content)
    const windows = await tileForward(file)
    const whole = windows.map((w) => w.text).join('')
    expect(whole).toBe(content)
    // No lone surrogates in any window.
    for (const win of windows) {
      expect(/[\uD800-\uDBFF]/.test(win.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
    }
  })

  it('reads a backward window that ends exactly at a forward window boundary', async () => {
    const content = 'x'.repeat(WINDOW_CHARS * 2 + 5)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    expect(first.atEof).toBe(false)
    const second = await readForwardWindow(file, first.endChar, first.endByte)
    // Now scroll back up: the window ending at the second window's start.
    const back = await readBackwardWindow(file, second.startChar, second.startByte)
    expect(back.atStart).toBe(true)
    expect(back.text).toBe(content.slice(0, back.endChar))
    expect(back.startChar).toBe(0)
    expect(back.startByte).toBe(0)
    expect(back.endChar).toBe(second.startChar)
    expect(back.endByte).toBe(second.startByte)
  })

  it('reads a backward window in the middle of a CJK file exactly', async () => {
    const content = '中文'.repeat(WINDOW_CHARS + 10)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    const second = await readForwardWindow(file, first.endChar, first.endByte)
    const back = await readBackwardWindow(file, second.startChar, second.startByte)
    expect(back.endChar).toBe(second.startChar)
    expect(back.endByte).toBe(second.startByte)
    expect(back.startChar + back.text.length).toBe(back.endChar)
    // The backward window equals the tail of the first window's region.
    expect(back.text).toBe(content.slice(back.startChar, second.startChar))
  })

  it('throws when asked to read past the file bounds', async () => {
    const file = makeFile('abc')
    await expect(readForwardWindow(file, 99, 99)).rejects.toThrow()
    await expect(readBackwardWindow(file, 0, 0)).rejects.toThrow()
  })
  it('handles an empty file as one empty at-start/at-eof window', async () => {
    const file = makeFile('')
    const win = await readForwardWindow(file, 0, 0)
    expect(win.text).toBe('')
    expect(win.atStart).toBe(true)
    expect(win.atEof).toBe(true)
    expect(win.endChar).toBe(0)
    expect(win.endByte).toBe(0)
  })

  it('keeps the whole file reachable when a UTF-8 BOM is present', async () => {
    const content = 'a'.repeat(WINDOW_CHARS * 2 + 10)
    const file = makeFile('\uFEFF' + content)
    const first = await readForwardWindow(file, 0, 0)
    expect(first.startByte).toBe(3) // BOM consumed as source bytes
    expect(first.text).not.toContain('\uFEFF')
    expect(first.atEof).toBe(false)
    const second = await readForwardWindow(file, first.endChar, first.endByte)
    expect(second.atEof).toBe(false)
    const last = await readForwardWindow(file, second.endChar, second.endByte)
    expect(last.endByte).toBe(file.size)
    expect(last.atEof).toBe(true)
    // The windows tile the whole file exactly: no duplicated tail, no gap.
    expect(first.text + second.text + last.text).toBe(content)
  })

  it('reads a BOM-less file from byte 0', async () => {
    const content = 'hello'
    const file = makeFile(content)
    const win = await readForwardWindow(file, 0, 0)
    expect(win.startByte).toBe(0)
    expect(win.text).toBe(content)
    expect(win.atEof).toBe(true)
  })

  it('reads a very short BOM file as one window without a phantom skip', async () => {
    const file = makeFile('\uFEFFhi')
    const win = await readForwardWindow(file, 0, 0)
    expect(win.startByte).toBe(3)
    expect(win.text).toBe('hi')
    expect(win.endByte).toBe(file.size)
    expect(win.atEof).toBe(true)
  })

  it('never splits a surrogate pair or a CRLF pair at a forward boundary', async () => {
    // Mix of emoji and CRLF so a boundary can land mid-pair for either.
    const content = '🚀\r\n'.repeat(WINDOW_CHARS)
    const file = makeFile(content)
    const windows = await tileForward(file, 10)
    expect(windows.length).toBeGreaterThan(1)
    const whole = windows.map((w) => w.text).join('')
    expect(whole).toBe(content)
    for (const win of windows) {
      // No lone surrogates.
      expect(/[\uD800-\uDBFF]/.test(win.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
      // No dangling CR at the window tail (always paired with its LF).
      expect(win.text.endsWith('\r')).toBe(false)
      expect(win.text.startsWith('\n')).toBe(false)
    }
  })

  it('never splits a surrogate pair or a CRLF pair at a backward boundary', async () => {
    const content = '🚀\r\n'.repeat(WINDOW_CHARS)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    const second = await readForwardWindow(file, first.endChar, first.endByte)
    const back = await readBackwardWindow(file, second.startChar, second.startByte, 10)
    expect(back.text).toBe(content.slice(back.startChar, second.startChar))
    expect(/[\uD800-\uDBFF]/.test(back.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false)
    expect(back.text.endsWith('\r')).toBe(false)
    expect(back.text.startsWith('\n')).toBe(false)
  })

  it('overlaps the next window with the current one so no text is skipped', async () => {
    const content = 'y'.repeat(WINDOW_CHARS * 3)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    const next = await readAdjacentWindow(file, first, 'next')
    // The new window starts before the old one ended, so the seam text is
    // present in both windows and nothing is dropped at the boundary.
    expect(next.startChar).toBeLessThan(first.endChar)
    expect(next.startChar + next.text.length).toBeGreaterThan(first.endChar)
    // The overlap content is identical in both windows.
    expect(first.text.slice(first.endChar - (first.endChar - next.startChar))).toBe(
      next.text.slice(0, first.endChar - next.startChar),
    )
    // Boundaries stay exact.
    expect(next.startChar + next.text.length).toBe(next.endChar)
    expect(next.startByte + utf8ByteLength(next.text)).toBe(next.endByte)
  })

  it('keeps a short final window scrollable by overlapping it backward', async () => {
    // Whole file ≈ 1.05 windows: the final window is short and at EOF.
    const content = 'y'.repeat(WINDOW_CHARS + 5000)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    expect(first.atEof).toBe(false)
    const last = await readAdjacentWindow(file, first, 'next')
    expect(last.atEof).toBe(true)
    // The final window carries the whole tail plus the overlap before it,
    // so it has content to scroll and the user can navigate back.
    expect(last.text.length).toBeGreaterThan(5000)
    expect(last.endChar).toBe(content.length)
    expect(last.text.endsWith(content.slice(-5000))).toBe(true)
    expect(last.startChar).toBeLessThan(first.endChar)
    // Its offsets stay exact.
    expect(last.startChar + last.text.length).toBe(last.endChar)
    expect(last.startByte + utf8ByteLength(last.text)).toBe(last.endByte)
  })

  it('navigates backward to a window that reaches the start of the file', async () => {
    const content = 'z'.repeat(WINDOW_CHARS * 2 + 5)
    const file = makeFile(content)
    const first = await readForwardWindow(file, 0, 0)
    const second = await readAdjacentWindow(file, first, 'next')
    expect(second.startChar).toBeLessThan(first.endChar)
    const back = await readAdjacentWindow(file, second, 'prev')
    expect(back.atStart).toBe(true)
    expect(back.startChar).toBe(0)
    expect(back.text).toBe(content.slice(0, back.endChar))
    expect(back.startChar + back.text.length).toBe(back.endChar)
  })
})
