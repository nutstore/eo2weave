import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { lsExecutor } from '../ls.tool'

const getActiveConversationMock = vi.fn()
const getCurrentHandleMock = vi.fn()
const resolveVfsTargetMock = vi.fn()
const getWorkspaceManagerMock = vi.fn()

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: () => getActiveConversationMock(),
}))

vi.mock('@/store/folder-access.store', () => ({
  useFolderAccessStore: {
    getState: () => ({
      getCurrentHandle: () => getCurrentHandleMock(),
    }),
  },
}))

vi.mock('../vfs-resolver', () => ({
  resolveVfsTarget: async (...args: unknown[]) => {
    const target = await resolveVfsTargetMock(...args)
    if (!target || target.backend) return target
    if (target.kind === 'agent') {
      return {
        ...target,
        backend: {
          label: 'agent',
          getDirectoryHandle: async () =>
            target.agentManager.getDirectoryHandle?.(target.agentId, target.path, { allowMissing: false }),
          listAgents: target.agentManager.listAgents,
        },
      }
    }
    return target
  },
  withVfsAgentIdHint: (message: string) => message,
  isVfsPath: (path: string) => path.startsWith('vfs://'),
}))

vi.mock('@/opfs', () => ({
  getWorkspaceManager: () => getWorkspaceManagerMock(),
}))

const findProjectRootsMock = vi.fn()

vi.mock('@/sqlite/repositories/project-root.repository', () => ({
  getProjectRootRepository: () => ({
    findByProject: findProjectRootsMock,
  }),
}))

vi.mock('@/native-fs', () => ({
  getRuntimeHandlesForProject: () => new Map(),
}))

function createEmptyDirectoryHandle(name = 'root'): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    entries: async function* () {
      return
    },
    getDirectoryHandle: vi.fn(async () => createEmptyDirectoryHandle('child')),
  } as unknown as FileSystemDirectoryHandle
}

function createDirectoryHandleWithFiles(fileNames: string[], name = 'root'): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    entries: async function* () {
      for (const fileName of fileNames) {
        yield [
          fileName,
          {
            kind: 'file',
            name: fileName,
          } as unknown as FileSystemFileHandle,
        ] as const
      }
    },
    getDirectoryHandle: vi.fn(async () => createEmptyDirectoryHandle('child')),
  } as unknown as FileSystemDirectoryHandle
}

/** Parse the Tool Envelope V2 result */
function parseEnvelope(result: string) {
  return JSON.parse(result) as {
    ok: boolean
    tool: string
    version: number
    data: unknown
    meta?: Record<string, unknown>
    error?: { code: string; message: string }
  }
}

/** Build a nested OPFS-mirror directory tree from slash-separated paths. */
function createNestedDirectoryHandle(paths: string[], name = 'files', contents: Record<string, string> = {}): FileSystemDirectoryHandle {
  // Build { dirName → children[], fileName → true }
  const dirs = new Map<string, { dirs: Set<string>; files: Set<string> }>()
  const ensureDir = (dirPath: string) => {
    if (!dirs.has(dirPath)) dirs.set(dirPath, { dirs: new Set(), files: new Set() })
    return dirs.get(dirPath)!
  }
  ensureDir('')
  for (const p of paths) {
    const segments = p.split('/').filter(Boolean)
    const fileName = segments.pop()!
    let current = ''
    for (const seg of segments) {
      const parent = ensureDir(current)
      parent.dirs.add(seg)
      current = current ? `${current}/${seg}` : seg
      ensureDir(current)
    }
    ensureDir(current).files.add(fileName)
  }

  const buildHandle = (dirPath: string, dirName: string): FileSystemDirectoryHandle => {
    const node = dirs.get(dirPath)!
    return {
      kind: 'directory',
      name: dirName,
      entries: async function* () {
        for (const d of [...node.dirs].sort()) {
          yield [d, buildHandle(dirPath ? `${dirPath}/${d}` : d, d)] as const
        }
        for (const f of [...node.files].sort()) {
          const fullPath = dirPath ? `${dirPath}/${f}` : f
          yield [f, { kind: 'file', name: f, getFile: async () => new File([contents[fullPath] ?? ''], f) } as unknown as FileSystemFileHandle] as const
        }
      },
      getDirectoryHandle: vi.fn(async (child: string) => {
        if (!node.dirs.has(child)) throw new Error(`NotFound: ${child}`)
        return buildHandle(dirPath ? `${dirPath}/${child}` : child, child)
      }),
      getFileHandle: vi.fn(async (child: string) => {
        if (!node.files.has(child)) throw new Error(`NotFound: ${child}`)
        const fullPath = dirPath ? `${dirPath}/${child}` : child
        return { kind: 'file', name: child, getFile: async () => new File([contents[fullPath] ?? ''], child) }
      }),
    } as unknown as FileSystemDirectoryHandle
  }

  return buildHandle('', name)
}

