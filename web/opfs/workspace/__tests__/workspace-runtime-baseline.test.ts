import { describe, expect, it, vi } from 'vitest'
import { WorkspaceRuntime } from '../workspace-runtime'
import type { PendingChange } from '@/opfs/types/opfs-types'

function createPending(id: string, path: string, type: PendingChange['type']): PendingChange {
  return {
    id,
    path,
    type,
    fsMtime: 0,
    timestamp: Date.now(),
  }
}

describe('WorkspaceRuntime baseline mtime', () => {
  it('uses native mtime as baseline when directory handle is provided', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>()

    runtime.hasFileInIndex = vi.fn(() => true)
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'old-opfs',
      mtime: 111,
      size: 10,
      contentType: 'text',
    }))
    runtime.readFromNativeFS = vi.fn(async () => ({
      content: 'old-native',
      metadata: {
        path: 'src/a.ts',
        mtime: 222,
        size: 10,
        contentType: 'text',
      },
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.writeToFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      markAsCreated: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      hasPendingPath: vi.fn(() => false),
    }

    await runtime.writeFile('src/a.ts', 'next-content', {} as FileSystemDirectoryHandle)

    expect(runtime.pendingManager.add).toHaveBeenCalledWith('src/a.ts', 222, {
      forceUpdateMtime: false,
    })
    expect(runtime.pendingManager.markAsCreated).not.toHaveBeenCalled()
  })

  it('writes directly to OPFS without pending tracking in OPFS-only mode', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>(['src/a.ts'])

    runtime.hasFileInIndex = vi.fn(() => true)
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'old-opfs',
      mtime: 111,
      size: 10,
      contentType: 'text',
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.writeToFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      markAsCreated: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      hasPendingPath: vi.fn(() => false),
    }

    await runtime.writeFile('src/a.ts', 'next-content')

    expect(runtime.captureModifyBaseline).not.toHaveBeenCalled()
    expect(runtime.pendingManager.add).not.toHaveBeenCalled()
    expect(runtime.writeToFilesDir).toHaveBeenCalledWith('src/a.ts', 'next-content')
    expect(runtime.pendingManager.markAsCreated).not.toHaveBeenCalled()
  })

  it('does not capture baseline for newly created file in OPFS-only mode', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>()
    // Simulate "native directory IS mounted" so the pure-OPFS short-circuit
    // doesn't fire — these tests exercise the baseline-capture flow.
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)

    runtime.hasFileInIndex = vi.fn(() => false)
    runtime.readFromFilesDir = vi.fn(async () => null)
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.writeToFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      markAsCreated: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      hasPendingPath: vi.fn(() => false),
    }

    await runtime.writeFile('src/new.ts', 'created-content')

    expect(runtime.captureModifyBaseline).not.toHaveBeenCalled()
    expect(runtime.pendingManager.markAsCreated).toHaveBeenCalledWith('src/new.ts', 0)
    expect(runtime.pendingManager.add).not.toHaveBeenCalled()
  })

  it('keeps existing baseline during the same pending modify cycle', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.pendingManager = {
      hasPendingPath: vi.fn(() => true),
    }
    runtime.readFromBaselineDir = vi.fn(async () => ({
      content: 'already-baselined',
      mtime: 1,
      size: 17,
      contentType: 'text',
    }))
    runtime.writeToBaselineDir = vi.fn(async () => {})

    await runtime.captureModifyBaseline('src/a.ts', 'newer-content')

    expect(runtime.writeToBaselineDir).not.toHaveBeenCalled()
  })

  it('overwrites stale baseline when pending modify cycle is cleared', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.pendingManager = {
      hasPendingPath: vi.fn(() => false),
    }
    runtime.readFromBaselineDir = vi.fn(async () => ({
      content: 'stale-baseline',
      mtime: 1,
      size: 14,
      contentType: 'text',
    }))
    runtime.writeToBaselineDir = vi.fn(async () => {})

    await runtime.captureModifyBaseline('src/a.ts', 'fresh-baseline')

    expect(runtime.writeToBaselineDir).toHaveBeenCalledWith('src/a.ts', 'fresh-baseline')
  })

  it('captures OPFS baseline before deleting existing file in OPFS-only mode', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>(['src/a.ts'])
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)

    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'old-opfs',
      mtime: 111,
      size: 10,
      contentType: 'text',
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.deleteFromFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      getAll: vi.fn(() => []),
      markForDeletion: vi.fn(async () => {}),
    }

    await runtime.deleteFile('src/a.ts')

    expect(runtime.captureModifyBaseline).toHaveBeenCalledWith('src/a.ts', 'old-opfs')
    expect(runtime.pendingManager.markForDeletion).toHaveBeenCalledWith('src/a.ts', 0)
  })

  it('immediately deletes an ignored file instead of recording a pending delete', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)
    runtime.getNativeDirectoryHandleForPath = vi.fn(async () => null)
    runtime.resolvePath = vi.fn(async () => ({ relativePath: 'node_modules/pkg/index.js', rootId: 'root-1' }))
    runtime.isGitIgnoredPath = vi.fn(async () => true)
    runtime.deleteIgnoredPathImmediately = vi.fn(async () => {})
    runtime.pendingManager = {
      getAll: vi.fn(() => []),
      markForDeletion: vi.fn(async () => {}),
    }

    await runtime.deleteFile('rootName/node_modules/pkg/index.js')

    expect(runtime.deleteIgnoredPathImmediately).toHaveBeenCalledWith(
      'rootName/node_modules/pkg/index.js', 'node_modules/pkg/index.js', null, false, 'root-1'
    )
    expect(runtime.pendingManager.markForDeletion).not.toHaveBeenCalled()
  })

  it('deleteFile checks gitignore with kind "file" so a directory-only rule cannot bypass review (#186)', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)
    runtime.getNativeDirectoryHandleForPath = vi.fn(async () => null)
    runtime.resolvePath = vi.fn(async () => ({ relativePath: 'build', rootId: 'root-1' }))

    const seenKinds: Array<'file' | 'directory' | undefined> = []
    runtime.isGitIgnoredPath = vi.fn(async (_p: string, _h: unknown, _r: unknown, kind?: 'file' | 'directory') => {
      seenKinds.push(kind)
      return false
    })
    runtime.deleteIgnoredPathImmediately = vi.fn(async () => {})
    runtime.readFromFilesDir = vi.fn(async () => null)
    runtime.hasFileInIndex = vi.fn(() => false)
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.deleteFromFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      getAll: vi.fn(() => []),
      markForDeletion: vi.fn(async () => {}),
    }

    // A regular file named `build` under a `build/` directory-only rule:
    // the checker must be asked about a FILE, and since it answers "not
    // ignored", the delete must go through the pending-review path.
    await runtime.deleteFile('rootName/build')

    expect(seenKinds).toEqual(['file'])
    expect(runtime.deleteIgnoredPathImmediately).not.toHaveBeenCalled()
    expect(runtime.pendingManager.markForDeletion).toHaveBeenCalledWith('rootName/build', 0)
  })

  it('does not capture baseline when deleting a file created in current pending cycle', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>(['src/new.ts'])

    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'created-opfs',
      mtime: 222,
      size: 12,
      contentType: 'text',
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.deleteFromFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      getAll: vi.fn(() => [createPending('p1', 'src/new.ts', 'create')]),
      markForDeletion: vi.fn(async () => {}),
    }

    await runtime.deleteFile('src/new.ts')

    expect(runtime.captureModifyBaseline).not.toHaveBeenCalled()
  })

  it('keeps baseline for approved-not-synced paths during cleanup', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.pendingManager = {
      hasPendingPath: vi.fn((path: string) => path === 'src/a.ts'),
    }
    runtime.listBaselinePaths = vi.fn(async () => ['src/a.ts'])
    runtime.deleteFromBaselineDirIfExists = vi.fn(async () => {})

    await runtime.cleanupStaleBaselines()

    expect(runtime.deleteFromBaselineDirIfExists).not.toHaveBeenCalled()
  })

  it('removes baseline once approved path is no longer tracked after sync', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.pendingManager = {
      hasPendingPath: vi.fn(() => false),
    }
    runtime.listBaselinePaths = vi.fn(async () => ['src/a.ts'])
    runtime.deleteFromBaselineDirIfExists = vi.fn(async () => {})

    await runtime.cleanupStaleBaselines()

    expect(runtime.deleteFromBaselineDirIfExists).toHaveBeenCalledWith('src/a.ts')
  })

  it('syncToDisk clears baseline for approved paths that got synced in this run', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.saveMetadata = vi.fn(async () => {})

    let tracked = true
    runtime.pendingManager = {
      sync: vi.fn(async () => {
        tracked = false
        return { success: 1, failed: 0, skipped: 0, conflicts: [] }
      }),
      hasPendingPath: vi.fn(() => tracked),
    }
    runtime.listBaselinePaths = vi.fn(async () => ['src/a.ts'])
    runtime.deleteFromBaselineDirIfExists = vi.fn(async () => {})

    await runtime.syncToDisk({} as FileSystemDirectoryHandle, ['src/a.ts'])

    expect(runtime.deleteFromBaselineDirIfExists).toHaveBeenCalledWith('src/a.ts')
  })

  it('syncToDisk keeps baseline for approved paths that remain unsynced', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.saveMetadata = vi.fn(async () => {})

    runtime.pendingManager = {
      sync: vi.fn(async () => ({ success: 0, failed: 0, skipped: 1, conflicts: [] })),
      hasPendingPath: vi.fn(() => true),
    }
    runtime.listBaselinePaths = vi.fn(async () => ['src/a.ts'])
    runtime.deleteFromBaselineDirIfExists = vi.fn(async () => {})

    await runtime.syncToDisk({} as FileSystemDirectoryHandle, ['src/other.ts'])

    expect(runtime.deleteFromBaselineDirIfExists).not.toHaveBeenCalled()
  })

  it('keeps OPFS pending view after native bind when native content still equals baseline', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasFileInIndex = vi.fn(() => true)
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'edited-in-opfs',
      mtime: 300,
      size: 14,
      contentType: 'text',
    }))
    runtime.getFileMetadata = vi.fn(async () => ({
      mtime: 200,
      size: 8,
      contentType: 'text',
    }))
    runtime.readFromBaselineDir = vi.fn(async () => ({
      content: 'original',
      mtime: 100,
      size: 8,
      contentType: 'text',
    }))
    runtime.readFromNativeFS = vi.fn(async () => ({
      content: 'original',
      metadata: { path: 'src/a.ts', mtime: 200, size: 8, contentType: 'text' },
    }))
    runtime.pendingManager = {
      hasPendingPath: vi.fn(() => true),
      getAll: vi.fn(() => [createPending('p1', 'src/a.ts', 'modify')]),
    }
    runtime.pendingManager.getAll.mockReturnValueOnce([
      {
        ...createPending('p1', 'src/a.ts', 'modify'),
        fsMtime: 100,
      },
    ])

    const result = await runtime.readFile('src/a.ts', {} as FileSystemDirectoryHandle)

    expect(result.content).toBe('edited-in-opfs')
  })

  it('prefers native view after bind when native content diverged from OPFS baseline', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasFileInIndex = vi.fn(() => true)
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'edited-in-opfs',
      mtime: 300,
      size: 14,
      contentType: 'text',
    }))
    runtime.getFileMetadata = vi.fn(async () => ({
      mtime: 200,
      size: 8,
      contentType: 'text',
    }))
    runtime.readFromBaselineDir = vi.fn(async () => ({
      content: 'original',
      mtime: 100,
      size: 8,
      contentType: 'text',
    }))
    runtime.readFromNativeFS = vi.fn(async () => ({
      content: 'changed-on-disk',
      metadata: { path: 'src/a.ts', mtime: 200, size: 14, contentType: 'text' },
    }))
    runtime.pendingManager = {
      hasPendingPath: vi.fn(() => true),
      getAll: vi.fn(() => [
        {
          ...createPending('p1', 'src/a.ts', 'modify'),
          fsMtime: 100,
        },
      ]),
    }

    const result = await runtime.readFile('src/a.ts', {} as FileSystemDirectoryHandle)

    expect(result.content).toBe('changed-on-disk')
  })

  it('normalizes /mnt paths for direct OPFS writes', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>(['src/a.ts'])

    runtime.hasFileInIndex = vi.fn((p: string) => p === 'src/a.ts')
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'old-opfs',
      mtime: 111,
      size: 10,
      contentType: 'text',
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.writeToFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      markAsCreated: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      hasPendingPath: vi.fn(() => false),
    }

    await runtime.writeFile('/mnt/src/a.ts', 'next-content')

    expect(runtime.captureModifyBaseline).not.toHaveBeenCalled()
    expect(runtime.pendingManager.add).not.toHaveBeenCalled()
    expect(runtime.writeToFilesDir).toHaveBeenCalledWith('src/a.ts', 'next-content')
    expect(runtime.pendingManager.markAsCreated).not.toHaveBeenCalled()
  })

  it('normalizes /mnt paths in readFile and returns OPFS pending content', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.hasFileInIndex = vi.fn((p: string) => p === 'src/a.ts')
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'edited-in-opfs',
      mtime: 300,
      size: 14,
      contentType: 'text',
    }))
    runtime.pendingManager = {
      hasPendingPath: vi.fn((p: string) => p === 'src/a.ts'),
      getAll: vi.fn(() => []),
    }
    runtime.getFileMetadata = vi.fn(async () => ({
      mtime: 100,
      size: 10,
      contentType: 'text',
    }))

    const result = await runtime.readFile('/mnt/src/a.ts', {} as FileSystemDirectoryHandle)
    expect(result.content).toBe('edited-in-opfs')
  })

  it('normalizes /mnt paths in deleteFile and captures existing baseline', async () => {
    const runtime = new WorkspaceRuntime('w1', {} as FileSystemDirectoryHandle, '/tmp') as any
    runtime.initialized = true
    runtime.metadata = { lastAccessedAt: 0 }
    runtime.filesIndex = new Set<string>(['src/a.ts'])
    runtime.hasAnyNativeDirectoryHandle = vi.fn(async () => true)

    runtime.hasFileInIndex = vi.fn((p: string) => p === 'src/a.ts')
    runtime.readFromFilesDir = vi.fn(async () => ({
      content: 'old-opfs',
      mtime: 111,
      size: 10,
      contentType: 'text',
    }))
    runtime.captureModifyBaseline = vi.fn(async () => {})
    runtime.deleteFromFilesDir = vi.fn(async () => {})
    runtime.saveMetadata = vi.fn(async () => {})
    runtime.pendingManager = {
      getAll: vi.fn(() => []),
      markForDeletion: vi.fn(async () => {}),
    }

    await runtime.deleteFile('/mnt/src/a.ts')

    expect(runtime.captureModifyBaseline).toHaveBeenCalledWith('src/a.ts', 'old-opfs')
    expect(runtime.pendingManager.markForDeletion).toHaveBeenCalledWith('src/a.ts', 0)
  })
})
