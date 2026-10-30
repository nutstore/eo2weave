/* eslint-disable */
// @ts-nocheck - Unit tests for persistence & message-merge paths in conversation.store.sqlite.ts
/**
 * Conversation Store — persistence & merge coverage
 *
 * These tests target the persistence/merge logic that the future
 * `conversation-persist.ts` / `conversation-message-ops.ts` split will own.
 * They drive the store through its PUBLIC API only (updateMessages /
 * addMessage / updateTitle / loadFromDB), so they keep passing unchanged
 * when the module is split — they assert behavior, not file layout.
 *
 * Covered semantics:
 *  - persistMessageReplace debounce coalescing (300ms window)
 *  - persistNewMessage immediate insert path
 *  - persistConversationMeta routing through saveMeta
 *  - reconcileMessageSnapshot replace-vs-append decision
 *  - healCompressionBaseline cutoff recovery on loadFromDB
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@/agent/message-types'
import { useConversationStore } from '../conversation.store'
import {
  reconcileMessageSnapshot,
  evictConversationMessagesIfSafe,
  scheduleConversationEviction,
  clearScheduledEvictionTimers,
  EVICTION_DELAY_MS,
  EVICTION_MIN_MESSAGES,
  EVICTION_LRU_KEEP,
} from '../conversation.store.sqlite'
import { useConversationRuntimeStore } from '../conversation-runtime.store'
import { persistMessageReplace, persistSchedulers } from '../conversation-persist'
import { clearAgentLoops } from '../agent-loop-registry'
import { clearStreamingQueues } from '../streaming-queue-registry'

const conversationRepoSaveMetaMock = vi.fn(() => Promise.resolve())
const conversationRepoUpdateKindMock = vi.fn((_id: string, _kind: 'project' | 'direct') => Promise.resolve())
const conversationRepoTouchMock = vi.fn(() => Promise.resolve())
const messageRepoReplaceAllMock = vi.fn(() => Promise.resolve())
const messageRepoApplyDiffMock = vi.fn(() => Promise.resolve())
const messageRepoInsertMock = vi.fn(() => Promise.resolve())

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
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
      // loadFromDB heals the ACTIVE conversation only — point it at heal-conv
      activeWorkspaceId: 'heal-conv',
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
    findAllMeta: vi.fn(() =>
      Promise.resolve([
        {
          id: 'heal-conv',
          title: 'heal me',
          titleMode: 'manual',
          lastContextWindowUsage: null,
          compressedContextSummary: null,
          compressedContextCutoffTimestamp: null,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        {
          id: 'bg-conv',
          title: 'background conversation',
          titleMode: 'manual',
          lastContextWindowUsage: null,
          compressedContextSummary: null,
          compressedContextCutoffTimestamp: null,
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ])
    ),
    findByConversation: vi.fn(() => Promise.resolve([])),
    save: vi.fn(() => Promise.resolve()),
    saveMeta: conversationRepoSaveMetaMock,
    updateKind: conversationRepoUpdateKindMock,
    touch: conversationRepoTouchMock,
    delete: vi.fn(() => Promise.resolve()),
  })),
  getMessageRepository: vi.fn(() => ({
    findByConversation: vi.fn((convId: string) => {
      if (convId === 'heal-conv') {
        return Promise.resolve([
          {
            id: 'summary-1',
            role: 'assistant',
            kind: 'context_summary',
            content: 'summary-of-earlier-context',
            // context_summary messages store timestamp = cutoffTimestamp - 1
            timestamp: 1_700_000_000_001 - 1,
          },
        ])
      }
      if (convId === 'bg-conv') {
        // Full DB history for a conversation that stays metadata-only in memory
        // (never opened) — the truncation-guard tests write into this state.
        return Promise.resolve([
          { id: 'bg-u1', role: 'user', content: 'question', timestamp: 1_700_000_000_100 },
          { id: 'bg-a1', role: 'assistant', content: 'answer', timestamp: 1_700_000_000_200 },
        ])
      }
      return Promise.resolve([])
    }),
    insert: messageRepoInsertMock,
    replaceAll: messageRepoReplaceAllMock,
    applyDiff: messageRepoApplyDiffMock,
    migrateFromJsonBlob: vi.fn(() => Promise.resolve({ conversations: 0, messages: 0 })),
    recoverFromAppSessions: vi.fn(() =>
      Promise.resolve({ sessions: 0, conversations: 0, messages: 0 })
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

/** Reset store + registries between tests (mirrors conversation.store.sqlite.test.ts).
 *  Also clears module-level registries (debounced persist schedulers, eviction
 *  timers): discarding fake timers mid-test would otherwise leak entries that
 *  silently block later assertions (e.g. eviction guards). */
