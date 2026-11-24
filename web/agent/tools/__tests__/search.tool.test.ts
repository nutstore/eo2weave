import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { searchDefinition, searchExecutor } from '../search.tool'
import { lookupFileSearchHits } from '@/vfs/search-operation'

const searchInDirectoryMock = vi.fn()
const getWorkspaceManagerMock = vi.fn()
const findProjectRootsMock = vi.fn()
const findWorkspaceByIdMock = vi.fn()

vi.mock('@/workers/search-worker-manager', () => ({
  getSearchWorkerManager: () => ({
    searchInDirectory: searchInDirectoryMock,
  }),
}))

vi.mock('@/opfs', () => ({
  getWorkspaceManager: () => getWorkspaceManagerMock(),
}))

vi.mock('@/sqlite/repositories/project-root.repository', () => ({
  getProjectRootRepository: () => ({
    findByProject: findProjectRootsMock,
  }),
}))

vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({
    findWorkspaceById: findWorkspaceByIdMock,
  }),
}))

vi.mock('@/native-fs', () => ({
  getRuntimeHandlesForProject: () => new Map(),
}))

const directoryHandle = {
  getFileHandle: vi.fn(),
  getDirectoryHandle: vi.fn(),
} as unknown as FileSystemDirectoryHandle

const context: ToolContext = { directoryHandle }

function unwrapOk(result: string) {
  const parsed = JSON.parse(result)
  expect(parsed.ok).toBe(true)
  expect(parsed.version).toBe(2)
  return parsed.data
}

function unwrapError(result: string) {
  const parsed = JSON.parse(result)
  expect(parsed.ok).toBe(false)
  expect(parsed.version).toBe(2)
  return parsed.error
}

