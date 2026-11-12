/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Conversation Store
 *
 * Manages chat history with per-conversation AgentLoop instances.
 * Uses SQLite for persistence.
 *
 * Runtime state (status, streaming content, etc.) is stored per-conversation
 * and not persisted to SQLite.
 */

import { credentialRegistry, isCredentialPending } from '@/agent/providers/credential-state'
import { isConversationUserMessage, isHumanUserMessage } from '@/agent/message-types'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import { toast } from 'sonner'
import type { Conversation, Message, ToolCall, ConversationStatus } from '@/agent/message-types'
import { createConversation, generateId } from '@/agent/message-types'
// Per-conversation authorization state (PR-1/PR-4 of the tool authorization
// redesign): grants die with the conversation — leaf stores, safe to import.
import { useSessionAllowStore } from '@/store/session-allow.store'
import { useYoloModeStore } from '@/store/yolo-mode.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { emitCompressionEvent } from '@/streaming-bus'
import { useConversationContextStore } from './conversation-context.store'
import { useConversationRuntimeStore, createEmptyRuntime } from './conversation-runtime.store'
import { deleteAgentLoop, getAgentLoop, setAgentLoop } from './agent-loop-registry'
import { deleteStreamingQueues, getStreamingQueues } from './streaming-queue-registry'
import { applyDraftAssistantEvent, createEmptyDraftAssistant } from './draft-assistant'
import { ensureToolCallResults } from '@/agent/loop/tool-call-results'
import { ensureRuntime, i18nText, commitDraftToMessages, findSpawnStepInDraft, truncateTitle, updateAutoTitleAfterMessageDelete, healCompressionBaseline, mergeUnloadedWriteSnapshot } from './conversation-message-ops'


// ---------------------------------------------------------------------------
// Subagent Step Notification Handler
// Routes streaming events from subagent's internal AgentLoop to a per-agentId
// DraftAssistantState in the runtime store, enabling real-time UI rendering
// of subagent's reasoning, content, and tool calls.
// ---------------------------------------------------------------------------

function handleSubagentStepNotification(
  conversationId: string,
  event: SubagentStepNotification
): void {
  const { agentId, parentToolCallId, step } = event

  useConversationRuntimeStore.setState((state) => {
    // Get or create draft state for this subagent
    let draft = state.subagentDrafts.get(agentId)
    if (!draft) {
      draft = createEmptyDraftAssistant()
      state.subagentDrafts.set(agentId, draft)
    }

    // Apply the step event directly to the draft state.
    // Note: Unlike the main agent (which batches deltas via StreamingQueue for
    // RAF-throttled updates), subagent steps are applied directly here.
    // Subagent streaming frequency is lower and the DraftAssistantState reducer
    // is cheap enough. If profiling shows store thrashing, a StreamingQueue can
    // be added via streaming-queue-registry keyed by agentId.
    applyDraftAssistantEvent({ draftAssistant: draft }, step)
  })

  // Also bridge the agentId into the parent spawn_subagent / batch_spawn step's
  // subagentEvents. Task notifications are the primary source of these entries,
  // but they can be delayed or missed — seeding from step notifications
  // guarantees that commitDraftToMessages (cancel path) can always recover
  // the agentId(s) to embed into the synthetic [Interrupted] result.
  const subagentEvent = {
    agentId,
    status: 'running',
    summary: '',
    timestamp: event.timestamp,
  }
  useConversationStoreSQLite.setState((state) => {
    const c = state.conversations.find((x: Conversation) => x.id === conversationId)
    if (!c || !c.draftAssistant) return
    const targetStep = findSpawnStepInDraft(c.draftAssistant, parentToolCallId)
    if (!targetStep) return
    if (!targetStep.subagentEvents) targetStep.subagentEvents = []
    // Avoid duplicating the same agentId entry from step notifications
    if (!targetStep.subagentEvents.some((e) => e.agentId === agentId)) {
      targetStep.subagentEvents.push(subagentEvent)
    }
  })
  useConversationRuntimeStore.setState((state) => {
    const r = state.runtimes.get(conversationId)
    if (!r || !r.draftAssistant) return
    const targetStep = findSpawnStepInDraft(r.draftAssistant, parentToolCallId)
    if (!targetStep) return
    if (!targetStep.subagentEvents) targetStep.subagentEvents = []
    if (!targetStep.subagentEvents.some((e) => e.agentId === agentId)) {
      targetStep.subagentEvents.push(subagentEvent)
    }
  })
}


// Enable Immer Map/Set support
enableMapSet()

import { AgentLoop } from '@/agent/agent-loop'
import { createLLMProvider } from '@/agent/llm/provider-factory'
import { ContextManager } from '@/agent/context-manager'
import { getToolRegistry } from '@/agent/tool-registry'
import { getApiKeyRepository } from '@/sqlite'
import { LLM_PROVIDER_CONFIGS, isCustomProviderType, isPotentiallyDynamicProviderType, getProviderConfig, type LLMProviderType } from '@/agent/providers/types'
import { generateConversationTitle } from '@/agent/title-generator'
import { getMessageRepository, getSQLiteDB } from '@/sqlite'
import { useSettingsStore } from './settings.store'
import type { SubagentStepNotification } from '@/agent/tools/tool-types'
import { disposeSubagentRuntime, peekSubagentRuntime } from '@/agent/subagent/runtime'

// Follow-up suggestions are enabled by default


//=============================================================================
import { deleteConversationFromDB, pendingConversationMetaPersists, persistConversationMeta, persistConversationKind, persistMessageReplace, persistNewMessage, primePersistBaseline, waitForConversationMetaPersist, withInflightLoad, invalidatePersistBaseline, persistSchedulers } from '@/store/conversation-persist'
import {
  cancelScheduledEviction,
  configureConversationEviction,
  scheduleConversationEviction,
} from '@/store/conversation-eviction'
import {
  bumpActiveSelectionGeneration,
  bumpTranscriptVersion,
  claimTranscriptRead,
  forgetTranscriptState,
  getActiveSelectionGeneration,
  getTranscriptVersion,
  markPersistedFailureResolved,
  INITIAL_LOAD_TIMEOUT_MS,
  isCurrentTranscriptRead,
  persistLoadErrorRecord,
  retryLoadedFailure,
  runLoadFromDB,
  withTimeout,
} from '@/store/conversation-load'
export { getTranscriptVersionEntryForTests, resetConversationRetryStateForTests } from '@/store/conversation-load'
import type { ConversationLoadState } from '@/store/conversation-load'


/**
 * Per-conversation serialization for kind transitions (setConversationKind).
 * Overlapping transitions of the SAME conversation must persist in call
 * order: an earlier write failing after a later one already persisted would
 * otherwise roll the in-memory kind back to a value SQLite never stored —
 * UI and reload would disagree. Different conversations chain independently.
 */
const kindTransitionChains = new Map<string, Promise<boolean>>()

/**
 * One optimistic-update + persist + rollback-on-failure kind transition.
 * Runs INSIDE the per-conversation chain, so no two transitions of the same
 * conversation interleave their bookkeeping.
 */
async function applyConversationKind(id: string, kind: 'direct' | 'project'): Promise<boolean> {
  const store = useConversationStoreSQLite
  const previousKind = store.getState().conversations.find((c) => c.id === id)?.kind
  store.setState((state) => {
    const conv = state.conversations.find((c) => c.id === id)
    if (conv) {
      conv.kind = kind
    }
  })
  const conv = store.getState().conversations.find((c) => c.id === id)
  if (!conv) return false
  try {
    // Kind changes go through the dedicated transition write so a generic
    // meta save racing this change cannot carry a stale kind into SQLite.
    await persistConversationKind(id, kind)
  } catch (error) {
    console.error(
      '[conversation.store] Failed to persist conversation kind on setConversationKind:',
      error
    )
    // Roll the in-memory kind back ONLY if it still reflects THIS call's
    // optimistic update: with transitions serialized, the only way the kind
    // moved on is a generic path outside this chain — blindly restoring
    // previousKind would clobber that newer committed value.
    store.setState((state) => {
      const stale = state.conversations.find((c) => c.id === id)
      if (stale && stale.kind === kind) {
        stale.kind = previousKind
      }
    })
    toast.error(i18nText('conversation.toast.kindSaveFailed', '对话类型修改保存失败'))
    // Explicit failure: callers must not treat a rolled-back kind as
    // persisted (the error is already surfaced here, so callers only
    // branch on the result — they do not re-toast).
    return false
  }
  return true
}
import {
  runAgentImpl,
  type ConversationAgentRunInternals,
} from './conversation-agent-run'


//=============================================================================
// Store Definition
//=============================================================================

interface ConversationState extends ConversationLoadState {

  // Live AgentLoop instances live in `@/store/agent-loop-registry` rather
  // than in this state. They are service objects with private fields that
  // cannot be immer-drafted (see registry file for the full rationale).

  // Live StreamingQueue pairs live in `@/store/streaming-queue-registry` for
  // the same reason — they are RAF-batched writers, not serializable state.

  // Follow-up suggestions (not persisted) - per conversation
  suggestedFollowUps: Map<string, string>

  // Track run IDs that were cancelled by user (not persisted)
  // Used to suppress follow-up generation for cancelled runs
  cancelledRunIds: Set<string>

  // Track mounted view ref counts per conversation (not persisted)
  // Used to prevent StrictMode mount/unmount churn from cancelling active runs
  mountedConversations: Map<string, number>

  // Computed
  activeConversation: () => Conversation | null

  // Status helpers
  getConversationStatus: (id: string) => ConversationStatus
  isConversationRunning: (id: string) => boolean
  getRunningConversations: () => string[]

  // Actions
  loadFromDB: () => Promise<void>
  /** Force a brand-new loadFromDB run even while a previous one is still
   * pending (in-flight guard bypassed). Used by the sidebar's Retry button:
   * a load wedged past the retry timeout must not make Retry a no-op that
   * merely re-awaits the stuck promise (PR #149 round-4 review). */
  retryLoadFromDB: () => Promise<void>
  createNew: (title?: string, options?: { activate?: boolean; kind?: 'project' | 'direct' }) => Conversation
  setActive: (id: string | null) => Promise<void>
  addMessage: (conversationId: string, message: Message) => void
  updateMessages: (conversationId: string, messages: Message[]) => void
  invalidateCompressionBaseline: (conv: Conversation, timestamp: number) => void
  deleteUserMessage: (conversationId: string, userMessageId: string) => boolean
  deleteAgentLoop: (conversationId: string, userMessageId: string) => boolean
  regenerateUserMessage: (conversationId: string, userMessageId: string) => void
  editAndResendUserMessage: (
    conversationId: string,
    userMessageId: string,
    newContent: string
  ) => void
  deleteConversation: (id: string) => Promise<void>
  deleteConversations: (ids: string[]) => Promise<{
    successIds: string[]
    failed: Array<{ id: string; error: string }>
  }>
  updateTitle: (id: string, title: string) => void
  /**
   * One-way kind upgrade: 'direct' → 'project' after folder authorization.
   * No downgrade path by design (a mounted folder has no unmount→direct
   * Persisted via a dedicated kind write (NOT the generic
   * saveMeta path, whose snapshot of `kind` can race a concurrent transition);
   * resolves only after the write settles. Returns true when the kind is
   * durably persisted; false when the conversation is missing or the write
   * failed (the in-memory kind is rolled back before resolving false).
   */
  setConversationKind: (id: string, kind: 'project' | 'direct') => Promise<boolean>
  /**
   * User-facing conversion of a standalone chat into a project conversation.
   * Launches the folder-authorization flow (folder picker for the active
   * project, mirroring the workspace-mount entry); only on a successful
   * authorization is the conversation's kind upgraded via setConversationKind.
   * Resolves true when the conversion completed.
   */
  convertDirectToProject: (id: string) => Promise<boolean>
  /**
   * Generate a title for a conversation using the current model.
   *
   * @param id - conversation id
   * @param manual - true when triggered by user (right-click menu); the
   *   resulting title is treated as user-confirmed (titleMode='manual') and
   *   will not be overwritten by subsequent auto-generation. false when
   *   triggered automatically after an agent run; only overwrites titles that
   *   are still in 'auto' mode.
   * @returns A discriminated result so callers can show precise toasts.
   */
  generateTitle: (
    id: string,
    manual: boolean
  ) => Promise<
    | { ok: true; title: string; changed: boolean }
    | {
        ok: false
        reason:
          | 'conversation_missing'
          | 'title_is_manual'
          | 'no_provider'
          | 'no_model'
          | 'no_api_key'
          | 'model_returned_empty'
          | 'model_error'
      }
  >

