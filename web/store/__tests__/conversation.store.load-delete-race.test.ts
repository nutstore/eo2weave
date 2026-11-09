/* eslint-disable */
/**
 * Conversation store — a delete that lands while a load's metadata read is
 * pending must not be resurrected by that load's install (issue #251).
 *
 * The metadata snapshot is read BEFORE the delete, so the install would put
 * the row back in the sidebar (and could reinstall it as the active
 * conversation) although its SQLite record is already gone. The load keeps a
 * per-run log of deletions; both the primary and the fallback install filter
 * the snapshot through it.
 *
 * Driven through the store's PUBLIC API (loadFromDB / deleteConversation),
 * like conversation.store.load-failure.*.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findAllMetaMock, findByConversationMock, migrateFromJsonBlobMock, restartInitializationMock, getWorkspaceManagerMock, createWorkspaceMock } = vi.hoisted(() => ({
  findAllMetaMock: vi.fn(),
  findByConversationMock: vi.fn(),
  migrateFromJsonBlobMock: vi.fn(),
  restartInitializationMock: vi.fn(),
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

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => ({
      activeWorkspaceId: 'conv-a',
      workspaces: [],
      createWorkspace: vi.fn(() => Promise.resolve()),
      switchWorkspace: vi.fn(() => Promise.resolve()),
      refreshWorkspaces: vi.fn(() => Promise.resolve()),
      refreshPendingChanges: vi.fn(() => Promise.resolve()),
      deleteWorkspace: vi.fn(() => Promise.resolve()),
    })),
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
    migrateFromJsonBlob: migrateFromJsonBlobMock,
    recoverFromAppSessions: vi.fn(() =>
      Promise.resolve({ conversations: 0, messages: 0, sessions: 0 })
    ),
  })),
  getSQLiteDB: vi.fn(() => ({
    queryFirst: vi.fn(() => Promise.resolve({ count: 0 })),
    restartPendingInitialization: restartInitializationMock,
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
import { resetConversationRetryStateForTests } from '@/store/conversation-load'
import { resetInflightLoadForTests } from '@/store/conversation-persist'

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

const ids = () => useConversationStore.getState().conversations.map((c) => c.id)

describe('conversation.store delete during a pending load (issue #251)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findAllMetaMock.mockReset()
    findByConversationMock.mockReset()
    migrateFromJsonBlobMock.mockReset()
    migrateFromJsonBlobMock.mockResolvedValue({ conversations: 0, messages: 0 })
    restartInitializationMock.mockReset()
    getWorkspaceManagerMock.mockReset()
    createWorkspaceMock.mockReset()
    createWorkspaceMock.mockResolvedValue(undefined)
    getWorkspaceManagerMock.mockResolvedValue({
      isWorkspaceLoaded: () => false,
      createWorkspace: createWorkspaceMock,
    })
    sessionStorage.clear()
    resetConversationRetryStateForTests()
    resetInflightLoadForTests()
    resetStore()
    findByConversationMock.mockResolvedValue([])
    findAllMetaMock.mockResolvedValue([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
  })

  it('does not reinstall a conversation deleted while the metadata read is pending', async () => {
    // Reachable case: the sidebar is already populated (a retried load), so
    // the user can delete a row while this run's metadata read is in flight.
    await useConversationStore.getState().loadFromDB()
    expect(ids()).toEqual([CONV_A, CONV_B])

    let releaseMeta!: (rows: unknown) => void
    findAllMetaMock.mockImplementationOnce(
      () => new Promise((resolve) => { releaseMeta = resolve })
    )

    const pending = useConversationStore.getState().loadFromDB()
    await vi.waitFor(() => expect(findAllMetaMock).toHaveBeenCalledTimes(2))

    await useConversationStore.getState().deleteConversation(CONV_B)
    expect(ids()).toEqual([CONV_A])

    // The snapshot this run read still contains the deleted row.
    releaseMeta([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await pending

    expect(ids()).toEqual([CONV_A])
    expect(useConversationStore.getState().loaded).toBe(true)
    expect(useConversationStore.getState().activeConversationId).not.toBe(CONV_B)
  })

  it('applies the same filter to the fallback install after a failed metadata read', async () => {
    await useConversationStore.getState().loadFromDB()
    expect(ids()).toEqual([CONV_A, CONV_B])

    // Primary metadata read fails; the fallback read (300 ms later) hangs
    // long enough for the delete to land.
    findAllMetaMock.mockRejectedValueOnce(new Error('metadata read failed'))
    let releaseFallback!: (rows: unknown) => void
    findAllMetaMock.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFallback = resolve })
    )
    const pending = useConversationStore.getState().loadFromDB()
    await vi.waitFor(() => expect(findAllMetaMock).toHaveBeenCalledTimes(3))

    await useConversationStore.getState().deleteConversation(CONV_B)
    releaseFallback([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
    await pending

    expect(ids()).toEqual([CONV_A])
    expect(useConversationStore.getState().loaded).toBe(true)
  })

  it('starts each run with an empty deletion log', async () => {
    // A delete recorded while nothing is pending must not filter a later
    // run: that run's read reflects the database as it is NOW.
    await useConversationStore.getState().deleteConversation(CONV_B)

    await useConversationStore.getState().loadFromDB()

    expect(ids()).toEqual([CONV_A, CONV_B])
  })
})
