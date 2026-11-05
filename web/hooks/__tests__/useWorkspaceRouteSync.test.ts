import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// ── Mocks ────────────────────────────────────────────────────────────
const routerReplaceMock = vi.fn()
const routerMock = { replace: routerReplaceMock, push: vi.fn(), back: vi.fn() }
const translate = (key: string) => key

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/',
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
  },
}))

vi.mock('@/i18n', () => ({
  useT: () => translate,
}))

import { useWorkspaceRouteSync } from '../useWorkspaceRouteSync'
import { useProjectStore } from '@/store/project.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useConversationStore } from '@/store/conversation.store'

// ── Fixtures ─────────────────────────────────────────────────────────
const PROJECT_A = {
  id: 'project-a',
  name: 'Project A',
  status: 'active' as const,
  createdAt: 1_000,
  updatedAt: 1_000,
}

function makeWorkspace(id: string, lastAccessedAt: number) {
  return {
    // The store's conversion layer (sqliteWorkspaceToWorkspaceStats) exposes
    // the identifier as `id` — that's what the hook reads.
    id,
    name: id,
    createdAt: lastAccessedAt - 100,
    lastAccessedAt,
    pendingCount: 0,
  }
}

/** Action spies, re-installed into the real stores before each test. */
let switchWorkspaceSpy: ReturnType<typeof vi.fn>
let refreshPendingChangesSpy: ReturnType<typeof vi.fn>
let setActiveConversationSpy: ReturnType<typeof vi.fn>
let setActiveProjectSpy: ReturnType<typeof vi.fn>
let loadConversationsSpy: ReturnType<typeof vi.fn>

function setupStores(opts: {
  projects?: typeof PROJECT_A[]
  activeProjectId?: string
  workspaces?: ReturnType<typeof makeWorkspace>[]
  activeWorkspaceId?: string | null
  conversations?: Array<{ id: string }>
  activeConversationId?: string | null
  loaded?: boolean
}) {
  const projects = opts.projects ?? [PROJECT_A]
  const workspaces = opts.workspaces ?? [makeWorkspace('ws-old', 100), makeWorkspace('ws-recent', 500)]

  switchWorkspaceSpy = vi.fn(async () => {})
  refreshPendingChangesSpy = vi.fn(async () => {})
  setActiveConversationSpy = vi.fn(async () => {})
  setActiveProjectSpy = vi.fn(async () => true)
  loadConversationsSpy = vi.fn(async () => {})

  useProjectStore.setState({
    projects,
    projectStats: {},
    activeProjectId: opts.activeProjectId ?? PROJECT_A.id,
    initialized: true,
    isLoading: false,
    error: null,
    // Test-only action spy replacing the real implementation.
    setActiveProject: setActiveProjectSpy as never,
  })

  useConversationContextStore.setState({
    // Test fixtures carry the minimal subset the hook reads.
    workspaces: workspaces as never,
    activeWorkspaceId: opts.activeWorkspaceId ?? null,
    initialized: true,
    // Test-only action spies replacing the real implementations.
    switchWorkspace: switchWorkspaceSpy as never,
    refreshPendingChanges: refreshPendingChangesSpy as never,
  })

  useConversationStore.setState({
    loaded: opts.loaded ?? true,
    conversations: (opts.conversations ?? []) as never,
    activeConversationId: opts.activeConversationId ?? null,
    setActive: setActiveConversationSpy as never,
    loadFromDB: loadConversationsSpy,
  })
}

async function renderSyncHook(projectId: string, workspaceId?: string) {
  renderHook(() => useWorkspaceRouteSync(projectId, workspaceId))
  // Let the async syncFromRoute chain settle (steps are awaited sequentially)
  await waitFor(() => {
    expect(useConversationStore.getState().activeConversationId !== undefined).toBe(true)
  }, { timeout: 500 }).catch(() => {})
}