  // Mount tracking actions
  mountConversation: (id: string) => void
  unmountConversation: (id: string) => void
  isConversationMounted: (id: string) => boolean

  // Agent runtime actions
  runAgent: (
    conversationId: string,
    providerType: LLMProviderType,
    modelName: string,
    maxTokens: number,
    directoryHandle: FileSystemDirectoryHandle | null,
    agentOverrideId?: string | null,
    options?: { background?: boolean; transient?: boolean }
  ) => Promise<void>
  cancelAgent: (conversationId: string) => void

  /** Compact conversation: generate context summary and stop (no agent loop). */
  compactConversation: (conversationId: string) => Promise<void>

  // Runtime state actions
  setConversationStatus: (id: string, status: ConversationStatus) => void
  appendStreamingContent: (id: string, delta: string) => void
  resetStreamingContent: (id: string) => void
  appendStreamingReasoning: (id: string, delta: string) => void
  resetStreamingReasoning: (id: string) => void
  setReasoningStreaming: (id: string, streaming: boolean) => void
  setCompletedReasoning: (id: string, reasoning: string) => void
  setContentStreaming: (id: string, streaming: boolean) => void
  setCompletedContent: (id: string, content: string) => void
  setCurrentToolCall: (id: string, tc: ToolCall | null) => void
  appendStreamingToolArgs: (id: string, delta: string) => void
  resetStreamingToolArgs: (id: string) => void
  setConversationError: (id: string, error: string | null) => void
  resetConversationState: (id: string) => void

  // Asset accumulation (not persisted — moved to assistant message on commit)
  collectAssets: (conversationId: string, assets: import('@/types/asset').AssetMeta[]) => void

  // Follow-up suggestion actions
  setSuggestedFollowUp: (conversationId: string, suggestion: string) => void
  clearSuggestedFollowUp: (conversationId: string) => void
  getSuggestedFollowUp: (conversationId: string) => string

  // Branch conversation (fork)
  branchConversation: (sourceConversationId: string, upToMessageId: string) => Promise<Conversation>

  // Emergency draft persistence (beforeunload)
  commitAndPersistRunningDrafts: () => void
}

// ---------------------------------------------------------------------------
// Write guard for metadata-only (never-loaded) conversations
// ---------------------------------------------------------------------------

/**
 * Deferred-write queues per conversation (serializes loads triggered by
 * concurrent guarded writes to the same conversation).
 */
const unloadedWriteQueues = new Map<string, Promise<void>>()

/**
 * Guard against the history-truncation hazard: a metadata-only conversation
 * (loaded from DB meta with `messages: []`, `messagesLoaded: false`) receives
 * a write whose snapshot was built from in-memory state — the widespread
 * `[...conv.messages, userMsg]` pattern (sendMessage, WebMCP app-tools, run
 * paths). Applied directly, that snapshot replaces the full history with a
 * fragment, and the incremental persist then DELETEs the missing rows from
 * the database.
 *
 * Instead: reload the DB history into memory first (prime the persist
 * baseline), then run `apply` — callers re-derive their write against the now
 * complete state (updateMessages merges via reconcileMessageSnapshot, which
 * appends fragments and only replaces on a genuinely covering snapshot). If
 * the reload fails, the write is skipped: dropping one write is recoverable,
 * deleting history is not.
 */
function writeWithMessagesLoaded(conversationId: string, apply: () => void): void {
  const chained = (unloadedWriteQueues.get(conversationId) ?? Promise.resolve())
    .then(async () => {
      const conv = useConversationStoreSQLite
        .getState()
        .conversations.find((c) => c.id === conversationId)
      if (!conv || conv.messagesLoaded !== false) {
        // Already loaded (or a pre-flag/runtime-created object) — safe to apply.
        apply()
        return
      }
      let loaded: Message[]
      try {
        loaded = (await getMessageRepository().findByConversation(conversationId)) as Message[]
      } catch (error) {
        console.error(
          '[conversation.store] Reload-before-write failed; skipping write to protect DB history:',
          conversationId,
          error
        )
        return
      }
      primePersistBaseline(conversationId, loaded)
      let installedSnapshot = false
      useConversationStoreSQLite.setState((state) => {
        const c = state.conversations.find((x) => x.id === conversationId)
        if (c && c.messagesLoaded === false) {
          c.messages = loaded
          c.messagesLoaded = true
          healCompressionBaseline(c)
          installedSnapshot = true
        }
      })
      // Installing the reloaded snapshot into memory is a transcript
      // mutation: a transcript read that is pending right now must not
      // install its own (older) snapshot over it nor prime that snapshot as
      // the persistence baseline (PR #152 review, "Recent transcript changes
      // disappear").
      if (installedSnapshot) bumpTranscriptVersion(conversationId)
      apply()
      // The write target was metadata-only, i.e. not open in any view. If no
      // run keeps it alive it becomes an eviction candidate right away.
      scheduleConversationEviction(conversationId)
    })
    .catch((error) => {
      console.error('[conversation.store] Deferred write failed:', conversationId, error)
    })
  unloadedWriteQueues.set(conversationId, chained)
  void chained.finally(() => {
    if (unloadedWriteQueues.get(conversationId) === chained) {
      unloadedWriteQueues.delete(conversationId)
    }
  })
}

/**
 * Await deferred reload-before-append operations before starting an offscreen
 * run. A background MCP task continuation must not append to a conversation
 * whose history is still being reloaded, otherwise the continuation snapshot
 * races the load and can drop the reloaded messages.
 */
export async function waitForConversationWrites(conversationId: string): Promise<void> {
  while (unloadedWriteQueues.has(conversationId)) await unloadedWriteQueues.get(conversationId)
}

