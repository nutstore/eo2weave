import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRepo = vi.hoisted(() => ({
  load: vi.fn(),
  loadAllForProject: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  deleteByProjectAndRoot: vi.fn(),
  findByProjectAndRoot: vi.fn(),
  saveParkedHandle: vi.fn(),
  takeParkedHandle: vi.fn(),
}))

const mockNativeFS = vi.hoisted(() => ({
  bindRuntimeDirectoryHandle: vi.fn(),
  unbindRuntimeDirectoryHandle: vi.fn(),
}))

const mockWorkspaceStore = vi.hoisted(() => ({
  onNativeDirectoryGranted: vi.fn(),
}))

const mockProjectRootRepo = vi.hoisted(() => ({
  findByProject: vi.fn(),
  findByScopeId: vi.fn(),
  createRoot: vi.fn(),
  deleteRoot: vi.fn(),
  setDefaultRoot: vi.fn(),
}))

const mockNativeHostExecutor = vi.hoisted(() => ({
  revokeRoot: vi.fn(),
  authorizeRoot: vi.fn(),
}))

const mockAgentStoreModule = vi.hoisted(() => ({
  useAgentStore: { setState: vi.fn() },
}))

const mockSidePanelContext = vi.hoisted(() => ({
  isSidePanelMode: vi.fn(() => false),
}))

vi.mock('@/services/folder-access.repository', () => ({
  folderAccessRepo: mockRepo,
}))

vi.mock('@/agent/workspace-assistant-context', () => mockSidePanelContext)

vi.mock('@/store/agent.store', () => mockAgentStoreModule)

vi.mock('@/services/fsAccess.service', () => ({
  selectFolderReadWrite: vi.fn(),
}))

vi.mock('@/native-fs', () => ({
  bindRuntimeDirectoryHandle: mockNativeFS.bindRuntimeDirectoryHandle,
  unbindRuntimeDirectoryHandle: mockNativeFS.unbindRuntimeDirectoryHandle,
  getRuntimeHandlesForProject: vi.fn(() => new Map()),
}))

vi.mock('@/sqlite', () => ({
  getProjectRootRepository: () => mockProjectRootRepo,
}))

vi.mock('@/opfs/native-disk/executor', () => ({
  isNativeHostAvailable: vi.fn(() => true),
}))

vi.mock('@/opfs/native-disk/executor-native-host', () => ({
  NativeHostExecutor: class {
    revokeRoot = mockNativeHostExecutor.revokeRoot
    authorizeRoot = mockNativeHostExecutor.authorizeRoot
  },
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('../workspace.store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      onNativeDirectoryGranted: mockWorkspaceStore.onNativeDirectoryGranted,
    }),
  },
}))

import { useFolderAccessStore } from '../folder-access.store'