function resetStore(extra: Record<string, unknown> = {}) {
  clearAgentLoops()
  clearStreamingQueues()
  persistSchedulers.clear()
  clearScheduledEvictionTimers()
  useConversationRuntimeStore.setState({
    runtimes: new Map(),
    mountedConversations: new Map(),
    pendingMessageQueues: new Map(),
    subagentDrafts: new Map(),
  })
  useConversationStore.setState({
    conversations: [],
    activeConversationId: null,
    loaded: true,
    loadError: null,
    suggestedFollowUps: new Map(),
    cancelledRunIds: new Set(),
    mountedConversations: new Map(),
    ...extra,
  } as never)
}

/** createUserMessage ignores id overrides (2nd arg is assets) — build then patch id */
function mkUser(id: string, content: string) {
  const m = createUserMessage(content)
  m.id = id
  return m
}
function mkAssistant(id: string, content: string) {
  const m = createAssistantMessage(content)
  m.id = id
  return m
}

/** Seed a conversation as a plain (non-frozen) object in the store. */
function seedConversation(messages: ReturnType<typeof createUserMessage>[]) {
  const conv = useConversationStore.getState().createNew('persist-test')
  // createNew returns a frozen store object; replace it wholesale via setState
  // with a plain snapshot carrying the messages we want.
  useConversationStore.setState({
    conversations: [{ ...conv, messages }],
    activeConversationId: conv.id,
  } as never)
  return conv
}

const getConv = (id: string) =>
  useConversationStore.getState().conversations.find((c) => c.id === id)

/**
 * Seed one loaded, idle, non-active conversation with `messageCount` messages
 * and `updatedAt`, returning its id. (`createNew` with `activate: false`
 * keeps activeConversationId untouched.)
 */
function seedLoadedConv(messageCount: number, updatedAt: number): string {
  const conv = useConversationStore.getState().createNew('seed', { activate: false })
  const messages = Array.from({ length: messageCount }, (_, j) =>
    j % 2 === 0
      ? mkUser(`${conv.id}-u${j}`, `q${j}`)
      : mkAssistant(`${conv.id}-a${j}`, `a${j}`)
  )
  patchConversation(conv.id, { messages, messagesLoaded: true, updatedAt })
  return conv.id
}

/** Patch one conversation in the store with a plain (non-frozen) object. */
function patchConversation(id: string, patch: Record<string, unknown>) {
  useConversationStore.setState({
    conversations: useConversationStore
      .getState()
      .conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  } as never)
}

/**
 * Seed an evictable fixture: one old conversation with more than
 * EVICTION_MIN_MESSAGES messages plus EVICTION_LRU_KEEP newer (small)
 * conversations that occupy the keep-set. Returns [oldId, ...newerIds].
 */
function seedEvictFixture(): string[] {
  const old = seedLoadedConv(EVICTION_MIN_MESSAGES + 20, 1_000)
  const newer = Array.from({ length: EVICTION_LRU_KEEP }, (_, i) =>
    seedLoadedConv(2, 2_000 + i)
  )
  return [old, ...newer]
}

