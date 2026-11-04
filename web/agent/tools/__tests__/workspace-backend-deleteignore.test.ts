import { describe, it, expect, vi, beforeEach } from 'vitest'

const useOPFSStoreMock = vi.hoisted(() => ({ getState: vi.fn() }))
const useWorkspaceStoreMock = vi.hoisted(() => ({ getState: vi.fn() }))
const getWorkspaceManagerMock = vi.hoisted(() => vi.fn())
const resolveNativeDirectoryHandleMock = vi.hoisted(() => vi.fn())

vi.mock('@/store/opfs.store', () => ({ useOPFSStore: useOPFSStoreMock }))
vi.mock('@/store/workspace.store', () => ({ useWorkspaceStore: useWorkspaceStoreMock }))
vi.mock('@/opfs', () => ({ getWorkspaceManager: getWorkspaceManagerMock }))
vi.mock('../tool-utils', () => ({ resolveNativeDirectoryHandle: resolveNativeDirectoryHandleMock }))

import { WorkspaceBackend } from '../backends/workspace-backend'

describe('WorkspaceBackend.deleteDir — gitignore protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceStoreMock.getState.mockReturnValue({ activeWorkspaceId: 'ws-test' })
    resolveNativeDirectoryHandleMock.mockResolvedValue(null)
  })

  it('skips gitignored files when deleting a directory tree', async () => {
    useOPFSStoreMock.getState.mockReturnValue({
      getCachedPaths: () => [],
      getPendingChanges: () => [],
    })
    const workspace = {
      resolvePath: vi.fn(async () => ({
        rootName: 'creatorweave',
        rootId: 'scope-123',
        backend: 'native-host' as const,
        relativePath: 'pkg',
        readOnly: false,
      })),
      getNativeDirectoryHandleForPath: vi.fn(async () => null),
      readFromDiskRoot: vi.fn(async (_root: string, path: string) => {
        if (path === '.gitignore' || path === 'pkg/.gitignore') return { content: '*.log\n' }
        throw new Error('not found')
      }),
      diskExec: {
        listDir: vi.fn(async (_root: string, relativePath: string) => {
          if (relativePath === 'pkg') return [
            { name: '.gitignore', kind: 'file' as const },
            { name: 'keep.ts', kind: 'file' as const },
            { name: 'debug.log', kind: 'file' as const },
          ]
          return []
        }),
      },
    }
    getWorkspaceManagerMock.mockResolvedValue({ getWorkspace: vi.fn(async () => workspace) })

    const deleteFile = vi.fn<(path: string) => Promise<void>>(async () => {})
    const backend = new WorkspaceBackend('ws-test', null, 'project-test')
    backend.deleteFile = deleteFile
    ;(backend as unknown as { getWorkspaceForBackend: () => Promise<unknown> }).getWorkspaceForBackend =
      async () => ({ workspace, workspaceId: 'ws-test' })

    const result = await backend.deleteDir('creatorweave/pkg')

    expect(result.deletedFiles).toEqual(['creatorweave/pkg/.gitignore', 'creatorweave/pkg/keep.ts'])
    expect(deleteFile).toHaveBeenCalledTimes(2)
    expect(deleteFile.mock.calls.map((call) => call[0])).toEqual(['creatorweave/pkg/.gitignore', 'creatorweave/pkg/keep.ts'])
  })

  it('keeps deleting every file when gitignore checking is unavailable', async () => {
    useOPFSStoreMock.getState.mockReturnValue({
      getCachedPaths: () => [],
      getPendingChanges: () => [],
    })
    const workspace = {
      resolvePath: vi.fn(async () => ({
        rootName: 'creatorweave',
        rootId: 'scope-999',
        backend: 'native-host' as const,
        relativePath: 'pkg',
        readOnly: false,
      })),
      getNativeDirectoryHandleForPath: vi.fn(async () => null),
      // Read surface exists but no .gitignore is readable anywhere —
      // ignore state cannot be proven, so deletion must fail open.
      readFile: vi.fn(async () => { throw new Error('not found') }),
      diskExec: {
        listDir: vi.fn(async (_root: string, relativePath: string) => {
          if (relativePath === 'pkg') return [
            { name: 'keep.ts', kind: 'file' as const },
            { name: 'debug.log', kind: 'file' as const },
          ]
          return []
        }),
      },
    }
    getWorkspaceManagerMock.mockResolvedValue({ getWorkspace: vi.fn(async () => workspace) })

    const deleteFile = vi.fn(async () => {})
    const backend = new WorkspaceBackend('ws-test', null, 'project-test')
    backend.deleteFile = deleteFile
    ;(backend as unknown as { getWorkspaceForBackend: () => Promise<unknown> }).getWorkspaceForBackend =
      async () => ({ workspace, workspaceId: 'ws-test' })

    const result = await backend.deleteDir('creatorweave/pkg')

    expect(result.deletedFiles).toEqual(['creatorweave/pkg/keep.ts', 'creatorweave/pkg/debug.log'])
    expect(deleteFile).toHaveBeenCalledTimes(2)
  })
})