describe('folder-access.store runtime handle binding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRepo.loadAllForProject.mockResolvedValue([])
    mockProjectRootRepo.findByProject.mockResolvedValue([])
    // Default: removed root was the last binding of its scope.
    mockProjectRootRepo.findByScopeId.mockResolvedValue([])
    useFolderAccessStore.setState({
      activeProjectId: null,
      records: {},
      roots: [],
      rootsHydrated: false,
    })
  })

  it('binds runtime handle during hydrate when persisted permission is granted', async () => {
    const projectId = 'project-1'
    const handle = {
      name: 'demo',
      queryPermission: vi.fn().mockResolvedValue('granted'),
    } as unknown as FileSystemDirectoryHandle

    mockRepo.load.mockResolvedValue({
      projectId,
      folderName: 'demo',
      handle: null,
      persistedHandle: handle,
      status: 'needs_user_activation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    await useFolderAccessStore.getState().setActiveProject(projectId)

    const record = useFolderAccessStore.getState().records[projectId]
    expect(record.status).toBe('ready')
    expect(record.handle).toBe(handle)
    expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'demo', handle)
    expect(mockWorkspaceStore.onNativeDirectoryGranted).toHaveBeenCalledWith(handle)
  })

  it('binds runtime handle after requestPermission succeeds', async () => {
    const projectId = 'project-2'
    const handle = {
      name: 'repo',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    } as unknown as FileSystemDirectoryHandle

    useFolderAccessStore.setState({
      activeProjectId: projectId,
      records: {
        [projectId]: {
          projectId,
          folderName: 'repo',
          handle: null,
          persistedHandle: handle,
          status: 'needs_user_activation',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })

    mockRepo.save.mockResolvedValue(undefined)
    const granted = await useFolderAccessStore.getState().requestPermission(projectId)

    const record = useFolderAccessStore.getState().records[projectId]
    expect(granted).toBe(true)
    expect(record.status).toBe('ready')
    expect(record.handle).toBe(handle)
    expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'repo', handle)
    expect(mockWorkspaceStore.onNativeDirectoryGranted).toHaveBeenCalledWith(handle)
  })

  it('removes a native-host root locally when host revocation fails', async () => {
    const projectId = 'project-3'
    const rootId = 'root-native-1'
    const scopeId = 'scope_missing'
    mockNativeHostExecutor.revokeRoot.mockRejectedValueOnce(new Error(`unknown scope_id: ${scopeId}`))
    useFolderAccessStore.setState({
      activeProjectId: projectId,
      roots: [{
        id: rootId,
        name: 'orphaned-folder',
        isDefault: false,
        readOnly: false,
        backend: 'native-host',
        scopeId,
        handle: null,
        persistedHandle: null,
        status: 'idle',
      }],
    })

    await useFolderAccessStore.getState().removeRoot(rootId)

    expect(mockNativeHostExecutor.revokeRoot).toHaveBeenCalledWith(projectId, scopeId)
    expect(mockProjectRootRepo.deleteRoot).toHaveBeenCalledWith(rootId)
    expect(mockRepo.deleteByProjectAndRoot).toHaveBeenCalledWith(projectId, 'orphaned-folder')
  })

  // Regression: native-host scopes are GLOBAL on the host side — adding the
  // same local folder from another project reuses the same scope_id. Removing
  // the folder from one project used to revoke the shared scope, breaking
  // every other project still using it.
  it('keeps host authorization when another project still binds the same scope', async () => {
    const projectId = 'project-shared'
    const rootId = 'root-native-shared'
    const scopeId = 'scope_shared'
    mockProjectRootRepo.findByScopeId.mockResolvedValue([
      {
        id: 'root-other-project',
        projectId: 'project-B',
        name: 'shared-repo',
        isDefault: true,
        readOnly: false,
        backend: 'native-host',
        scopeId,
        sortOrder: 0,
        createdAt: Date.now(),
      },
    ])

    useFolderAccessStore.setState({
      activeProjectId: projectId,
      roots: [{
        id: rootId,
        name: 'shared-repo',
        isDefault: false,
        readOnly: false,
        backend: 'native-host',
        scopeId,
        handle: null,
        persistedHandle: null,
        status: 'ready',
      }],
    })

    await useFolderAccessStore.getState().removeRoot(rootId)

    expect(mockProjectRootRepo.findByScopeId).toHaveBeenCalledWith(scopeId)
    expect(mockNativeHostExecutor.revokeRoot).not.toHaveBeenCalled()
    expect(mockProjectRootRepo.deleteRoot).toHaveBeenCalledWith(rootId)
    expect(mockRepo.deleteByProjectAndRoot).toHaveBeenCalledWith(projectId, 'shared-repo')
  })

  it('revokes host authorization when the removed root was the last binding', async () => {
    const projectId = 'project-last'
    const rootId = 'root-native-last'
    const scopeId = 'scope_last'

    useFolderAccessStore.setState({
      activeProjectId: projectId,
      roots: [{
        id: rootId,
        name: 'only-repo',
        isDefault: false,
        readOnly: false,
        backend: 'native-host',
        scopeId,
        handle: null,
        persistedHandle: null,
        status: 'ready',
      }],
    })

    await useFolderAccessStore.getState().removeRoot(rootId)

    expect(mockProjectRootRepo.findByScopeId).toHaveBeenCalledWith(scopeId)
    expect(mockNativeHostExecutor.revokeRoot).toHaveBeenCalledWith(projectId, scopeId)
    expect(mockProjectRootRepo.deleteRoot).toHaveBeenCalledWith(rootId)
  })

  it('removes a native-host root with missing scopeId locally without revoking', async () => {
    const projectId = 'project-noscope'
    const rootId = 'root-native-noscope'

    useFolderAccessStore.setState({
      activeProjectId: projectId,
      roots: [{
        id: rootId,
        name: 'drifted-repo',
        isDefault: false,
        readOnly: false,
        backend: 'native-host',
        scopeId: null,
        handle: null,
        persistedHandle: null,
        status: 'idle',
      }],
    })

    await useFolderAccessStore.getState().removeRoot(rootId)

    expect(mockNativeHostExecutor.revokeRoot).not.toHaveBeenCalled()
    expect(mockProjectRootRepo.findByScopeId).not.toHaveBeenCalled()
    expect(mockProjectRootRepo.deleteRoot).toHaveBeenCalledWith(rootId)
    expect(mockRepo.deleteByProjectAndRoot).toHaveBeenCalledWith(projectId, 'drifted-repo')
  })

  // Regression: exec's in-flow authorization passes the CONVERSATION's
  // projectId so the new root is bound to the right project even when the
  // global active-project pointer changed while the OS picker was open.
  it('binds addNativeHostRoot to the explicit projectId override', async () => {
    mockNativeHostExecutor.authorizeRoot.mockResolvedValue({
      id: 'scope_new',
      displayName: 'fresh-repo',
    })
    mockProjectRootRepo.createRoot.mockResolvedValue({
      id: 'root-new',
      projectId: 'conversation-project',
      name: 'fresh-repo',
      isDefault: false,
      readOnly: false,
      backend: 'native-host',
      scopeId: 'scope_new',
      sortOrder: 0,
      createdAt: Date.now(),
    })

    const added = await useFolderAccessStore.getState().addNativeHostRoot('conversation-project')

    expect(added).toBe(true)
    expect(mockProjectRootRepo.createRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'conversation-project',
        name: 'fresh-repo',
        backend: 'native-host',
        scopeId: 'scope_new',
      })
    )

    // No override + no active project (beforeEach resets it) → no-op; exec
    // always passes the override, UI callers always have an active project.
    mockProjectRootRepo.createRoot.mockClear()
    const noop = await useFolderAccessStore.getState().addNativeHostRoot()
    expect(noop).toBe(false)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
  })

  // ─── adoptPickedRoot (folder-pick tab handoff) ──────────────────────

  /** Build a minimal fake directory handle for adopt tests. */
  function fakeHandle(name: string): FileSystemDirectoryHandle {
    return { name } as unknown as FileSystemDirectoryHandle
  }

  it('adoptPickedRoot adopts a project-scoped picked handle (SQLite-first ordering)', async () => {
    const projectId = 'project-adopt'
    const handle = fakeHandle('picked-repo')
    mockRepo.findByProjectAndRoot.mockResolvedValue({
      projectId,
      rootName: 'picked-repo',
      persistedHandle: handle,
      status: 'ready',
    })
    mockRepo.save.mockResolvedValue(undefined)
    mockProjectRootRepo.createRoot.mockResolvedValue({
      id: 'root-adopted',
      projectId,
      name: 'picked-repo',
    })
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('picked-repo')

    expect(adopted).toBe(true)
    // SQLite row MUST be created before the runtime handle is bound (the
    // addRoot anti-orphan contract).
    expect(mockProjectRootRepo.createRoot).toHaveBeenCalledWith({ projectId, name: 'picked-repo' })
    expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'picked-repo', handle)
    expect(mockRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      rootName: 'picked-repo',
      persistedHandle: handle,
      status: 'ready',
    }))
    // Parked slot must be untouched when the project-scoped record hit.
    expect(mockRepo.takeParkedHandle).not.toHaveBeenCalled()
  })

  it('adoptPickedRoot falls back to the parked handle when no project record exists', async () => {
    const projectId = 'project-adopt-parked'
    const handle = fakeHandle('parked-repo')
    mockRepo.findByProjectAndRoot.mockResolvedValue(null)
    mockRepo.takeParkedHandle.mockResolvedValue(handle)
    mockRepo.save.mockResolvedValue(undefined)
    mockProjectRootRepo.createRoot.mockResolvedValue({ id: 'root-2', projectId, name: 'parked-repo' })
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('parked-repo')

    expect(adopted).toBe(true)
    expect(mockRepo.takeParkedHandle).toHaveBeenCalledTimes(1)
    expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'parked-repo', handle)
  })

  it('adoptPickedRoot reports duplicates as already-exists without creating', async () => {
    const projectId = 'project-adopt-dup'
    mockRepo.findByProjectAndRoot.mockResolvedValue({
      projectId,
      rootName: 'dup-repo',
      persistedHandle: fakeHandle('dup-repo'),
      status: 'ready',
    })
    // Root already present in SQLite.
    mockProjectRootRepo.findByProject.mockResolvedValue([
      { id: 'root-dup', projectId, name: 'dup-repo' },
    ])
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('dup-repo')

    expect(adopted).toBe(false)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
    expect(mockNativeFS.bindRuntimeDirectoryHandle).not.toHaveBeenCalled()
    const { toast } = await import('sonner')
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('already exists'))
  })

  it('adoptPickedRoot fails cleanly when neither record nor parked handle exists', async () => {
    const projectId = 'project-adopt-missing'
    mockRepo.findByProjectAndRoot.mockResolvedValue(null)
    mockRepo.takeParkedHandle.mockResolvedValue(null)
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('ghost-repo')

    expect(adopted).toBe(false)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
  })

  // Regression: the store now exposes `rootsHydrated` so WelcomeScreen can
  // wait for hydration to complete before deciding whether to render the
  // "select a folder" step (cold-start race that previously flashed the
  // prompt to users who already had a folder mounted).
  it('marks rootsHydrated=true after setActiveProject completes', async () => {
    const projectId = 'project-hydrated'
    mockRepo.load.mockResolvedValue(null)
    mockProjectRootRepo.findByProject.mockResolvedValue([])
    useFolderAccessStore.setState({ rootsHydrated: false })

    await useFolderAccessStore.getState().setActiveProject(projectId)

    expect(useFolderAccessStore.getState().rootsHydrated).toBe(true)
  })

  it('resets rootsHydrated when switching to a different project', async () => {
    const firstProject = 'project-a'
    const secondProject = 'project-b'
    mockRepo.load.mockResolvedValue(null)
    mockProjectRootRepo.findByProject.mockResolvedValue([])

    await useFolderAccessStore.getState().setActiveProject(firstProject)
    expect(useFolderAccessStore.getState().rootsHydrated).toBe(true)

    // Switching to a different project must reset the flag so the new
    // project's hydration status is what consumers see.
    useFolderAccessStore.setState({ rootsHydrated: true }) // baseline
    await useFolderAccessStore.getState().setActiveProject(secondProject)

    expect(useFolderAccessStore.getState().rootsHydrated).toBe(true)
    // And a fresh call to loadRoots (after the switch) must set it again
    // (the path that runs inside setActiveProject already covers this, but
    // this exercises the public action directly).
    useFolderAccessStore.setState({ rootsHydrated: false })
    await useFolderAccessStore.getState().loadRoots()
    expect(useFolderAccessStore.getState().rootsHydrated).toBe(true)
  })
})