describe('ls tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getActiveConversationMock.mockResolvedValue(undefined)
    getCurrentHandleMock.mockReturnValue(null)
    findProjectRootsMock.mockResolvedValue([])
  })

  it('filters ignored files from workspace glob results', async () => {
    const root = createNestedDirectoryHandle(['.gitignore', 'src/keep.ts', 'src/debug.log'], 'root', { '.gitignore': '*.log\n' })
    const result = await lsExecutor({ pattern: 'src/**/*' }, { directoryHandle: root } as unknown as ToolContext)
    const envelope = parseEnvelope(result)
    const paths = (envelope.data as Array<{ path: string }>).map((entry) => entry.path)
    expect(paths).toContain('src/keep.ts')
    expect(paths).not.toContain('src/debug.log')
  })

  it('falls back to folder-access current handle when context handle is missing', async () => {
    getCurrentHandleMock.mockReturnValue(createEmptyDirectoryHandle())

    const result = await lsExecutor(
      { pattern: '**/*.ts' },
      { directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toEqual([])
    expect(envelope.meta?._hint).toContain('No files matching pattern')
  })

  it('returns no-directory error when all handle sources are unavailable', async () => {
    const result = await lsExecutor(
      { pattern: '**/*.ts' },
      { directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(false)
    expect(envelope.error?.message).toContain('No directory selected.')
  })

  it('falls back to workspace files dir when native directory is unavailable', async () => {
    const getNativeDirectoryHandle = vi.fn().mockResolvedValue(null)
    const getFilesDir = vi.fn().mockResolvedValue(createEmptyDirectoryHandle())
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({
        getNativeDirectoryHandle,
        getFilesDir,
      }),
    })

    const result = await lsExecutor(
      { pattern: '**/*.ts' },
      { directoryHandle: null, workspaceId: 'ws_1' } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toEqual([])
    expect(getNativeDirectoryHandle).toHaveBeenCalled()
    expect(getFilesDir).toHaveBeenCalled()
  })

  it('supports glob scans on vfs agents namespace', async () => {
    const getDirectoryHandle = vi.fn(async () => createEmptyDirectoryHandle('agent-root'))
    resolveVfsTargetMock.mockResolvedValueOnce({
      kind: 'agent',
      path: '',
      agentId: 'default',
      projectId: 'project-1',
      agentManager: {
        getDirectoryHandle,
      },
    })

    const result = await lsExecutor(
      { path: 'vfs://agents/default', pattern: 'src/**/*.ts' },
      { directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toEqual([])
    expect(getDirectoryHandle).toHaveBeenCalledWith('default', '', { allowMissing: false })
  })

  it('lists agents for vfs://agents in list mode', async () => {
    resolveVfsTargetMock.mockResolvedValueOnce({
      kind: 'agent',
      path: '',
      agentId: '',
      projectId: 'project-1',
      agentManager: {
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'default' },
          { id: 'novel-editor', name: 'novel-editor' },
        ]),
      },
    })

    const result = await lsExecutor(
      { path: 'vfs://agents' },
      { directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(envelope.data).toEqual([
      { name: 'default', kind: 'directory' },
      { name: 'novel-editor', kind: 'directory' },
    ])
  })

  it('supports glob scans on vfs://agents root and returns namespaced paths', async () => {
    const agentRoot = {
      kind: 'directory',
      name: 'root',
      entries: async function* () {
        yield [
          'SOUL.md',
          {
            kind: 'file',
            name: 'SOUL.md',
          } as unknown as FileSystemFileHandle,
        ] as const
      },
    } as unknown as FileSystemDirectoryHandle

    const resolveAgentHandle = vi.fn(async () => ({
      handle: agentRoot,
      exists: true,
    }))

    resolveVfsTargetMock.mockResolvedValueOnce({
      kind: 'agent',
      path: '',
      agentId: '',
      projectId: 'project-1',
      agentManager: {
        listAgents: vi.fn(async () => [{ id: 'novel-editor', name: 'novel-editor' }]),
        getDirectoryHandle: resolveAgentHandle,
      },
    })

    const result = await lsExecutor(
      { path: 'vfs://agents', pattern: '**/SOUL.md' },
      { directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    const data = envelope.data as Array<{ name: string; path: string }>
    expect(data.some(e => e.path === 'novel-editor/SOUL.md')).toBe(true)
    expect(resolveAgentHandle).toHaveBeenCalledWith('novel-editor', '', { allowMissing: false })
  })

  it('matches exact filename pattern at workspace root', async () => {
    const rootHandle = createDirectoryHandleWithFiles([
      'loan-contract-template.docx',
      'ai-assistant-overview-rich.docx',
      'ai-assistant-overview.docx',
    ])

    const result = await lsExecutor(
      { pattern: 'loan-contract-template.docx' },
      { directoryHandle: rootHandle } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    const data = envelope.data as Array<{ name: string }>
    expect(data.some(e => e.name === 'loan-contract-template.docx')).toBe(true)
  })

  it('matches exact filename pattern when path is "./"', async () => {
    const rootHandle = createDirectoryHandleWithFiles([
      'loan-contract-template.docx',
      'ai-assistant-overview-rich.docx',
      'ai-assistant-overview.docx',
    ])

    const result = await lsExecutor(
      { path: './', pattern: 'loan-contract-template.docx' },
      { directoryHandle: rootHandle } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    const data = envelope.data as Array<{ name: string }>
    expect(data.some(e => e.name === 'loan-contract-template.docx')).toBe(true)
  })

  it('routes a root-prefixed list path to the native-host disk scanner even when an OPFS mirror exists', async () => {
    // Regression: native-host roots have no FileSystemDirectoryHandle, so they
    // are invisible to getRuntimeHandlesForProject. Before the fix, ls
    // "rootName/sub" silently fell through to the OPFS workspace mirror.
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'web/src', type: 'directory', size: 0, depth: 2 },
      { path: 'web/package.json', type: 'file', size: 512, depth: 2 },
    ])
    const getFilesDir = vi.fn().mockResolvedValue(createEmptyDirectoryHandle())
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, getFilesDir }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'creatorweave', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { path: 'creatorweave/web' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(scanDiskTree).toHaveBeenCalledWith(
      'creatorweave/web',
      expect.any(Number),
      'project_1',
      expect.objectContaining({})
    )
    const data = envelope.data as Array<{ path: string; kind: string }>
    expect(data.map(e => e.path)).toEqual(['web/src', 'web/package.json'])
  })

  it('routes a root-prefixed glob to the native-host disk scanner and prefixes match paths', async () => {
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src/app.ts', type: 'file', size: 32, depth: 2 },
      { path: 'src/lib', type: 'directory', size: 0, depth: 2 },
      { path: 'README.md', type: 'file', size: 128, depth: 1 },
    ])
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { path: 'native-root', pattern: '**/*.ts' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(scanDiskTree).toHaveBeenCalledWith(
      'native-root',
      expect.any(Number),
      'project_1',
      expect.objectContaining({})
    )
    const data = envelope.data as Array<{ path: string }>
    expect(data.map(e => e.path)).toEqual(['native-root/src/app.ts'])
  })

  it('globs native-host roots in a native-host-only project instead of erroring no_directory', async () => {
    // Native-host-only project: no FS Access/OPFS handle exists, so
    // resolveDiscoveryScope throws "No directory selected." — the glob must
    // fall back to the disk scanner (mirrors list mode and search).
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src/app.ts', type: 'file', size: 32, depth: 2 },
    ])
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { pattern: '**/*.ts' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(scanDiskTree).toHaveBeenCalledWith(
      'native-root',
      expect.any(Number),
      'project_1',
      expect.objectContaining({})
    )
    const data = envelope.data as Array<{ path: string }>
    expect(data.map(e => e.path)).toEqual(['native-root/src/app.ts'])
  })

  it('merges native-host root matches into an unscoped glob when both handle and native roots exist', async () => {
    // Hybrid project: an FS Access handle AND a native-host root. The unscoped
    // glob must cover both (mirrors search's mergeSearchResults behavior).
    const rootHandle = createDirectoryHandleWithFiles(['handle-file.ts'])
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'native-src/app.ts', type: 'file', size: 32, depth: 2 },
    ])
    const getFilesDir = vi.fn().mockResolvedValue(null)
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, getFilesDir }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { pattern: '**/*.ts' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: rootHandle } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    expect(scanDiskTree).toHaveBeenCalledWith(
      'native-root',
      expect.any(Number),
      'project_1',
      expect.objectContaining({})
    )
    const paths = (envelope.data as Array<{ path: string }>).map(e => e.path).sort()
    expect(paths).toEqual(['handle-file.ts', 'native-root/native-src/app.ts'])
  })

  it('merges OPFS pending changes into a native-host list scan (disk base + OPFS overlay)', async () => {
    // ls "rootName" on a native-host root must show BOTH disk files and
    // OPFS-only entries (pending write/edit not yet synced to disk).
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src', type: 'directory', size: 0, depth: 1 },
      { path: 'src/app.ts', type: 'file', size: 32, depth: 2 },
      { path: 'README.md', type: 'file', size: 128, depth: 1 },
    ])
    const getFilesDir = vi.fn().mockResolvedValue(createNestedDirectoryHandle([
      'creatorweave/src/app.ts',      // stale OPFS copy of a disk file — must NOT duplicate
      'creatorweave/notes-pending.md', // OPFS-only pending change — must be visible
    ]))
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, getFilesDir }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'creatorweave', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { path: 'creatorweave' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    const paths = (envelope.data as Array<{ path: string }>).map(e => e.path).sort()
    expect(paths).toEqual(['README.md', 'notes-pending.md', 'src', 'src/app.ts'])
  })

  it('applies native-host ignore rules to pending files in the OPFS overlay', async () => {
    const readFromDiskRoot = vi.fn(async () => ({ content: '*.log\n' }))
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({
        scanDiskTree: vi.fn().mockResolvedValue([]),
        resolvePath: vi.fn().mockResolvedValue({ rootId: 'root-id', relativePath: '' }),
        readFromDiskRoot,
        getFilesDir: vi.fn().mockResolvedValue(createNestedDirectoryHandle(['native-root/debug.log', 'native-root/app.ts'])),
      }),
    })
    findProjectRootsMock.mockResolvedValue([{ name: 'native-root', backend: 'native-host' }])
    const result = await lsExecutor({ path: 'native-root' }, { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext)
    const paths = (parseEnvelope(result).data as Array<{ path: string }>).map((entry) => entry.path)
    expect(paths).toContain('app.ts')
    expect(paths).not.toContain('debug.log')
    expect(readFromDiskRoot).toHaveBeenCalledTimes(1)
  })

  it('merges OPFS pending changes into a native-host glob (disk precedence for duplicates)', async () => {
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src/app.ts', type: 'file', size: 32, depth: 2 },
    ])
    const getFilesDir = vi.fn().mockResolvedValue(createNestedDirectoryHandle([
      'native-root/src/app.ts',      // duplicate of disk file — deduped
      'native-root/notes-pending.md', // OPFS-only pending change — visible
    ]))
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, getFilesDir }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await lsExecutor(
      { path: 'native-root', pattern: '**/*' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null } as unknown as ToolContext
    )

    const envelope = parseEnvelope(result)
    expect(envelope.ok).toBe(true)
    const paths = (envelope.data as Array<{ path: string }>).map(e => e.path).sort()
    expect(paths).toEqual(['native-root/notes-pending.md', 'native-root/src/app.ts'])
  })
})

