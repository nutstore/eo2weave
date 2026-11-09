/**
 * Conversation Runtime Store
 *
 * Stores per-conversation runtime state that changes at high frequency
 * during agent execution (streaming content, tool calls, draft assistant, etc.).
 *
 * This store is intentionally separated from the main conversation store
 * so that streaming updates (~60fps during agent runs) do NOT trigger
 * re-renders in components that only need persisted data
 * (conversation list, titles, message history).
 *
 * All state is ephemeral (lost on page reload) and keyed by conversationId.
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import type {
  ConversationStatus,
  ToolCall,
  DraftAssistantStep,
  ContextWindowUsage,
  Message,
} from '@/agent/message-types'
import type { AssetMeta } from '@/types/asset'

/** A message waiting in the per-conversation queue */
export interface QueuedMessage {
  /** Explicit MCP result continuation; used to restore its card if withdrawn. */
  mcpTaskId?: string
  text: string
  assets?: AssetMeta[]
  agentOverrideId?: string | null
  enqueuedAt: number
  /** External-agent runs stay in the background (no UI workspace switch). */
  background?: boolean
  /** Upstream page context captured at enqueue time (side-panel mode) */
  pageContext?: Message['pageContext']
  /** Persisted multimodal content for a synthetic follow-up user message. */
  contentParts?: Message['contentParts']
  /** Provenance for a user-role message created by an agent tool handoff. */
  readImageHandoff?: Message['readImageHandoff']
  /**
   * Re-run trigger from an overlapping dispatch: the caller already appended
   * its user message to the conversation, so the end-of-run consumer must
   * start a follow-up turn WITHOUT creating another user message.
   */
  rerunOnly?: boolean
  /**
   * Identity of the run this trigger is parked on (the dispatch that was
   * holding the start claim or owned the active run when the trigger was
   * enqueued). The queue-full drain uses it to tell ACCEPTED triggers —
   * their owning dispatch is still live and will consume them — apart from
   * stale residue whose owning dispatch already died (#170 review round 2).
   * Untagged triggers predate the stamping and are treated as stale.
   */
  ownerToken?: string | null
}

/** Maximum queued messages per conversation */
const MAX_QUEUE_SIZE = 20

// Enable Immer Map/Set support
enableMapSet()

// ─── Types ────────────────────────────────────────────────────────────────

/** Per-conversation runtime state (ephemeral, not persisted) */
export interface ConversationRuntime {
  /** Agent lifecycle status */
  status: ConversationStatus
  /** Streaming content being received */
  streamingContent: string
  /** Streaming reasoning content */
  streamingReasoning: string
  /** Whether reasoning is actively streaming */
  isReasoningStreaming: boolean
  /** Whether content is actively streaming */
  isContentStreaming: boolean
  /** Complete reasoning content */
  completedReasoning: string | null
  /** Complete content */
  completedContent: string | null
  /** Currently executing tool call */
  currentToolCall: ToolCall | null
  /** All currently executing tool calls */
  activeToolCalls: ToolCall[]
  /** Streaming tool call arguments */
  streamingToolArgs: string
  /** Streaming args keyed by tool call id */
  streamingToolArgsByCallId: Record<string, string>
  /** Error message */
  error: string | null
  /** Active run id for guarding stale callbacks */
  activeRunId: string | null
  /** Monotonic run counter for this conversation */
  runEpoch: number
  /** Streaming draft projection rendered in UI */
  draftAssistant: {
    reasoning: string
    content: string
    toolCalls: ToolCall[]
    toolResults: Record<string, string>
    toolCall: ToolCall | null
    toolArgs: string
    steps: DraftAssistantStep[]
    activeReasoningStepId?: string | null
    activeContentStepId?: string | null
    activeToolStepId?: string | null
    activeCompressionStepId?: string | null
  } | null
  /** Runtime context window usage for the active model call */
  contextWindowUsage: ContextWindowUsage | null
  /** Assets collected during current agent run */
  collectedAssets: AssetMeta[]
  /** Runtime convert call counter for context compression cadence */
  compressionConvertCallCount: number
  /** Runtime marker for last summary convert call */
  compressionLastSummaryConvertCall: number
  /** Set when agent loop stops due to maxIterations limit (null when not applicable) */
  iterationLimitReached: number | null
}

/** Creates a fresh runtime state for a conversation */
export function createEmptyRuntime(): ConversationRuntime {
  return {
    status: 'idle',
    streamingContent: '',
    streamingReasoning: '',
    isReasoningStreaming: false,
    isContentStreaming: false,
    completedReasoning: null,
    completedContent: null,
    currentToolCall: null,
    activeToolCalls: [],
    streamingToolArgs: '',
    streamingToolArgsByCallId: {},
    error: null,
    activeRunId: null,
    runEpoch: 0,
    draftAssistant: null,
    contextWindowUsage: null,
    collectedAssets: [],
    compressionConvertCallCount: 0,
    compressionLastSummaryConvertCall: Number.NEGATIVE_INFINITY,
    iterationLimitReached: null,
  }
}

