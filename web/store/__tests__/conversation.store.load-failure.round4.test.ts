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

import { useConversationStore } from '@/store/conversation.store'
import { CONVERSATION_STORE_LOAD_ERROR_KEY } from '@/lib/app-storage-keys'

const CONV_A = 'conv-a'
const CONV_B = 'conv-b'

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
    resetStore()
    mockContext.activeWorkspaceId = CONV_A
    mockContext.workspaces = []
    findAllMetaMock.mockResolvedValue([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
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
    // Primary metadata fails → fallback path; the user selects conv-b during
    // the fallback read (the fallback run itself awaits a 300ms backoff plus
    // the metadata read before installing).
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

    await useConversationStore.getState().setActive(CONV_B)
    resolveMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await load
    await vi.waitFor(() => {
      expect(useConversationStore.getState().loaded).toBe(true)
    })

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

    expect(useConversationStore.getState().activeConversationId).toBe(CONV_A)
    expect(useConversationStore.getState().loadError).toContain('OPFS workspace unavailable')
    expect(useConversationStore.getState().loadErrorScope).toBe('workspace')
  })

  it('does not let a pending fallback replace a conversation created meanwhile', async () => {
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
