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
import { getRuntimeHandlesForProject } from '@/native-fs'
import { isNativeHostAvailable } from '@/opfs/native-disk/executor'

describe('folder-access.store runtime handle binding', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(getRuntimeHandlesForProject).mockReturnValue(new Map())
    vi.mocked(isNativeHostAvailable).mockReturnValue(true)
    mockSidePanelContext.isSidePanelMode.mockReturnValue(false)
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

  it.each(['denied', 'prompt'])('does not bind a persisted directory for permission state %s', async (permission) => {
    const projectId = 'project-permission-not-granted'
    const handle = { name: 'repo', requestPermission: vi.fn().mockResolvedValue(permission) } as unknown as FileSystemDirectoryHandle
    useFolderAccessStore.setState({
      records: { [projectId]: {
        projectId, folderName: 'repo', handle: null, persistedHandle: handle,
        status: 'needs_user_activation', createdAt: Date.now(), updatedAt: Date.now(),
      } },
    })
    expect(await useFolderAccessStore.getState().requestPermission(projectId)).toBe(false)
    expect(useFolderAccessStore.getState().records[projectId]).toMatchObject({ handle: null, status: 'needs_user_activation' })
    expect(mockRepo.save).not.toHaveBeenCalled()
    expect(mockNativeFS.bindRuntimeDirectoryHandle).not.toHaveBeenCalled()
    expect(mockWorkspaceStore.onNativeDirectoryGranted).not.toHaveBeenCalled()
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

  it('adoptPickedRoot validates a pending project handoff before SQLite-first adoption', async () => {
    const projectId = 'project-adopt'
    const handle = fakeHandle('picked-repo')
    mockRepo.takeParkedHandle.mockResolvedValue(handle)
    mockRepo.save.mockResolvedValue(undefined)
    mockProjectRootRepo.createRoot.mockResolvedValue({
      id: 'root-adopted',
      projectId,
      name: 'picked-repo',
    })
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('picked-repo', 'pick-1', projectId)

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
    expect(mockRepo.takeParkedHandle).toHaveBeenCalledWith('pick-1', projectId, 'picked-repo')
    expect(mockRepo.findByProjectAndRoot).not.toHaveBeenCalled()
  })

  it('adoptPickedRoot adopts a pending root-route handoff into the active project', async () => {
    const projectId = 'project-adopt-parked'
    const handle = fakeHandle('parked-repo')
    mockRepo.findByProjectAndRoot.mockResolvedValue(null)
    mockRepo.takeParkedHandle.mockResolvedValue(handle)
    mockRepo.save.mockResolvedValue(undefined)
    mockProjectRootRepo.createRoot.mockResolvedValue({ id: 'root-2', projectId, name: 'parked-repo' })
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('parked-repo', 'pick-root-route', null)

    expect(adopted).toBe(true)
    expect(mockRepo.takeParkedHandle).toHaveBeenCalledTimes(1)
    expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'parked-repo', handle)
  })

  it('adoptPickedRoot reports duplicates as already-exists without creating', async () => {
    const projectId = 'project-adopt-dup'
    mockRepo.takeParkedHandle.mockResolvedValue(fakeHandle('dup-repo'))
    // Root already present in SQLite.
    mockProjectRootRepo.findByProject.mockResolvedValue([
      { id: 'root-dup', projectId, name: 'dup-repo' },
    ])
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('dup-repo', 'pick-dup', projectId)

    expect(adopted).toBe(false)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
    expect(mockNativeFS.bindRuntimeDirectoryHandle).not.toHaveBeenCalled()
    const { toast } = await import('sonner')
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('already exists'))
  })

  it.each([true, false])('re-picking a directory restores only the same entry (same=%s)', async (sameEntry) => {
    const projectId = 'project-restore-picked'
    const handle = fakeHandle('photos')
    const previousHandle = {
      name: 'photos',
      isSameEntry: vi.fn().mockResolvedValue(sameEntry),
    } as unknown as FileSystemDirectoryHandle
    mockRepo.takeParkedHandle.mockResolvedValue(handle)
    mockRepo.findByProjectAndRoot.mockResolvedValue({ persistedHandle: previousHandle })
    mockRepo.save.mockResolvedValue(undefined)
    mockProjectRootRepo.findByProject.mockResolvedValue([
      { id: 'existing-photos', projectId, name: 'photos', backend: 'fsaccess' },
    ])
    useFolderAccessStore.setState({
      activeProjectId: projectId,
      roots: [{
        id: 'existing-photos', name: 'photos', backend: 'fsaccess', scopeId: null,
        isDefault: true, readOnly: true, handle: null, persistedHandle: previousHandle,
        status: 'needs_user_activation',
      }],
    })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('photos', 'pick-photos', projectId)

    expect(adopted).toBe(sameEntry)
    expect(previousHandle.isSameEntry).toHaveBeenCalledWith(handle)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
    if (sameEntry) {
      expect(mockNativeFS.bindRuntimeDirectoryHandle).toHaveBeenCalledWith(projectId, 'photos', handle)
      expect(mockRepo.save).toHaveBeenCalled()
    } else {
      expect(mockNativeFS.bindRuntimeDirectoryHandle).not.toHaveBeenCalled()
      expect(mockRepo.save).not.toHaveBeenCalled()
    }
  })

  it('adoptPickedRoot fails cleanly when its pending handle is missing', async () => {
    const projectId = 'project-adopt-missing'
    mockRepo.findByProjectAndRoot.mockResolvedValue(null)
    mockRepo.takeParkedHandle.mockResolvedValue(null)
    useFolderAccessStore.setState({ activeProjectId: projectId })

    const adopted = await useFolderAccessStore.getState().adoptPickedRoot('ghost-repo', 'pick-missing', projectId)

    expect(adopted).toBe(false)
    expect(mockProjectRootRepo.createRoot).not.toHaveBeenCalled()
  })

  it('rejects a different same-name directory without changing the persisted root after reload', async () => {
    const projectId = 'project-identity'
    const original = { name: 'photos', isSameEntry: vi.fn().mockResolvedValue(false), queryPermission: vi.fn().mockResolvedValue('granted') } as unknown as FileSystemDirectoryHandle
    const replacement = fakeHandle('photos')
    let persisted = { projectId, rootName: 'photos', persistedHandle: original }
    mockRepo.findByProjectAndRoot.mockImplementation(async () => persisted)
    mockRepo.save.mockImplementation(async (record) => { persisted = record })
    mockRepo.takeParkedHandle.mockResolvedValue(replacement)
    mockProjectRootRepo.findByProject.mockResolvedValue([{ id: 'root-original', projectId, name: 'photos', backend: 'fsaccess' }])
    useFolderAccessStore.setState({ activeProjectId: projectId, roots: [] })

    expect(await useFolderAccessStore.getState().adoptPickedRoot('photos', 'pick-wrong', projectId)).toBe(false)
    expect(original.isSameEntry).toHaveBeenCalledWith(replacement)
    expect(mockRepo.save).not.toHaveBeenCalled()
    expect(mockNativeFS.bindRuntimeDirectoryHandle).not.toHaveBeenCalled()
    expect((await mockRepo.findByProjectAndRoot(projectId, 'photos')).persistedHandle).toBe(original)
    await useFolderAccessStore.getState().loadRoots()
    expect(useFolderAccessStore.getState().roots[0].persistedHandle).toBe(original)
  })

  it('does not consume a handoff for a different active project', async () => {
    useFolderAccessStore.setState({ activeProjectId: 'project-other' })
    expect(await useFolderAccessStore.getState().adoptPickedRoot('photos', 'pick-other', 'project-picked')).toBe(false)
    expect(mockRepo.takeParkedHandle).not.toHaveBeenCalled()
    expect(mockRepo.save).not.toHaveBeenCalled()
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