export interface ConversationRuntimeState {
  // ─── Per-conversation runtime state ───
  runtimes: Map<string, ConversationRuntime>

  // Note: live AgentLoop instances are kept in
  // `@/store/agent-loop-registry` rather than in this state. They are
  // service objects (provider, toolRegistry, AbortController, …) with
  // private fields, and putting them through immer breaks type-checking.

  // Note: live StreamingQueue pairs are kept in
  // `@/store/streaming-queue-registry` for the same reason — they are
  // RAF-batched writers, not serializable state.

  // ─── Subagent draft assistants: per-agentId runtime state (not persisted) ───
  // Each subagent gets its own DraftAssistantState, rendered identically
  // to the main agent's draft steps (reasoning, content, tool calls, etc.)
  // Note: subagent StreamingQueue pairs (if needed in the future) should
  // also go into `@/store/streaming-queue-registry`, not here — they are
  // RAF-batched writers, not serializable state.
  subagentDrafts: Map<string, import('./draft-assistant').DraftAssistantState>

  // ─── Follow-up suggestions (not persisted) ───
  suggestedFollowUps: Map<string, string>

  // ─── Track run IDs that were cancelled by user (not persisted) ───
  cancelledRunIds: Set<string>

  // ─── Track mounted view ref counts per conversation (not persisted) ───
  mountedConversations: Map<string, number>

  // ─── Queued user messages (not persisted) ───
  pendingMessageQueues: Map<string, QueuedMessage[]>

  // ─── Computed helpers ───
  getRuntime: (convId: string) => ConversationRuntime | undefined
  getConversationStatus: (convId: string) => ConversationStatus
  isConversationRunning: (convId: string) => boolean
  getRunningConversations: () => string[]

  // ─── Runtime state mutations ───
  setConversationStatus: (convId: string, status: ConversationStatus) => void
  setConversationError: (convId: string, error: string | null) => void
  resetConversationState: (convId: string) => void
  collectAssets: (convId: string, assets: AssetMeta[]) => void

  // ─── Follow-up suggestion actions ───
  setSuggestedFollowUp: (convId: string, suggestion: string) => void
  clearSuggestedFollowUp: (convId: string) => void
  getSuggestedFollowUp: (convId: string) => string

  // ─── Mount tracking ───
  mountConversation: (convId: string) => void
  unmountConversation: (convId: string) => void
  isConversationMounted: (convId: string) => boolean

  // ─── Message queue actions ───
  enqueueMessage: (convId: string, message: QueuedMessage) => { enqueued: boolean; position: number }
  dequeueMessage: (convId: string) => QueuedMessage | null
  getQueueDepth: (convId: string) => number
  clearQueue: (convId: string) => void
  removeQueuedMessage: (convId: string, index: number) => void
  /** Update a queued message's text/assets by index */
  updateQueuedMessage: (convId: string, index: number, patch: Partial<Pick<QueuedMessage, 'text' | 'assets'>>) => void
  /** Move a queued message from one index to another */
  moveQueuedMessage: (convId: string, fromIndex: number, toIndex: number) => void
  /** Get a single queued message by index (non-reactive) */
  getQueuedMessage: (convId: string, index: number) => QueuedMessage | undefined
}