export const useConversationStoreSQLite = create<ConversationState>()(
  immer((set, get) => ({
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

    activeConversation: () => {
      const { conversations, activeConversationId } = get()
      if (!activeConversationId) return null
      return conversations.find((c) => c.id === activeConversationId) || null
    },

    getConversationStatus: (id: string) => {
      const { conversations } = get()
      const conv = conversations.find((c) => c.id === id)
      return conv?.status || 'idle'
    },

    isConversationRunning: (id: string) => {
      const status = get().getConversationStatus(id)
      return status !== 'idle' && status !== 'error'
    },

    getRunningConversations: () => {
      const { conversations } = get()
      return conversations
        .filter((c) => c.status !== 'idle' && c.status !== 'error')
        .map((c) => c.id)
    },

    // Mount tracking actions
    mountConversation: (id: string) => {
      set((state) => {
        const next = (state.mountedConversations.get(id) || 0) + 1
        state.mountedConversations.set(id, next)
        const conv = state.conversations.find((c) => c.id === id)
        if (conv) {
          conv.mountRefCount = next
        }
      })
    },

    unmountConversation: (id: string) => {
      set((state) => {
        const current = state.mountedConversations.get(id) || 0
        const next = Math.max(0, current - 1)
        if (next === 0) {
          state.mountedConversations.delete(id)
        } else {
          state.mountedConversations.set(id, next)
        }
        const conv = state.conversations.find((c) => c.id === id)
        if (conv) {
          conv.mountRefCount = next
        }
      })
    },

    isConversationMounted: (id: string) => {
      return (get().mountedConversations.get(id) || 0) > 0
    },

    loadFromDB: async () =>
      withInflightLoad(() => runLoadFromDB(set, get)),

    // Loaded transcript and workspace failures retry only the failed target,
    // preserving other conversations' cached messages and running state.
    // Explicit user retry bypasses the in-flight guard so a load wedged past
    // the sidebar's 15s retry timeout starts a FRESH run instead of handing
    // back the stuck promise (PR #149 round-4 review, "Retry cannot restart
    // stuck load"). The old run keeps running in the background. Generation
    // checks discard its late results, and withInflightLoad's ownership check
    // leaves the new run's guard slot alone when the old run settles.
    retryLoadFromDB: async () => {
      if (get().loaded &&
          (get().loadErrorScope === 'transcript' || get().loadErrorScope === 'workspace')) {
        // Targeted retry: with a workspace-scoped failure visible, the retry
        // path runs ensureActiveWorkspace itself, so a success here is the
        // workspace recovery a workspace-scoped diagnostics record requires
        // before it may be marked resolved (PR #152 review). This is also why
        // a transcript-scoped failure must NOT fall through to the full load
        // below: the full load would run the workspace ensure and resolve a
        // record the transcript retry alone never justified.
        return withInflightLoad(() => retryLoadedFailure(set, get), { force: true })
      }
      // A load timeout only rejects this store's await. The SQLite manager
      // can still hold the same pending initPromise, so restart that worker
      // once it has exceeded the load deadline before starting a fresh run.
      getSQLiteDB().restartPendingInitialization(INITIAL_LOAD_TIMEOUT_MS)
      return withInflightLoad(() => runLoadFromDB(set, get), { force: true })
    },

    createNew: (title?: string, options?: { activate?: boolean; kind?: 'project' | 'direct' }) => {
      const conversation = createConversation(title, { kind: options?.kind })
      // `activate: false` lets background creators (WebMCP app-tools) add a
      // conversation without yanking the user's current view (m-2).
      const activate = options?.activate !== false
      set((state) => {
        state.conversations.unshift(conversation)
        if (activate) {
          // Activation changes the active conversation just like setActive —
          // advance the selection generation so an in-flight (fallback) load
          // cannot later reinstall ITS captured selection over the user's
          // brand-new conversation (issue #147 PR #152 review).
          bumpActiveSelectionGeneration()
          state.activeConversationId = conversation.id
        }
      })
      // Persist metadata (creates the conversation row) + empty messages
      const metaPersist = persistConversationMeta(conversation)
        .catch((error) => {
          console.error('[conversation.store] Failed to persist new conversation:', error)
          i18nText('conversation.toast.saveFailed', '对话保存失败，刷新页面后可能丢失')
          throw error
        })
        .finally(() => {
          if (pendingConversationMetaPersists.get(conversation.id) === metaPersist) {
            pendingConversationMetaPersists.delete(conversation.id)
          }
        })
      pendingConversationMetaPersists.set(conversation.id, metaPersist)
      void metaPersist.catch(() => {})

      // NOTE: workspace switching for new conversations is handled by syncFromRoute
      // in App.tsx after the URL is updated via navigateToRoute.

      return conversation
    },

    setActive: async (id) => {
      const t0 = performance.now()
      const previousActiveId = get().activeConversationId
      const errorAtReadStart = get().loadError
      const errorScopeAtReadStart = get().loadErrorScope
      const selectionGeneration = bumpActiveSelectionGeneration()
      set((state) => {
        state.activeConversationId = id
      })

      if (id) {
        // Lazy-load messages if not already loaded (or if they were evicted)
        const conv = get().conversations.find((c) => c.id === id)
        // True only when a transcript READ actually happened and succeeded —
        // a cached selection skips the read entirely and proves nothing
        // (issue #147, PR #149 review).
        let transcriptReadOk = false
        // The failure id observed when this selection started (null when
        // nothing was failing). Overlapping reads are reconciled against
        // THIS snapshot below (PR #149 round-4 review): a successful read of
        // conversation B must not resolve or clear a failure that belongs to
        // conversation A while A's own read is still pending.
        const failureOwnerAtReadStart = get().loadFailedConversationId
        if (conv && (conv.messages.length === 0 || conv.messagesLoaded === false)) {
          const transcriptGeneration = claimTranscriptRead(id)
          // Mutation watermark captured BEFORE the read (same rule as the
          // targeted retry and the primary/fallback installs): a transcript
          // mutated in memory while this read was pending must not be
          // replaced by the older DB snapshot
          // (PR #152 review, "Recent transcript changes disappear").
          const transcriptVersionAtReadStart = getTranscriptVersion(id) ?? 0
          try {
            const msgRepo = getMessageRepository()
            const tFetch = performance.now()
            const messages = await withTimeout(
              msgRepo.findByConversation(id),
              INITIAL_LOAD_TIMEOUT_MS,
              'conversation transcript read'
            )
            if (!isCurrentTranscriptRead(id, transcriptGeneration)) return
            // A transcript read never exercises the OPFS workspace layer, so
            // it must not resolve a workspace-scoped record even when the ids
            // coincide (PR #152 review, "Workspace failure reported as
            // recovered") — only a path where ensureActiveWorkspace ran and
            // succeeded may.
            markPersistedFailureResolved(id, {
              requireNamedConversation: true,
              requireWorkspaceEnsure: true,
            })
            if (selectionGeneration !== getActiveSelectionGeneration() || get().activeConversationId !== id) return
            // Stale-snapshot guard: the transcript may have been mutated in
            // memory while the read was pending (e.g. a queued message landed
            // through writeWithMessagesLoaded). Installing the older snapshot
            // would make those changes disappear, and priming it as the
            // persist baseline could lose them from storage
            // (PR #152 review, "Recent transcript changes disappear").
            // Same shape as the targeted-retry / primary / fallback guards:
            // a still-metadata-only conversation has no in-memory transcript
            // to lose, so its install stays unconditional.
            const conversationBeforeInstall = get().conversations.find((c) => c.id === id)
            const transcriptChangedDuringRead =
              conversationBeforeInstall !== undefined &&
              conversationBeforeInstall.messagesLoaded !== false &&
              (getTranscriptVersion(id) ?? 0) !== transcriptVersionAtReadStart
            const tDeserialize = performance.now()
            if (!transcriptChangedDuringRead) {
              primePersistBaseline(id, messages as Message[])
              set((state) => {
                const c = state.conversations.find((c) => c.id === id)
                if (c && (c.messages.length === 0 || c.messagesLoaded === false)) {
                  c.messages = messages as Message[]
                  c.messagesLoaded = true
                  // Auto-heal: restore compression baseline from context_summary messages
                  // for conversations created before the persistence fix.
                  healCompressionBaseline(c)
                }
              })
            }
            console.log(
              `[conversation.store] setActive(${id?.slice(0, 8)}) message load (${Math.round(performance.now() - t0)}ms)`,
              {
                fetchMs: Math.round(tDeserialize - tFetch),
                messageCount: messages.length,
                immutifyMs: Math.round(performance.now() - tDeserialize),
              }
            )
            transcriptReadOk = true
          } catch (error) {
            if (!isCurrentTranscriptRead(id, transcriptGeneration) ||
                selectionGeneration !== getActiveSelectionGeneration() || get().activeConversationId !== id) return
            console.error('[conversation.store] Failed to load messages for conversation:', error)
            // The lazy path failed for the newly selected conversation — surface
            // it like any other transcript failure so the sidebar can offer a
            // Retry (issue #147, PR #149 review).
            const activeLoadMessage =
              error instanceof Error
                ? `Failed to load messages for active conversation: ${error.message}`
                : 'Failed to load messages for active conversation'
            transcriptReadOk = false
            set((state) => {
              state.loadError = activeLoadMessage
              state.loadErrorScope = 'transcript'
              // Remember WHICH conversation failed (issue #147, PR #149 review).
              state.loadFailedConversationId = id
              state.loadFailedWorkspaceId = null
            })
            // A lazy transcript failure is a real load failure — persist it
            // for Diagnostics like the initial-load catch does, or a bug
            // report carries no trace of it (issue #147, PR #149 review).
            persistLoadErrorRecord(activeLoadMessage, error, id)
          }
        } else {
          console.log(
            `[conversation.store] setActive(${id?.slice(0, 8)}) cached (${Math.round(performance.now() - t0)}ms)`,
            { alreadyLoaded: conv ? conv.messages.length : -1 }
          )
        }
        // A transcript-scoped error belongs to the conversation that failed.
        // Once the user switches to another conversation and its transcript
        // READ actually succeeds, the stale error must go — otherwise the
        // sidebar keeps showing a failure banner for a conversation the user
        // left (issue #147, PR #149 review). A cached selection never reads,
        // so it neither clears the banner nor counts as recovery.
        //
        // A successful read clears the visible error only if it is still
        // current. Another conversation's successful read can dismiss a stale
        // banner, while the persisted failure stays unresolved until its own
        // transcript is read successfully.
        if (transcriptReadOk) {
          if (
            get().loadErrorScope === 'transcript' &&
            (get().loadFailedConversationId === id ||
              (errorScopeAtReadStart === 'transcript' && get().loadError === errorAtReadStart &&
                get().loadFailedConversationId === failureOwnerAtReadStart))
          ) {
            // The failure on record is the SAME one this selection observed
            // at start — no newer failure was recorded meanwhile. Clear the
            // stale banner; resolution of the persisted record is checked
            // separately against the conversation ID below.
            set((state) => {
              state.loadError = null
              state.loadErrorScope = null
              state.loadFailedConversationId = null
              state.loadFailedWorkspaceId = null
            })
          } else if (
            get().loadErrorScope === 'workspace' &&
            errorScopeAtReadStart === 'workspace' &&
            get().loadError === errorAtReadStart &&
            previousActiveId !== id
          ) {
            set((state) => {
              state.loadError = null
              state.loadErrorScope = null
              state.loadFailedConversationId = null
              state.loadFailedWorkspaceId = null
            })
          }
          // The persisted failure may outlive the visible banner after the
          // user switches away. This successful read verifies recovery only
          // if the record names this same conversation.
        }
        // NOTE: workspace switching is handled by syncFromRoute in App.tsx.
        // This store only manages conversation data; it does NOT call switchWorkspace.
      }
    },

    addMessage: (conversationId, message) => {
      // Metadata-only conversation: pushing onto `messages: []` would corrupt
      // seq order and title logic — reload history first, then append.
      const conv0 = get().conversations.find((c) => c.id === conversationId)
      if (conv0 && conv0.messagesLoaded === false) {
        writeWithMessagesLoaded(conversationId, () => {
          get().addMessage(conversationId, message)
        })
        return
      }
      set((state) => {
        const conv = state.conversations.find((c) => c.id === conversationId)
        if (conv) {
          conv.messages.push(message)
          conv.updatedAt = Date.now()
          bumpTranscriptVersion(conversationId)

          // A user message marks the start of a new loop: bump the
          // conversation's sort position (lastAccessedAt) now — NOT on click.
          if (isHumanUserMessage(message)) {
            const wsState = useConversationContextStore.getState()
            const ws = wsState.workspaces.find((w) => w.id === conversationId)
            if (ws) {
              wsState.touchWorkspaceAccessTime(conversationId)
            }
          }

          if (isHumanUserMessage(message) && conv.titleMode !== 'manual' && message.content) {
            const userMessages = conv.messages.filter((m) => isHumanUserMessage(m))
            if (userMessages.length === 1) {
              const newTitle = truncateTitle(message.content)
              conv.title = newTitle
              conv.titleMode = 'auto'
            }
          }
        }
      })
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (conv) {
        // Persist the new message
        const seq = conv.messages.indexOf(message)
        persistNewMessage(conversationId, message, seq).catch((error) => {
          console.error('[conversation.store] Failed to persist conversation on addMessage:', error)
          i18nText('conversation.toast.messageSaveFailed', '消息保存失败')
        })
        // If title was auto-generated, also persist metadata
        if (conv.titleMode === 'auto' && isHumanUserMessage(message)) {
          persistConversationMeta(conv).catch(() => {})
        }
      }
    },

    updateMessages: (conversationId, messages) => {
      // The caller built `messages` from in-memory state; for a metadata-only
      // conversation that snapshot is a fragment ([userMsg]), and applying it
      // directly truncates history — the incremental persist then deletes the
      // missing DB rows. Reload first, then merge strictly additively (a
      // snapshot built from empty memory can never be a legitimate
      // replacement of a longer history).
      const conv0 = get().conversations.find((c) => c.id === conversationId)
      if (conv0 && conv0.messagesLoaded === false) {
        writeWithMessagesLoaded(conversationId, () => {
          const current =
            useConversationStoreSQLite
              .getState()
              .conversations.find((c) => c.id === conversationId)?.messages ?? []
          get().updateMessages(conversationId, mergeUnloadedWriteSnapshot(current, messages))
        })
        return
      }
      set((state) => {
        const conv = state.conversations.find((c) => c.id === conversationId)
        if (conv) {
          const prevUserMessageCount = conv.messages.filter((m) => isHumanUserMessage(m)).length

          conv.messages = messages
          conv.updatedAt = Date.now()
          bumpTranscriptVersion(conversationId)

          const currentUserMessageCount = messages.filter((m) => isHumanUserMessage(m)).length

          // A new user message marks the start of a new loop: bump the
          // conversation's sort position (lastAccessedAt) now — NOT on click.
          if (
            currentUserMessageCount > prevUserMessageCount &&
            messages.some((m) => isHumanUserMessage(m))
          ) {
            const wsState = useConversationContextStore.getState()
            if (wsState.workspaces.some((w) => w.id === conversationId)) {
              wsState.touchWorkspaceAccessTime(conversationId)
            }
          }

          if (
            currentUserMessageCount === 1 &&
            prevUserMessageCount === 0 &&
            conv.titleMode !== 'manual'
          ) {
            const firstUserMessage = messages.find((m) => isHumanUserMessage(m))
            if (firstUserMessage?.content) {
              const newTitle = truncateTitle(firstUserMessage.content)
              conv.title = newTitle
              conv.titleMode = 'auto'
            }
          }
        }
      })
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (conv) {
        persistMessageReplace(conversationId, conv.messages).catch((error) => {
          console.error(
            '[conversation.store] Failed to persist conversation on updateMessages:',
            error
          )
          i18nText('conversation.toast.messageUpdateFailed', '消息更新保存失败')
        })
        // If title was auto-updated, persist metadata too
        if (conv.titleMode === 'auto') {
          persistConversationMeta(conv).catch(() => {})
        }
      }
    },

    /** Invalidate compression baseline if a message at `timestamp` falls within the compressed range. */
    invalidateCompressionBaseline: (conv, timestamp) => {
      if (
        conv.compressedContextSummary &&
        conv.compressedContextCutoffTimestamp != null &&
        timestamp < conv.compressedContextCutoffTimestamp
      ) {
        conv.compressedContextSummary = null
        conv.compressedContextCutoffTimestamp = null
        conv.messages = conv.messages.filter((m) => m.kind !== 'context_summary')
        bumpTranscriptVersion(conv.id)
      }
    },

    deleteUserMessage: (conversationId, userMessageId) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        i18nText('conversation.toast.stopBeforeDeleteMessage', '请先停止当前运行，再删除消息')
        return false
      }

      let deleted = false
      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return
        const idx = conv.messages.findIndex((m) => m.id === userMessageId)
        if (idx < 0 || !isConversationUserMessage(conv.messages[idx])) return
        const msgTimestamp = conv.messages[idx].timestamp
        conv.messages.splice(idx, 1)
        // Invalidate compression summary if the deleted message was within the compressed range
        get().invalidateCompressionBaseline(conv, msgTimestamp)
        conv.updatedAt = Date.now()
        bumpTranscriptVersion(conversationId)
        updateAutoTitleAfterMessageDelete(conv)
        deleted = true
      })

      if (!deleted) return false
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (conv) {
        persistMessageReplace(conversationId, conv.messages).catch((error) => {
          console.error(
            '[conversation.store] Failed to persist conversation on deleteUserMessage:',
            error
          )
          i18nText('conversation.toast.messageDeleteFailed', '删除消息失败')
        })
      }
      return true
    },

    deleteAgentLoop: (conversationId, userMessageId) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        i18nText('conversation.toast.stopBeforeDeleteTurn', '请先停止当前运行，再删除对话轮次')
        return false
      }

      let deleted = false
      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return
        const startIdx = conv.messages.findIndex((m) => m.id === userMessageId)
        if (startIdx < 0 || !isConversationUserMessage(conv.messages[startIdx])) return

        const loopStartTimestamp = conv.messages[startIdx].timestamp

        const idsToDelete = new Set<string>()
        idsToDelete.add(conv.messages[startIdx].id)
        for (let i = startIdx + 1; i < conv.messages.length; i++) {
          const msg = conv.messages[i]
          if (isConversationUserMessage(msg)) break
          idsToDelete.add(msg.id)
        }

        conv.messages = conv.messages.filter((msg) => !idsToDelete.has(msg.id))
        // Invalidate compression summary if the deleted loop was within the compressed range
        get().invalidateCompressionBaseline(conv, loopStartTimestamp)
        conv.updatedAt = Date.now()
        bumpTranscriptVersion(conversationId)
        updateAutoTitleAfterMessageDelete(conv)
        deleted = true
      })

      if (!deleted) return false
      const conv = get().conversations.find((c) => c.id === conversationId)
      if (conv) {
        persistMessageReplace(conversationId, conv.messages).catch((error) => {
          console.error(
            '[conversation.store] Failed to persist conversation on deleteAgentLoop:',
            error
          )
          i18nText('conversation.toast.turnDeleteFailed', '删除对话轮次失败')
        })
      }
      return true
    },

    regenerateUserMessage: (conversationId, userMessageId) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        toast.error(i18nText('conversation.toast.stopBeforeRegenerate', '请先停止当前运行，再重新生成'))
        return
      }

      // ── Unregistered dynamic provider guard (#87, Sourcery round 3) ──
      // Direct callers bypass the component-level guards in
      // useConversationLogic. The deletion below mutates and persists the
      // conversation BEFORE runAgent would reject dispatch — check the live
      // registry here so a rejected provider never deletes history.
      const preSettings = useSettingsStore.getState()
      if (
        preSettings.providerType &&
        isPotentiallyDynamicProviderType(preSettings.providerType) &&
        !getProviderConfig(preSettings.providerType)
      ) {
        toast.error(i18nText('conversation.toast.providerReauthRequired', '所选服务商当前不可用，请重新登录后使用'))
        return
      }

      const conv = state.conversations.find((c) => c.id === conversationId)
      if (!conv) {
        toast.error(i18nText('conversation.toast.conversationMissingForRegenerate', '会话不存在，无法重新生成'))
        return
      }

      const userMsgIndex = conv.messages.findIndex((m) => m.id === userMessageId)
      if (userMsgIndex < 0) {
        toast.error(i18nText('conversation.toast.targetMessageMissing', '目标消息不存在，可能已被删除'))
        return
      }
      if (!isConversationUserMessage(conv.messages[userMsgIndex])) {
        toast.error(i18nText('conversation.toast.onlyUserMessageRegenerate', '只能重新生成用户消息'))
        return
      }

      const userMsgTimestamp = conv.messages[userMsgIndex].timestamp

      // Find and delete all subsequent messages in the same turn (until the next user message)
      const idsToDelete = new Set<string>()
      for (let i = userMsgIndex + 1; i < conv.messages.length; i++) {
        const msg = conv.messages[i]
        if (isConversationUserMessage(msg)) break
        idsToDelete.add(msg.id)
      }

      const originalContent = conv.messages[userMsgIndex]?.content?.trim()

      // For non-command messages, do the cleanup and run the standard agent
      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return

        if (idsToDelete.size > 0) {
          conv.messages = conv.messages.filter((m) => !idsToDelete.has(m.id))
        }
        get().invalidateCompressionBaseline(conv, userMsgTimestamp)
        conv.status = 'idle'
        conv.error = null
        conv.updatedAt = Date.now()
        bumpTranscriptVersion(conversationId)
      })

      // Persist the cleanup
      const finalConv = get().conversations.find((c) => c.id === conversationId)
      if (finalConv) {
        persistMessageReplace(conversationId, finalConv.messages).catch((error) => {
          console.error('[conversation.store] Failed to persist on regenerate:', error)
        })
      }

      if (originalContent === '/compact') {
        get().compactConversation(conversationId)
        return
      }

      // Get settings and run the standard agent flow
      const settingsState = useSettingsStore.getState()
      const provider = settingsState.providerType
      const effectiveConfig = settingsState.getEffectiveProviderConfig()
      const model = effectiveConfig?.modelName || settingsState.modelName

      if (provider && model) {
        get().runAgent(conversationId, provider, model, 8192, null)
      } else {
        toast.error(i18nText('conversation.toast.modelNotConfigured', '模型未配置，请先在设置中选择服务商和模型'))
      }
    },

    editAndResendUserMessage: (conversationId, userMessageId, newContent) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        toast.error(i18nText('conversation.toast.stopBeforeEditResend', '请先停止当前运行，再编辑发送'))
        return
      }

      // ── Unregistered dynamic provider guard (#87, Sourcery round 3) ──
      // Same rationale as regenerateUserMessage above: check the live
      // registry BEFORE mutating/persisting the edited message, because a
      // direct caller skips the component-level guard.
      const preSettings = useSettingsStore.getState()
      if (
        preSettings.providerType &&
        isPotentiallyDynamicProviderType(preSettings.providerType) &&
        !getProviderConfig(preSettings.providerType)
      ) {
        toast.error(i18nText('conversation.toast.providerReauthRequired', '所选服务商当前不可用，请重新登录后使用'))
        return
      }

      const conv = state.conversations.find((c) => c.id === conversationId)
      if (!conv) {
        toast.error(i18nText('conversation.toast.conversationMissingForEditResend', '会话不存在，无法编辑重发'))
        return
      }

      const userMsgIndex = conv.messages.findIndex((m) => m.id === userMessageId)
      if (userMsgIndex < 0) {
        toast.error(i18nText('conversation.toast.targetMessageMissing', '目标消息不存在，可能已被删除'))
        return
      }
      if (!isConversationUserMessage(conv.messages[userMsgIndex])) {
        toast.error(i18nText('conversation.toast.onlyUserMessageEditResend', '只能编辑并重发用户消息'))
        return
      }

      const userMsgTimestamp = conv.messages[userMsgIndex].timestamp

      // Find all subsequent messages in this user message's turn that need
      // clearing (up to the next user message)
      const idsToDelete = new Set<string>()
      for (let i = userMsgIndex + 1; i < conv.messages.length; i++) {
        const msg = conv.messages[i]
        if (isConversationUserMessage(msg)) break
        idsToDelete.add(msg.id)
      }

      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return

        // Update the user message content
        conv.messages[userMsgIndex] = {
          ...conv.messages[userMsgIndex],
          content: newContent,
          timestamp: Date.now(),
        }

        // Delete all non-user messages after this user message, before the
        // next user message
        if (idsToDelete.size > 0) {
          conv.messages = conv.messages.filter((m) => !idsToDelete.has(m.id))
        }

        // Invalidate compression summary if the edited message was within the compressed range
        get().invalidateCompressionBaseline(conv, userMsgTimestamp)

        // Reset streaming state
        conv.status = 'idle'
        conv.streamingContent = ''
        conv.streamingReasoning = ''
        conv.completedContent = null
        conv.completedReasoning = null
        conv.currentToolCall = null
        conv.activeToolCalls = []
        conv.error = null
        conv.updatedAt = Date.now()
        bumpTranscriptVersion(conversationId)
      })

      // Persist
      const updatedConv = get().conversations.find((c) => c.id === conversationId)
      if (updatedConv) {
        persistMessageReplace(conversationId, updatedConv.messages).catch((error) => {
          console.error('[conversation.store] Failed to persist on editAndResend:', error)
        })
      }

      // If the edited message is a slash command (e.g. /compact),
      // dispatch the corresponding handler instead of runAgent.
      if (newContent.trim() === '/compact') {
        get().compactConversation(conversationId)
        return
      }

      // Get settings and execute
      const settingsState = useSettingsStore.getState()
      const provider = settingsState.providerType
      const effectiveConfig = settingsState.getEffectiveProviderConfig()
      const model = effectiveConfig?.modelName || settingsState.modelName

      if (provider && model) {
        get().runAgent(conversationId, provider, model, 8192, null)
      } else {
        toast.error(i18nText('conversation.toast.modelNotConfigured', '模型未配置，请先在设置中选择服务商和模型'))
      }
    },

    branchConversation: async (sourceConversationId, upToMessageId) => {
      const sourceConv = get().conversations.find((c) => c.id === sourceConversationId)
      if (!sourceConv) {
        throw new Error('Source conversation not found')
      }

      // Ensure source messages are loaded. In-memory history can be empty (never
      // loaded) or a trimmed window (evicted turns), so a miss on the branch
      // point is not proof the row is gone — read the DB before failing.
      let sourceMessages = sourceConv.messages
      let branchIndex = sourceMessages.findIndex((msg) => msg.id === upToMessageId)
      if (branchIndex === -1) {
        const msgRepo = getMessageRepository()
        const dbMessages = (await msgRepo.findByConversation(sourceConversationId)) as Message[]
        if (dbMessages.length > 0) {
          sourceMessages = dbMessages
          branchIndex = sourceMessages.findIndex((msg) => msg.id === upToMessageId)
        }
      }

      if (sourceMessages.length === 0) {
        throw new Error('Cannot branch an empty conversation')
      }

      // Only include messages up to (and including) the branch point
      if (branchIndex === -1) {
        throw new Error('Branch point message not found in source conversation')
      }
      const messagesToCopy = sourceMessages.slice(0, branchIndex + 1)

      // Create a new conversation (new ID)
      // A branch keeps its source's kind: branching a standalone chat must not
      // mint a project conversation (it would surface in the projects sidebar
      // with no authorized folder, while the /chats route that spawned it
      // expects a folder-less chat).
      const branched = createConversation(undefined, { kind: sourceConv.kind })
      const sourceTitle = sourceConv.title || 'Chat'
      branched.title = `分支: ${sourceTitle}`
      branched.titleMode = 'auto'

      // Deep-copy messages with new IDs (to avoid primary key conflicts)
      const branchedMessages: Message[] = messagesToCopy.map((msg) => ({
        ...msg,
        id: generateId(),
      }))

      // Set messages on the new conversation
      branched.messages = branchedMessages

      // Add to state
      set((state) => {
        state.conversations.unshift(branched)
        // Activation changes the active conversation just like setActive /
        // createNew({activate}) — advance the selection generation so an
        // in-flight (primary or fallback) load cannot later reinstall ITS
        // captured selection over the user's brand-new branch
        // (PR #152 review, "Branch selection is replaced").
        bumpActiveSelectionGeneration()
        state.activeConversationId = branched.id
      })
      bumpTranscriptVersion(branched.id)

      // Persist conversation metadata. Errors are rethrown for the caller:
      // AssistantTurnBubble is the only caller and it owns the user-facing
      // message (i18n'd, one toast per failure). A second hardcoded-Chinese
      // toast here both duplicated it and broke the all-copy-lives-in-i18n rule.
      const metaPersist = persistConversationMeta(branched)
        .catch((error) => {
          console.error('[conversation.store] Failed to persist branched conversation:', error)
          throw error
        })
        .finally(() => {
          if (pendingConversationMetaPersists.get(branched.id) === metaPersist) {
            pendingConversationMetaPersists.delete(branched.id)
          }
        })
      pendingConversationMetaPersists.set(branched.id, metaPersist)

      // Persist messages to SQLite. messages.conversation_id has a FK onto
      // conversations(id) and foreign_keys is ON, so the conversations row must
      // exist first: the meta chain above is fire-and-forget, and inserting
      // before it lands fails the whole branch with
      // SQLITE_CONSTRAINT_FOREIGNKEY (same reason persistNewMessage waits).
      await waitForConversationMetaPersist(branched.id)
      const msgRepo = getMessageRepository()
      await msgRepo.insertBatch(branched.id, branchedMessages)

      // NOTE: workspace switching for branched conversations is handled by syncFromRoute
      // in App.tsx after the URL is updated via navigateToRoute.

      void metaPersist.catch(() => {})

      toast.success(i18nText('conversation.toast.branchCreated', 'Branched conversation created'))

      return branched
    },

    deleteConversation: async (id) => {
      const queues = getStreamingQueues(id)
      if (queues) {
        queues.reasoning.destroy()
        queues.content.destroy()
      }

      // Stop runtime work first to avoid continued writes while deleting persisted data.
      const agentLoop = deleteAgentLoop(id)
      if (agentLoop) {
        agentLoop.cancel()
      }
      deleteStreamingQueues(id)
      // A pending eviction check for a deleted conversation is pointless.
      cancelScheduledEviction(id)
      // Subagent runtime keyed by conversation id keeps every task (loops,
      // tool contexts, transcripts) alive until explicitly disposed — dispose
      // it here and drop the per-agent drafts it owned, plus the conversation's
      // runtime entry itself.
      const subagentAgentIds = disposeSubagentRuntime(id)
      useConversationRuntimeStore.setState((state) => {
        state.runtimes.delete(id)
        for (const agentId of subagentAgentIds) {
          state.subagentDrafts.delete(agentId)
        }
      })
      // Authorization grants/yolo are conversation-scoped (redesign §3.8):
      // once the conversation is deleted there is no re-opening path, so any
      // remembered "always allow" or yolo grant must die with it. Without
      // this, re-creating a conversation with a colliding id would inherit
      // stale approvals.
      try {
        useSessionAllowStore.getState().clearFor(id)
        useYoloModeStore.getState().setYolo(id, false)
      } catch (error) {
        console.warn('[conversation.store] Failed to clear conversation-scoped auth state:', error)
      }
      set((state) => {
        state.suggestedFollowUps.delete(id)
        // Clean up any cancelled run IDs for this conversation's active run
        const convToDelete = state.conversations.find((c) => c.id === id)
        if (convToDelete?.activeRunId) {
          state.cancelledRunIds.delete(convToDelete.activeRunId)
        }
        state.mountedConversations.delete(id)
      })

      const [convDeleteResult, workspaceDeleteResult] = await Promise.allSettled([
        deleteConversationFromDB(id),
        useConversationContextStore.getState().deleteWorkspace(id),
      ])

      // Workspace (OPFS files / SQLite workspace row) deletion failure is
      // non-fatal for the conversation itself. Once deleteConversationFromDB
      // resolves the conversation record is already gone from the DB, so we
      // must still clean up the in-memory state regardless — otherwise the UI
      // keeps showing a ghost conversation and "clear all" reports a spurious
      // failure. Orphan workspace directories are logged and can be GC'd later.
      if (workspaceDeleteResult.status === 'rejected') {
        console.error(
          '[conversation.store] Failed to delete workspace (non-fatal, orphan dir may remain):',
          workspaceDeleteResult.reason
        )
      }

      // Cascade: delete scheduled tasks bound to this conversation. Schedules
      // live in a global OPFS namespace (schedules/{id}.json), so they would
      // otherwise keep firing against a dead conversation. Best-effort — a
      // failed cascade leaves the schedule, which the runner's orphan check
      // (CONV_DELETED) disables on its next tick as a fallback.
      try {
        const { getSchedulesForWorkspace, deleteSchedule } = await import(
          '@/services/schedule-storage'
        )
        const bound = await getSchedulesForWorkspace(id)
        for (const schedule of bound) {
          await deleteSchedule(schedule.id)
        }
        if (bound.length > 0) {
          const { useScheduleStore } = await import('@/store/schedule.store')
          useScheduleStore.getState().refresh()
          console.log(`[conversation.store] Cascade-deleted ${bound.length} schedule(s) for deleted conversation ${id}`)
        }
      } catch (error) {
        console.warn('[conversation.store] Schedule cascade delete failed (non-fatal):', error)
      }

      // If the conversation record itself could not be deleted from the DB,
      // keep the in-memory state in sync with the DB and surface the error.
      if (convDeleteResult.status === 'rejected') {
        console.error(
          '[conversation.store] Failed to delete conversation from DB:',
          convDeleteResult.reason
        )
        throw new Error(
          `delete conversation failed: ${
            convDeleteResult.reason instanceof Error
              ? convDeleteResult.reason.message
              : String(convDeleteResult.reason)
          }`
        )
      }

      // Conversation record deleted — remove from memory and clear active id
      // so the UI switches to the Welcome screen when appropriate.
      set((state) => {
        state.conversations = state.conversations.filter((c) => c.id !== id)
        if (state.activeConversationId === id) {
          state.activeConversationId = null
        }
      })
      // The watermark map is module-level and lives for the page's lifetime:
      // drop this conversation's entry with the conversation itself, or a
      // long-lived session that creates/mutates/deletes many conversations
      // grows the map without bound
      // (PR #152 review, "Deleted conversations retain watermark entries").
      forgetTranscriptState(id)

      // The per-conversation Agent selection dies with the conversation —
      // otherwise it lingers in local storage forever and a new conversation
      // reusing the id would inherit it. Only AFTER the DB delete is confirmed:
      // clearing it earlier would erase the saved Agent for a conversation that
      // survived a failed deletion.
      try {
        useWorkspacePreferencesStore.getState().clearWorkspaceAgentId(id)
      } catch (error) {
        console.warn('[conversation.store] Failed to clear conversation-scoped auth state:', error)
      }
      const { useAssetStore } = await import('@/store/asset.store')
      useAssetStore.getState().discardDeferredAssets(id)
    },

    deleteConversations: async (ids) => {
      const uniqueIds = Array.from(new Set(ids.filter((id): id is string => !!id)))
      const successIds: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const id of uniqueIds) {
        try {
          await get().deleteConversation(id)
          successIds.push(id)
          // The per-conversation Agent selection must die with the
          // conversation on EVERY successful deletion path. The single
          // deleteConversation action already clears it; this redundant
          // clearing documents the bulk contract — a bulk delete is not
          // guaranteed to route through the single action (it may call the
          // repository directly), and a stale `agentIdByWorkspace` entry
          // would be inherited by a new conversation reusing the id.
          try {
            useWorkspacePreferencesStore.getState().clearWorkspaceAgentId(id)
          } catch (error) {
            console.warn('[conversation.store] Failed to clear conversation-scoped auth state:', error)
          }
        } catch (error) {
          failed.push({
            id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { successIds, failed }
    },

    updateTitle: (id, title) => {
      set((state) => {
        const conv = state.conversations.find((c) => c.id === id)
        if (conv) {
          conv.title = title
          conv.titleMode = 'manual'
          conv.updatedAt = Date.now()
        }
      })
      const conv = get().conversations.find((c) => c.id === id)
      if (conv)
        persistConversationMeta(conv).catch((error) => {
          console.error(
            '[conversation.store] Failed to persist conversation on updateTitle:',
            error
          )
          i18nText('conversation.toast.titleSaveFailed', '标题修改保存失败')
        })
    },

    setConversationKind: async (id, kind) => {
      // Serialize per-conversation kind transitions: two overlapping
      // transitions for the same conversation must persist in call order.
      // Out-of-order writes would interleave the rollback bookkeeping below
      // with a LATER transition's optimistic update — an earlier write
      // failing after a later one already persisted could then roll the
      // in-memory kind back to a value that no longer matches SQLite.
      // Different conversations remain independent (per-key chains).
      const predecessor = kindTransitionChains.get(id) ?? Promise.resolve()
      // Run the transition inside the chain: the map holds the FULL link
      // (prefix + apply step), so a concurrent caller queues behind the
      // whole transition — not just the swallowed predecessor prefix. The
      // entry is cleared once no newer caller has replaced it, so the map
      // cannot grow unboundedly on long-lived sessions.
      const section = predecessor
        .catch(() => {
          // A failed earlier transition must not skip this one: its failure
          // was already reported by ITS own call (boolean + toast).
        })
        .then(() => applyConversationKind(id, kind))
        .finally(() => {
          if (kindTransitionChains.get(id) === section) kindTransitionChains.delete(id)
        })
      kindTransitionChains.set(id, section)
      return section
    },

    convertDirectToProject: async (id) => {
      const conv = get().conversations.find((c) => c.id === id)
      if (!conv) {
        toast.error(i18nText('conversation.toast.conversationMissing', '对话不存在'))
        return false
      }
      // One-way upgrade: a project conversation needs no conversion.
      if (conv.kind !== 'direct') return true

      // Failures anywhere in the flow (dynamic-import chunk unavailable,
      // picker crash, persistence error) must surface to the user instead of
      // rejecting into a click handler that does not catch.
      try {
        // Folder-authorization flow: the conversation becomes a project
        // conversation, so its host project must have an authorized folder —
        // the same picker the workspace-mount entry uses. Dynamic import keeps
        // the folder-access store out of this module's initial graph.
        const { useFolderAccessStore } = await import('@/store/folder-access.store')
        const folderState = useFolderAccessStore.getState()
        const projectId = folderState.activeProjectId
        if (!projectId) {
          toast.error(i18nText('conversation.toast.convertNoProject', '没有可用的项目来承载此对话'))
          return false
        }

        // pickDirectory launches the native folder picker and persists the
        // granted handle; it resolves false on cancel / failure.
        const authorized = await folderState.pickDirectory(projectId)
        if (!authorized) return false

        // Consume the explicit result instead of re-inspecting store state:
        // setConversationKind reports persistence failure through its boolean
        // (after rolling the in-memory kind back), so a false here means the
        // conversion did not land and must not report success.
        const persisted = await get().setConversationKind(id, 'project')
        if (!persisted) {
          return false
        }
      } catch (error) {
        console.error(
          '[conversation.store] convertDirectToProject failed:',
          error
        )
        toast.error(i18nText('conversation.toast.convertFailed', '转换失败，请重试'))
        return false
      }
      toast.success(i18nText('conversation.toast.convertedToProject', '已转换为项目对话'))
      return true
    },

    generateTitle: async (id, manual) => {
      const conv = get().conversations.find((c) => c.id === id)
      if (!conv) return { ok: false, reason: 'conversation_missing' }

      // Auto mode must not overwrite a user-edited (manual) title.
      if (!manual && conv.titleMode === 'manual') {
        return { ok: false, reason: 'title_is_manual' }
      }

      const settingsState = useSettingsStore.getState()
      const providerType = settingsState.providerType
      if (!providerType) return { ok: false, reason: 'no_provider' }

      const effectiveConfig = settingsState.getEffectiveProviderConfig()
      const modelName = effectiveConfig?.modelName || settingsState.modelName
      if (!modelName) return { ok: false, reason: 'no_model' }

      const providerConfig = isCustomProviderType(providerType)
        ? effectiveConfig
        : {
            apiKeyProviderKey: providerType,
            baseUrl: LLM_PROVIDER_CONFIGS[providerType].baseURL,
            modelName: modelName || LLM_PROVIDER_CONFIGS[providerType].modelName,
          }
      if (!providerConfig?.baseUrl || !providerConfig.modelName) {
        return { ok: false, reason: 'no_model' }
      }

      const apiKeyRepo = getApiKeyRepository()
      // The gateway's credential is the shared session (#277).
      const { resolveDispatchApiKey } = await import('@/agent/providers/gateway-dispatch-key')
      const credential = await resolveDispatchApiKey(providerConfig.apiKeyProviderKey, () => apiKeyRepo.load(providerConfig.apiKeyProviderKey))
      const apiKey = credential.ok ? credential.apiKey : null
      // A gateway without a live session is NOT keyless: sending would reach the
      // endpoint with no Authorization header (#172 finding 4).
      const { isGatewayCredentialKey } = await import('@/agent/providers/gateway-credential-alias')
      if (!credential.ok && isGatewayCredentialKey(providerConfig.apiKeyProviderKey)) {
        return { ok: false, reason: 'no_api_key' }
      }
      // Custom providers may run keyless (e.g. Ollama) — an absent key only
      // blocks title generation for built-in providers.
      if (!apiKey && !isCustomProviderType(providerType)) {
        return { ok: false, reason: 'no_api_key' }
      }

      const title = await generateConversationTitle(
        conv.messages,
        conv.compressedContextSummary ?? null,
        {
          apiKey: apiKey || '',
          providerType,
          baseUrl: providerConfig.baseUrl,
          model: providerConfig.modelName,
          apiMode: isCustomProviderType(providerType)
            ? settingsState.customProviders.find((p) => p.id === providerType)?.apiMode ||
              'chat-completions'
            : undefined,
        }
      )
      if (!title) return { ok: false, reason: 'model_returned_empty' }

      // Re-check mode right before applying — a manual edit may have landed
      // while the generation request was in flight.
      const current = get().conversations.find((c) => c.id === id)
      if (!current) return { ok: false, reason: 'conversation_missing' }
      if (!manual && current.titleMode === 'manual') {
        return { ok: false, reason: 'title_is_manual' }
      }

      const changed = current.title !== title
      set((state) => {
        const c = state.conversations.find((x) => x.id === id)
        if (!c) return
        // Never overwrite a manual title with an auto one.
        if (!manual && c.titleMode === 'manual') return
        c.title = title
        c.titleMode = manual ? 'manual' : 'auto'
        c.updatedAt = Date.now()
      })
      const updated = get().conversations.find((c) => c.id === id)
      if (updated) {
        persistConversationMeta(updated).catch((error) => {
          if (process.env.NODE_ENV !== 'production') console.error('[conversation.store] Failed to persist generated title:', error)
        })
      }
      return { ok: true, title, changed }
    },

    // Agent runtime actions
    runAgent: async (
      conversationId: string,
      providerType: LLMProviderType,
      modelName: string,
      maxTokens: number,
      directoryHandle: FileSystemDirectoryHandle | null,
      agentOverrideId?: string | null,
      options?: { background?: boolean; transient?: boolean }
    ) =>
      runAgentImpl(
        {
          handleSubagentStepNotification,
          scheduleConversationEviction,
          bumpTranscriptVersion,
        } as unknown as ConversationAgentRunInternals,
        set,
        get,
        conversationId,
        providerType,
        modelName,
        maxTokens,
        directoryHandle,
        agentOverrideId,
        options
      ),

    cancelAgent: (conversationId: string) => {
      // Track the run being cancelled to suppress follow-up generation
      const convBeingCancelled = get().conversations.find((c) => c.id === conversationId)
      const runIdBeingCancelled = convBeingCancelled?.activeRunId

      // Clear any pending ask_user_question entries to unblock executor promises
      import('@/store/pending-question.store')
        .then(({ clearPendingQuestions }) => {
          clearPendingQuestions(conversationId)
        })
        .catch(() => {})

      // Aborting the parent must abort its subagents too. `stopAll` marks and
      // cancels every member synchronously, so this stays correct even though
      // the action itself is not awaited.
      void peekSubagentRuntime(conversationId)?.stopAll({ force: true }).catch(() => {})

      const agentLoop = getAgentLoop(conversationId)
      if (agentLoop) {
        agentLoop.cancel()
        const queues = getStreamingQueues(conversationId)
        if (queues) {
          queues.reasoning.flushNow()
          queues.content.flushNow()
          queues.reasoning.destroy()
          queues.content.destroy()
        }
        deleteStreamingQueues(conversationId)

        // Commit draft to conversation messages BEFORE aborting the agent loop.
        // This ensures the draft is in c.messages when finalizeRun runs.
        let committedPartial = false
        deleteAgentLoop(conversationId)
        set((state) => {
          const c = state.conversations.find((c) => c.id === conversationId)
          if (c) {
            // Sync draft from runtime store to main store before committing
            // (streaming updates write draftAssistant to runtime store only)
            const rtDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
            if (rtDraft && !c.draftAssistant) {
              c.draftAssistant = rtDraft
            }
            committedPartial = commitDraftToMessages(c)
            const repairedMessages = ensureToolCallResults(c.messages)
            if (repairedMessages !== c.messages) {
              c.messages = repairedMessages
              committedPartial = true
            }
            if (committedPartial) {
              c.updatedAt = Date.now()
              bumpTranscriptVersion(conversationId)
            }
            // Clean up streaming/draft UI state but let finalizeRun handle run lifecycle
            c.draftAssistant = null
            c.currentToolCall = null
            c.activeToolCalls = []
            c.streamingToolArgs = ''
            c.streamingToolArgsByCallId = {}
            c.streamingContent = ''
            c.streamingReasoning = ''
            c.isContentStreaming = false
            c.isReasoningStreaming = false
            // Mark run canceled immediately so UI exits running state
            // even if AgentLoop abort callbacks are delayed or suppressed.
            c.status = 'idle'
            c.error = null
            c.activeRunId = null
            // Bump epoch so late callbacks from the cancelled run are ignored.
            c.runEpoch = (c.runEpoch || 0) + 1
            // Mark this run as cancelled so finalizeRun skips follow-up generation
            if (runIdBeingCancelled) {
              state.cancelledRunIds.add(runIdBeingCancelled)
            }
          }
        })
        // Reset runtime store for cancelled conversation
        useConversationRuntimeStore.setState((state) => {
          const r = state.runtimes.get(conversationId)
          if (r) {
            r.status = 'idle'
            r.error = null
            r.activeRunId = null
            r.draftAssistant = null
            r.currentToolCall = null
            r.activeToolCalls = []
            r.streamingToolArgs = ''
            r.streamingToolArgsByCallId = {}
            r.streamingContent = ''
            r.streamingReasoning = ''
            r.isContentStreaming = false
            r.isReasoningStreaming = false
          }
        })
        if (committedPartial) {
          const conv = get().conversations.find((c) => c.id === conversationId)
          if (conv)
            persistMessageReplace(conversationId, conv.messages).catch((error) => {
              console.error(
                '[conversation.store] Failed to persist conversation on cancelAgent partial commit:',
                error
              )
              i18nText('conversation.toast.draftSaveFailed', '停止后保存草稿失败，部分内容可能丢失')
            })
        }
        // Cancelled → idle: eviction candidate (guards re-checked after delay).
        scheduleConversationEviction(conversationId)
        return
      }

    },

    // ── Compact conversation ──
    compactConversation: async (conversationId: string) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        toast.error(i18nText('conversation.toast.stopBeforeCompact', '请等待当前任务完成'))
        return
      }

      const conv = state.conversations.find((c) => c.id === conversationId)
      if (!conv) {
        toast.error(i18nText('conversation.toast.conversationMissing', '会话不存在'))
        return
      }

      // Nothing to compress if only user messages (or empty)
      const compressibleMessages = conv.messages.filter(
        (m) => m.kind !== 'context_summary' && m.role !== 'user',
      )
      if (compressibleMessages.length === 0) {
        toast.info(i18nText('conversation.toast.nothingToCompact', '没有可压缩的上下文'))
        return
      }

      // 1. Add "/compact" as a user message — reuse existing one if the last
      //    message is already "/compact" (e.g. regenerated via context menu).
      const { createUserMessage } = await import('@/agent/message-types')
      const lastMsg = conv.messages[conv.messages.length - 1]
      const lastIsCompact = lastMsg?.role === 'user' && lastMsg?.content?.trim() === '/compact'
      const compactUserMsg = lastIsCompact ? lastMsg : createUserMessage('/compact')
      const messagesBeforeCompact = lastIsCompact ? conv.messages : [...conv.messages, compactUserMsg]
      if (!lastIsCompact) {
        set((state) => {
          const c = state.conversations.find((c) => c.id === conversationId)
          if (c) {
            c.messages = messagesBeforeCompact
            c.updatedAt = Date.now()
            bumpTranscriptVersion(conversationId)
          }
        })
        persistMessageReplace(conversationId, messagesBeforeCompact).catch((err) => {
          console.error('[conversation.store] Failed to persist /compact user message:', err)
        })
      }

      // 2. Create provider / contextManager / toolRegistry (same as runAgent)
      const settingsState = useSettingsStore.getState()
      const { hasApiKey: hasKey, providerType: pType, modelName: mName } = settingsState
      const credentialKind = credentialRegistry.getState(pType).kind
      if (!hasKey && !isCredentialPending(pType)) {
        const message = pType === 'llm-gateway' && credentialKind === 'expired'
          ? i18nText('conversation.error.gatewayCredentialExpired', 'Nutstore AI login has expired. Please log in again.')
          : pType === 'llm-gateway' && credentialKind === 'missing'
            ? i18nText('conversation.error.gatewayCredentialMissing', 'Not logged in to Nutstore AI. Please log in first.')
            : i18nText('conversation.toast.noApiKey', '未配置 API Key')
        toast.error(message)
        return
      }

      const effectiveConfig = settingsState.getEffectiveProviderConfig()

      // Resolve provider config (same logic as runAgent — handles custom providers)
      const providerConfig =
        isCustomProviderType(pType)
          ? effectiveConfig
          : {
              apiKeyProviderKey: pType,
              baseUrl: LLM_PROVIDER_CONFIGS[pType]?.baseURL,
              modelName: mName || LLM_PROVIDER_CONFIGS[pType]?.modelName,
            }

      if (!providerConfig?.baseUrl || !providerConfig.modelName) {
        toast.error(i18nText('conversation.toast.noApiKey', '未配置 API Key'))
        return
      }

      const apiKeyRepo = getApiKeyRepository()
      const { resolveDispatchApiKey } = await import('@/agent/providers/gateway-dispatch-key')
      let credential: Awaited<ReturnType<typeof resolveDispatchApiKey>>
      try {
        credential = await resolveDispatchApiKey(providerConfig.apiKeyProviderKey, () => apiKeyRepo.load(providerConfig.apiKeyProviderKey))
      } catch {
        toast.error(i18nText('settings.toast.apiKeyLoadFailed', 'Failed to read saved API key. Please retry.'))
        return
      }
      const apiKey = credential.ok ? credential.apiKey : null
      if (!apiKey) {
        const message = !credential.ok && credential.kind === 'temporary'
          ? i18nText('conversation.error.gatewayCredentialTemporary', 'Nutstore AI is temporarily unavailable — please retry')
          : !credential.ok && pType === 'llm-gateway' && credential.kind === 'expired'
            ? i18nText('conversation.error.gatewayCredentialExpired', 'Nutstore AI login has expired. Please log in again.')
            : !credential.ok && pType === 'llm-gateway' && credential.kind === 'missing'
              ? i18nText('conversation.error.gatewayCredentialMissing', 'Not logged in to Nutstore AI. Please log in first.')
              : i18nText('conversation.toast.noApiKey', '未配置 API Key')
        toast.error(message)
        return
      }

      const provider = createLLMProvider({
        apiKey,
        providerType: pType,
        baseUrl: providerConfig.baseUrl,
        model: providerConfig.modelName,
        apiMode: isCustomProviderType(pType)
          ? settingsState.customProviders.find((p) => p.id === pType)?.apiMode || 'chat-completions'
          : undefined,
      })

      const maxTokens = settingsState.maxTokens || 4096
      const contextManager = new ContextManager({
        maxContextTokens: provider.maxContextTokens,
        reserveTokens: maxTokens,
        enableSummarization: true,
        maxMessageGroups: provider.maxContextTokens >= 200000 ? 80 : 50,
        compressionAbsoluteCapEnabled: settingsState.compressionAbsoluteCapEnabled,
        compressionAbsoluteCap: settingsState.compressionAbsoluteCap,
      })

      const toolRegistry = getToolRegistry()
      // FIX (parallel isolation): resolve handle from conversationId, not global state.
      let directoryHandle: FileSystemDirectoryHandle | null = null
      try {
        const { resolveWorkspaceDirectoryHandle } = await import('@/agent/tools/tool-utils')
        directoryHandle = await resolveWorkspaceDirectoryHandle(conversationId)
      } catch {
        // compression loop tolerates a null handle
      }

      // Direct conversations (kind='direct') have no folder authorization:
      // the compaction loop's ToolContext must carry directMode so the
      // registry guard rejects folder-dependent tools even on this secondary
      // loop. Derived via the single kind selector, same as runAgent.
      const directMode = isDirectConversation(conversationId)

      const agentLoop = new AgentLoop({
        provider,
        toolRegistry,
        contextManager,
        toolContext: {
          directoryHandle: directMode ? null : directoryHandle,
          workspaceId: conversationId,
          projectId: undefined,
          currentAgentId: 'default',
          agentMode: 'act',
          directMode: directMode || undefined,
        },
        maxIterations: 1,
        initialConvertCallCount: conv.compressionConvertCallCount ?? 0,
        initialLastSummaryConvertCall: conv.compressionLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY,
        initialCompressionBaseline:
          conv.compressedContextSummary && conv.compressedContextCutoffTimestamp
            ? { summary: conv.compressedContextSummary, cutoffTimestamp: conv.compressedContextCutoffTimestamp }
            : null,
        onCompressionStateUpdate: (compressionState) => {
          set((state) => {
            const c = state.conversations.find((x) => x.id === conversationId)
            if (!c) return
            c.compressionConvertCallCount = compressionState.convertCallCount
            c.compressionLastSummaryConvertCall = compressionState.lastSummaryConvertCall
          })
        },
        onLoopComplete: async () => {
          const { useConversationContextStore } = await import('@/store/conversation-context.store')
          await useConversationContextStore.getState().refreshPendingChanges()
        },
      })

      // 3. Acquire run lock (simplified version of runAgent)
      const runId = `${Date.now()}-compact-${Math.random().toString(36).slice(2, 10)}`
      let runEpoch = 0
      let committed = false

      useConversationRuntimeStore.setState((state) => {
        let rt = state.runtimes.get(conversationId)
        if (!rt) {
          rt = createEmptyRuntime()
          state.runtimes.set(conversationId, rt)
        }
        rt.runEpoch = (rt.runEpoch || 0) + 1
        runEpoch = rt.runEpoch
        rt.activeRunId = runId
        rt.status = 'pending'
        rt.error = null
        rt.draftAssistant = {
          reasoning: '',
          content: '',
          toolCalls: [],
          toolResults: {},
          toolCall: null,
          toolArgs: '',
          steps: [],
          activeReasoningStepId: null,
          activeContentStepId: null,
          activeToolStepId: null,
          activeCompressionStepId: null,
        }
      })

      // Register the agentLoop so cancelAgent can find and abort it
      setAgentLoop(conversationId, agentLoop)
      set((state) => {
        const c = state.conversations.find((c) => c.id === conversationId)
        if (c) {
          c.activeRunId = runId
          c.runEpoch = runEpoch
          c.status = 'pending'
          c.error = null
          c.draftAssistant = {
            reasoning: '',
            content: '',
            toolCalls: [],
            toolResults: {},
            toolCall: null,
            toolArgs: '',
            steps: [],
            activeReasoningStepId: null,
            activeContentStepId: null,
            activeToolStepId: null,
            activeCompressionStepId: null,
          }
        }
      })

      const isCurrentRun = () => {
        const rt = useConversationRuntimeStore.getState().runtimes.get(conversationId)
        return !!rt && rt.activeRunId === runId && (rt.runEpoch || 0) === runEpoch
      }

      const emitCompactEvent = (payload: Record<string, unknown>) => {
        emitCompressionEvent(payload as any)
      }

      // 4. Run compact — generate summary and update compression baseline only.
      //    IMPORTANT: We do NOT replace c.messages with the compacted result.
      //    The UI must keep showing the full history.  The compressed summary is
      //    stored in c.compressedContextSummary / c.compressedContextCutoffTimestamp
      //    so that the next LLM call automatically uses the trimmed context via
      //    applyCompressionBaseline().
      try {
        const resultMessages = await agentLoop.runCompactOnly(messagesBeforeCompact, {
          onContextCompressionStart: (payload) => {
            if (!isCurrentRun()) return
            emitCompactEvent({ phase: 'start', ...payload })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (c && c.activeRunId === runId) {
                applyDraftAssistantEvent(c, { type: 'compression_start' })
              }
            })
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                applyDraftAssistantEvent(r, { type: 'compression_start' })
              }
            })
          },
          onContextCompressionComplete: (payload) => {
            if (!isCurrentRun()) return
            emitCompactEvent({ phase: 'complete', ...payload })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (c && c.activeRunId === runId) {
                applyDraftAssistantEvent(c, {
                  type: 'compression_complete',
                  mode: payload.mode === 'skip' ? 'skip' : 'compress',
                })
              }
            })
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                applyDraftAssistantEvent(r, {
                  type: 'compression_complete',
                  mode: payload.mode === 'skip' ? 'skip' : 'compress',
                })
              }
            })
          },
          onMessagesUpdated: (msgs) => {
            // Do NOT replace c.messages — only update compression baseline state.
            // The compacted message list is for the LLM, not for the UI.
            if (!isCurrentRun()) return
            // messages persisted via onMessagesUpdated callback
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || (c.runEpoch || 0) !== runEpoch) return
              // Only update compression metadata — keep original messages intact
              const summaryMsg = [...msgs].reverse().find((msg) => msg.kind === 'context_summary')
              if (summaryMsg) {
                c.compressedContextSummary = summaryMsg.content || c.compressedContextSummary || null
                c.compressedContextCutoffTimestamp =
                  typeof summaryMsg.timestamp === 'number' ? summaryMsg.timestamp : c.compressedContextCutoffTimestamp || null
              }
              c.updatedAt = Date.now()
            })
          },
          onError: (error) => {
            console.error('[conversation.store] compactConversation error:', error)
            toast.error(i18nText('conversation.toast.compactFailed', '压缩失败：') + error.message)
          },
        })

        // 5. Finalize — keep original messages + append a visible summary message
        if (!committed) {
          committed = true
          // Extract the summary message from resultMessages to show in UI.
          // Keep ALL original messages intact (no history loss), just add the summary at the end.
          const summaryMsg = [...resultMessages].reverse().find((m) => m.kind === 'context_summary')
          const finalMessages = summaryMsg
            ? [...messagesBeforeCompact, summaryMsg]
            : messagesBeforeCompact
          deleteAgentLoop(conversationId)
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              c.messages = finalMessages
              c.status = 'idle'
              c.error = null
              c.activeRunId = null
              c.draftAssistant = null
              c.updatedAt = Date.now()
              bumpTranscriptVersion(conversationId)
            }
          })
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.status = 'idle'
              r.error = null
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
          persistMessageReplace(conversationId, finalMessages).catch((err) => {
            console.error('[conversation.store] Failed to persist after compact:', err)
          })
          // Compact finished → idle: eviction candidate.
          scheduleConversationEviction(conversationId)
        }
      } catch (error) {
        if (!committed) {
          committed = true
          const errorMsg = error instanceof Error ? error.message : String(error)
          deleteAgentLoop(conversationId)
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              c.status = 'error'
              c.error = errorMsg
              c.activeRunId = null
              c.draftAssistant = null
            }
          })
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.status = 'error'
              r.error = errorMsg
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
        }
      }

      // ── Consume queued messages ──
      // After a successful compact, check if messages were queued during
      // the compression run. If so, dequeue and trigger a new agent run —
      // mirroring the behavior in runAgent's finalize block.
      const finalStatus = get().conversations.find((c) => c.id === conversationId)?.status
      if (finalStatus === 'idle') {
        const nextMsg = useConversationRuntimeStore.getState().dequeueMessage(conversationId)
        if (nextMsg) {
          // rerunOnly trigger from an overlapping runAgent dispatch (its
          // running state routed the dispatch into this queue): the user
          // message is ALREADY persisted, so the follow-up must start
          // directly — creating a user message here would add a blank
          // "/empty" entry (the trigger's text is always ''). Same
          // no-new-message behavior as runAgent's finalize consumer.
          if (nextMsg.rerunOnly) {
            queueMicrotask(() => {
              get().runAgent(
                conversationId,
                pType,
                mName,
                maxTokens,
                null,
                nextMsg.agentOverrideId ?? null,
              )
            })
          } else {
            const { createUserMessage: createMsg } = await import('@/agent/message-types')
            const userMsg = createMsg(nextMsg.text, nextMsg.assets, nextMsg.pageContext, {
              contentParts: nextMsg.contentParts,
              readImageHandoff: nextMsg.readImageHandoff,
            })
            const currentConv = get().conversations.find((c) => c.id === conversationId)
            if (currentConv) {
              get().updateMessages(conversationId, [...currentConv.messages, userMsg])
              queueMicrotask(() => {
                get().runAgent(
                  conversationId,
                  pType,
                  mName,
                  maxTokens,
                  null,
                  nextMsg.agentOverrideId ?? null,
                )
              })
            }
          }
        }
      }
    },

    // ── Runtime state actions ──
    setConversationStatus: (id: string, status: ConversationStatus) => {
      let becameIdle = false
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) {
          becameIdle = status === 'idle' && c.status !== 'idle'
          c.status = status
        }
      })
      // Run completion → eviction candidate (guards re-checked after the delay).
      if (becameIdle) scheduleConversationEviction(id)
    },

    appendStreamingContent: (id: string, delta: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.streamingContent += delta
      })
    },

    resetStreamingContent: (id: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.streamingContent = ''
      })
    },

    appendStreamingReasoning: (id: string, delta: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.streamingReasoning += delta
      })
    },

    resetStreamingReasoning: (id: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.streamingReasoning = ''
      })
    },

    setReasoningStreaming: (id: string, streaming: boolean) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.isReasoningStreaming = streaming
      })
    },

    setCompletedReasoning: (id: string, reasoning: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.completedReasoning = reasoning
      })
    },

    setContentStreaming: (id: string, streaming: boolean) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.isContentStreaming = streaming
      })
    },

    setCompletedContent: (id: string, content: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.completedContent = content
      })
    },

    setCurrentToolCall: (id: string, tc: ToolCall | null) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) {
          c.currentToolCall = tc
          c.activeToolCalls = c.activeToolCalls || []
          if (tc && !c.activeToolCalls.some((x) => x.id === tc.id)) {
            c.activeToolCalls.push(tc)
          }
        }
      })
    },

    appendStreamingToolArgs: (id: string, delta: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.streamingToolArgs += delta
      })
    },

    resetStreamingToolArgs: (id: string) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) {
          c.streamingToolArgs = ''
          c.streamingToolArgsByCallId = {}
        }
      })
    },

    setConversationError: (id: string, error: string | null) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) {
          c.error = error
          c.status = error ? 'error' : 'idle'
        }
      })
    },

    resetConversationState: (id: string) => {
      // Clear any pending ask_user_question entries
      import('@/store/pending-question.store')
        .then(({ clearPendingQuestions }) => {
          clearPendingQuestions(id)
        })
        .catch(() => {})

      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) {
          c.status = 'idle'
          c.streamingContent = ''
          c.streamingReasoning = ''
          c.isReasoningStreaming = false
          c.completedReasoning = null
          c.isContentStreaming = false
          c.completedContent = null
          c.currentToolCall = null
          c.activeToolCalls = []
          c.streamingToolArgs = ''
          c.streamingToolArgsByCallId = {}
          c.error = null
          c.activeRunId = null
          c.draftAssistant = null
          c.contextWindowUsage = null
        }
      })

      // Reset runtime store for this conversation
      useConversationRuntimeStore.setState((state) => {
        const r = state.runtimes.get(id)
        if (r) {
          r.status = 'idle'
          r.streamingContent = ''
          r.streamingReasoning = ''
          r.isReasoningStreaming = false
          r.completedReasoning = null
          r.isContentStreaming = false
          r.completedContent = null
          r.currentToolCall = null
          r.activeToolCalls = []
          r.streamingToolArgs = ''
          r.streamingToolArgsByCallId = {}
          r.error = null
          r.activeRunId = null
          r.draftAssistant = null
          r.contextWindowUsage = null
        }
      })
    },

    // Follow-up suggestion actions
    collectAssets: (conversationId: string, assets: import('@/types/asset').AssetMeta[]) => {
      set((state) => {
        const conv = state.conversations.find((c) => c.id === conversationId)
        if (conv) {
          if (!conv.collectedAssets) {
            conv.collectedAssets = []
          }
          conv.collectedAssets.push(...assets)
        }
      })
    },

    setSuggestedFollowUp: (conversationId: string, suggestion: string) => {
      set((state) => ({
        suggestedFollowUps: new Map(state.suggestedFollowUps).set(conversationId, suggestion),
      }))
    },

    clearSuggestedFollowUp: (conversationId: string) => {
      set((state) => {
        const newMap = new Map(state.suggestedFollowUps)
        newMap.delete(conversationId)
        return { suggestedFollowUps: newMap }
      })
    },

    getSuggestedFollowUp: (conversationId: string) => {
      return get().suggestedFollowUps.get(conversationId) || ''
    },

    /**
     * Emergency draft persistence for beforeunload.
     *
     * When the page is about to close/refresh, this commits any in-flight
     * streaming drafts into conversation messages and triggers persistence.
     * This prevents content loss if the user refreshes the page.
     *
     * Must be called synchronously from beforeunload/pagehide.
     * The async persist calls are fire-and-forget — the browser will
     * typically let in-flight IndexedDB writes complete.
     */
    commitAndPersistRunningDrafts: () => {
      const state = get()
      const runningConvs = state.conversations.filter((c) => !!c.activeRunId)
      if (runningConvs.length === 0) return

      // Collect messages to persist for each running conversation.
      // We use set() to properly mutate through immer and collect the
      // resulting messages for persistence.
      const toPersist: Array<{ convId: string; messages: Message[] }> = []

      // Phase 1: Flush streaming queues OUTSIDE of set() so that the runtime
      // store's draftAssistant is fully up-to-date before we read it.
      // flushNow() is synchronous — it cancels pending RAF and invokes callbacks
      // which call useConversationRuntimeStore.setState() synchronously.
      for (const convRef of runningConvs) {
        const queues = getStreamingQueues(convRef.id)
        if (queues) {
          queues.reasoning.flushNow()
          queues.content.flushNow()
        }
      }

      // Phase 2: Now read the (freshly flushed) runtime draft and commit.
      set((draft) => {
        for (const convRef of runningConvs) {
          const c = draft.conversations.find((x) => x.id === convRef.id)
          if (!c) continue

          // Sync runtime draft to main store (same pattern as cancelAgent)
          const rtDraft =
            useConversationRuntimeStore.getState().runtimes.get(c.id)?.draftAssistant
          if (rtDraft && !c.draftAssistant) {
            c.draftAssistant = rtDraft
          }

          // Commit draft into messages
          const committed = commitDraftToMessages(c)
          if (committed) {
            c.updatedAt = Date.now()
            bumpTranscriptVersion(c.id)
            // Clean up streaming/draft UI state
            c.draftAssistant = null
            c.currentToolCall = null
            c.activeToolCalls = []
            c.streamingToolArgs = ''
            c.streamingToolArgsByCallId = {}
            c.streamingContent = ''
            c.streamingReasoning = ''
            c.isContentStreaming = false
            c.isReasoningStreaming = false
            c.status = 'idle'
            c.error = null
            c.activeRunId = null

            toPersist.push({ convId: c.id, messages: [...c.messages] })
          }
        }
      })

      // Persist outside of set() — fire-and-forget async writes
      for (const { convId, messages } of toPersist) {
        persistMessageReplace(convId, messages, true).catch((err) => {
          console.error(
            '[conversation.store] Failed to persist draft on beforeunload:',
            err,
          )
        })
        console.info(
          `[conversation.store] Saved streaming draft for conversation ${convId} on page unload`,
        )
      }
    },
  }))
)