describe('conversation persistence: debounce coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('writes each updateMessages call immediately (flush path, serialized, incremental)', async () => {
    // Keep ONE user message object so its reference is stable across calls —
    // the incremental diff keys on message identity, not deep equality.
    const u1 = mkUser('u1', 'q')
    const conv = seedConversation([u1])

    // updateMessages uses the flush path (final saves): every call persists
    // immediately, chained after the previous write — never dropped.
    useConversationStore.getState().updateMessages(conv.id, [u1, mkAssistant('a-1', 'block 1')])
    useConversationStore.getState().updateMessages(conv.id, [u1, mkAssistant('a-2', 'block 2')])
    useConversationStore.getState().updateMessages(conv.id, [u1, mkAssistant('a-3', 'block 3')])

    await vi.advanceTimersByTimeAsync(0)

    // First persist has no baseline: one full rewrite establishing it.
    expect(messageRepoReplaceAllMock).toHaveBeenCalledTimes(1)
    const firstPersisted = messageRepoReplaceAllMock.mock.calls[0][1] as { id: string }[]
    expect(firstPersisted.map((m) => m.id)).toEqual(['u1', 'a-1'])

    // Later persists are incremental: only new/changed rows upserted, dropped
    // ids deleted — never the whole history again.
    expect(messageRepoApplyDiffMock).toHaveBeenCalledTimes(2)
    const [, secondUpserts, secondDeletes] = messageRepoApplyDiffMock.mock.calls[0]
    expect(secondUpserts.map((u: { message: { id: string } }) => u.message.id)).toEqual(['a-2'])
    expect(secondDeletes).toEqual(['a-1'])

    const [, thirdUpserts, thirdDeletes] = messageRepoApplyDiffMock.mock.calls[1]
    expect(thirdUpserts.map((u: { message: { id: string } }) => u.message.id)).toEqual(['a-3'])
    expect(thirdDeletes).toEqual(['a-2'])

    expect(conversationRepoTouchMock).toHaveBeenCalledWith(conv.id)
  })

  it('persists through updateMessages after the debounce window elapses', async () => {
    const conv = seedConversation([mkUser('u1', 'hello')])

    useConversationStore.getState().updateMessages(conv.id, [
      mkUser('u1', 'hello'),
      mkAssistant('a1', 'answer'),
    ])
    await vi.advanceTimersByTimeAsync(400)

    expect(messageRepoReplaceAllMock).toHaveBeenCalledTimes(1)
    expect(conversationRepoTouchMock).toHaveBeenCalledWith(conv.id)
  })

  it('persists new messages immediately through addMessage (insert path)', async () => {
    const conv = seedConversation([])

    useConversationStore.getState().addMessage(conv.id, createUserMessage('first'))
    await vi.advanceTimersByTimeAsync(0)

    expect(messageRepoInsertMock).toHaveBeenCalledTimes(1)
    expect(conversationRepoTouchMock).toHaveBeenCalledWith(conv.id)
  })
})