describe('search tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findProjectRootsMock.mockResolvedValue([])
    searchInDirectoryMock.mockResolvedValue({
      results: [{ path: 'src/a.ts', line: 3, column: 8, match: 'TODO', preview: 'const x = TODO' }],
      totalMatches: 1,
      scannedFiles: 4,
      skippedFiles: 1,
      truncated: false,
      deadlineExceeded: false,
    })
  })

  it('requires query', async () => {
    const result = await searchExecutor({ mode: 'literal' }, context)
    const error = unwrapError(result)
    expect(error.message).toContain('query is required')
  })

  it('declares only query as required in schema', () => {
    expect(searchDefinition.function.parameters.required).toEqual(['query'])
  })

  it('defaults an omitted mode to literal', async () => {
    const result = await searchExecutor({ query: 'TODO' }, context)
    unwrapOk(result)
    expect(searchInDirectoryMock).toHaveBeenCalledWith(
      directoryHandle,
      expect.objectContaining({ query: 'TODO', regex: false })
    )
  })

  it('searches with provided directory handle', async () => {
    const result = await searchExecutor({ query: 'TODO', mode: 'literal', max_results: 20 }, context)
    const data = unwrapOk(result)

    expect(data.totalMatches).toBe(1)
    expect(searchInDirectoryMock).toHaveBeenCalledWith(
      directoryHandle,
      expect.objectContaining({ query: 'TODO', regex: false, maxResults: 10000 })
    )
  })

  it('searches a native-host root without a browser directory handle', async () => {
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src/app.ts', type: 'file', size: 32, depth: 2 },
    ])
    const readFile = vi.fn().mockResolvedValue({
      content: 'export const marker = "NATIVE_TODO"\n',
    })
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, readFile }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await searchExecutor(
      { query: 'NATIVE_TODO', mode: 'literal' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle: null }
    )
    const data = unwrapOk(result)

    expect(scanDiskTree).toHaveBeenCalledWith(
      'native-root',
      expect.any(Number),
      'project_1',
      expect.objectContaining({ includeSizes: true })
    )
    expect(readFile).toHaveBeenCalledWith('native-root/src/app.ts', null, { projectId: 'project_1' })
    expect(data.totalMatches).toBe(1)
    expect(data.files[0]).toMatchObject({ path: 'native-root/src/app.ts', bestLine: 1 })
    expect(searchInDirectoryMock).not.toHaveBeenCalled()
  })

  it('routes a root-prefixed path to the native-host disk scanner even when an OPFS handle exists', async () => {
    // Regression: native-host roots have no FileSystemDirectoryHandle, so they
    // are invisible to getRuntimeHandlesForProject. Before the fix, a path like
    // "creatorweave/web/src" fell through to the OPFS workspace handle and the
    // search silently scanned 0 files (or errored with path_not_found).
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'src/opfs/backup.ts', type: 'file', size: 64, depth: 3 },
    ])
    const readFile = vi.fn().mockResolvedValue({
      content: 'const REQUIRED_DB_FILE = "bfosa-unified.sqlite"\n',
    })
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, readFile }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'creatorweave', backend: 'native-host' },
    ])

    const result = await searchExecutor(
      { query: 'bfosa-unified.sqlite', mode: 'literal', path: 'creatorweave/web/src' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle }
    )
    const data = unwrapOk(result)

    expect(scanDiskTree).toHaveBeenCalledWith(
      'creatorweave/web/src',
      expect.any(Number),
      'project_1',
      expect.objectContaining({ includeSizes: true })
    )
    expect(readFile).toHaveBeenCalledWith(
      'creatorweave/web/src/src/opfs/backup.ts',
      null,
      { projectId: 'project_1' }
    )
    expect(data.totalMatches).toBe(1)
    expect(data.files[0]).toMatchObject({
      path: 'creatorweave/web/src/src/opfs/backup.ts',
      bestLine: 1,
    })
    expect(searchInDirectoryMock).not.toHaveBeenCalled()
  })

  it('merges native-host root results into an unscoped search when both handle and native roots exist', async () => {
    // Hybrid project: an OPFS/FS Access handle AND a native-host root. The
    // unscoped search must cover both — handle path via the worker, native-host
    // path via the disk scanner — and merge the results.
    const scanDiskTree = vi.fn().mockResolvedValue([
      { path: 'native-src/app.ts', type: 'file', size: 32, depth: 2 },
    ])
    const readFile = vi.fn().mockResolvedValue({
      content: 'export const marker = "NATIVE_TODO"\n',
    })
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({ scanDiskTree, readFile }),
    })
    findProjectRootsMock.mockResolvedValue([
      { name: 'native-root', backend: 'native-host' },
    ])

    const result = await searchExecutor(
      { query: 'TODO', mode: 'literal' },
      { workspaceId: 'ws_1', projectId: 'project_1', directoryHandle }
    )
    const data = unwrapOk(result)

    // Worker scanned the handle root; disk scanner scanned the native-host root.
    expect(searchInDirectoryMock).toHaveBeenCalledTimes(1)
    expect(scanDiskTree).toHaveBeenCalledWith(
      'native-root',
      expect.any(Number),
      'project_1',
      expect.objectContaining({ includeSizes: true })
    )

    const paths = data.files.map((f: { path: string }) => f.path).sort()
    expect(paths).toEqual(['native-root/native-src/app.ts', 'src/a.ts'])
    // 1 match from the worker + 1 from the disk scan
    expect(data.totalMatches).toBe(2)
  })

  it('does not scan native-host roots when the project has none', async () => {
    // Pure FS Access / OPFS project — the disk scanner must stay out of the way.
    const getWorkspace = vi.fn().mockResolvedValue({})
    getWorkspaceManagerMock.mockResolvedValue({ getWorkspace })

    await searchExecutor({ query: 'TODO', mode: 'literal' }, context)

    expect(searchInDirectoryMock).toHaveBeenCalledTimes(1)
    expect(getWorkspace).not.toHaveBeenCalled()
  })

  it('returns error when no directory or native-host workspace is available', async () => {
    const result = await searchExecutor({ query: 'TODO', mode: 'literal' }, { directoryHandle: null })
    const error = unwrapError(result)

    expect(error.message).toContain('No active workspace')
  })

  it('auto-upgrades regex-like query when mode=literal', async () => {
    const result = await searchExecutor(
      {
        query: 'from.*project-fingerprint|from.*intelligence-coordinator',
        mode: 'literal',
      },
      context
    )
    unwrapOk(result)
    expect(searchInDirectoryMock).toHaveBeenCalledWith(
      directoryHandle,
      expect.objectContaining({ regex: true })
    )
  })

  it('accepts regex-like query when mode=regex', async () => {
    const result = await searchExecutor(
      {
        query: 'Fingerprint|IntelligenceCoordinator|getFingerprintScanner|formatFingerprint',
        mode: 'regex',
      },
      context
    )
    unwrapOk(result)

    expect(searchInDirectoryMock).toHaveBeenCalledWith(
      directoryHandle,
      expect.objectContaining({
        query: 'Fingerprint|IntelligenceCoordinator|getFingerprintScanner|formatFingerprint',
        regex: true,
      })
    )
  })

  it('returns structured path_not_found error from worker details', async () => {
    searchInDirectoryMock.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          code: 'path_not_found',
          message: 'Search path "web/src/agent" not found under current root "web"',
          requestedPath: 'web/src/agent',
          resolvedRootName: 'web',
        })
      )
    )

    const result = await searchExecutor(
      {
        query: 'ProjectFingerprint',
        mode: 'regex',
        path: 'web/src/agent',
      },
      context
    )
    const error = unwrapError(result)

    expect(error.code).toBe('path_not_found')
    expect(error.details.requestedPath).toBe('web/src/agent')
    expect(error.details.resolvedRootName).toBe('web')
    expect(error.hint).toContain('Try')
  })
})

