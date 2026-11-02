/**
 * Conversation store — round-3 Sourcery findings (PR #149 review)
 *
 * Regression tests for the two unresolved conversation-store threads:
 *
 *  - PRRT_kwDORoHsZ86ysZzp ("Unverified failures appear recovered"):
 *    markPersistedFailureResolved() may only run after the transcript of the
 *    conversation NAMED BY THE FAILURE (the one that was active when it was
 *    recorded) re-read successfully. Selecting an absent, cached or
 *    different conversation must NOT flag the record recovered.
 *
 *  - PRRT_kwDORoHsZ86ysZzy ("Diagnostics omits transcript failures"): the
 *    fallback-retry and lazy setActive transcript-read catch paths must
 *    persist the failure to CONVERSATION_STORE_LOAD_ERROR_KEY, not only to
 *    in-memory loadError.
 *
 * Like the round-1/2 suite, these drive the store through its PUBLIC API only
 * (loadFromDB / setActive) plus useStore.setState seeding for frozen immer
 * objects.
 */
/* eslint-disable */
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

vi.mock('../conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => mockContext),
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

describe('conversation.store — round-3 Sourcery fixes (issue #147, PR #149)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the two repository mocks explicitly: `mockClear` does not drop
    // queued `once` implementations, and a leftover deferred promise would
    // leak into the next test.
    findAllMetaMock.mockReset()
    findByConversationMock.mockReset()
    sessionStorage.clear()
    resetStore()
    mockContext.activeWorkspaceId = CONV_A
    mockContext.workspaces = []
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

  it('keeps the error visible when switching to a conversation whose transcript also fails', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')

    await useConversationStore.getState().setActive(CONV_B)

    // The failure is still real — the error must NOT be cleared.
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')
    expect(useConversationStore.getState().loadErrorScope).toBe('transcript')
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

  // ── thread PRRT_kwDORoHsZ86ysZzp — switching must not fake recovery ─────

  it('does NOT mark the failure resolved when the user switches to a DIFFERENT conversation whose transcript loads', async () => {
    // conv-a's transcript fails → unresolved record.
    findByConversationMock.mockRejectedValue(new Error('conv-a transcript failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadErrorScope).toBe('transcript')
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // The user picks conv-b, whose transcript loads fine.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-b', role: 'user', content: 'b', timestamp: 2 },
    ])
    await useConversationStore.getState().setActive(CONV_B)

    // conv-a was NEVER re-read. Its failure is not recovered — the record
    // must stay unresolved even though the stale banner cleared.
    expect(readPersistedRecord()?.resolved).toBeFalsy()
  })

  it('clears the stale transcript error but keeps the failed conversation UNVERIFIED', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadError).toContain('sqlite read failed')

    // The user picks another conversation whose transcript loads fine.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm2', role: 'user', content: 'other', timestamp: 2 },
    ])
    await useConversationStore.getState().setActive(CONV_B)

    // The stale banner belongs to the conversation the user left — it goes.
    expect(useConversationStore.getState().loadError).toBeNull()
    expect(useConversationStore.getState().loadErrorScope).toBeNull()
    // PRRT_kwDORoHsZ86ysZzp round-3: conv-a was never re-read, so its
    // failure is NOT verified as recovered — the persisted record stays
    // unresolved.
    expect(readPersistedRecord()?.resolved).toBeFalsy()
  })

  it('does NOT mark the failure resolved when the user selects an ABSENT conversation (no transcript read possible)', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // A conversation id that is not in the store — setActive cannot read
    // any transcript for it, so nothing is verified as recovered.
    await useConversationStore.getState().setActive('conv-missing')

    expect(readPersistedRecord()?.resolved).toBeFalsy()
  })

  it('does NOT mark the failure resolved or clear loadError when a CACHED conversation is selected (no transcript read happens)', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    const failedMessage = useConversationStore.getState().loadError

    // conv-b is cached from an earlier session — selecting it takes the
    // cached path and never re-reads any transcript. (Immer state objects
    // are frozen — seed via setState, per repo test conventions.)
    useConversationStore.setState((state) => {
      const conv = state.conversations.find((c) => c.id === CONV_B)
      if (conv) {
        conv.messages = [
          { id: 'seed-b', role: 'user', content: 'cached', timestamp: 1 } as never,
        ]
        conv.messagesLoaded = true
      }
    })
    await useConversationStore.getState().setActive(CONV_B)
    // The persisted record must NOT be flagged recovered: no transcript was
    // read for the conversation that failed.
    expect(readPersistedRecord()?.resolved).toBeFalsy()
    // The banner is a UX signal for a conversation that may still be broken;
    // a cached selection proves nothing, so the error must stay.
    expect(useConversationStore.getState().loadError).toBe(failedMessage)
  })

  it('DOES mark the failure resolved only after re-loading the failed conversation itself', async () => {
    findByConversationMock.mockRejectedValue(new Error('sqlite read failed'))
    await useConversationStore.getState().loadFromDB()
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // Re-read the SAME conversation that failed — successfully this time.
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-a2', role: 'user', content: 'a', timestamp: 3 },
    ])
    await useConversationStore.getState().setActive(CONV_A)

    expect(useConversationStore.getState().loadError).toBeNull()
    expect(useConversationStore.getState().loadErrorScope).toBeNull()
    expect(readPersistedRecord()?.resolved).toBe(true)
  })

  // ── thread PRRT_kwDORoHsZ86ysZzy — lazy/retry failures reach Diagnostics ──

  it('persists a lazy setActive transcript failure to the diagnostics record', async () => {
    // A clean load first (no record, no error).
    findByConversationMock.mockResolvedValue([])
    await useConversationStore.getState().loadFromDB()
    expect(readPersistedRecord()).toBeNull()

    // The lazy transcript read for conv-b fails.
    findByConversationMock.mockRejectedValue(new Error('lazy read failed'))
    await useConversationStore.getState().setActive(CONV_B)

    expect(useConversationStore.getState().loadError).toContain('lazy read failed')
    const record = readPersistedRecord()
    expect(record).not.toBeNull()
    expect(record?.message).toContain('lazy read failed')
    expect(record?.resolved).toBeFalsy()
  })

  it('persists a fallback-retry transcript failure to the diagnostics record', async () => {
    // The metadata pass fails; the fallback retry then succeeds on metadata
    // but the active transcript read fails.
    findAllMetaMock.mockRejectedValueOnce(new Error('metadata pass failed'))
    findByConversationMock.mockRejectedValue(new Error('retry transcript failed'))
    await useConversationStore.getState().loadFromDB()

    expect(useConversationStore.getState().loadError).toContain('retry transcript failed')
    const record = readPersistedRecord()
    expect(record).not.toBeNull()
    expect(record?.message).toContain('retry transcript failed')
    expect(record?.resolved).toBeFalsy()
  })

  it('fallback-retry success preserves the ORIGINAL failure in the resolved record', async () => {
    // Round-4 (PRRT_kwDORoHsZ86yw1er, "Recovered failures vanish from
    // diagnostics"): the INITIAL exception is persisted before the fallback
    // attempt, so a fallback recovery leaves the original failure — flagged
    // resolved — on record for the bug report, instead of nothing at all.
    // The metadata pass fails; the retry recovers metadata AND transcript.
    findAllMetaMock.mockRejectedValueOnce(new Error('metadata pass failed'))
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-r', role: 'user', content: 'ok', timestamp: 4 },
    ])
    await useConversationStore.getState().loadFromDB()

    expect(useConversationStore.getState().loadError).toBeNull()
    const record = readPersistedRecord()
    expect(record?.resolved).toBe(true)
    // The ORIGINAL failure message is preserved, not the recovered state.
    expect(record?.message).toBe('metadata pass failed')
  })

  it('fallback-retry success marks an EARLIER persisted record resolved too', async () => {
    // An earlier unresolved failure on record (e.g. from a previous load).
    sessionStorage.setItem(
      CONVERSATION_STORE_LOAD_ERROR_KEY,
      JSON.stringify({ message: 'earlier failure', at: new Date().toISOString() }),
    )

    // The metadata pass fails; the retry recovers metadata AND transcript.
    // The initial catch OVERWRITES the earlier record with the current
    // failure before the fallback runs — the latest failure is the one a
    // bug report needs.
    findAllMetaMock.mockRejectedValueOnce(new Error('metadata pass failed'))
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-r', role: 'user', content: 'ok', timestamp: 4 },
    ])
    await useConversationStore.getState().loadFromDB()

    expect(useConversationStore.getState().loadError).toBeNull()
    expect(readPersistedRecord()?.resolved).toBe(true)
    expect(readPersistedRecord()?.message).toBe('metadata pass failed')
  })
})

