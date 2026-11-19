import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceRuntime } from '../workspace-runtime'

/**
 * deleteDirPending - directory-level pending-delete records.
 *
 * Background: deleteDir() records a pending entry per file, but an empty directory tree (0 files) produces no
 * records at all, so sync's pruneEmptyParents has nothing to anchor on and empty directories linger forever.
 * deleteDirPending records the directory path itself as a pending delete (fsMtime=0 skips the
 * conflict check; rollback treats it as a ghost delete, silently cleaned when no baseline exists).
 */
describe('WorkspaceRuntime deleteDirPending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks the directory path as pending delete with fsMtime 0 (native mode)', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)
    runtime.pendingManager = {
      markForDeletion: vi.fn(async () => {}),
    }
    runtime.saveMetadata = vi.fn(async () => {})

    await runtime.deleteDirPending('rootName/web/src')

    // fsMtime=0 -> the sync conflict check is skipped by construction; the path is left as-is (normalizeWorkspacePath)
    expect(runtime.pendingManager.markForDeletion).toHaveBeenCalledWith(
      'rootName/web/src', 0, { deleteMode: 'tree' }
    )
    expect(runtime.saveMetadata).toHaveBeenCalled()
  })

  it('is a no-op record in pure OPFS mode (no native root mounted)', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => false)
    runtime.pendingManager = {
      markForDeletion: vi.fn(async () => {}),
    }
    runtime.deleteFromFilesDirIfExists = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})

    await runtime.deleteDirPending('web/src')

    // Pure-OPFS mode has no disk side to delete from and must not record a pending entry either
    expect(runtime.pendingManager.markForDeletion).not.toHaveBeenCalled()
  })

  it('pure OPFS mode still prunes the OPFS files/ side best-effort', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => false)
    runtime.pendingManager = {
      markForDeletion: vi.fn(async () => {}),
    }
    runtime.deleteFromFilesDirIfExists = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})

    await runtime.deleteDirPending('web/src')

    expect(runtime.deleteFromFilesDirIfExists).toHaveBeenCalledWith('web/src')
  })

  it('tolerates missing files/ representation in pure OPFS mode', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => false)
    runtime.pendingManager = {
      markForDeletion: vi.fn(async () => {}),
    }
    // The directory is absent from files/ -> deleteFromFilesDir throws NotFoundError, which must be swallowed
    runtime.deleteFromFilesDirIfExists = vi.fn(async () => {
      throw new Error('NotFoundError')
    })
    runtime.saveMetadata = vi.fn(async () => {})

    await expect(runtime.deleteDirPending('web/src')).resolves.toBeUndefined()
  })

  it('immediately deletes an ignored directory instead of adding a pending record', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)
    runtime.resolvePath = vi.fn(async () => ({ relativePath: 'node_modules', rootId: 'root-1' }))
    runtime.getNativeDirectoryHandleForPath = vi.fn(async () => null)
    runtime.isGitIgnoredPath = vi.fn(async () => true)
    runtime.deleteIgnoredPathImmediately = vi.fn(async () => {})
    runtime.pendingManager = { markForDeletion: vi.fn(async () => {}) }

    await runtime.deleteDirPending('rootName/node_modules')

    expect(runtime.deleteIgnoredPathImmediately).toHaveBeenCalledWith(
      'rootName/node_modules', 'node_modules', null, true, 'root-1'
    )
    expect(runtime.pendingManager.markForDeletion).not.toHaveBeenCalled()
  })

  it('cancels out when the directory already has a pending create record', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)
    const discardPendingPath = vi.fn(async () => {})
    runtime.pendingManager = {
      markForDeletion: vi.fn(async () => {}),
      pendingChanges: new Map([
        ['rootName/web/src', { id: 'p1', path: 'rootName/web/src', type: 'create', fsMtime: 0, timestamp: 1 }],
      ]),
      removePendingPath: vi.fn(),
      discardPendingPath,
    }
    runtime.saveMetadata = vi.fn(async () => {})

    // The create->delete cancellation inside markForDeletion lives in the real manager,
    // so here we only verify the runtime side does not crash outside that mock
    await runtime.deleteDirPending('rootName/web/src')
    expect(runtime.pendingManager.markForDeletion).toHaveBeenCalledWith(
      'rootName/web/src', 0, { deleteMode: 'tree' }
    )
  })
})
