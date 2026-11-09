/**
 * Conversation message memory eviction (phase 2 of the memory-governance plan)
 *
 * Conversations keep their full message history in memory forever once opened
 * (mount ref-counting has no cache-releasing consumer), which is a major
 * contributor to the "page gets slower the longer you chat" problem. Eviction
 * returns a conversation to its metadata-only state (`messages: []`,
 * `messagesLoaded: false`); reopening it reloads from SQLite via setActive.
 *
 * Safety relies on phase 1: after eviction any late writer goes through the
 * `writeWithMessagesLoaded` guard (reload-before-write), so a write can never
 * truncate the DB history.
 *
 * This module owns ONLY the policy and the timers. Everything it needs to know
 * about its owner comes through `ConversationEvictionPort`, so the policy is
 * unit-testable without booting the store.
 */

/** Minimum in-memory message count before eviction is worth the reload cost. */
export const EVICTION_MIN_MESSAGES = 100
/** Newest conversations (by updatedAt) with loaded messages that stay cached. */
export const EVICTION_LRU_KEEP = 3
/** Delay before an eviction candidate is re-checked and evicted. Lets final
 *  persists settle (completion handlers read `conv.messages` right after
 *  setting status idle — evicting synchronously would hand them `[]`). */
export const EVICTION_DELAY_MS = 30_000

/** Minimal read-only view of one conversation, for guards + the LRU keep-set. */
export interface EvictionCandidate {
  id: string
  messageCount: number
  messagesLoaded: boolean
  status: string
  hasDraftAssistant: boolean
  updatedAt: number
}

/**
 * The owner side of eviction: whatever the store must answer or do. Keep it
 * minimal — every method here is a coupling point between the policy and the
 * store internals.
 */
export interface ConversationEvictionPort {
  /** All conversations' minimal metadata (guards + LRU keep-set). */
  listCandidates(): EvictionCandidate[]
  /** The conversation currently open in the main view, if any. */
  getActiveConversationId(): string | null
  /** Live mount ref-count (0 = not visible to the user). */
  getMountedCount(conversationId: string): number
  /** Queued user messages awaiting the current run. */
  getPendingQueueLength(conversationId: string): number
  /** A debounced message persist is pending for this conversation. */
  hasPendingPersist(conversationId: string): boolean
  /** A deferred metadata-only write is queued for this conversation. */
  hasPendingUnloadedWrite(conversationId: string): boolean
  /** Drop the in-memory messages and release the caches that pin them. */
  unload(conversationId: string): void
}

let port: ConversationEvictionPort | undefined

/** Wire the policy to its owner. Called once at store module init. */
export function configureConversationEviction(next: ConversationEvictionPort): void {
  port = next
}

function getPort(): ConversationEvictionPort {
  if (!port) throw new Error('[conversation.store] eviction port is not configured')
  return port
}

const evictionTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule a delayed eviction check for `conversationId`. All safety guards are
 * re-evaluated when the timer fires, so scheduling is cheap and always safe.
 * Idempotent: a pending timer for the same conversation is kept.
 */
export function scheduleConversationEviction(conversationId: string): void {
  if (evictionTimers.has(conversationId)) return
  const timer = setTimeout(() => {
    evictionTimers.delete(conversationId)
    evictConversationMessagesIfSafe(conversationId)
  }, EVICTION_DELAY_MS)
  evictionTimers.set(conversationId, timer)
}

export function cancelScheduledEviction(conversationId: string): void {
  const timer = evictionTimers.get(conversationId)
  if (timer) {
    clearTimeout(timer)
    evictionTimers.delete(conversationId)
  }
}

/**
 * Test helper: drop all pending eviction timers. Tests that discard fake
 * timers mid-flight would otherwise leave stale `evictionTimers` entries that
 * silently block future `scheduleConversationEviction` calls for the same id.
 */
export function clearScheduledEvictionTimers(): void {
  for (const timer of evictionTimers.values()) clearTimeout(timer)
  evictionTimers.clear()
}

/**
 * Evict a conversation's in-memory messages back to metadata-only state when it
 * is provably quiescent and outside the LRU keep-set. Every guard is checked
 * at execution time (not scheduling time). Returns true when eviction ran.
 */
export function evictConversationMessagesIfSafe(conversationId: string): boolean {
  const owner = getPort()
  const candidates = owner.listCandidates()
  const conv = candidates.find((c) => c.id === conversationId)
  if (!conv || !conv.messagesLoaded) return false
  if (conv.messageCount < EVICTION_MIN_MESSAGES) return false
  if (owner.getActiveConversationId() === conversationId) return false
  if (conv.status !== 'idle') return false
  if (conv.hasDraftAssistant) return false
  if (owner.getMountedCount(conversationId) > 0) return false
  if (owner.getPendingQueueLength(conversationId) > 0) return false
  if (owner.hasPendingPersist(conversationId)) return false
  if (owner.hasPendingUnloadedWrite(conversationId)) return false

  // LRU keep-set: the newest conversations with loaded messages stay cached so
  // recently-used ones reopen instantly.
  const keepSet = new Set(
    candidates
      .filter((c) => c.messagesLoaded && c.messageCount > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, EVICTION_LRU_KEEP)
      .map((c) => c.id)
  )
  if (keepSet.has(conversationId)) return false

  owner.unload(conversationId)
  console.info('[conversation.store] Evicted conversation messages from memory', {
    conversationId,
    messageCount: conv.messageCount,
  })
  return true
}
