import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// ── Mocks ────────────────────────────────────────────────────────────
const routerReplaceMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock, push: vi.fn(), back: vi.fn() }),
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
  useT: () => (key: string) => key,
}))

import { useWorkspaceRouteSyncStandalone } from '@/hooks/useWorkspaceRouteSyncStandalone'
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

/** Action spies, re-installed into the real stores before each test. */
let switchWorkspaceSpy: ReturnType<typeof vi.fn>
let refreshPendingChangesSpy: ReturnType<typeof vi.fn>
let setActiveConversationSpy: ReturnType<typeof vi.fn>
let setActiveProjectSpy: ReturnType<typeof vi.fn>

function setupStores(opts: {
  activeProjectId?: string
  activeWorkspaceId?: string | null
  conversations?: Array<{ id: string; kind?: 'direct' | 'project' }>
  activeConversationId?: string | null
}) {
  switchWorkspaceSpy = vi.fn(async () => {})
  refreshPendingChangesSpy = vi.fn(async () => {})
  setActiveConversationSpy = vi.fn(async () => {})
  setActiveProjectSpy = vi.fn(async () => true)

  useProjectStore.setState({
    projects: [PROJECT_A],
    projectStats: {},
    activeProjectId: opts.activeProjectId ?? PROJECT_A.id,
    initialized: true,
    isLoading: false,
    error: null,
    // Test-only action spy replacing the real implementation.
    setActiveProject: setActiveProjectSpy as never,
  })

  useConversationContextStore.setState({
    workspaces: [] as never,
    activeWorkspaceId: opts.activeWorkspaceId ?? null,
    initialized: true,
    // Test-only action spies replacing the real implementations.
    switchWorkspace: switchWorkspaceSpy as never,
    refreshPendingChanges: refreshPendingChangesSpy as never,
  })

  useConversationStore.setState({
    conversations: (opts.conversations ?? []) as never,
    activeConversationId: opts.activeConversationId ?? null,
    loaded: true,
    setActive: setActiveConversationSpy as never,
  })
}