describe('conversation.store — round-4 in-flight transcript read race (PRRT_kwDORoHsZ86yw1e0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findAllMetaMock.mockReset()
    findByConversationMock.mockReset()
    sessionStorage.clear()
    resetStore()
    mockContext.activeWorkspaceId = CONV_A
    mockContext.workspaces = []
    findAllMetaMock.mockResolvedValue([meta(CONV_A, 'first'), meta(CONV_B, 'second')])
  })

  it("B's later success does NOT resolve A's failure while A's own read is in flight", async () => {
    // conv-a's transcript read FAILS.
    findByConversationMock.mockRejectedValueOnce(new Error('conv-a failed'))
    await useConversationStore.getState().loadFromDB()
    expect(useConversationStore.getState().loadFailedConversationId).toBe(CONV_A)
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // The user switches to conv-b while conv-a's (retry) read is still
    // pending; conv-b's read succeeds first.
    let resolveA!: (messages: unknown[]) => void
    const pendingA = new Promise<unknown[]>((resolve) => {
      resolveA = resolve as (m: unknown[]) => void
    })
    findByConversationMock.mockReturnValueOnce(pendingA) // conv-a retry (in flight)
    findByConversationMock.mockResolvedValueOnce([
      { id: 'm-b2', role: 'user', content: 'b2', timestamp: 5 },
    ])

    // Kick off conv-a's re-read (still pending), then complete conv-b.
    const retryA = useConversationStore.getState().setActive(CONV_A)
    await useConversationStore.getState().setActive(CONV_B)

    // conv-b succeeded, but conv-a was NOT re-read successfully yet: the
    // record must still be unresolved.
    expect(readPersistedRecord()?.resolved).toBeFalsy()

    // Now conv-a's own read settles successfully — THIS resolves it.
    resolveA([{ id: 'm-a3', role: 'user', content: 'a3', timestamp: 6 }])
    await retryA
    await vi.waitFor(() => {
      expect(readPersistedRecord()?.resolved).toBe(true)
    })
  })
})
