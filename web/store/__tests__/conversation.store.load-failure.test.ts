/* eslint-disable */
/**
 * Conversation store — load-failure semantics (issue #147, PR #149 review)
 *
 * These tests cover the loadFromDB() failure paths that the review flagged
 * on head d5139714:
 *
 *  1. An active-transcript failure must NOT mark the persisted diagnostics
 *     record as resolved ("Failed loads appear recovered").
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
