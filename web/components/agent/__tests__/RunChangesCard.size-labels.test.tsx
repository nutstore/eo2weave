/**
 * Regression tests for RunChangesCard's before/after size labels.
 *
 * A create/delete snapshot row has one absent side — the snapshot repository
 * reports it as size 0 — and the row used to render that side through the
 * canonical formatter, which renders 0 as "0 B". Because the arrow was only
 * drawn when BOTH sizes were positive, the two labels ran together
 * ("0 B1 KB") and the row advertised a zero-byte file that never existed.
 *
 * These tests assert that only the side which actually exists gets a label,
 * and that the separator appears exactly when both sides are present.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunChangesCard } from '../RunChangesCard'
import type { SnapshotFileMetaRecord } from '@/sqlite/repositories/fs-overlay.repository'

const repoMock = vi.hoisted(() => ({
  listSnapshotFiles: vi.fn<() => Promise<SnapshotFileMetaRecord[]>>(),
  getSnapshotFileContent: vi.fn(async () => null),
}))

vi.mock('@/sqlite/repositories/fs-overlay.repository', () => ({
  getFSOverlayRepository: () => repoMock,
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('@/components/sync/LazyDiffViewer', () => ({
  default: () => <div data-testid="diff-viewer" />,
}))

function fileMeta(partial: Partial<SnapshotFileMetaRecord>): SnapshotFileMetaRecord {
  return {
    path: 'src/app.ts',
    opType: 'modify',
    createdAt: 0,
    beforeContentKind: 'text',
    beforeContentSize: 0,
    afterContentKind: 'text',
    afterContentSize: 0,
    ...partial,
  }
}

/** The size cell of a row, identified by the file path it belongs to. */
function sizeCellFor(path: string): HTMLElement {
  const pathCell = screen.getByTitle(path)
  const row = pathCell.closest('button')
  if (!row) throw new Error(`no row button found for ${path}`)
  const cells = row.querySelectorAll('span')
  const sizeCell = cells[cells.length - 1]
  if (!sizeCell) throw new Error(`no size cell found for ${path}`)
  return sizeCell as HTMLElement
}

describe('RunChangesCard size labels', () => {
  beforeEach(() => {
    repoMock.listSnapshotFiles.mockReset()
    repoMock.getSnapshotFileContent.mockReset()
    repoMock.getSnapshotFileContent.mockResolvedValue(null)
  })

  it('shows only the new size for a created file', async () => {
    repoMock.listSnapshotFiles.mockResolvedValue([
      fileMeta({
        path: 'created.ts',
        opType: 'create',
        beforeContentKind: 'none',
        beforeContentSize: 0,
        afterContentSize: 1024,
      }),
    ])

    render(<RunChangesCard snapshotId="snap-1" />)

    await waitFor(() => expect(screen.getByTitle('created.ts')).toBeTruthy())
    const cell = sizeCellFor('created.ts')
    expect(cell.textContent).toBe('1.0 KB')
    expect(cell.textContent).not.toContain('0 B')
    expect(cell.textContent).not.toContain('→')
  })

  it('shows only the old size for a deleted file', async () => {
    repoMock.listSnapshotFiles.mockResolvedValue([
      fileMeta({
        path: 'deleted.ts',
        opType: 'delete',
        beforeContentSize: 2048,
        afterContentKind: 'none',
        afterContentSize: 0,
      }),
    ])

    render(<RunChangesCard snapshotId="snap-2" />)

    await waitFor(() => expect(screen.getByTitle('deleted.ts')).toBeTruthy())
    const cell = sizeCellFor('deleted.ts')
    expect(cell.textContent).toBe('2.0 KB')
    expect(cell.textContent).not.toContain('0 B')
    expect(cell.textContent).not.toContain('→')
  })

  it('separates both sizes with an arrow when both sides exist', async () => {
    repoMock.listSnapshotFiles.mockResolvedValue([
      fileMeta({
        path: 'modified.ts',
        opType: 'modify',
        beforeContentSize: 1024,
        afterContentSize: 3072,
      }),
    ])

    render(<RunChangesCard snapshotId="snap-3" />)

    await waitFor(() => expect(screen.getByTitle('modified.ts')).toBeTruthy())
    const cell = sizeCellFor('modified.ts')
    expect(cell.textContent).toBe('1.0 KB → 3.0 KB')
  })

  it('renders no size label when neither side has content', async () => {
    repoMock.listSnapshotFiles.mockResolvedValue([
      fileMeta({
        path: 'empty.ts',
        opType: 'modify',
        beforeContentKind: 'none',
        beforeContentSize: 0,
        afterContentKind: 'none',
        afterContentSize: 0,
      }),
    ])

    render(<RunChangesCard snapshotId="snap-4" />)

    await waitFor(() => expect(screen.getByTitle('empty.ts')).toBeTruthy())
    const cell = sizeCellFor('empty.ts')
    expect(cell.textContent).toBe('')
  })
})
