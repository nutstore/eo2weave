// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { RunChangesCard } from '../RunChangesCard'
import { formatBytes } from '@/lib/utils'

/**
 * Issue #124 + Sourcery PR#127 follow-up: a REAL zero-byte file
 * (contentKind 'text', size 0) must render its "0 B" label — the old
 * `size > 0` check treated it as an absent side. These tests exercise the
 * RENDERED RunChangesCard (not a copied expression) with the SQLite
 * repository mocked, so a regression in the component's label logic fails
 * here.
 */

type MetaRecord = {
  path: string
  opType: 'create' | 'modify' | 'delete'
  createdAt: number
  beforeContentKind: 'text' | 'binary' | 'none'
  beforeContentSize: number
  afterContentKind: 'text' | 'binary' | 'none'
  afterContentSize: number
}

const { listSnapshotFilesMock } = vi.hoisted(() => ({
  listSnapshotFilesMock: vi.fn<(snapshotId: string) => Promise<unknown[]>>(),
}))

vi.mock('@/sqlite/repositories/fs-overlay.repository', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getFSOverlayRepository: () => ({
      listSnapshotFiles: listSnapshotFilesMock,
    }),
  }
})

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
  useI18nStore: { getState: () => ({ locale: 'en-US' }) },
}))

vi.mock('@/components/sync/LazyDiffViewer', () => ({
  default: () => <div data-testid="lazy-diff" />,
}))

let mockFiles: MetaRecord[] = []

const meta = (over: Partial<MetaRecord> & { path: string }): MetaRecord => ({
  opType: 'modify',
  createdAt: 1,
  beforeContentKind: 'text',
  beforeContentSize: 100,
  afterContentKind: 'text',
  afterContentSize: 200,
  ...over,
})

/** Row text for a path: labels + arrow joined, e.g. "0 B → 300 B". */
function rowLabel(container: HTMLElement, path: string): string {
  const row = [...container.querySelectorAll('li')].find((li) =>
    li.querySelector(`[title="${CSS.escape(path)}"]`)
  )
  if (!row) throw new Error(`row for ${path} not found`)
  // The trailing <span> holds the size labels; take its full text.
  const spans = row.querySelectorAll('button > span')
  return (spans[spans.length - 1]?.textContent ?? '').trim()
}

describe('RunChangesCard size labels (rendered component, issue #124)', () => {
  beforeEach(() => {
    mockFiles = []
    listSnapshotFilesMock.mockImplementation(async () => mockFiles)
  })
  afterEach(() => cleanup())

  it('modify with an empty BEFORE file: "0 B → 300 B" (the #124 regression)', async () => {
    mockFiles = [meta({ path: 'a.txt', beforeContentSize: 0, afterContentSize: 300 })]
    const { container } = render(<RunChangesCard snapshotId="snap-1" />)
    // The file list lazy-loads in an effect; wait for the row to appear.
    await vi.waitFor(() => expect(screen.getByTitle('a.txt')).toBeTruthy())
    expect(rowLabel(container, 'a.txt')).toBe('0 B → 300 B')
  })

  it('modify with an empty AFTER file: "500 B → 0 B"', async () => {
    mockFiles = [meta({ path: 'b.txt', beforeContentSize: 500, afterContentSize: 0 })]
    const { container } = render(<RunChangesCard snapshotId="snap-1" />)
    await vi.waitFor(() => expect(screen.getByTitle('b.txt')).toBeTruthy())
    expect(rowLabel(container, 'b.txt')).toBe('500 B → 0 B')
  })

  it('both sides empty: "0 B → 0 B"', async () => {
    mockFiles = [meta({ path: 'c.txt', beforeContentSize: 0, afterContentSize: 0 })]
    const { container } = render(<RunChangesCard snapshotId="snap-1" />)
    await vi.waitFor(() => expect(screen.getByTitle('c.txt')).toBeTruthy())
    expect(rowLabel(container, 'c.txt')).toBe('0 B → 0 B')
  })

  it('create: before side is none — only the after label, no arrow', async () => {
    mockFiles = [
      meta({ path: 'd.txt', opType: 'create', beforeContentKind: 'none', afterContentSize: 300 }),
    ]
    const { container } = render(<RunChangesCard snapshotId="snap-1" />)
    await vi.waitFor(() => expect(screen.getByTitle('d.txt')).toBeTruthy())
    expect(rowLabel(container, 'd.txt')).toBe('300 B')
  })

  it('delete: after side is none — only the before label, no arrow', async () => {
    mockFiles = [
      meta({ path: 'e.txt', opType: 'delete', beforeContentSize: 300, afterContentKind: 'none', afterContentSize: 0 }),
    ]
    const { container } = render(<RunChangesCard snapshotId="snap-1" />)
    await vi.waitFor(() => expect(screen.getByTitle('e.txt')).toBeTruthy())
    expect(rowLabel(container, 'e.txt')).toBe('300 B')
  })

  it('the canonical formatter renders 0 bytes as "0 B" (guard against formatter regressions)', () => {
    expect(formatBytes(0)).toBe('0 B')
  })
})