// Re-exports preserve the original public surface of this module
// (external importers and tests resolve these names here).
export { findSpawnStepInDraft } from './conversation-message-ops'
export { reconcileMessageSnapshot } from './conversation-message-ops'
export {
  clearScheduledEvictionTimers,
  EVICTION_DELAY_MS,
  EVICTION_LRU_KEEP,
  EVICTION_MIN_MESSAGES,
  evictConversationMessagesIfSafe,
  scheduleConversationEviction,
  type ConversationEvictionPort,
} from '@/store/conversation-eviction'

/**
 * The single kind selector — read a conversation's direct-mode flag.
 *
 * The design mandates ONE check site (never scatter `kind === 'direct'`
 * across WorkspaceLayout/ConversationView/agent-run): undefined ≡ 'project',
 * so legacy conversations and runtime-created ones behave exactly as before.
 */
export function isDirectConversation(id: string | null | undefined): boolean {
  if (!id) return false
  return useConversationStoreSQLite.getState().conversations.find((c) => c.id === id)?.kind === 'direct'
}

// ---------------------------------------------------------------------------
// Eviction port: the minimal store surface the policy module may read or act on
// ---------------------------------------------------------------------------
configureConversationEviction({
  listCandidates: () =>
    useConversationStoreSQLite.getState().conversations.map((c) => ({
      id: c.id,
      messageCount: c.messages.length,
      messagesLoaded: c.messagesLoaded !== false,
      status: c.status,
      hasDraftAssistant: Boolean(c.draftAssistant),
      updatedAt: c.updatedAt,
    })),
  getActiveConversationId: () => useConversationStoreSQLite.getState().activeConversationId,
  getMountedCount: (id) => useConversationRuntimeStore.getState().mountedConversations.get(id) ?? 0,
  getPendingQueueLength: (id) =>
    useConversationRuntimeStore.getState().pendingMessageQueues.get(id)?.length ?? 0,
  hasPendingPersist: (id) => persistSchedulers.has(id),
  hasPendingUnloadedWrite: (id) => unloadedWriteQueues.has(id),
  unload: (id) => {
    useConversationStoreSQLite.setState((draft) => {
      const c = draft.conversations.find((x) => x.id === id)
      if (c && c.messagesLoaded !== false) {
        c.messages = []
        c.messagesLoaded = false
      }
    })
    // Baseline must go too: it pins references to every evicted message object.
    invalidatePersistBaseline(id)
    // Release the mirrored runtime entry as well (idle leftovers only).
    useConversationRuntimeStore.setState((draft) => {
      const rt = draft.runtimes.get(id)
      if (rt && rt.status === 'idle' && !rt.activeRunId && !rt.draftAssistant) {
        draft.runtimes.delete(id)
      }
    })
  },
})

// ---------------------------------------------------------------------------
// Eviction trigger: last view unmounted
// ---------------------------------------------------------------------------
// The live mount ref-counts live in the RUNTIME store (useConversationLogic
// mounts/unmounts through its actions). When a conversation's count drops to
// zero the user can no longer see it, making it an eviction candidate.
useConversationRuntimeStore.subscribe((state, prev) => {
  if (state.mountedConversations === prev.mountedConversations) return
  for (const [id, count] of prev.mountedConversations) {
    if (count > 0 && (state.mountedConversations.get(id) ?? 0) === 0) {
      scheduleConversationEviction(id)
    }
  }
})
