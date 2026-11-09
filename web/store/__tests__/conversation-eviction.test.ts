/**
 * Conversation eviction policy — pure unit tests through the port interface.
 *
 * The policy is exercised against a fake port here; store-level wiring (real
 * state, runtime ref-counts, pending persists) is covered by
 * conversation-persist.test.ts, which drives the store's public API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelScheduledEviction,
  clearScheduledEvictionTimers,
  configureConversationEviction,
  EVICTION_DELAY_MS,
  EVICTION_LRU_KEEP,
  EVICTION_MIN_MESSAGES,
  evictConversationMessagesIfSafe,
  scheduleConversationEviction,
  type ConversationEvictionPort,
  type EvictionCandidate,
} from '../conversation-eviction'

function candidate(id: string, over: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    id,
    messageCount: EVICTION_MIN_MESSAGES + 10,
    messagesLoaded: true,
    status: 'idle',
    hasDraftAssistant: false,
    updatedAt: 1_000,
    ...over,
  }
}

/** Seed the LRU keep-set with newer conversations so `id` stays evictable. */
function withKeepSet(candidates: EvictionCandidate[], id: string): EvictionCandidate[] {
  const existing = candidates.find((c) => c.id === id) ?? candidate(id)
  const keep = Array.from({ length: EVICTION_LRU_KEEP }, (_, i) =>
    candidate(`keep-${i}`, { messageCount: 2, updatedAt: 10_000 + i })
  )
  return [
    ...candidates.filter((c) => c.id !== id),
    { ...existing, updatedAt: 1_000 },
    ...keep,
  ]
}

function makePort(overrides: Partial<ConversationEvictionPort> = {}) {
  let candidates: EvictionCandidate[] = []
  const unloaded: string[] = []
  const port: ConversationEvictionPort = {
    listCandidates: () => candidates,
    getActiveConversationId: () => null,
    getMountedCount: () => 0,
    getPendingQueueLength: () => 0,
    hasPendingPersist: () => false,
    hasPendingUnloadedWrite: () => false,
    unload: (conversationId) => {
      unloaded.push(conversationId)
      candidates = candidates.map((c) =>
        c.id === conversationId ? { ...c, messageCount: 0, messagesLoaded: false } : c
      )
    },
    ...overrides,
  }
  return {
    port,
    unloaded,
    seed: (next: EvictionCandidate[]) => {
      candidates = next
    },
  }
}