describe('useWorkspaceRouteSync', () => {
  beforeEach(() => {
    routerReplaceMock.mockClear()
  })

  it('redirects to /projects when the project does not exist', async () => {
    setupStores({})
    await renderSyncHook('project-missing')

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/projects'))
    expect(setActiveProjectSpy).not.toHaveBeenCalled()
    expect(switchWorkspaceSpy).not.toHaveBeenCalled()
    expect(setActiveConversationSpy).not.toHaveBeenCalled()
  })

  it('falls back to the most recently accessed workspace when the URL workspace is unknown', async () => {
    setupStores({})
    // ws-unknown is neither a workspace nor a conversation → fallback picks
    // the workspace with the highest lastAccessedAt (ws-recent)
    await renderSyncHook(PROJECT_A.id, 'ws-unknown')

    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith(`/projects/${PROJECT_A.id}/workspaces/ws-recent`)
    )
    expect(switchWorkspaceSpy).toHaveBeenCalledWith('ws-recent')
    expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-recent')
  })

  it('fills in the canonical URL when none is present (bare project URL)', async () => {
    setupStores({})
    await renderSyncHook(PROJECT_A.id, undefined)

    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith(`/projects/${PROJECT_A.id}/workspaces/ws-recent`)
    )
    expect(switchWorkspaceSpy).toHaveBeenCalledWith('ws-recent')
    expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-recent')
  })

  it('activates the URL workspace without rewriting the URL when it is valid', async () => {
    setupStores({})
    await renderSyncHook(PROJECT_A.id, 'ws-old')

    await waitFor(() => expect(switchWorkspaceSpy).toHaveBeenCalledWith('ws-old'))
    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-old')
  })

  it('allows a brand-new conversation id to pass through before it appears in the workspace list', async () => {
    // Sidebar "new conversation" flow: conversation exists, workspace list not
    // yet updated — syncFromRoute must accept the transient id.
    setupStores({
      workspaces: [makeWorkspace('ws-old', 100)],
      conversations: [{ id: 'ws-brand-new' }],
    })
    await renderSyncHook(PROJECT_A.id, 'ws-brand-new')

    await waitFor(() => expect(switchWorkspaceSpy).toHaveBeenCalledWith('ws-brand-new'))
    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-brand-new')
  })

  it('refreshes pending changes instead of switching when the target is already active', async () => {
    // Typical after F5: initialize() restores BOTH the active workspace and
    // the active conversation (same id) from the persisted record.
    setupStores({
      workspaces: [makeWorkspace('ws-recent', 500)],
      activeWorkspaceId: 'ws-recent',
      activeConversationId: 'ws-recent',
    })
    await renderSyncHook(PROJECT_A.id, 'ws-recent')

    await waitFor(() => expect(refreshPendingChangesSpy).toHaveBeenCalledWith(true))
    expect(switchWorkspaceSpy).not.toHaveBeenCalled()
    expect(setActiveConversationSpy).not.toHaveBeenCalled()
  })

  it('keeps the initial route pending until saved conversation messages are restored', async () => {
    setupStores({})
    let finishRestore!: () => void
    setActiveConversationSpy.mockImplementation(() => new Promise<void>((resolve) => {
      finishRestore = resolve
    }))
    const { result } = renderHook(() => useWorkspaceRouteSync(PROJECT_A.id, 'ws-old'))

    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-old'))
    expect(result.current).toBe(false)

    await act(async () => finishRestore())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('finishes an empty project without waiting for a conversation', async () => {
    setupStores({ workspaces: [] })
    const { result } = renderHook(() => useWorkspaceRouteSync(PROJECT_A.id))

    await waitFor(() => expect(result.current).toBe(true))
    expect(setActiveConversationSpy).not.toHaveBeenCalled()
  })

  it('keeps the workspace UI mounted during later conversation switches', async () => {
    setupStores({})
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useWorkspaceRouteSync(PROJECT_A.id, workspaceId),
      { initialProps: { workspaceId: 'ws-old' } },
    )
    await waitFor(() => expect(result.current).toBe(true))

    let finishSwitch!: () => void
    setActiveConversationSpy.mockImplementation(() => new Promise<void>((resolve) => {
      finishSwitch = resolve
    }))
    rerender({ workspaceId: 'ws-recent' })
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('ws-recent'))
    expect(result.current).toBe(true)
    await act(async () => finishSwitch())
  })

  it('awaits the cold metadata and transcript load before showing the workspace', async () => {
    setupStores({ loaded: false, conversations: [] })
    let finishTranscript!: () => void
    loadConversationsSpy.mockImplementation(async () => {
      // The real loader installs metadata and loaded=true BEFORE it reads
      // the active transcript. Readiness must await the whole load promise.
      useConversationStore.setState({ loaded: true, activeConversationId: 'ws-old' })
      await new Promise<void>((resolve) => { finishTranscript = resolve })
    })
    const { result } = renderHook(() => useWorkspaceRouteSync(PROJECT_A.id, 'ws-old'))

    await waitFor(() => expect(loadConversationsSpy).toHaveBeenCalled())
    expect(useConversationStore.getState().loaded).toBe(true)
    expect(result.current).toBe(false)
    expect(setActiveConversationSpy).not.toHaveBeenCalled()

    await act(async () => finishTranscript())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('reveals the existing workspace recovery UI if the initial switch fails', async () => {
    setupStores({})
    switchWorkspaceSpy.mockRejectedValue(new Error('Workspace could not be opened'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useWorkspaceRouteSync(PROJECT_A.id, 'ws-old'))

      await waitFor(() => expect(result.current).toBe(true))
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('keeps awaiting the cold transcript when the canonical route commits', async () => {
    setupStores({ loaded: false, conversations: [] })
    let finishTranscript!: () => void
    loadConversationsSpy.mockImplementation(async () => {
      useConversationStore.setState({ loaded: true, activeConversationId: 'ws-recent' })
      await new Promise<void>((resolve) => { finishTranscript = resolve })
    })
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useWorkspaceRouteSync(PROJECT_A.id, workspaceId),
      { initialProps: { workspaceId: undefined as string | undefined } },
    )
    await waitFor(() => expect(loadConversationsSpy).toHaveBeenCalledTimes(1))

    await act(async () => rerender({ workspaceId: 'ws-recent' }))
    expect(result.current).toBe(false)
    await act(async () => finishTranscript())
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('keeps awaiting an active selection when the canonical route commits', async () => {
    setupStores({})
    let finishTranscript!: () => void
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      useConversationStore.setState({ activeConversationId: id })
      await new Promise<void>((resolve) => { finishTranscript = resolve })
    })
    const { result, rerender } = renderHook(
      ({ workspaceId }) => useWorkspaceRouteSync(PROJECT_A.id, workspaceId),
      { initialProps: { workspaceId: undefined as string | undefined } },
    )
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledTimes(1))

    await act(async () => rerender({ workspaceId: 'ws-recent' }))
    expect(result.current).toBe(false)
    await act(async () => finishTranscript())
    await waitFor(() => expect(result.current).toBe(true))
  })
})
