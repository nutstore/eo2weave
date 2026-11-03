/**
 * Conversation store — PR #152 Sourcery findings (issue #147)
 *
 * Regression tests for the load-recovery guards added by PR #152's review:
 *
 *  - "User selection is replaced": a full or fallback load pending when the
 *    user selects another conversation must NOT reinstall its own
 *    context-preferred active id over the user's newer choice.
 *  - "Old workspace failure stays visible": a workspace-ensure failure for a
 *    workspace that is no longer active by the time the ensure settles must
 *    not be recorded (stale retry banner).
 *  - "Load recovery overrides a new conversation": createNew({activate})
 *    advances the selection generation, so pending recovery cannot replace
 *    the brand-new conversation.
 *  - "Workspace failure reported as recovered": a transcript read must not
 *    resolve a workspace-scoped diagnostics record.
 *
 * Like the earlier rounds, these drive the store through its PUBLIC API only
 * (loadFromDB / setActive / createNew) plus useStore.setState seeding.
 */
/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findAllMetaMock, findByConversationMock, getWorkspaceManagerMock, createWorkspaceMock } =
  vi.hoisted(() => ({
    findAllMetaMock: vi.fn(),
    findByConversationMock: vi.fn(),
    getWorkspaceManagerMock: vi.fn(),
    createWorkspaceMock: vi.fn(),
  }))

vi.mock('@/opfs', () => ({ getWorkspaceManager: getWorkspaceManagerMock }))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() },
}))

vi.mock('@/streaming-bus', () => ({
  emitThinkingStart: vi.fn(),
  emitThinkingDelta: vi.fn(),
  emitCompressionEvent: vi.fn(),
  emitToolStart: vi.fn(),
  emitComplete: vi.fn(),
  emitError: vi.fn(),
}))

// Mutable context: the tests below re-point the active workspace between
// scenarios (switch to another conversation / to an absent one).
const mockContext = {
  activeWorkspaceId: 'conv-a' as string | null,
  workspaces: [] as Array<{ id: string }>,
  createWorkspace: vi.fn(() => Promise.resolve()),
  switchWorkspace: vi.fn(() => Promise.resolve()),
  refreshWorkspaces: vi.fn(() => Promise.resolve()),
  refreshPendingChanges: vi.fn(() => Promise.resolve()),
  deleteWorkspace: vi.fn(() => Promise.resolve()),
}

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => mockContext),
  },
}))

vi.mock('@/store/settings.store', () => {
  const mockSettingsState = {
    providerType: 'openai',
    modelName: 'mock-model',
    maxIterations: 20,
    getEffectiveProviderConfig: vi.fn(() => ({
      apiKeyProviderKey: 'openai',
      baseUrl: 'https://example.com',
      modelName: 'mock-model',
    })),
  }
  return {
    useSettingsStore: { getState: vi.fn(() => mockSettingsState) },
    __mockSettingsState: mockSettingsState,
  }
})

vi.mock('@/sqlite', () => ({
  initSQLiteDB: vi.fn(() => Promise.resolve()),
  getApiKeyRepository: vi.fn(() => ({
    load: vi.fn(() => Promise.resolve('test-key')),
  })),
  getConversationRepository: vi.fn(() => ({
    findAllMeta: findAllMetaMock,
    findByConversation: vi.fn(() => Promise.resolve([])),
    save: vi.fn(() => Promise.resolve()),
    saveMeta: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  })),
  getMessageRepository: vi.fn(() => ({
    findByConversation: findByConversationMock,
    insert: vi.fn(() => Promise.resolve()),
    replaceAll: vi.fn(() => Promise.resolve()),
    applyDiff: vi.fn(() => Promise.resolve()),
    migrateFromJsonBlob: vi.fn(() => Promise.resolve({ conversations: 0, messages: 0 })),
    recoverFromAppSessions: vi.fn(() =>
      Promise.resolve({ conversations: 0, messages: 0, sessions: 0 })
    ),
  })),
  getSQLiteDB: vi.fn(() => ({
    queryFirst: vi.fn(() => Promise.resolve({ count: 0 })),
    restartPendingInitialization: vi.fn(),
  })),
}))

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    LLM_PROVIDER_CONFIGS: {
      ...actual.LLM_PROVIDER_CONFIGS,
      openai: {
        ...actual.LLM_PROVIDER_CONFIGS.openai,
        baseURL: 'https://example.com',
        modelName: 'mock-model',
      },
    },
    isCustomProviderType: vi.fn(() => false),
  }
})