describe('conversation persistence: metadata routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('routes title updates through saveMeta without touching message rows', async () => {
    const conv = seedConversation([])

    useConversationStore.getState().updateTitle(conv.id, 'renamed')
    await vi.advanceTimersByTimeAsync(400)

    expect(conversationRepoSaveMetaMock).toHaveBeenCalled()
    const saved = conversationRepoSaveMetaMock.mock.calls.at(-1)[0]
    expect(saved.id).toBe(conv.id)
    expect(saved.title).toBe('renamed')
    // Meta persist must not rewrite message rows
    expect(messageRepoReplaceAllMock).not.toHaveBeenCalled()
  })

  it('a late generic meta save never reverts a committed kind change (stale-kind guard)', async () => {
    const conv = useConversationStore.getState().createNew('race-conv', { kind: 'direct' })

    // 1) A generic meta save STARTS while the conversation is still 'direct':
    //    its saveMeta call snapshot carries kind='direct'.
    const slowSave = new Promise<void>((resolve) => setTimeout(resolve, 500))
    conversationRepoSaveMetaMock.mockImplementationOnce(() => slowSave)
    useConversationStore.getState().updateTitle(conv.id, 'renamed mid-flight')

    // 2) The direct→project transition commits while the meta save is still
    //    in flight (persistConversationKind awaits the in-flight meta save, so
    //    advance past it and run through the kind write).
    const kindPersist = useConversationStore.getState().setConversationKind(conv.id, 'project')
    await vi.advanceTimersByTimeAsync(600)
    await kindPersist

    // The transition went through the dedicated updateKind write...
    expect(conversationRepoUpdateKindMock).toHaveBeenCalledWith(conv.id, 'project')
    // Non-vacuous guard: the pre-transition generic meta save (its snapshot
    // carrying the stale kind='direct') MUST actually have fired — otherwise
    // the 'never reverts' assertion below would pass on an empty call list.
    const staleMetaCall = conversationRepoSaveMetaMock.mock.calls.find(
      (call) => call[0]?.id === conv.id && call[0]?.kind === 'direct',
    )
    expect(staleMetaCall).toBeDefined()
    // ...and NO kind='project' value ever travelled through the generic
    // saveMeta path (the stale 'direct' snapshot is ignored by the repository
    // UPSERT guard, so the committed conversion cannot be reverted).
    const metaKinds = conversationRepoSaveMetaMock.mock.calls.map((call) => call[0]?.kind)
    expect(metaKinds).not.toContain('project')
    // NOTE: the SQL-level half of this contract (the saveMeta UPSERT must
    // declare kind on INSERT and NEVER assign it in the ON CONFLICT update
    // clause — not via excluded.kind, a positional parameter, or a literal)
    // is asserted against the real SQL in
    // web/sqlite/repositories/conversation.repository.test.ts
    // ('saveMeta writes kind on INSERT but never updates it on conflict');
    // this file mocks the repository, so only the caller-side argument
    // contract is observable here.
    expect(useConversationStore.getState().conversations.find((c) => c.id === conv.id)?.kind).toBe('project')
  })
})

describe('message merge semantics (reconcileMessageSnapshot)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns previous when incoming is empty', () => {
    const previous = [mkUser('u1', 'q1')]
    expect(reconcileMessageSnapshot(previous, [])).toBe(previous)
  })

  it('returns incoming when previous is empty', () => {
    const incoming = [mkUser('u1', 'q1')]
    expect(reconcileMessageSnapshot([], incoming)).toBe(incoming)
  })

  it('replaces when incoming fully covers previous (re-mapped snapshot)', () => {
    const previous = [mkUser('u1', 'q1'), mkAssistant('a1', 'a1')]
    const incoming = [mkUser('u1', 'q1'), mkAssistant('a1', 'a1-regenerated')]

    const merged = reconcileMessageSnapshot(previous, incoming)

    expect(merged).toHaveLength(2)
    expect(merged[1].content).toBe('a1-regenerated')
  })

  it('appends unseen messages on partial overlap without dropping history', () => {
    const previous = [mkUser('u1', 'q1')]
    const incoming = [mkUser('u1', 'q1'), mkAssistant('a-tail', 'tail')]

    const merged = reconcileMessageSnapshot(previous, incoming)

    expect(merged).toHaveLength(2)
    expect(merged[0].id).toBe('u1')
    expect(merged[1].id).toBe('a-tail')
  })

  it('appends a small non-overlapping fragment instead of replacing history', () => {
    const previous = [
      mkUser('u1', 'q1'),
      mkAssistant('a1', 'long answer'),
      mkAssistant('a2', 'more'),
      mkAssistant('a3', 'even more'),
    ]
    // A tiny fragment (new tool result) — must append, not replace
    const fragment = [mkAssistant('a-new', 'tool result')]

    const merged = reconcileMessageSnapshot(previous, fragment)

    expect(merged).toHaveLength(5)
    expect(merged[0].id).toBe('u1')
    expect(merged[4].id).toBe('a-new')
  })

  it('treats a large non-overlapping incoming as a replacement snapshot (regenerated ids)', () => {
    const previous = [mkUser('u1', 'q1'), mkAssistant('a1', 'answer')]
    // Cancel/regenerate re-maps all ids: no overlap but same scale as previous
    const incoming = [mkUser('u1-r', 'q1'), mkAssistant('a1-r', 'answer-regenerated')]

    const merged = reconcileMessageSnapshot(previous, incoming)

    expect(merged).toHaveLength(2)
    expect(merged.map((m) => m.id)).toEqual(['u1-r', 'a1-r'])
  })

  it('preserves previous reasoningDurationMs when incoming drops it', () => {
    const previous = [mkAssistant('a1', 'answer')]
    previous[0].reasoningDurationMs = 1234
    const incoming = [mkAssistant('a1', 'answer')]

    const merged = reconcileMessageSnapshot(previous, incoming)

    expect(merged[0].reasoningDurationMs).toBe(1234)
  })
})