export const useConversationRuntimeStore = create<ConversationRuntimeState>()(
  immer((set, get) => ({
    runtimes: new Map(),
    subagentDrafts: new Map(),

    suggestedFollowUps: new Map(),
    cancelledRunIds: new Set(),
    mountedConversations: new Map(),
    pendingMessageQueues: new Map(),

    // ─── Computed helpers ───

    getRuntime: (convId: string) => {
      return get().runtimes.get(convId)
    },

    getConversationStatus: (convId: string) => {
      return get().runtimes.get(convId)?.status || 'idle'
    },

    isConversationRunning: (convId: string) => {
      const rt = get().runtimes.get(convId)
      if (!rt) return false
      return rt.status !== 'idle' && rt.status !== 'error'
    },

    getRunningConversations: () => {
      const { runtimes } = get()
      const result: string[] = []
      runtimes.forEach((rt, convId) => {
        if (rt.status !== 'idle' && rt.status !== 'error') {
          result.push(convId)
        }
      })
      return result
    },

    // ─── Runtime state mutations ───

    setConversationStatus: (convId: string, status: ConversationStatus) => {
      set((state) => {
        let rt = state.runtimes.get(convId)
        if (!rt) {
          rt = createEmptyRuntime()
          state.runtimes.set(convId, rt)
        }
        rt.status = status
      })
    },

    setConversationError: (convId: string, error: string | null) => {
      set((state) => {
        let rt = state.runtimes.get(convId)
        if (!rt) {
          rt = createEmptyRuntime()
          state.runtimes.set(convId, rt)
        }
        rt.error = error
        rt.status = error ? 'error' : 'idle'
      })
    },

    resetConversationState: (convId: string) => {
      // Clear any pending ask_user_question entries
      import('@/store/pending-question.store')
        .then(({ clearPendingQuestions }) => {
          clearPendingQuestions(convId)
        })
        .catch(() => {})

      set((state) => {
        const rt = state.runtimes.get(convId)
        if (rt) {
          // Reset all runtime fields to initial state
          rt.status = 'idle'
          rt.streamingContent = ''
          rt.streamingReasoning = ''
          rt.isReasoningStreaming = false
          rt.completedReasoning = null
          rt.isContentStreaming = false
          rt.completedContent = null
          rt.currentToolCall = null
          rt.activeToolCalls = []
          rt.streamingToolArgs = ''
          rt.streamingToolArgsByCallId = {}
          rt.error = null
          rt.activeRunId = null
          rt.draftAssistant = null
          rt.contextWindowUsage = null
          rt.iterationLimitReached = null
        }
      })
    },

    collectAssets: (convId: string, assets: AssetMeta[]) => {
      set((state) => {
        let rt = state.runtimes.get(convId)
        if (!rt) {
          rt = createEmptyRuntime()
          state.runtimes.set(convId, rt)
        }
        rt.collectedAssets.push(...assets)
      })
    },

    // ─── Follow-up suggestion actions ───

    setSuggestedFollowUp: (convId: string, suggestion: string) => {
      set((state) => {
        state.suggestedFollowUps.set(convId, suggestion)
      })
    },

    clearSuggestedFollowUp: (convId: string) => {
      set((state) => {
        state.suggestedFollowUps.delete(convId)
      })
    },

    getSuggestedFollowUp: (convId: string) => {
      return get().suggestedFollowUps.get(convId) || ''
    },

    // ─── Mount tracking ───

    mountConversation: (convId: string) => {
      set((state) => {
        const count = state.mountedConversations.get(convId) || 0
        state.mountedConversations.set(convId, count + 1)
      })
    },

    unmountConversation: (convId: string) => {
      set((state) => {
        const count = state.mountedConversations.get(convId) || 0
        if (count <= 1) {
          state.mountedConversations.delete(convId)
        } else {
          state.mountedConversations.set(convId, count - 1)
        }
      })
    },

    isConversationMounted: (convId: string) => {
      return (get().mountedConversations.get(convId) || 0) > 0
    },

    // ─── Message queue actions ───

    enqueueMessage: (convId: string, message: QueuedMessage) => {
      const queue = get().pendingMessageQueues.get(convId)
      if (queue && queue.length >= MAX_QUEUE_SIZE) {
        return { enqueued: false, position: -1 }
      }
      set((state) => {
        let q = state.pendingMessageQueues.get(convId)
        if (!q) {
          q = []
          state.pendingMessageQueues.set(convId, q)
        }
        q.push(message)
      })
      const updated = get().pendingMessageQueues.get(convId)
      return { enqueued: true, position: updated?.length ?? 0 }
    },

    dequeueMessage: (convId: string) => {
      const queue = get().pendingMessageQueues.get(convId)
      if (!queue || queue.length === 0) return null
      const item = queue[0]
      set((state) => {
        const q = state.pendingMessageQueues.get(convId)
        if (q && q.length > 0) {
          q.shift()
          if (q.length === 0) {
            state.pendingMessageQueues.delete(convId)
          }
        }
      })
      return item
    },

    getQueueDepth: (convId: string) => {
      return get().pendingMessageQueues.get(convId)?.length ?? 0
    },

    clearQueue: (convId: string) => {
      set((state) => {
        state.pendingMessageQueues.delete(convId)
      })
    },

    removeQueuedMessage: (convId: string, index: number) => {
      set((state) => {
        const q = state.pendingMessageQueues.get(convId)
        if (q && index >= 0 && index < q.length) {
          q.splice(index, 1)
          if (q.length === 0) {
            state.pendingMessageQueues.delete(convId)
          }
        }
      })
    },

    updateQueuedMessage: (convId, index, patch) => {
      set((state) => {
        const q = state.pendingMessageQueues.get(convId)
        if (q && index >= 0 && index < q.length) {
          if (patch.text !== undefined) q[index].text = patch.text
          if (patch.assets !== undefined) q[index].assets = patch.assets
        }
      })
    },

    moveQueuedMessage: (convId, fromIndex, toIndex) => {
      set((state) => {
        const q = state.pendingMessageQueues.get(convId)
        if (!q || fromIndex < 0 || fromIndex >= q.length || toIndex < 0 || toIndex >= q.length || fromIndex === toIndex) {
          return
        }
        const [item] = q.splice(fromIndex, 1)
        q.splice(toIndex, 0, item)
      })
    },

    getQueuedMessage: (convId, index) => {
      const q = get().pendingMessageQueues.get(convId)
      return q?.[index]
    },
  }))
)