describe('useWorkspaceRouteSyncStandalone', () => {
  beforeEach(() => {
    routerReplaceMock.mockClear()
  })

  it('redirects to /chats when the conversation does not exist', async () => {
    setupStores({ conversations: [{ id: 'chat-1', kind: 'direct' }] })
    renderHook(() => useWorkspaceRouteSyncStandalone('chat-missing'))

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/chats'))
    expect(switchWorkspaceSpy).not.toHaveBeenCalled()
    expect(setActiveConversationSpy).not.toHaveBeenCalled()
  })

  it('redirects to /chats when the conversation is not standalone (kind !== direct)', async () => {
    setupStores({ conversations: [{ id: 'chat-1', kind: 'project' }] })
    renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/chats'))
    expect(switchWorkspaceSpy).not.toHaveBeenCalled()
  })

  it('activates the URL chat: switches workspace then sets the conversation active', async () => {
    setupStores({
      conversations: [{ id: 'chat-1', kind: 'direct' }],
    })
    // Interleaving log: switchWorkspace records on COMPLETION (it is
    // awaited by the hook), setActive records on CALL. Ordering must be
    // [switchWorkspace:done, setActive:call] — if the hook ever fired
    // setActive before the switch finished, the log would invert and this
    // test would fail.
    const eventLog: string[] = []
    switchWorkspaceSpy.mockImplementation(async (id: string) => {
      await Promise.resolve()
      eventLog.push(`switchWorkspace:done:${id}`)
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      eventLog.push(`setActive:call:${id}`)
    })

    renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))

    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-1'))
    expect(eventLog).toEqual(['switchWorkspace:done:chat-1', 'setActive:call:chat-1'])
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('drops a stale route-sync completion: a slow sync for chat A never activates chat A after a newer sync to chat B', async () => {
    // Route navigation A → B while A's sync is still inside its switchWorkspace
    // await: when A's await resolves, its generation check must discard the
    // run — setActive('chat-a') must NEVER be called, and the active
    // conversation must remain chat B (the newest sync's choice).
    let releaseSwitchA: (() => void) | null = null
    const switchAGate = new Promise<void>((resolve) => {
      releaseSwitchA = resolve
    })

    setupStores({
      conversations: [
        { id: 'chat-a', kind: 'direct' },
        { id: 'chat-b', kind: 'direct' },
      ],
    })
    switchWorkspaceSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-a') await switchAGate
    })
    // Mirror the real setActive: commit synchronously when called.
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      useConversationStore.setState({ activeConversationId: id })
    })

    const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
      initialProps: { chatId: 'chat-a' },
    })
    // Let sync A reach its switchWorkspace await (blocked on the gate).
    await waitFor(() => expect(switchWorkspaceSpy).toHaveBeenCalledWith('chat-a'))
    // Navigate to chat B: effect cleanup bumps A's generation; sync B starts.
    rerender({ chatId: 'chat-b' })
    await waitFor(() => expect(useConversationStore.getState().activeConversationId).toBe('chat-b'))

    // NOW A's slow switchWorkspace resolves — the stale completion must be
    // dropped before it can touch the stores.
    releaseSwitchA!()
    // Flush A's continuation past its awaited call.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(setActiveConversationSpy).not.toHaveBeenCalledWith('chat-a')
    expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
  })

  it('drops a stale setActive continuation: a newer sync landing while the older setActive is suspended keeps chat B active', async () => {
    // The inverse interleaving of the test above: sync A has CLEARED its
    // pre-await cancelled() check and is suspended inside setActive('chat-a')
    // when sync B (chat-b) runs to completion. When A's setActive resolves,
    // the post-await generation check must discard the run — the store must
    // end on chat B, never chat A.
    let settleSetActiveA: (() => void) | null = null
    const setActiveAGate = new Promise<void>((resolve) => {
      settleSetActiveA = resolve
    })

    setupStores({
      conversations: [
        { id: 'chat-a', kind: 'direct' },
        { id: 'chat-b', kind: 'direct' },
      ],
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-a') await setActiveAGate
      // Mirror the real setActive: commit synchronously when called —
      // INCLUDING chat-a after its gate resumes. If the guard under test is
      // removed, the stale continuation would commit chat-a here and the
      // final assertion would catch it; a mock that never commits chat-a
      // would pass vacuously.
      useConversationStore.setState({ activeConversationId: id })
    })

    const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
      initialProps: { chatId: 'chat-a' },
    })
    // Let sync A enter setActive('chat-a') and suspend on the gate.
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-a'))
    // B's sync starts and completes while A is inside setActive.
    rerender({ chatId: 'chat-b' })
    await waitFor(() => expect(useConversationStore.getState().activeConversationId).toBe('chat-b'))

    // A's suspended setActive resumes: with the stale-activation guard, the
    // run must discard itself instead of committing chat A.
    settleSetActiveA!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
  })

  it('skips stale-completion repair after the hook unmounts (user left /chats/:id)', async () => {
    // A's sync is suspended inside setActive('chat-a') when the user leaves
    // the route entirely (unmount). When A's setActive resolves there is no
    // newest route target anymore — the repair must NOT read the old ref and
    // re-activate the chat the user just left.
    let settleSetActiveA: (() => void) | null = null
    const setActiveAGate = new Promise<void>((resolve) => {
      settleSetActiveA = resolve
    })

    setupStores({
      conversations: [{ id: 'chat-a', kind: 'direct' }],
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-a') await setActiveAGate
      useConversationStore.setState({ activeConversationId: id })
    })

    const { unmount } = renderHook(() => useWorkspaceRouteSyncStandalone('chat-a'))
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-a'))

    // Leave /chats/:chat-a while setActive is still pending.
    unmount()
    settleSetActiveA!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The committed setActive inside the store cannot be undone by the hook,
    // but the stale completion must not fire ANY further activation: no
    // repair call re-asserts the abandoned chat.
    expect(setActiveConversationSpy).toHaveBeenCalledTimes(1)
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('stale-completion repair targets the latest route even when its effect early-returned on loading', async () => {
    // A's sync is suspended inside setActive('chat-a'); the user navigates to
    // /chats/chat-b while project state is loading, so chat-b's effect
    // early-returns BEFORE syncing. The repair must still pick up the
    // chat-b target (tracked before the loading guards) and re-assert chat-b
    // — never re-activate the abandoned chat-a.
    let settleSetActiveA: (() => void) | null = null
    const setActiveAGate = new Promise<void>((resolve) => {
      settleSetActiveA = resolve
    })

    setupStores({
      conversations: [
        { id: 'chat-a', kind: 'direct' },
        { id: 'chat-b', kind: 'direct' },
      ],
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-a') await setActiveAGate
      useConversationStore.setState({ activeConversationId: id })
    })

    const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
      initialProps: { chatId: 'chat-a' },
    })
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-a'))

    // Navigate to chat-b while project state is loading: the new effect
    // returns early, so no sync B ever runs — only the ref tracking
    // (placed before the guards) learns the new target.
    useProjectStore.setState({ isLoading: true })
    rerender({ chatId: 'chat-b' })
    // Give the (early-returning) effect a tick; nothing should have synced.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(switchWorkspaceSpy).not.toHaveBeenCalledWith('chat-b')

    // A's suspended setActive resumes: the repair must re-assert the LATEST
    // route target (chat-b), not the abandoned chat-a.
    settleSetActiveA!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
    // Exactly two activations: the original chat-a call and the repair to
    // the latest route target — the repair went to chat-b, not chat-a.
    expect(setActiveConversationSpy).toHaveBeenCalledTimes(2)
    expect(setActiveConversationSpy).toHaveBeenNthCalledWith(2, 'chat-b')
  })

  it('stale-completion repair goes through the workspace-switch path (workspace and conversation move together)', async () => {
    // Finding: the repair called setActive(newest) WITHOUT switching the
    // workspace, so when navigation reached chat-b while project state was
    // loading (chat-b's effect early-returned) the conversation store could
    // point at chat-b while the workspace store still pointed at chat-a.
    // The repair must run the FULL sync — switchWorkspace included.
    let settleSetActiveA: (() => void) | null = null
    const setActiveAGate = new Promise<void>((resolve) => {
      settleSetActiveA = resolve
    })

    setupStores({
      conversations: [
        { id: 'chat-a', kind: 'direct' },
        { id: 'chat-b', kind: 'direct' },
      ],
      activeWorkspaceId: null,
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-a') await setActiveAGate
      useConversationStore.setState({ activeConversationId: id })
    })
    // First sync switches to chat-a; the repair must switch to chat-b.
    switchWorkspaceSpy.mockImplementation(async (id: string) => {
      useConversationContextStore.setState({ activeWorkspaceId: id })
    })

    const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
      initialProps: { chatId: 'chat-a' },
    })
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-a'))
    expect(useConversationContextStore.getState().activeWorkspaceId).toBe('chat-a')

    // Navigate to chat-b while project state is loading: its effect
    // early-returns, so without a full-sync repair chat-b would never get
    // its workspace switch.
    useProjectStore.setState({ isLoading: true })
    rerender({ chatId: 'chat-b' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    settleSetActiveA!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The repair switched the workspace to chat-b (not a bare setActive):
    expect(switchWorkspaceSpy).toHaveBeenCalledWith('chat-b')
    expect(useConversationContextStore.getState().activeWorkspaceId).toBe('chat-b')
    expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('a navigation that lands DURING the repair is not overwritten: newer route wins', async () => {
    // Finding: the repair committed setActive(newest) after its await
    // without re-checking the route target, so a navigation that happened
    // while the repair was suspended could be overwritten by the older
    // repair. The repair must re-check the ref after every await.
    let settleSetActiveB: (() => void) | null = null
    const setActiveBGate = new Promise<void>((resolve) => {
      settleSetActiveB = resolve
    })

    setupStores({
      conversations: [
        { id: 'chat-a', kind: 'direct' },
        { id: 'chat-b', kind: 'direct' },
        { id: 'chat-c', kind: 'direct' },
      ],
    })
    switchWorkspaceSpy.mockImplementation(async (id: string) => {
      useConversationContextStore.setState({ activeWorkspaceId: id })
    })
    setActiveConversationSpy.mockImplementation(async (id: string) => {
      if (id === 'chat-b') await setActiveBGate
      useConversationStore.setState({ activeConversationId: id })
    })

    const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
      initialProps: { chatId: 'chat-a' },
    })
    await waitFor(() => expect(useConversationStore.getState().activeConversationId).toBe('chat-a'))

    // Navigate to chat-b; its sync suspends inside setActive (gated).
    rerender({ chatId: 'chat-b' })
    await waitFor(() => expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-b'))
    // While chat-b's setActive is suspended, navigate AGAIN to chat-c. This
    // bumps chat-b's effect away (the whole hook effect re-runs for chat-c,
    // whose sync now races the repair).
    rerender({ chatId: 'chat-c' })
    await waitFor(() => expect(useConversationStore.getState().activeConversationId).toBe('chat-c'))

    // Chat-b's suspended setActive resumes and commits — that internal
    // commit cannot be undone — but the repair must follow the NEWEST
    // target (chat-c), never let chat-b win.
    settleSetActiveB!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useConversationContextStore.getState().activeWorkspaceId).toBe('chat-c')
    expect(useConversationStore.getState().activeConversationId).toBe('chat-c')
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('bounds the host-project activation wait: a stalled setActiveProject redirects to /chats', async () => {
    vi.useFakeTimers()
    try {
      // No active project: Step 0 must bind a host before anything else.
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-1', kind: 'direct' }] })
      // The activation never settles — the stall class the bound exists for.
      setActiveProjectSpy.mockImplementation(() => new Promise<boolean>(() => {}))

      renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveProjectSpy).toHaveBeenCalledWith('project-a')
      expect(routerReplaceMock).not.toHaveBeenCalled()

      // Past the HOST_ACTIVATION_TIMEOUT_MS bound (30s, shared with the
      // switchWorkspace bound) the sync gives up and takes the recoverable
      // /chats redirect instead of pinning the route behind its loading gate.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')
      expect(switchWorkspaceSpy).not.toHaveBeenCalled()
      expect(setActiveConversationSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repairs the destination after a timed-out host activation commits late (route left)', async () => {
    // The timeout releases the ROUTE (redirect to /chats), but the
    // activation promise keeps running inside the store and commits late —
    // AFTER the user has left the route. Cleanup blanks newestChatIdRef, so
    // the stale-completion repair cannot help; the retained
    // destinationChatIdRef must let the late commit re-run the full sync for
    // the destination chat instead of leaving the stale host project active.
    vi.useFakeTimers()
    try {
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-1', kind: 'direct' }] })
      let releaseActivation: (() => void) | null = null
      const activationGate = new Promise<boolean>((resolve) => {
        releaseActivation = () => resolve(true)
      })
      // Mirror the real setActiveProject: the commit lands inside the store
      // whenever the activation finally settles (long after the timeout).
      setActiveProjectSpy.mockImplementation(
        () =>
          activationGate.then((value) => {
            useProjectStore.setState({ activeProjectId: PROJECT_A.id })
            return value
          }) as Promise<boolean>,
      )

      const { unmount } = renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveProjectSpy).toHaveBeenCalledWith('project-a')

      // Timeout: the recoverable redirect fires while the activation hangs.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')

      // The user leaves the route entirely before the activation settles.
      unmount()

      // The activation settles and commits late inside the store.
      releaseActivation!()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // The late-commit repair restored the destination: full sync ran for
      // the retained destination chat (workspace switch + activation).
      expect(useProjectStore.getState().activeProjectId).toBe('project-a')
      expect(switchWorkspaceSpy).toHaveBeenCalledWith('chat-1')
      expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repair after a genuinely rejected host activation', async () => {
    // Only a LATE COMMIT (timeout then eventual success) needs the repair;
    // a genuine rejection never commits anything, so no sync may run after
    // the redirect.
    vi.useFakeTimers()
    try {
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-1', kind: 'direct' }] })
      setActiveProjectSpy.mockRejectedValue(new Error('activation failed'))

      renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      expect(switchWorkspaceSpy).not.toHaveBeenCalled()
      expect(setActiveConversationSpy).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a late-REJECTED activation (timeout first, rejection after cleanup) triggers no repair and leaves the destination untouched', async () => {
    // Sourcery round-6: the settlement watcher used to run on ANY settlement
    // (`.catch(() => {}).then(...)`), so a promise that REJECTS only after
    // the timeout fired — and after cleanup blanked newestChatIdRef — still
    // entered the repair branch and re-ran the full sync for the retained
    // destination. A rejected activation committed nothing, so that repair
    // would re-activate the abandoned chat from nothing. The watcher now
    // runs only on FULFILLMENT: a late rejection must leave the destination
    // store state exactly as cleanup left it.
    vi.useFakeTimers()
    try {
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-1', kind: 'direct' }] })
      let rejectActivation: (() => void) | null = null
      setActiveProjectSpy.mockImplementation(
        () =>
          new Promise<boolean>((_, reject) => {
            rejectActivation = () => reject(new Error('late activation failure'))
          }) as Promise<boolean>,
      )

      const { unmount } = renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveProjectSpy).toHaveBeenCalledWith('project-a')

      // Timeout: the recoverable redirect fires while the activation hangs.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')

      // The user leaves the route entirely (cleanup blanks newestChatIdRef;
      // destinationChatIdRef is retained) BEFORE the activation settles.
      unmount()

      // The abandoned activation now REJECTS — nothing ever committed.
      rejectActivation!()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)

      // No repair ran: the workspace/conversation stores were never touched,
      // and the host pointer still holds the pre-route state ('' — the
      // activation never committed).
      expect(switchWorkspaceSpy).not.toHaveBeenCalled()
      expect(setActiveConversationSpy).not.toHaveBeenCalled()
      expect(useProjectStore.getState().activeProjectId).toBe('')
      expect(useConversationContextStore.getState().activeWorkspaceId).toBeNull()
      expect(useConversationStore.getState().activeConversationId).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a settled host-project activation still proceeds normally (bound does not fire early)', async () => {
    vi.useFakeTimers()
    try {
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-1', kind: 'direct' }] })

      renderHook(() => useWorkspaceRouteSyncStandalone('chat-1'))
      // Well past the bound minus a tick: the activation resolves first, so
      // the sync must continue into the workspace switch — no redirect.
      await vi.advanceTimersByTimeAsync(29_999)
      expect(routerReplaceMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(switchWorkspaceSpy).toHaveBeenCalledWith('chat-1')
      expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-1')
      expect(routerReplaceMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timed-out host activation that commits later does not repoint the newer chat (full re-sync)', async () => {
    vi.useFakeTimers()
    try {
      // No active project: Step 0 binds a host. The activation is SLOW, not
      // dead — it commits after the 30s bound, landing on whatever page the
      // user navigated to in the meantime. The hook must observe that late
      // commit and re-run the full sync so the stores return to chat-b.
      setupStores({ activeProjectId: '', conversations: [{ id: 'chat-a', kind: 'direct' }, { id: 'chat-b', kind: 'direct' }] })
      let releaseActivation: (() => void) | null = null
      setActiveProjectSpy.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            releaseActivation = () => resolve(true)
          }),
      )
      // Mirror the real setActive: commit synchronously when called.
      setActiveConversationSpy.mockImplementation(async (id: string) => {
        useConversationStore.setState({ activeConversationId: id })
      })

      const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
        initialProps: { chatId: 'chat-a' },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveProjectSpy).toHaveBeenCalledWith('project-a')

      // Timeout fires: sync A bails with the recoverable redirect.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')

      // User navigates to chat-b; its sync activates it. Only patch the
      // active-project pointer — re-running setupStores here would re-install
      // fresh spies and drop the committing setActive mock above.
      useProjectStore.setState({ activeProjectId: 'project-a', isLoading: false })
      rerender({ chatId: 'chat-b' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-b')

      // NOW the abandoned activation for chat-a's session commits. The late
      // commit would repoint the stores; the watcher must re-run the full
      // sync for chat-b so it converges back (no stale chat-a activation).
      releaseActivation!()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveConversationSpy).not.toHaveBeenCalledWith('chat-a')
      expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a timed-out workspace switch that completes later does not repoint the newer chat (full re-sync)', async () => {
    vi.useFakeTimers()
    try {
      // Host is already bound, so the sync goes straight to Step 2. The
      // switchWorkspace for chat-a is SLOW: the 30s bound redirects, the user
      // navigates to chat-b, and then the abandoned switch completes — its
      // late commit must trigger a re-sync back to chat-b.
      setupStores({ conversations: [{ id: 'chat-a', kind: 'direct' }, { id: 'chat-b', kind: 'direct' }] })
      let releaseSwitch: (() => void) | null = null
      switchWorkspaceSpy.mockImplementation(
        (id: string) =>
          new Promise<void>((resolve) => {
            if (id === 'chat-a') {
              releaseSwitch = resolve
            } else {
              resolve()
            }
          }),
      )
      // Mirror the real setActive: commit synchronously when called.
      setActiveConversationSpy.mockImplementation(async (id: string) => {
        useConversationStore.setState({ activeConversationId: id })
      })

      const { rerender } = renderHook(({ chatId }) => useWorkspaceRouteSyncStandalone(chatId), {
        initialProps: { chatId: 'chat-a' },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(switchWorkspaceSpy).toHaveBeenCalledWith('chat-a')

      // Timeout fires: sync A bails with the recoverable redirect.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(routerReplaceMock).toHaveBeenCalledWith('/chats')

      // User navigates to chat-b; its sync activates it.
      rerender({ chatId: 'chat-b' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveConversationSpy).toHaveBeenCalledWith('chat-b')

      // NOW the abandoned switch to chat-a completes. The watcher re-runs the
      // full sync for chat-b, converging the stores back onto the route.
      releaseSwitch!()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(setActiveConversationSpy).not.toHaveBeenCalledWith('chat-a')
      expect(useConversationStore.getState().activeConversationId).toBe('chat-b')
    } finally {
      vi.useRealTimers()
    }
  })
})