/**
 * Regression: the transcript "show all hits" drill-down used to resolve a
 * FileSystemDirectoryHandle on the client, which native-host roots never expose —
 * clicking "+N more lines" always failed with "No workspace handle".
 * lookupFileSearchHits must route through the same backends as the tool.
 */
describe('lookupFileSearchHits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findProjectRootsMock.mockResolvedValue([])
    findWorkspaceByIdMock.mockResolvedValue({ projectId: 'project_1' })
    searchInDirectoryMock.mockResolvedValue({
      results: [{ path: 'web/a.ts', line: 3, column: 8, match: 'TODO', preview: 'const x = TODO' }],
      files: [],
      totalMatches: 1,
      scannedFiles: 1,
      skippedFiles: 0,
      truncated: false,
      deadlineExceeded: false,
    })
  })

  it('reads a native-host file through the workspace runtime (no handle needed)', async () => {
    const scanDiskTree = vi.fn().mockResolvedValue([]) // file path → empty listing
    const readFile = vi.fn().mockResolvedValue({ content: 'a\npinWorkspace\nlock pinWorkspace();\n' })
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({
        scanDiskTree,
        readFile,
        resolvePath: vi.fn(),
        getNativeDirectoryHandleForPath: vi.fn().mockResolvedValue(null),
      }),
    })
    findProjectRootsMock.mockResolvedValue([{ name: 'creatorweave', backend: 'native-host' }])

    const hits = await lookupFileSearchHits(
      'creatorweave/web/components/a.tsx',
      { query: 'pinWorkspace' },
      { workspaceId: 'ws_1' }
    )

    expect(hits?.map((h) => h.line)).toEqual([2, 3])
    expect(readFile).toHaveBeenCalledWith('creatorweave/web/components/a.tsx', null, {
      projectId: 'project_1',
    })
    expect(searchInDirectoryMock).not.toHaveBeenCalled()
  })

  it('falls back to the search worker for handle-backed roots', async () => {
    const handle = { getFileHandle: vi.fn() } as unknown as FileSystemDirectoryHandle
    getWorkspaceManagerMock.mockResolvedValue({
      getWorkspace: vi.fn().mockResolvedValue({
        scanDiskTree: vi.fn().mockResolvedValue([]),
        readFile: vi.fn(),
        resolvePath: vi.fn().mockResolvedValue({
          rootName: 'creatorweave',
          relativePath: 'web/a.ts',
          backend: 'fsaccess',
          rootId: 'root_1',
          readOnly: false,
        }),
        getNativeDirectoryHandleForPath: vi.fn().mockResolvedValue(handle),
      }),
    })
    findProjectRootsMock.mockResolvedValue([{ name: 'creatorweave', backend: 'fsaccess' }])

    const hits = await lookupFileSearchHits('creatorweave/web/a.ts', { query: 'TODO' }, { workspaceId: 'ws_1' })

    expect(hits).toHaveLength(1)
    expect(searchInDirectoryMock).toHaveBeenCalledWith(
      handle,
      expect.objectContaining({ path: 'web/a.ts', query: 'TODO' })
    )
  })

  it('returns null when no backend can be reached', async () => {
    await expect(lookupFileSearchHits('ghost/a.ts', { query: 'x' }, {})).resolves.toBeNull()
  })
})
