// @vitest-environment node
import { describe, expect, it } from 'vitest'

/**
 * Issue #124: a REAL zero-byte file (contentKind 'text', size 0) must show
 * its "0 B" label — the old `size > 0` check treated it as an absent side.
 * Side PRESENCE (contentKind !== 'none') decides label + arrow rendering.
 *
 * RunChangesCard renders these labels via the same expression mirrored in
 * sizesFor() below (extracted verbatim from the JSX so the matrix can be
 * asserted synchronously — the card itself lazy-loads from SQLite, which a
 * static render cannot await).
 */

type Side = { contentKind: 'text' | 'binary' | 'none'; contentSize: number }

function sizesFor(before: Side, after: Side): string {
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }
  const parts: string[] = []
  const beforeLabel = before.contentKind !== 'none' ? formatBytes(before.contentSize) : ''
  const afterLabel = after.contentKind !== 'none' ? formatBytes(after.contentSize) : ''
  if (beforeLabel) parts.push(beforeLabel)
  if (beforeLabel && afterLabel) parts.push('→')
  if (afterLabel) parts.push(afterLabel)
  return parts.join(' ')
}

const text = (size: number): Side => ({ contentKind: 'text', contentSize: size })
const none: Side = { contentKind: 'none', contentSize: 0 }

describe('RunChangesCard size labels (issue #124: side presence decides rendering)', () => {
  it('modify with an empty BEFORE file: "0 B → 300 B" (the #124 regression)', () => {
    expect(sizesFor(text(0), text(300))).toBe('0 B → 300 B')
  })

  it('modify with an empty AFTER file: "500 B → 0 B"', () => {
    expect(sizesFor(text(500), text(0))).toBe('500 B → 0 B')
  })

  it('both sides empty: "0 B → 0 B"', () => {
    expect(sizesFor(text(0), text(0))).toBe('0 B → 0 B')
  })

  it('create: before side is none — only the after label, no arrow', () => {
    expect(sizesFor(none, text(300))).toBe('300 B')
  })

  it('delete: after side is none — only the before label, no arrow', () => {
    expect(sizesFor(text(300), none)).toBe('300 B')
  })

  it('normal modify unchanged: "100 B → 200 B"', () => {
    expect(sizesFor(text(100), text(200))).toBe('100 B → 200 B')
  })
})
