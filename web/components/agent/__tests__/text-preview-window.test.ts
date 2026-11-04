import { describe, expect, it } from 'vitest'
import { readBackwardWindow, readForwardWindow, utf8ByteLength, WINDOW_CHARS, type LoadedWindow } from '@/components/agent/text-preview-window'

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
})
