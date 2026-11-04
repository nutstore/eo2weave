import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@/sqlite/repositories/workspace.repository'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, Workspace>(),
  route: { activeProjectId: 'open-project' },
  getManager: vi.fn(),
  getDirectory: vi.fn(),
  initializeRuntime: vi.fn(async () => {}),
  findActiveProject: vi.fn(async () => ({ id: 'unrelated-persisted-project' })),
  upsert: vi.fn(async (row: Omit<Workspace, 'pendingCount'>) => {
    mocks.rows.set(row.id, { ...row, pendingCount: 0 })
  }),
}))

vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({
    findAllWorkspaces: async () => [...mocks.rows.values()],
    findWorkspaceById: async (id: string) => mocks.rows.get(id) ?? null,
    upsertWorkspace: mocks.upsert,
  }),
}))
vi.mock('@/sqlite/repositories/project.repository', () => ({
  getProjectRepository: () => ({ findActiveProject: mocks.findActiveProject }),
}))
vi.mock('@/opfs', () => ({ getWorkspaceManager: mocks.getManager, WorkspaceFiles: class {} }))
vi.mock('@/store/project.store', () => ({ useProjectStore: { getState: () => mocks.route } }))
vi.mock('@/opfs/workspace/workspace-runtime', () => ({
  WorkspaceRuntime: class {
    pendingCount = 0
    constructor(readonly workspaceId: string) {}
    initialize = mocks.initializeRuntime
  },
}))
vi.mock('@/opfs/native-disk/executor', () => ({ isNativeHostAvailable: () => false }))
vi.mock('@/opfs/native-disk/executor-fsaccess', () => ({ FSAccessExecutor: class {} }))
vi.mock('@/opfs/native-disk/executor-native-host', () => ({ NativeHostExecutor: class {} }))
vi.mock('@/opfs/native-disk/executor-composite', () => ({ CompositeExecutor: class {} }))
vi.mock('@/native-fs', () => ({
  requestDirectoryAccess: vi.fn(),
  releaseDirectoryHandle: vi.fn(),
  bindRuntimeDirectoryHandle: vi.fn(),
  getRuntimeHandlesForProject: () => new Map(),
}))
vi.mock('@/sqlite/repositories/fs-overlay.repository', () => ({ getFSOverlayRepository: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { WorkspaceManager } from '@/opfs/workspace/workspace-manager'
import { useWorkspaceStore } from '@/store/workspace.store'

function record(id: string, projectId = 'open-project'): Workspace {
  return {
    id,
    projectId,
    rootDirectory: `workspaces/${id}`,
    name: id,
    status: 'active',
    cacheSize: 0,
    modifiedFiles: 0,
    pendingCount: 0,
    createdAt: 10,
    lastAccessedAt: 20,
  }
}

describe('background conversation workspace initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rows.clear()
    mocks.rows.set('open-chat', record('open-chat'))
    mocks.route.activeProjectId = 'open-project'
    const directory = { getDirectoryHandle: mocks.getDirectory }
    mocks.getDirectory.mockResolvedValue(directory)
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory: async () => directory },
    })
    mocks.getManager.mockResolvedValue(new WorkspaceManager())
    useWorkspaceStore.setState({
      activeWorkspaceId: 'open-chat',
      workspaces: [record('open-chat')],
      currentPendingCount: 7,
      hasDirectoryHandle: true,
      initialized: true,
      pendingChanges: null,
      showPreview: true,
      error: null,
      pinnedWorkspaceIds: ['open-chat'],
    })
  })

  it('persists the conversation ID and open project, adds its sidebar row, and preserves the active view', async () => {
    const created = await useWorkspaceStore
      .getState()
      .ensureWorkspace('new-chat', 'Agent introduction')
    expect(created).toMatchObject({
      id: 'new-chat',
      projectId: 'open-project',
      name: 'Agent introduction',
    })
    expect(mocks.getDirectory).toHaveBeenCalledWith('open-project', { create: true })
    expect(mocks.getDirectory).toHaveBeenCalledWith('new-chat', { create: true })
    expect(mocks.findActiveProject).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'open-chat',
      currentPendingCount: 7,
      hasDirectoryHandle: true,
      showPreview: true,
      error: null,
    })
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual([
      'open-chat',
      'new-chat',
    ])

    // A new manager after a reload can resolve the same ID from persisted metadata.
    const reloaded = new WorkspaceManager()
    expect((await reloaded.getWorkspace('new-chat'))?.workspaceId).toBe('new-chat')
  })

  it('coalesces concurrent ensures and keeps timestamps and list entries stable on follow-up', async () => {
    const [first, second] = await Promise.all([
      useWorkspaceStore.getState().ensureWorkspace('new-chat'),
      useWorkspaceStore.getState().ensureWorkspace('new-chat'),
    ])
    const followup = await useWorkspaceStore.getState().ensureWorkspace('new-chat')
    expect(second).toEqual(first)
    expect(followup).toEqual(first)
    expect(mocks.upsert).toHaveBeenCalledTimes(1)
    expect(useWorkspaceStore.getState().workspaces.filter((w) => w.id === 'new-chat')).toHaveLength(
      1
    )
  })

  it('uses the open project when there is no selected conversation', async () => {
    useWorkspaceStore.setState({ activeWorkspaceId: null })
    expect(await useWorkspaceStore.getState().ensureWorkspace('new-chat')).toMatchObject({
      projectId: 'open-project',
    })
    expect(mocks.findActiveProject).not.toHaveBeenCalled()
  })

  it('keeps an existing target in its own project and out of another project sidebar', async () => {
    mocks.rows.set('foreign-chat', record('foreign-chat', 'other-project'))
    await useWorkspaceStore.getState().ensureWorkspace('foreign-chat')
    expect(mocks.rows.get('foreign-chat')).toMatchObject({
      projectId: 'other-project',
      createdAt: 10,
    })
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(['open-chat'])
  })

  it('captures the open conversation before a UI switch during initialization', async () => {
    mocks.getManager.mockImplementationOnce(async () => {
      mocks.route.activeProjectId = 'another-project'
      useWorkspaceStore.setState({ activeWorkspaceId: 'another-chat', workspaces: [] })
      return new WorkspaceManager()
    })
    await useWorkspaceStore.getState().ensureWorkspace('new-chat')
    expect(mocks.rows.get('new-chat')?.projectId).toBe('open-project')
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeWorkspaceId: 'another-chat',
      workspaces: [],
    })
  })

  it('does not reuse a legacy workspace whose root matches but whose ID is wrong', async () => {
    mocks.rows.set('legacy-wrong-id', {
      ...record('legacy-wrong-id'),
      rootDirectory: 'workspaces/new-chat',
    })
    await useWorkspaceStore.getState().ensureWorkspace('new-chat')
    expect(mocks.rows.get('new-chat')).toMatchObject({ id: 'new-chat', projectId: 'open-project' })
    expect((await (await mocks.getManager()).getWorkspace('new-chat'))?.workspaceId).toBe(
      'new-chat'
    )
  })

  it('surfaces a persistence failure and retries the metadata write on the next attempt', async () => {
    mocks.upsert.mockRejectedValueOnce(new Error('SQLite unavailable'))
    await expect(useWorkspaceStore.getState().ensureWorkspace('new-chat')).rejects.toThrow(
      'SQLite unavailable'
    )
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(['open-chat'])
    await expect(useWorkspaceStore.getState().ensureWorkspace('new-chat')).resolves.toMatchObject({
      id: 'new-chat',
    })
    expect(mocks.upsert).toHaveBeenCalledTimes(2)
  })

  it('fails without an open project instead of using a persisted global default', async () => {
    mocks.route.activeProjectId = ''
    useWorkspaceStore.setState({ activeWorkspaceId: null })
    await expect(useWorkspaceStore.getState().ensureWorkspace('new-chat')).rejects.toThrow(
      'No open project'
    )
    expect(mocks.upsert).not.toHaveBeenCalled()
    expect(mocks.findActiveProject).not.toHaveBeenCalled()
  })

  it('refuses to move an existing workspace to a different explicit project', async () => {
    const manager = new WorkspaceManager()
    await expect(
      manager.createWorkspace('workspaces/open-chat', 'open-chat', undefined, 'other-project')
    ).rejects.toThrow('already belongs to project open-project')
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('creates in an explicit project without switching or polluting the open project', async () => {
    expect(
      await useWorkspaceStore.getState().ensureWorkspace('new-chat', 'Other task', 'other-project')
    ).toMatchObject({ id: 'new-chat', projectId: 'other-project' })
    expect(useWorkspaceStore.getState()).toMatchObject({ activeWorkspaceId: 'open-chat' })
    expect(useWorkspaceStore.getState().workspaces.map((w) => w.id)).toEqual(['open-chat'])
    await expect(
      useWorkspaceStore.getState().ensureWorkspace('new-chat', undefined, 'open-project')
    ).rejects.toThrow('already belongs')
  })
})