describe('compression baseline healing on loadFromDB', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore({ loaded: false, activeConversationId: 'heal-conv' })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('heals compressedContextSummary/cutoff from a context_summary message', async () => {
    await useConversationStore.getState().loadFromDB()
    await vi.advanceTimersByTimeAsync(0)

    const healed = getConv('heal-conv')
    expect(healed).toBeDefined()
    expect(healed?.compressedContextSummary).toBe('summary-of-earlier-context')
    // cutoff = summary timestamp + 1
    expect(healed?.compressedContextCutoffTimestamp).toBe(1_700_000_000_001)
  })
})

describe('truncation guard: writes to metadata-only conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore({ loaded: false })
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('updateMessages merges with DB history instead of truncating it', async () => {
    await useConversationStore.getState().loadFromDB()
    await vi.advanceTimersByTimeAsync(0)

    // loadFromDB loads the ACTIVE conversation only — bg-conv stays meta-only.
    const bg = getConv('bg-conv')
    expect(bg?.messagesLoaded).toBe(false)
    expect(bg?.messages).toHaveLength(0)

    // External writer pattern (webmcp app-tools): snapshot built from the
    // EMPTY in-memory state — applying it directly would wipe bg-u1/bg-a1.
    useConversationStore.getState().updateMessages('bg-conv', [mkUser('ext-1', 'from webmcp')])
    await vi.advanceTimersByTimeAsync(0)

    const after = getConv('bg-conv')
    expect(after?.messagesLoaded).toBe(true)
    expect(after?.messages.map((m) => m.id)).toEqual(['bg-u1', 'bg-a1', 'ext-1'])

    // No full rewrite with a truncated snapshot; incremental upsert of the
    // appended row only, nothing deleted.
    expect(messageRepoReplaceAllMock).not.toHaveBeenCalled()
    const lastDiff = messageRepoApplyDiffMock.mock.calls.at(-1)
    expect(lastDiff).toBeDefined()
    const [, upserts, deletes] = lastDiff
    expect(upserts.map((u: { message: { id: string } }) => u.message.id)).toEqual(['ext-1'])
    expect(upserts[0].seq).toBe(2)
    expect(deletes).toEqual([])
  })

  it('addMessage loads DB history before appending (correct seq)', async () => {
    await useConversationStore.getState().loadFromDB()
    await vi.advanceTimersByTimeAsync(0)

    useConversationStore.getState().addMessage('bg-conv', createUserMessage('late arrival'))
    await vi.advanceTimersByTimeAsync(0)

    // Deferred load → append chain: history restored, new message appended.
    const after = getConv('bg-conv')
    expect(after?.messagesLoaded).toBe(true)
    expect(after?.messages.map((m) => m.id)).toEqual(['bg-u1', 'bg-a1', after?.messages[2]?.id])
    expect(after?.messages).toHaveLength(3)
    expect(after?.messages[2]?.content).toBe('late arrival')
    // Insert path with a seq that does not collide with the existing rows.
    expect(messageRepoInsertMock).toHaveBeenCalledWith(
      'bg-conv',
      expect.objectContaining({ content: 'late arrival' }),
      2
    )
  })
})