describe('conversation eviction policy', () => {
  beforeEach(() => {
    clearScheduledEvictionTimers()
  })

  afterEach(() => {
    clearScheduledEvictionTimers()
    vi.useRealTimers()
  })

  it('evicts an idle, unmounted, non-active conversation outside the keep-set', () => {
    const fake = makePort()
    fake.seed(withKeepSet([], 'old'))
    configureConversationEviction(fake.port)

    expect(evictConversationMessagesIfSafe('old')).toBe(true)
    expect(fake.unloaded).toEqual(['old'])
  })

  it('keeps conversations below the message threshold', () => {
    const fake = makePort()
    fake.seed(withKeepSet([candidate('small', { messageCount: EVICTION_MIN_MESSAGES - 1 })], 'small'))
    configureConversationEviction(fake.port)

    expect(evictConversationMessagesIfSafe('small')).toBe(false)
    expect(fake.unloaded).toEqual([])
  })

  it('keeps metadata-only and unknown conversations', () => {
    const fake = makePort()
    fake.seed(withKeepSet([candidate('meta', { messageCount: 0, messagesLoaded: false })], 'meta'))
    configureConversationEviction(fake.port)

    expect(evictConversationMessagesIfSafe('meta')).toBe(false)
    expect(evictConversationMessagesIfSafe('missing')).toBe(false)
    expect(fake.unloaded).toEqual([])
  })

  it('keeps the active conversation', () => {
    const fake = makePort({ getActiveConversationId: () => 'old' })
    fake.seed(withKeepSet([], 'old'))
    configureConversationEviction(fake.port)

    expect(evictConversationMessagesIfSafe('old')).toBe(false)
    expect(fake.unloaded).toEqual([])
  })

  it('keeps non-idle conversations and conversations with a draft assistant', () => {
    const running = makePort()
    running.seed(withKeepSet([candidate('old', { status: 'streaming' })], 'old'))
    configureConversationEviction(running.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)

    const drafted = makePort()
    drafted.seed(withKeepSet([candidate('old', { hasDraftAssistant: true })], 'old'))
    configureConversationEviction(drafted.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)
  })

  it('keeps mounted conversations and conversations with queued messages', () => {
    const mounted = makePort({ getMountedCount: () => 1 })
    mounted.seed(withKeepSet([], 'old'))
    configureConversationEviction(mounted.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)

    const queued = makePort({ getPendingQueueLength: () => 1 })
    queued.seed(withKeepSet([], 'old'))
    configureConversationEviction(queued.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)

    expect(mounted.unloaded).toEqual([])
    expect(queued.unloaded).toEqual([])
  })

  it('keeps conversations with a pending persist or a deferred write', () => {
    const persisting = makePort({ hasPendingPersist: () => true })
    persisting.seed(withKeepSet([], 'old'))
    configureConversationEviction(persisting.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)

    const writing = makePort({ hasPendingUnloadedWrite: () => true })
    writing.seed(withKeepSet([], 'old'))
    configureConversationEviction(writing.port)
    expect(evictConversationMessagesIfSafe('old')).toBe(false)

    expect(persisting.unloaded).toEqual([])
    expect(writing.unloaded).toEqual([])
  })

  it('keeps the newest loaded conversations (LRU keep-set)', () => {
    const fake = makePort()
    const newer = Array.from({ length: EVICTION_LRU_KEEP }, (_, i) =>
      candidate(`new-${i}`, { messageCount: 2, updatedAt: 2_000 + i })
    )
    // Exactly as many loaded conversations as the keep-set holds → nothing is evictable.
    fake.seed(newer)
    configureConversationEviction(fake.port)
    for (const c of newer) expect(evictConversationMessagesIfSafe(c.id)).toBe(false)

    // An older big conversation joins → it sits outside the keep-set and is
    // evictable, while the newer ones stay cached.
    fake.seed([candidate('old', { updatedAt: 1_000 }), ...newer])
    for (const c of newer) expect(evictConversationMessagesIfSafe(c.id)).toBe(false)
    expect(evictConversationMessagesIfSafe('old')).toBe(true)
    expect(fake.unloaded).toEqual(['old'])
  })

  describe('scheduling', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('defers the check until EVICTION_DELAY_MS and re-evaluates guards at fire time', () => {
      const fake = makePort()
      fake.seed(withKeepSet([], 'old'))
      configureConversationEviction(fake.port)

      scheduleConversationEviction('old')
      vi.advanceTimersByTime(EVICTION_DELAY_MS - 1)
      expect(fake.unloaded).toEqual([])

      vi.advanceTimersByTime(1)
      expect(fake.unloaded).toEqual(['old'])
    })

    it('re-checks guards at fire time instead of scheduling time', () => {
      let mounted = 0
      const fake = makePort({ getMountedCount: () => mounted })
      fake.seed(withKeepSet([], 'old'))
      configureConversationEviction(fake.port)

      scheduleConversationEviction('old')
      mounted = 1
      vi.advanceTimersByTime(EVICTION_DELAY_MS)
      expect(fake.unloaded).toEqual([])
    })

    it('is idempotent per conversation', () => {
      const fake = makePort()
      fake.seed(withKeepSet([], 'old'))
      configureConversationEviction(fake.port)

      scheduleConversationEviction('old')
      scheduleConversationEviction('old')
      vi.advanceTimersByTime(EVICTION_DELAY_MS)
      expect(fake.unloaded).toEqual(['old'])
    })

    it('cancelScheduledEviction drops the pending check', () => {
      const fake = makePort()
      fake.seed(withKeepSet([], 'old'))
      configureConversationEviction(fake.port)

      scheduleConversationEviction('old')
      cancelScheduledEviction('old')
      vi.advanceTimersByTime(EVICTION_DELAY_MS)
      expect(fake.unloaded).toEqual([])
    })

    it('clearScheduledEvictionTimers drops every pending check', () => {
      const fake = makePort()
      fake.seed(withKeepSet([], 'old'))
      configureConversationEviction(fake.port)

      scheduleConversationEviction('old')
      scheduleConversationEviction('other')
      clearScheduledEvictionTimers()
      vi.advanceTimersByTime(EVICTION_DELAY_MS)
      expect(fake.unloaded).toEqual([])
    })
  })
})
