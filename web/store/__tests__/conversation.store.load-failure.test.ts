/* eslint-disable */
/**
 * Conversation store — load-failure semantics (issue #147, PR #149 review)
 *
 * These tests cover the loadFromDB() failure paths that the review flagged
 * on head d5139714:
 *
 *  1. An active-transcript failure must NOT mark the persisted diagnostics
 *     record as resolved ("Failed loads appear recovered").
 *  2. A retry must keep the visible load error until the active transcript
 *     read actually succeeded ("Retry hides the load error").
 *  3. The failure scope tells the UI whether the loaded conversation rows
 *     are usable ("Active transcript failure hides all history").
 *
 * They drive the store through its PUBLIC API only (loadFromDB / setActive),
 * so they keep passing when the module is split.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findAllMetaMock, findByConversationMock } = vi.hoisted(() => ({
  findAllMetaMock: vi.fn(),
  findByConversationMock: vi.fn(),
}))

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

vi.mock('../conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => ({
      // The active workspace is 'conv-a' — loadFromDB loads ITS transcript.
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

vi.mock('../settings.store', () => {
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

import { useConversationStore } from '../conversation.store'
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
    suggestedFollowUps: new Map(),
    cancelledRunIds: new Set(),
    mountedConversations: new Map(),
  } as never)
}

function readPersistedRecord(): { message?: string; resolved?: boolean } | null {
  const raw = sessionStorage.getItem(CONVERSATION_STORE_LOAD_ERROR_KEY)
  return raw ? (JSON.parse(raw) as { message?: string; resolved?: boolean }) : null
}

describe('conversation.store loadFromDB failure semantics (issue #147, PR #149)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the two repository mocks explicitly: `mockClear` does not drop
    // queued `once` implementations, and a leftover deferred promise would
    // leak into the next test.
    findAllMetaMock.mockReset()
    findByConversationMock.mockReset()
    sessionStorage.clear()
    resetStore()
    findAllMetaMock.mockResolvedValue([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
  })

  it('reports a transcript-only failure without hiding the loaded conversations', async () => {
    // The metadata load succeeds; only the ACTIVE conversation's transcript
    // read fails. The list is perfectly usable — the store must say so.
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))

    await useConversationStore.getState().loadFromDB()

    const state = useConversationStore.getState()
    expect(state.conversations.map((c) => c.id)).toEqual([CONV_A, CONV_B])
    expect(state.loaded).toBe(true)
    expect(state.loadError).toContain('sqlite read failed')
    // Scope tells the UI the ROWS are still usable.
    expect(state.loadErrorScope).toBe('transcript')
  })

  it('scopes a metadata failure as "metadata" so the UI can hide the list', async () => {
    findAllMetaMock.mockRejectedValue(new Error('opfs init failed'))

    await useConversationStore.getState().loadFromDB()

    const state = useConversationStore.getState()
    expect(state.loaded).toBe(false)
    expect(state.loadError).toContain('opfs init failed')
    expect(state.loadErrorScope).toBe('metadata')
  })

  it('clears a stale transcript error when the user switches to a working conversation', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')

    // The user picks another conversation whose transcript loads fine.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm2', role: 'user', content: 'other', timestamp: 2 },
    ])
    await useConversationStore.getState().setActive(CONV_B)

    // The banner belongs to the conversation the user left — it must go.
    expect(useConversationStore.getState().loadError).toBeNull()
    expect(useConversationStore.getState().loadErrorScope).toBeNull()
    expect(readPersistedRecord()?.resolved).toBe(true)
  })

  it('keeps the error visible when switching to a conversation whose transcript also fails', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')

    await useConversationStore.getState().setActive(CONV_B)

    // The failure is still real — the error must NOT be cleared.
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')
    expect(useConversationStore.getState().loadErrorScope).toBe('transcript')
  })

  it('does not mark the persisted failure record resolved when the transcript failed', async () => {
    // The metadata load succeeds; only the ACTIVE conversation's transcript
    // read fails. That is still a load failure — the diagnostics record must
    // NOT be flagged as recovered.
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))

    await useConversationStore.getState().loadFromDB()

    // The record exists (for diagnostics) but is NOT flagged as recovered.
    const record = readPersistedRecord()
    expect(record).not.toBeNull()
    expect(record?.message).toContain('sqlite read failed')
    expect(record?.resolved).toBeFalsy()
  })

  it('keeps the load error visible until the active transcript read succeeds', async () => {
    // First load fails on the transcript.
    findByConversationMock.mockRejectedValueOnce(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')

    // The retry's transcript read is deferred: while it is in flight the
    // error must STAY visible (the retry must not look successful).
    let resolveTranscript!: (messages: unknown[]) => void
    findByConversationMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTranscript = resolve
      })
    )

    const retry = useConversationStore.getState().loadFromDB()
    // Let the metadata pass complete.
    await vi.waitFor(() => {
      expect(findByConversationMock).toHaveBeenCalledTimes(2)
    })
    // Snapshot the state WHILE the transcript read is still pending, then
    // settle it before asserting: a failed assertion must not leave the
    // deferred load pending and hang the following tests.
    const errorWhilePending = useConversationStore.getState().loadError

    resolveTranscript([{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }])
    await retry

    // The transcript read is still pending — the error must still be there.
    expect(errorWhilePending).toContain('sqlite read failed')
    // Now the load really succeeded — the error is gone and the record is
    // marked resolved.
    expect(useConversationStore.getState().loadError).toBeNull()
    expect(readPersistedRecord()?.resolved).toBe(true)
  })

  it('marks the persisted failure resolved only after a fully successful load', async () => {
    // A first run leaves an unresolved record behind.
    findByConversationMock.mockRejectedValueOnce(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // The next load succeeds end-to-end.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
    ])
    await useConversationStore.getState().loadFromDB()

    const record = readPersistedRecord()
    expect(record?.resolved).toBe(true)
    // The ORIGINAL failure message is kept for the bug report.
    expect(record?.message).toContain('sqlite read failed')
    expect(useConversationStore.getState().loadError).toBeNull()
  })
})