describe('conversation message memory eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  it('evicts a big idle unmounted non-active conversation outside the keep-set', () => {
    const [old] = seedEvictFixture()
    expect(getConv(old)?.messages).toHaveLength(EVICTION_MIN_MESSAGES + 20)

    expect(evictConversationMessagesIfSafe(old)).toBe(true)

    const evicted = getConv(old)
    expect(evicted?.messages).toEqual([])
    expect(evicted?.messagesLoaded).toBe(false)
    // Newer keep-set conversations stay cached
    for (const c of useConversationStore.getState().conversations) {
      if (c.id !== old) expect(c.messages.length).toBeGreaterThan(0)
    }
  })

  it('keeps conversations inside the LRU keep-set (newest first)', () => {
    const [, ...newer] = seedEvictFixture()
    // Newest conversations are keep-set members — never evicted
    for (const id of newer) {
      expect(evictConversationMessagesIfSafe(id)).toBe(false)
      expect(getConv(id)?.messages.length).toBe(2)
    }
  })

  it('evicts nothing while total loaded conversations fit in the keep-set', () => {
    const only = seedLoadedConv(EVICTION_MIN_MESSAGES + 20, 1_000)
    expect(evictConversationMessagesIfSafe(only)).toBe(false)
  })

  it('keeps active, running, mounted, queued, drafted, or meta-only conversations', () => {
    // Active
    let [old] = seedEvictFixture()
    useConversationStore.setState({ activeConversationId: old } as never)
    expect(evictConversationMessagesIfSafe(old)).toBe(false)

    // Running
    ;[old] = seedEvictFixture()
    patchConversation(old, { status: 'streaming' })
    expect(evictConversationMessagesIfSafe(old)).toBe(false)

    // Mounted view (runtime-store refcount)
    ;[old] = seedEvictFixture()
    useConversationRuntimeStore.getState().mountConversation(old)
    expect(evictConversationMessagesIfSafe(old)).toBe(false)
    useConversationRuntimeStore.getState().unmountConversation(old)
    expect(evictConversationMessagesIfSafe(old)).toBe(true)

    // Queued messages
    ;[old] = seedEvictFixture()
    useConversationRuntimeStore.getState().enqueueMessage(old, {
      text: 'queued',
      enqueuedAt: Date.now(),
    })
    expect(evictConversationMessagesIfSafe(old)).toBe(false)
    useConversationRuntimeStore.getState().clearQueue(old)
    expect(evictConversationMessagesIfSafe(old)).toBe(true)

    // Pending draft assistant
    ;[old] = seedEvictFixture()
    patchConversation(old, { draftAssistant: { steps: [] } })
    expect(evictConversationMessagesIfSafe(old)).toBe(false)

    // Already metadata-only
    ;[old] = seedEvictFixture()
    patchConversation(old, { messages: [], messagesLoaded: false })
    expect(evictConversationMessagesIfSafe(old)).toBe(false)
  })

  it('keeps conversations below the message threshold', () => {
    const small = seedLoadedConv(EVICTION_MIN_MESSAGES - 1, 1_000)
    for (let i = 0; i < EVICTION_LRU_KEEP; i++) seedLoadedConv(2, 2_000 + i)
    expect(evictConversationMessagesIfSafe(small)).toBe(false)
  })

  it('blocks eviction while a persist is scheduled, allows it after flush', async () => {
    const [old] = seedEvictFixture()
    const currentMessages = getConv(old)!.messages

    // Debounced persist pending → eviction must not race it
    persistMessageReplace(old, currentMessages, false)
    expect(evictConversationMessagesIfSafe(old)).toBe(false)

    // After the debounce flush completes, eviction is allowed
    await vi.advanceTimersByTimeAsync(400)
    expect(evictConversationMessagesIfSafe(old)).toBe(true)
  })

  it('scheduleConversationEviction defers and re-checks guards at fire time', async () => {
    const [old] = seedEvictFixture()
    scheduleConversationEviction(old)

    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS - 1)
    expect(getConv(old)?.messages.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(getConv(old)?.messages).toEqual([])
    expect(getConv(old)?.messagesLoaded).toBe(false)
  })

  it('scheduled eviction is cancelled by a mounted view appearing before fire time', async () => {
    const [old] = seedEvictFixture()
    scheduleConversationEviction(old)
    useConversationRuntimeStore.getState().mountConversation(old)

    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS + 100)
    expect(getConv(old)?.messages.length).toBeGreaterThan(0)
  })

  it('unmounting the last view schedules eviction (runtime-store subscription)', async () => {
    const [old] = seedEvictFixture()
    const runtime = useConversationRuntimeStore.getState()
    runtime.mountConversation(old)
    runtime.mountConversation(old)
    runtime.unmountConversation(old)
    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS + 100)
    // Still one view mounted → kept
    expect(getConv(old)?.messages.length).toBeGreaterThan(0)

    runtime.unmountConversation(old)
    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS + 100)
    expect(getConv(old)?.messages).toEqual([])
  })

  it('setConversationStatus idle transition schedules eviction', async () => {
    const [old] = seedEvictFixture()
    patchConversation(old, { status: 'streaming' })

    useConversationStore.getState().setConversationStatus(old, 'idle')
    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS + 100)

    expect(getConv(old)?.messages).toEqual([])
    expect(getConv(old)?.messagesLoaded).toBe(false)
  })

  it('setConversationStatus non-idle transitions do not schedule eviction', async () => {
    const [old] = seedEvictFixture()
    useConversationStore.getState().setConversationStatus(old, 'streaming')
    await vi.advanceTimersByTimeAsync(EVICTION_DELAY_MS + 100)
    expect(getConv(old)?.messages.length).toBeGreaterThan(0)
  })

  it('evicted conversation reloads from DB when reopened via setActive', async () => {
    // loadFromDB early-returns when already loaded — reset to unloaded first
    resetStore({ loaded: false })
    await useConversationStore.getState().loadFromDB()
    await vi.advanceTimersByTimeAsync(0)
    expect(getConv('bg-conv')).toBeDefined()

    // Force bg-conv into a "long session" loaded state (messages beyond the
    // eviction threshold), older than the keep-set seeds.
    const big = Array.from(
      { length: EVICTION_MIN_MESSAGES + 20 },
      (_, j) => (j % 2 === 0 ? mkUser(`mem-u${j}`, 'q') : mkAssistant(`mem-a${j}`, 'a'))
    )
    patchConversation('bg-conv', { messages: big, messagesLoaded: true, updatedAt: 1_000 })
    // Occupy the LRU keep-set with newer conversations
    for (let i = 0; i < EVICTION_LRU_KEEP; i++) seedLoadedConv(2, 2_000 + i)

    expect(evictConversationMessagesIfSafe('bg-conv')).toBe(true)

    await useConversationStore.getState().setActive('bg-conv')

    // Reopen reloads the DB rows (bg-u1 / bg-a1 from the mock repository)
    const reopened = getConv('bg-conv')
    expect(reopened?.messagesLoaded).toBe(true)
    expect(reopened?.messages.map((m) => m.id)).toEqual(['bg-u1', 'bg-a1'])
  })
})