const CONV_A = 'conv-a'
const CONV_B = 'conv-b'

// The store module reads this once at init — tests here exercise the
// 15s load-timeout→fallback path, which must be compressed to stay inside
// vitest's 10s per-test timeout. Assigned BEFORE the store import below.
;(globalThis as Record<string, unknown>).__CONVERSATION_LOAD_TIMEOUT_MS__ = 300

import { useConversationStore } from '@/store/conversation.store'
// A deliberately-hung retry in an earlier scenario must not no-op retries in
// later ones (the in-flight slot map is module-level).
import { resetConversationRetryStateForTests } from '@/store/conversation.store.sqlite'
import { CONVERSATION_STORE_LOAD_ERROR_KEY } from '@/lib/app-storage-keys'

function meta(id: string, title: string) {
  return {
    id,
    title,
    titleMode: 'manual',
    lastContextWindowUsage: null,
    compressedContextSummary: null,
    compressedContextCutoffTimestamp: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
}

function resetStore() {
  useConversationStore.setState({
    conversations: [],
    activeConversationId: null,
    loaded: false,
    loadError: null,
    loadErrorScope: null,
    loadFailedConversationId: null,
    loadFailedWorkspaceId: null,
    suggestedFollowUps: new Map(),
    cancelledRunIds: new Set(),
    mountedConversations: new Map(),
  } as never)
}

function readPersistedRecord(): {
  message?: string
  resolved?: boolean
  workspaceId?: string
  conversationId?: string
} | null {
  const raw = sessionStorage.getItem(CONVERSATION_STORE_LOAD_ERROR_KEY)
  return raw ? JSON.parse(raw) : null
}

describe('conversation.store — PR #152 Sourcery fixes (issue #147)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findAllMetaMock.mockReset()
    findByConversationMock.mockReset()
    getWorkspaceManagerMock.mockReset()
    createWorkspaceMock.mockReset()
    createWorkspaceMock.mockResolvedValue(undefined)
    // Default: the active workspace is already loaded, so ensureActiveWorkspace
    // is a no-op unless a test overrides it.
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => true,
      createWorkspace: createWorkspaceMock,
    })
    sessionStorage.clear()
    resetConversationRetryStateForTests()
    resetStore()
    mockContext.activeWorkspaceId = CONV_A
    mockContext.workspaces = []
    findAllMetaMock.mockResolvedValue([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    // Tests that create conversations must not leak the watermark across
    // scenarios — the store module keeps module-level Maps.
    useConversationStore.setState({ conversations: [] } as never)
  })

  it('preserves a selection made while the primary metadata read is pending', async () => {
    // Defer the metadata read: the user selects conv-b WHILE the load waits.
    let resolveMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMeta = resolve as (v: unknown[]) => void
      })
    )
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()

    await useConversationStore.getState().setActive(CONV_B)
    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)

    resolveMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    // The user's newer choice must survive the load's install.
    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)
    expect(useConversationStore.getState().loadError).toBeNull()
  })

  it('preserves a selection made during the fallback metadata read', async () => {
    // Primary metadata fails → fallback path; the user selects conv-b while
    // the fallback metadata request itself is pending (not during the
    // preceding backoff — a regression that snapshots selection only when
    // fallback starts must still fail) (PR #152 review, "Fallback selection
    // race goes untested").
    findAllMetaMock.mockRejectedValueOnce(new Error('initial metadata unavailable'))
    let resolveFallbackMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFallbackMeta = resolve as (v: unknown[]) => void
      })
    )
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()

    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(false)
      expect(useConversationStore.getState().loadError).toContain('initial metadata unavailable')
    })
    // The fallback metadata REQUEST is now pending (awaiting its deferred
    // result). Change the selection NOW, while the request is in flight —
    // then release the result.
    await useConversationStore.getState().setActive(CONV_B)
    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)

    resolveFallbackMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)
    expect(useConversationStore.getState().loadError).toBeNull()
  })

  it('does not let a pending primary install replace a conversation created meanwhile', async () => {
    // A conversation created while the primary metadata read is pending is
    // not in the snapshot — installing the snapshot verbatim would hide it
    // and leave the active ID without a matching row
    // (PR #152 review, "New conversations disappear from sidebar").
    let resolveMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMeta = resolve as (v: unknown[]) => void
      })
    )
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()

    await useConversationStore.getState().setActive(CONV_B)
    const created = useConversationStore.getState().createNew('fresh')
    expect(useConversationStore.getState().activeConversationId).toBe(created.id)

    resolveMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    expect(useConversationStore.getState().activeConversationId).toBe(created.id)
    expect(
      useConversationStore.getState().conversations.some((c) => c.id === created.id)
    ).toBe(true)
    expect(
      useConversationStore.getState().conversations.map((c) => c.id)
    ).toEqual(expect.arrayContaining([CONV_A, CONV_B, created.id]))
    // Detach-avoidance is not enough: the load (and any leg hanging in it)
    // must have fully settled BEFORE the next test starts, or the next
    // test's own load no-ops behind this run's in-flight dedupe slot
    // (withInflightLoad) — that cross-test wedge cost a debugging round.
    await Promise.race([
      load.catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ])
    expect(useConversationStore.getState().loadError).toBeNull()
  })

  it('does not let a pending fallback replace a conversation created meanwhile', { timeout: 20000 }, async () => {
    findAllMetaMock.mockRejectedValueOnce(new Error('initial metadata unavailable'))
    let resolveFallbackMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFallbackMeta = resolve as (v: unknown[]) => void
      })
    )
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()

    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(false)
    })

    // The user creates and activates a new conversation while the fallback
    // metadata read is pending.
    const created = useConversationStore.getState().createNew('fresh')
    expect(useConversationStore.getState().activeConversationId).toBe(created.id)

    // The fallback snapshot does not include the created conversation —
    // recovery must merge it back instead of dropping it.
    resolveFallbackMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    // The brand-new conversation keeps the active selection AND its row.
    expect(useConversationStore.getState().activeConversationId).toBe(created.id)
    expect(
      useConversationStore.getState().conversations.some((c) => c.id === created.id)
    ).toBe(true)
  })

  it('does not keep a stale metadata retry banner after a selection change during fallback recovery', async () => {
    // While the fallback's transcript read is pending, the user selects a
    // different conversation. The fallback still installs its own transcript,
    // but the stale METADATA loadError from the failed primary must be
    // cleared — the conversation the user is looking at loaded fine
    // (PR #152 review, "Stale retry error remains visible").
    findAllMetaMock.mockRejectedValueOnce(new Error('initial metadata unavailable'))
    let resolveFallbackRead!: (messages: unknown[]) => void
    findByConversationMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveFallbackRead = resolve as (v: unknown[]) => void
    }))
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()
    await vi.waitFor(() => expect(findByConversationMock).toHaveBeenCalledTimes(1))

    await useConversationStore.getState().setActive(CONV_B)
    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)

    resolveFallbackRead([])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)
    expect(useConversationStore.getState().loadError).toBeNull()
    expect(useConversationStore.getState().loadErrorScope).toBeNull()
  })

  it('does not resolve a workspace failure when the transcript retry also fails and the workspace is still broken', async () => {
    // Workspace ensure AND transcript read both fail → a transcript retry
    // succeeds → the workspace is STILL broken. The retry path must refuse
    // to resolve the record: it names a workspace the retry never ensured.
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => false,
      createWorkspace: createWorkspaceMock,
    })
    createWorkspaceMock.mockRejectedValue(new Error('OPFS workspace unavailable'))
    findByConversationMock.mockRejectedValueOnce(new Error('transcript unavailable'))
    await useConversationStore.getState().loadFromDB()

    expect(useConversationStore.getState().loadErrorScope).toBe('transcript')
    const record = readPersistedRecord()
    expect(record?.workspaceId).toBe(CONV_A)
    expect(record?.conversationId).toBe(CONV_A)

    // Transcript retry succeeds (workspace manager still failing).
    findByConversationMock.mockResolvedValueOnce([])
    await useConversationStore.getState().retryLoadFromDB()

    // The transcript recovered, but the workspace is STILL unavailable and
    // the record correctly stays unresolved — the visible failure must be
    // PROMOTED to the workspace scope (not cleared), so the sidebar keeps a
    // workspace Retry affordance (PR #152 review, "Workspace retry
    // disappears after transcript recovery").
    expect(useConversationStore.getState().loadError).toContain('workspace')
    expect(useConversationStore.getState().loadErrorScope).toBe('workspace')
    expect(useConversationStore.getState().loadFailedWorkspaceId).toBe(CONV_A)
    expect(readPersistedRecord()?.resolved).toBeFalsy()
    expect(createWorkspaceMock).toHaveBeenCalledTimes(1)
  })

  it('does not start duplicate retry work after a timed-out targeted retry', async () => {
    // A targeted workspace retry whose ensure never settles keeps its slot:
    // a second Retry awaits the SAME run instead of starting another ensure
    // behind the first (PR #152 review, "Timed-out retries queue more work").
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => false,
      createWorkspace: createWorkspaceMock,
    })
    createWorkspaceMock.mockRejectedValueOnce(new Error('workspace unavailable'))
    findByConversationMock.mockResolvedValue([])
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadErrorScope).toBe('workspace')
    const callsAfterFailure = createWorkspaceMock.mock.calls.length

    // First retry hangs (workspace ensure never settles).
    createWorkspaceMock.mockImplementation(() => new Promise(() => {}))
    const firstRetry = useConversationStore.getState().retryLoadFromDB()
    await vi.waitFor(() => {
      expect(createWorkspaceMock.mock.calls.length).toBe(callsAfterFailure + 1)
    })

    // Second retry while the first is still pending: no additional ensure.
    const secondRetry = useConversationStore.getState().retryLoadFromDB()
    await Promise.race([secondRetry, new Promise((r) => setTimeout(r, 100))])
    expect(createWorkspaceMock.mock.calls.length).toBe(callsAfterFailure + 1)

    // The hung retry never settles in this test; detach to avoid leaks.
    void firstRetry.catch(() => {})
    void secondRetry.catch(() => {})
  })

  it('does not surface a workspace-ensure failure for a workspace the user left', async () => {
    // The workspace ensure for conv-a fails, but by then the user has already
    // switched to conv-b — the stale failure must not be recorded.
    let resolveMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMeta = resolve as (v: unknown[]) => void
      })
    )
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => false,
      createWorkspace: createWorkspaceMock,
    })
    createWorkspaceMock.mockRejectedValue(new Error('OPFS workspace unavailable'))
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()
    // Run setActive to the end BEFORE resolving the metadata: resolving first
    // lets the load install its snapshot and finish before the (cached)
    // selection change lands, which would lose the race this test guards.
    const selection = useConversationStore.getState().setActive(CONV_B)
    resolveMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await selection
    await Promise.race([
      load,
      new Promise((r) => setTimeout(r, 2000)),
    ])
    await vi.waitFor(
      () => {
        expect(useConversationStore.getState().loaded).toBe(true)
      },
      { timeout: 2000, interval: 50 }
    )

    expect(useConversationStore.getState().activeConversationId).toBe(CONV_B)
    expect(useConversationStore.getState().loadError).toBeNull()
    expect(useConversationStore.getState().loadErrorScope).toBeNull()
    expect(readPersistedRecord()).toBeNull()
  })

  it('keeps the failed workspace error visible when the workspace is still active', async () => {
    // Control for the guard above: same failure, no selection change — the
    // error must still be surfaced.
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => false,
      createWorkspace: createWorkspaceMock,
    })
    createWorkspaceMock.mockRejectedValue(new Error('OPFS workspace unavailable'))
    findByConversationMock.mockResolvedValue([])

    await useConversationStore.getState().loadFromDB()
    await useConversationStore.getState().retryLoadFromDB()

    expect(useConversationStore.getState().activeConversationId).toBe(CONV_A)
    expect(useConversationStore.getState().loadError).toContain('OPFS workspace unavailable')
    expect(useConversationStore.getState().loadErrorScope).toBe('workspace')
  })

  it('does not let a pending fallback replace a conversation created meanwhile', { timeout: 20000 }, async () => {
    findAllMetaMock.mockRejectedValueOnce(new Error('initial metadata unavailable'))
    let resolveFallbackMeta!: (value: unknown[]) => void
    findAllMetaMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFallbackMeta = resolve as (v: unknown[]) => void
      })
    )
    findByConversationMock.mockResolvedValue([])
    const load = useConversationStore.getState().loadFromDB()

    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(false)
    })

    // The user creates and activates a new conversation while the fallback
    // metadata read is pending.
    const created = useConversationStore.getState().createNew('fresh')
    expect(useConversationStore.getState().activeConversationId).toBe(created.id)

    resolveFallbackMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

    // The brand-new conversation keeps the active selection.
    expect(useConversationStore.getState().activeConversationId).toBe(created.id)
    // The load must be FULLY settled before the next test starts: the
    // post-install transcript read of the preserved active id still runs
    // behind `await load`'s resolution? No — but the in-flight load slot and
    // any hung leg must be released, or the next test's own load silently
    // no-ops (cross-test wedge). Await the same promise again and require a
    // clean error state; a 15s-cap leg would blow this test's 20s timeout
    // and surface here instead of polluting the following scenario.
    await load
    expect(useConversationStore.getState().loadError).toBeNull()
  })

  it('does not resolve a workspace-scoped record via a transcript read alone', async () => {
    // A workspace-scoped failure on record (ensure for conv-a failed).
    sessionStorage.setItem(
      CONVERSATION_STORE_LOAD_ERROR_KEY,
      JSON.stringify({
        message: 'Failed to open active workspace: OPFS down',
        at: new Date().toISOString(),
        workspaceId: CONV_A,
      })
    )
    // Seed conv-a as not-yet-loaded so setActive takes the lazy-read path.
    useConversationStore.setState((state) => {
      state.conversations = [
        { ...meta(CONV_A, 'first'), messages: [], messagesLoaded: false, mountRefCount: 0, collectedAssets: [] } as never,
      ]
      state.activeConversationId = CONV_A
    })

    // The transcript read succeeds — but the OPFS workspace was never
    // re-ensured, so the workspace-scoped record stays unresolved.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-a', role: 'user', content: 'a', timestamp: 1 },
    ])
    await useConversationStore.getState().setActive(CONV_A)

    const record = readPersistedRecord()
    expect(record?.resolved).toBeFalsy()
    expect(record?.message).toContain('OPFS down')
  })

  it('still resolves a conversation-scoped record via a successful transcript read', async () => {
    // Control: the same lazy read DOES resolve a record naming the same
    // conversation (existing round-3 behavior must keep working).
    sessionStorage.setItem(
      CONVERSATION_STORE_LOAD_ERROR_KEY,
      JSON.stringify({
        message: 'Failed to load messages for active conversation: x',
        at: new Date().toISOString(),
        conversationId: CONV_A,
      })
    )
    useConversationStore.setState((state) => {
      state.conversations = [
        { ...meta(CONV_A, 'first'), messages: [], messagesLoaded: false, mountRefCount: 0, collectedAssets: [] } as never,
      ]
      state.activeConversationId = CONV_A
    })

    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-a2', role: 'user', content: 'a2', timestamp: 2 },
    ])
    await useConversationStore.getState().setActive(CONV_A)

    expect(readPersistedRecord()?.resolved).toBe(true)
  })
})
