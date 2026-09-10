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

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import { toast } from 'sonner'
import { t as translateStatic } from '@creatorweave/i18n'
import type {
  Conversation,
  Message,
  MessageUsage,
  ToolCall,
  ConversationStatus,
  DraftAssistantStep,
  ContextWindowUsage,
} from '@/agent/message-types'
import type { AssetMeta } from '@/types/asset'
import {
  createAssistantMessage,
  createConversation,
  createRunChangesMessage,
  createToolMessage,
  createUserMessage,
  generateId,
} from '@/agent/message-types'
import { extractFirstMentionedAgentId } from '@/agent/agent-mention'
// Per-conversation authorization state (PR-1/PR-4 of the tool authorization
// redesign): grants die with the conversation — leaf stores, safe to import.
import { useSessionAllowStore } from '@/store/session-allow.store'
import { useYoloModeStore } from '@/store/yolo-mode.store'
import {
  emitThinkingStart,
  emitThinkingDelta,
  emitCompressionEvent,
  emitToolStart,
  emitComplete,
  emitError,
} from '@/streaming-bus'
import { useConversationContextStore } from './conversation-context.store'
import { useConversationRuntimeStore, createEmptyRuntime } from './conversation-runtime.store'
import type { ConversationRuntime } from './conversation-runtime.store'
import { deleteAgentLoop, getAgentLoop, setAgentLoop } from './agent-loop-registry'
import {
  deleteStreamingQueues,
  getStreamingQueues,
  setStreamingQueues,
} from './streaming-queue-registry'
import {
  applyDraftAssistantEvent,
  createEmptyDraftAssistant,
} from './draft-assistant'
import { ensureToolCallResults } from '@/agent/loop/tool-call-results'
import { useI18nStore } from '@/i18n/store'
import { getElicitationHandler } from '@/mcp/elicitation-handler.tsx'

/** Default conversation name when title is not available */
const DEFAULT_CONVERSATION_NAME = 'New Chat'

/** Tool calls preserved in committed messages even when in-flight (no result) on cancel/refresh. */
const PRESERVED_IN_FLIGHT_TOOLS = new Set([
  'spawn_subagent',
  'batch_spawn',
  'ask_user_question',
])

/**
 * Build a synthetic ask_user_question tool result for interrupted questions.
 * Used when the user refreshes/closes the page while a question is pending —
 * the in-memory Promise is gone, so we inject a result using default_answer
 * (or 'cancelled' fallback) so QuestionCard renders in answered state.
 */
function makeSyntheticAskUserResult(argsJson: string): string {
  let defaultAnswer = 'cancelled'
  try {
    const parsed = JSON.parse(argsJson || '{}') as { default_answer?: unknown }
    if (typeof parsed.default_answer === 'string' && parsed.default_answer.trim()) {
      defaultAnswer = parsed.default_answer.trim()
    }
  } catch {
    // Malformed args — keep the fallback.
  }
  return JSON.stringify({
    ok: true,
    tool: 'ask_user_question',
    version: 2,
    data: { answer: defaultAnswer, confirmed: false, timed_out: false },
    warning: '[Interrupted] 页面刷新或关闭，未提交答案。已自动使用 default_answer。',
  })
}

/** Helper to get or create a runtime in the runtime store (Immer draft) */
function ensureRuntime(state: import('./conversation-runtime.store').ConversationRuntimeState, convId: string): ConversationRuntime {
  let rt = state.runtimes.get(convId)
  if (!rt) {
    rt = createEmptyRuntime()
    state.runtimes.set(convId, rt)
  }
  return rt
}

function i18nText(key: string, fallback: string): string {
  const locale = useI18nStore.getState().locale
  const translated = translateStatic(locale, key)
  return translated === key ? fallback : translated
}

/** Add completed reasoning durations to freshly committed assistant messages. */
function attachReasoningDurations(
  messages: Message[],
  draft?: { steps: DraftAssistantStep[] } | null
): Message[] {
  if (!draft) return messages

  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.reasoning || message.reasoningDurationMs !== undefined) {
      return message
    }
    const step = [...draft.steps]
      .reverse()
      .find(
        (candidate): candidate is Extract<DraftAssistantStep, { type: 'reasoning' }> =>
          candidate.type === 'reasoning' &&
          !candidate.streaming &&
          candidate.content === message.reasoning &&
          candidate.durationMs !== undefined
      )
    return step?.durationMs === undefined ? message : { ...message, reasoningDurationMs: step.durationMs }
  })
}

/**
 * Commit completed draft assistant content + tool calls into conversation messages.
 * Used both when starting a new assistant message (onMessageStart) and when cancelling.
 */
function commitDraftToMessages(conv: {
  messages: Message[]
  collectedAssets?: AssetMeta[]
  draftAssistant?: {
    reasoning: string
    content: string
    toolCalls: ToolCall[]
    toolResults: Record<string, string>
    toolCall: ToolCall | null
    toolArgs: string
    steps: import('@/agent/message-types').DraftAssistantStep[]
    activeReasoningStepId?: string | null
    activeContentStepId?: string | null
    activeToolStepId?: string | null
    activeCompressionStepId?: string | null
  } | null
}): boolean {
  const draft = conv.draftAssistant
  if (!draft) return false

  const completedToolCalls = draft.toolCalls.filter((tc) =>
    Object.prototype.hasOwnProperty.call(draft.toolResults, tc.id)
  )
  // In-flight calls that started via onToolCallStart but have no result yet.
  // We preserve these (instead of discarding) when:
  //   - spawn_subagent / batch_spawn: subagent still running in background, UI
  //     renders it as interrupted and keeps agentId for detail panel.
  //   - ask_user_question: the user might have refreshed the page or the
  //     browser closed. The in-memory Promise for the user's answer is gone,
  //     but we must still keep the tool_call in committed messages so the
  //     QuestionCard renders the question (in answered state) and the user
  //     can see what was asked and decide how to continue.
  // Other in-flight calls (read, search, ...) are discarded on cancel by design.
  // Exclude those already committed via onMessagesUpdated.
  const committedToolCallIds = new Set(
    conv.messages
      .filter((m) => m.role === 'assistant' && m.toolCalls)
      .flatMap((m) => m.toolCalls!.map((tc) => tc.id))
  )
  const inFlightPreservedCalls = draft.toolCalls.filter(
    (tc) =>
      !Object.prototype.hasOwnProperty.call(draft.toolResults, tc.id) &&
      !committedToolCallIds.has(tc.id) &&
      PRESERVED_IN_FLIGHT_TOOLS.has(tc.function.name)
  )
  const hasContent =
    draft.reasoning.trim() ||
    draft.content.trim() ||
    completedToolCalls.length > 0 ||
    inFlightPreservedCalls.length > 0

  if (!hasContent) return false

  // Collect assets accumulated during this agent run
  const collectedAssets = conv.collectedAssets?.length ? conv.collectedAssets : undefined
  // Clear the accumulator after collecting
  conv.collectedAssets = []

  // Fallback: find the last valid (non-zero) token usage from previous
  // assistant messages. When the agent is cancelled mid-stream, the API
  // never returns final usage, so the committed draft would otherwise show
  // "input 0 output 0" in the UI.  We use the last known-good usage instead.
  let fallbackUsage: MessageUsage | undefined
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.role === 'assistant' && m.usage && m.usage.totalTokens > 0) {
      fallbackUsage = m.usage
      break
    }
  }

  // Merge completed + in-flight preserved calls (spawn_subagent / batch_spawn /
  // ask_user_question) into the assistant message. Other in-flight calls
  // (read, search, ...) are discarded on cancel by design.
  const allToolCalls = [...completedToolCalls, ...inFlightPreservedCalls]

  const assistantMessage = createAssistantMessage(
    draft.content || null,
    allToolCalls.length > 0 ? allToolCalls : undefined,
    fallbackUsage,
    draft.reasoning || null,
    undefined,
    collectedAssets
  )
  const [assistantWithReasoningDuration] = attachReasoningDurations([assistantMessage], draft)
  conv.messages.push(assistantWithReasoningDuration)
  for (const tc of completedToolCalls) {
    conv.messages.push(
      createToolMessage({
        toolCallId: tc.id,
        name: tc.function.name,
        content: draft.toolResults[tc.id] || '',
      })
    )
  }
  // Push synthetic [Interrupted] results for in-flight spawn_subagent /
  // batch_spawn calls. Embed agentId(s) from subagentEvents so SubagentCard
  // can resolve and render the subagent detail panel even after the draft
  // is cleared. Also push synthetic results for orphaned ask_user_question
  // calls so the QuestionCard renders them in "answered" state with the
  // default_answer (or "cancelled") so the user can see what was asked
  // after a page refresh or browser close.
  for (const tc of inFlightPreservedCalls) {
    if (tc.function.name === 'ask_user_question') {
      conv.messages.push(
        createToolMessage({
          toolCallId: tc.id,
          name: tc.function.name,
          content: makeSyntheticAskUserResult(tc.function.arguments),
        })
      )
      continue
    }
    // spawn_subagent / batch_spawn path — unchanged.
    const toolName = tc.function.name
    const step = draft.steps.find(
      (s) => s.type === 'tool_call' && s.toolCall.id === tc.id
    )
    const agentIds =
      step && step.type === 'tool_call' && step.subagentEvents
        ? Array.from(new Set(step.subagentEvents.map((e) => e.agentId)))
        : []
    let syntheticContent: string
    if (agentIds.length === 1) {
      syntheticContent = JSON.stringify({
        success: false,
        error: '[Interrupted] 用户取消了运行。',
        data: { agentId: agentIds[0], content: '', interrupted: true },
      })
    } else if (agentIds.length > 1) {
      syntheticContent = JSON.stringify({
        success: false,
        error: '[Interrupted] 用户取消了运行。',
        data: {
          completed: agentIds.map((aid) => ({
            agentId: aid,
            content: '',
            interrupted: true,
          })),
        },
      })
    } else {
      syntheticContent = JSON.stringify({
        success: false,
        error: '[Interrupted] 用户取消了运行。',
      })
    }
    conv.messages.push(
      createToolMessage({
        toolCallId: tc.id,
        name: toolName,
        content: syntheticContent,
      })
    )
  }
  return true
}

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

/** Find the spawn_subagent/batch_spawn step that owns a subagent event.
 *  Parent IDs are authoritative; the active/recent fallback only supports
 *  legacy tasks that were created before correlation IDs existed.
 *  Accepts ReadonlyArray steps so the same helper works for plain objects,
 *  immer drafts, and Readonly drafts. Callers that need to mutate the
 *  returned step (e.g. to push into subagentEvents) should do so within an
 *  immer producer where the draft is already mutable. */
export function findSpawnStepInDraft(draft: {
  activeToolStepId?: string | null
  steps: ReadonlyArray<DraftAssistantStep>
}, parentToolCallId?: string): Extract<DraftAssistantStep, { type: 'tool_call' }> | undefined {
  if (parentToolCallId) {
    const step = draft.steps.find(
      (candidate): candidate is Extract<DraftAssistantStep, { type: 'tool_call' }> =>
        candidate.type === 'tool_call' &&
        candidate.toolCall.id === parentToolCallId &&
        (candidate.toolCall.function.name === 'spawn_subagent' || candidate.toolCall.function.name === 'batch_spawn')
    )
    // A correlated notification must never be routed to a different spawn
    // card. If its parent step is gone, drop it rather than guessing.
    return step
  }

  // Compatibility fallback for tasks created before parentToolCallId existed.
  if (draft.activeToolStepId) {
    const activeStep = draft.steps.find((s) => s.id === draft.activeToolStepId)
    if (activeStep && activeStep.type === 'tool_call') {
      const name = activeStep.toolCall.function.name
      if (name === 'spawn_subagent' || name === 'batch_spawn') return activeStep
    }
  }
  for (let i = draft.steps.length - 1; i >= 0; i--) {
    const step = draft.steps[i]
    if (
      step.type === 'tool_call' &&
      step.streaming &&
      (step.toolCall.function.name === 'spawn_subagent' ||
        step.toolCall.function.name === 'batch_spawn')
    ) {
      return step
    }
  }
  return undefined
}
import { StreamingQueue } from '../utils/streaming-queue'

// Enable Immer Map/Set support
enableMapSet()
import { AgentLoop } from '@/agent/agent-loop'
import { createToolPolicyHooks } from '@/agent/tool-policy'
import { createLLMProvider } from '@/agent/llm/provider-factory'
import { ContextManager } from '@/agent/context-manager'
import { getToolRegistry } from '@/agent/tool-registry'
import { getOrCreateSubagentRuntime } from '@/agent/subagent/runtime'
import { getApiKeyRepository } from '@/sqlite'
import { LLM_PROVIDER_CONFIGS, isCustomProviderType, type LLMProviderType } from '@/agent/providers/types'
import { generateFollowUp } from '@/agent/follow-up-generator'
import { generateConversationTitle } from '@/agent/title-generator'
import {
  getConversationRepository,
  getMessageRepository,
  getSQLiteDB,
  initSQLiteDB,
} from '@/sqlite'
import { useSettingsStore } from './settings.store'
import { getCurrentWorkspaceAgentMode } from './workspace-preferences.store'
import type { SubagentTaskNotification, SubagentStepNotification } from '@/agent/tools/tool-types'

// Follow-up suggestions are enabled by default

//=============================================================================
// Helpers
//=============================================================================

/**
 * Produce a short text summary suitable for a system notification body.
 * Trims whitespace, normalises newlines, and truncates to ~60 chars with
 * an ellipsis. If the input is empty, returns '已完成'.
 */
function summarizeForNotification(content: string, maxChars = 60): string {
  const normalised = content.replace(/\s+/g, ' ').trim()
  if (!normalised) return '已完成'
  if (normalised.length <= maxChars) return normalised
  return normalised.slice(0, maxChars) + '…'
}

//=============================================================================
// Persistence Functions (SQLite)
//=============================================================================

const pendingConversationMetaPersists = new Map<string, Promise<void>>()

/**
 * In-flight loadFromDB promise. StrictMode (dev only) double-mounts effects
 * synchronously, and both invocations see `loaded === false` before the first
 * one finishes. Without this guard, the full N-conversation load runs twice
 * on every page refresh in dev — observed 2×5.3s back-to-back. Production
 * builds mount once, so this is a dev-only no-op there.
 */
let inflightLoadFromDB: Promise<void> | null = null

async function waitForConversationMetaPersist(convId: string): Promise<void> {
  const pending = pendingConversationMetaPersists.get(convId)
  if (pending) {
    await pending
  }
}

/** Append a single new message via MessageRepository */
async function persistNewMessage(convId: string, message: Message, seq: number): Promise<void> {
  await waitForConversationMetaPersist(convId)
  const msgRepo = getMessageRepository()
  const convRepo = getConversationRepository()
  await msgRepo.insert(convId, message, seq)
  await convRepo.touch(convId)
}


/**
 * Debounced persist scheduler — coalesces rapid fire-and-forget calls into
 * a single database write while guaranteeing immediate flush for final saves.
 *
 * Why: During an agent run, `persistAfterBlockComplete` and `onNotification`
 * can fire many times per second. Each triggers a full DELETE + INSERT in a
 * manual transaction. If two calls overlap, SQLite throws
 * "cannot start a transaction within a transaction".
 *
 * How: We debounce non-critical calls (300 ms window) so only the latest
 * messages snapshot is written. Critical calls (flush=true) skip the timer
 * and execute immediately, chained after any in-flight write.
 */
const persistSchedulers = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout> | null
    flushInProgress: Promise<void> | null
    // Resolve function for the currently-pending debounce Promise, so a
    // pre-empting call can settle it immediately instead of leaving it hanging.
    pendingResolve: (() => void) | null
  }
>()

const PERSIST_DEBOUNCE_MS = 300

async function doPersist(convId: string, messages: Message[]): Promise<void> {
  await waitForConversationMetaPersist(convId)
  const msgRepo = getMessageRepository()
  const convRepo = getConversationRepository()
  await msgRepo.replaceAll(convId, messages)
  await convRepo.touch(convId)
}

/**
 * Schedule (or immediately execute) a message persist for a conversation.
 *
 * @param flush  `true` = skip debounce, write immediately. Use for final
 *               saves (complete, cancel, user edits). `false` = debounce
 *               to coalesce rapid intermediate writes (block-complete,
 *               notifications).
 */
function persistMessageReplace(
  convId: string,
  messages: Message[],
  flush: boolean = true
): Promise<void> {
  let entry = persistSchedulers.get(convId)
  if (!entry) {
    entry = { timer: null, flushInProgress: null, pendingResolve: null }
    persistSchedulers.set(convId, entry)
  }

  // Cancel any pending debounced write — settle the old Promise immediately
  // so its caller (which uses .catch() / void) doesn't hang.
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (entry.pendingResolve !== null) {
    entry.pendingResolve() // resolve old debounce Promise harmlessly
    entry.pendingResolve = null
  }

  // Flush: chain immediately after any in-flight write
  if (flush) {
    const prev = entry.flushInProgress?.catch(() => undefined) ?? Promise.resolve()
    const next = prev.then(() => doPersist(convId, messages))
    entry.flushInProgress = next
    void next.then(
      () => {
        if (entry!.flushInProgress === next) entry!.flushInProgress = null
      },
      () => {
        if (entry!.flushInProgress === next) entry!.flushInProgress = null
      }
    )
    return next
  }

  // Debounce: schedule a write after PERSIST_DEBOUNCE_MS.
  // The returned Promise resolves when the actual write completes (or
  // immediately with void if superseded by a later call).
  let resolveDebounce!: (value: void | PromiseLike<void>) => void
  let rejectDebounce!: (reason?: unknown) => void
  const debouncePromise = new Promise<void>((r, j) => {
    resolveDebounce = r
    rejectDebounce = j
  })

  entry.timer = setTimeout(() => {
    entry!.timer = null
    entry!.pendingResolve = null

    const prev = entry!.flushInProgress?.catch(() => undefined) ?? Promise.resolve()
    const next = prev.then(() => doPersist(convId, messages))
    entry!.flushInProgress = next

    // Settle the debounce Promise once the write settles
    void next.then(
      () => resolveDebounce(),
      (err) => rejectDebounce(err)
    )
    void next.then(
      () => {
        if (entry!.flushInProgress === next) entry!.flushInProgress = null
        if (entry!.timer === null && entry!.flushInProgress === null) {
          persistSchedulers.delete(convId)
        }
      },
      () => {
        if (entry!.flushInProgress === next) entry!.flushInProgress = null
        if (entry!.timer === null && entry!.flushInProgress === null) {
          persistSchedulers.delete(convId)
        }
      }
    )
  }, PERSIST_DEBOUNCE_MS)

  // Store resolve so a pre-empting flush or newer debounce can settle early
  entry.pendingResolve = resolveDebounce

  return debouncePromise
}

/** Persist only conversation metadata (title, contextUsage, etc.) — no messages */
async function persistConversationMeta(conversation: Conversation): Promise<void> {
  const repo = getConversationRepository()
  await repo.saveMeta({
    id: conversation.id,
    title: conversation.title,
    titleMode: conversation.titleMode || 'manual',
    contextUsage: conversation.lastContextWindowUsage || null,
    compressedContextSummary: conversation.compressedContextSummary || null,
    compressedContextCutoffTimestamp: conversation.compressedContextCutoffTimestamp ?? null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  })
}

/** Load all conversation metadata from SQLite (without messages) */
async function loadConversationsMeta(): Promise<Conversation[]> {
  const repo = getConversationRepository()
  const metas = await repo.findAllMeta()
  // Create Conversation objects with empty messages (loaded on demand)
  return metas.map((meta) => ({
    id: meta.id,
    title: meta.title,
    titleMode: meta.titleMode || 'manual',
    messages: [] as Message[], // Messages loaded lazily when conversation is opened
    lastContextWindowUsage: meta.lastContextWindowUsage || null,
    compressedContextSummary: meta.compressedContextSummary || null,
    compressedContextCutoffTimestamp: meta.compressedContextCutoffTimestamp ?? null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    status: 'idle' as const,
    streamingContent: '',
    streamingReasoning: '',
    isReasoningStreaming: false,
    completedReasoning: null,
    isContentStreaming: false,
    completedContent: null,
    currentToolCall: null,
    activeToolCalls: [],
    streamingToolArgs: '',
    streamingToolArgsByCallId: {},
    error: null,
    activeRunId: null,
    runEpoch: 0,
    draftAssistant: null,
    contextWindowUsage: meta.lastContextWindowUsage || null,
    mountRefCount: 0,
    compressionConvertCallCount: 0,
    compressionLastSummaryConvertCall: Number.NEGATIVE_INFINITY,
    collectedAssets: [],
    agentMode: getCurrentWorkspaceAgentMode(),
  }))
}

/** Delete a conversation from SQLite */
async function deleteConversationFromDB(id: string): Promise<void> {
  const repo = getConversationRepository()
  await repo.delete(id)
}

//=============================================================================
// Title Management
//=============================================================================

const MAX_TITLE_LENGTH = 30

function truncateTitle(content: string): string {
  let trimmed = content.trim()
  trimmed = trimmed.replace(/\s+/g, ' ')
  if (trimmed.length <= MAX_TITLE_LENGTH) {
    return trimmed
  }
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1) + '…'
}

function updateAutoTitleAfterMessageDelete(conv: Conversation): void {
  if (conv.titleMode === 'manual') return

  const firstUserMessage = conv.messages.find((m) => m.role === 'user' && m.content)
  if (firstUserMessage?.content) {
    conv.title = truncateTitle(firstUserMessage.content)
    return
  }
  conv.title = DEFAULT_CONVERSATION_NAME
}

/**
 * AgentLoop callbacks are expected to provide a full conversation snapshot,
 * but under rare races we may receive a partial fragment (for example, only
 * the current turn messages). Guard against destructive regressions by
 * merging fragments with the previous in-memory snapshot.
 */
function reconcileMessageSnapshot(previous: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return previous
  if (previous.length === 0) return incoming

  const previousById = new Map(previous.map((message) => [message.id, message]))
  const mergeReasoningDuration = (message: Message): Message => {
    const previousMessage = previousById.get(message.id)
    return previousMessage?.reasoningDurationMs !== undefined && message.reasoningDurationMs === undefined
      ? { ...message, reasoningDurationMs: previousMessage.reasoningDurationMs }
      : message
  }
  const previousIds = new Set(previousById.keys())
  const overlap = incoming.reduce((count, m) => count + (previousIds.has(m.id) ? 1 : 0), 0)
  if (overlap === incoming.length && incoming.length >= previous.length) {
    return incoming.map(mergeReasoningDuration)
  }

  // If there is no overlap at all, we must determine whether incoming is a
  // small fragment to append (e.g. a new tool result) or a full snapshot that
  // should replace previous (e.g. re-mapped messages with regenerated IDs
  // after a cancel). Blindly appending a full snapshot would duplicate the
  // entire conversation history.
  if (overlap === 0) {
    // If incoming is large relative to previous, treat it as a replacement
    // snapshot rather than a tiny fragment to append.
    if (previous.length > 0 && incoming.length >= previous.length * 0.5) {
      return incoming.map(mergeReasoningDuration)
    }
    return [...previous, ...incoming.map(mergeReasoningDuration)]
  }

  // Partial overlap: update matching messages and append unseen ones without
  // dropping existing history.
  const merged = previous.slice()
  const indexById = new Map(merged.map((m, idx) => [m.id, idx]))
  for (const msg of incoming) {
    const idx = indexById.get(msg.id)
    if (idx === undefined) {
      merged.push(msg)
      indexById.set(msg.id, merged.length - 1)
    } else {
      merged[idx] = mergeReasoningDuration(msg)
    }
  }
  return merged
}

function deriveContextUsageFromAssistantUsage(
  messages: Message[],
  modelMaxTokens: number,
  reserveTokens: number
): ContextWindowUsage | null {
  const latestAssistantWithUsage = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.usage)
  if (!latestAssistantWithUsage?.usage) return null

  const usedTokens =
    latestAssistantWithUsage.usage.promptTokens +
    latestAssistantWithUsage.usage.completionTokens +
    (latestAssistantWithUsage.usage.cacheReadTokens ?? 0)
  const maxTokens = Math.max(1, modelMaxTokens - reserveTokens)
  const usagePercent = Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100))
  return {
    usedTokens,
    maxTokens,
    reserveTokens,
    usagePercent,
    modelMaxTokens,
  }
}

/**
 * Auto-heal compression baseline for conversations created before the
 * persistence fix.  When compressedContextSummary is missing but the message
 * list contains a context_summary message, restore the baseline from it.
 *
 * Note: context_summary messages store `timestamp = cutoffTimestamp - 1`,
 * so we add 1 to recover the original cutoff.
 */
function healCompressionBaseline(conv: Conversation): void {
  if (conv.compressedContextSummary) return // already has baseline
  const summaryMsg = [...conv.messages].reverse().find((m) => m.kind === 'context_summary')
  if (!summaryMsg?.content || typeof summaryMsg.timestamp !== 'number') return
  conv.compressedContextSummary = summaryMsg.content
  conv.compressedContextCutoffTimestamp = summaryMsg.timestamp + 1
  console.info('[conversation.store] Healed compression baseline from messages', {
    conversationId: conv.id,
    summaryChars: summaryMsg.content.length,
    cutoffTimestamp: conv.compressedContextCutoffTimestamp,
  })
}

//=============================================================================
// Store Definition
//=============================================================================

interface ConversationState {
  conversations: Conversation[]
  activeConversationId: string | null
  loaded: boolean
  /** Last loadFromDB error, if any. When set, `loaded` stays false so the
   *  WorkspaceLayout effect (`if (!loaded) loadFromDB()`) can retry. UI can
   *  also surface this instead of silently rendering an empty sidebar. */
  loadError: string | null

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
  createNew: (title?: string) => Conversation
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
    agentOverrideId?: string | null
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

export const useConversationStoreSQLite = create<ConversationState>()(
  immer((set, get) => ({
    conversations: [],
    activeConversationId: null,
    loaded: false,
    loadError: null,
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

    loadFromDB: async () => {
      if (inflightLoadFromDB) return inflightLoadFromDB
      inflightLoadFromDB = (async () => {
      const t0 = performance.now()
      try {
        // Initialize SQLite first
        await initSQLiteDB()
        const tSqlite = performance.now()
        // Force one legacy message migration pass in main thread.
        // This repairs cases where worker-side migration was skipped in previous versions.
        try {
          const msgRepo = getMessageRepository()
          const migrated = await msgRepo.migrateFromJsonBlob()
          if (migrated.messages > 0) {
            console.log(
              `[conversation.store] Recovered ${migrated.messages} legacy messages across ${migrated.conversations} conversations`
            )
          }
          const db = getSQLiteDB()
          const missingConversations = await db.queryFirst<{ count: number }>(
            `SELECT COUNT(*) as count
             FROM conversations c
             WHERE NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.conversation_id = c.id LIMIT 1
             )`
          )
          if ((missingConversations?.count ?? 0) > 0) {
            const recovered = await msgRepo.recoverFromAppSessions()
            if (recovered.messages > 0) {
              console.log(
                `[conversation.store] Recovered ${recovered.messages} messages from AppSessions (${recovered.conversations} conversations, ${recovered.sessions} snapshots)`
              )
            }
          }
        } catch (migrationError) {
          console.warn('[conversation.store] Legacy message migration pass failed:', migrationError)
        }
        const tMigrate = performance.now()

        const conversations = await loadConversationsMeta()
        const tLoadMeta = performance.now()

        // Orphan recovery: find ask_user_question tool_calls in committed messages
        // that have no matching tool result. This happens when the user refreshed
        // the page (or the browser closed) while a question was waiting for input —
        // the in-memory Promise is lost, but the committed draft is restored from
        // SQLite without a tool result. Without this pass, the user sees nothing
        // for that question and has no way to continue. We inject a synthetic
        // tool result using the tool_call's default_answer so QuestionCard shows
        // the question in "answered" state with a clear interrupted warning.
        try {
          let recoveredCount = 0
          for (const conv of conversations) {
            if (!conv.messages || conv.messages.length === 0) continue
            // Build set of answered toolCallIds for fast lookup
            const answeredIds = new Set<string>()
            for (const m of conv.messages) {
              if (m.role === 'tool' && typeof m.toolCallId === 'string') {
                answeredIds.add(m.toolCallId)
              }
            }
            // Walk messages, find orphaned ask_user_question tool_calls,
            // inject synthetic tool result right after the assistant message.
            // Use a single pass + index-based insertion to avoid mutating during iteration.
            const newMessages: typeof conv.messages = []
            let mutated = false
            for (const m of conv.messages) {
              newMessages.push(m)
              if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
                for (const tc of m.toolCalls) {
                  if (tc.function.name !== 'ask_user_question') continue
                  if (answeredIds.has(tc.id)) continue
                  // Orphaned ask_user_question — synthesize a tool result.
                  newMessages.push(
                    createToolMessage({
                      toolCallId: tc.id,
                      name: tc.function.name,
                      content: makeSyntheticAskUserResult(tc.function.arguments),
                    }),
                  )
                  // Avoid double-injection if another message somehow already references it.
                  answeredIds.add(tc.id)
                  recoveredCount++
                  mutated = true
                }
              }
            }
            if (mutated) {
              conv.messages = newMessages
              // Persist the recovered messages so the next load doesn't re-run the same work.
              await persistMessageReplace(conv.id, newMessages).catch((err) => {
                console.warn(
                  `[conversation.store] Failed to persist recovered orphan for ${conv.id}:`,
                  err,
                )
              })
            }
          }
          if (recoveredCount > 0) {
            console.info(
              `[conversation.store] Recovered ${recoveredCount} orphaned ask_user_question call(s) from a previous session (page refresh / browser close).`,
            )
          }
        } catch (orphanRecoveryError) {
          console.warn('[conversation.store] Orphan ask_user_question recovery pass failed:', orphanRecoveryError)
        }

        // Ensure OPFS conversations exist — but ONLY for the active workspace.
        // switchWorkspace already has lazy self-healing (workspace.store.ts:
        // "Workspace exists in SQLite but OPFS missing → recreate"), so
        // iterating all N conversations on every page load was redoing O(N)
        // SQLite/OPFS probes for no benefit. Measured impact: 4.9s for 119
        // conversations before this fix.
        const tManager = performance.now()
        let ensuredCount = 0
        let ensuredSkipped = 0
        try {
          const { getWorkspaceManager } = await import('@/opfs')
          const manager = await getWorkspaceManager()
          const activeWsId = useConversationContextStore.getState().activeWorkspaceId
          const target = conversations.find((c) => c.id === activeWsId)
          if (target && !manager.isWorkspaceLoaded(target.id)) {
            await manager.createWorkspace(
              `workspaces/${target.id}`,
              target.id,
              target.title || DEFAULT_CONVERSATION_NAME,
            )
            ensuredCount++
          } else {
            ensuredSkipped = conversations.length
          }
        } catch (e) {
          console.warn('[conversation.store] Active workspace ensure failed:', e)
        }
        const tEnsure = performance.now()
        console.log(
          `[conversation.store] loadFromDB phase timings (${Math.round(performance.now() - t0)}ms total)`,
          {
            sqliteInitMs: Math.round(tSqlite - t0),
            migrateMs: Math.round(tMigrate - tSqlite),
            loadMetaMs: Math.round(tLoadMeta - tMigrate),
            ensureOpfsMs: Math.round(tEnsure - tManager),
            conversationCount: conversations.length,
            ensuredActive: ensuredCount,
            lazyDeferred: ensuredSkipped,
          }
        )

        // NOTE: workspace switching is handled by syncFromRoute in App.tsx.
        // loadFromDB only loads conversation data; it does NOT call refreshWorkspaces or switchWorkspace.

        // Determine the active conversation ID from workspace store's current state.
        const workspaceStore = useConversationContextStore.getState()
        const preferredWorkspaceId = workspaceStore.activeWorkspaceId
        const activeId =
          (preferredWorkspaceId && conversations.some((c) => c.id === preferredWorkspaceId))
            ? preferredWorkspaceId
            : (workspaceStore.workspaces.find((w) =>
              conversations.some((c) => c.id === w.id)
            )?.id || null)

        set((state) => {
          state.conversations = conversations.map((conv) => ({
            ...conv,
            status: 'idle',
            streamingContent: '',
            streamingReasoning: '',
            isReasoningStreaming: false,
            completedReasoning: null,
            isContentStreaming: false,
            completedContent: null,
            currentToolCall: null,
            activeToolCalls: [],
            streamingToolArgs: '',
            streamingToolArgsByCallId: {},
            error: null,
            activeRunId: null,
            runEpoch: 0,
            draftAssistant: null,
            contextWindowUsage: conv.lastContextWindowUsage || null,
            lastContextWindowUsage: conv.lastContextWindowUsage || null,
            mountRefCount: 0,
            compressionConvertCallCount: conv.compressionConvertCallCount ?? 0,
            compressionLastSummaryConvertCall:
              conv.compressionLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY,
            collectedAssets: [],
          }))
          state.activeConversationId = activeId
          state.loaded = true
          state.loadError = null
          state.suggestedFollowUps.clear()
          state.cancelledRunIds.clear()
        })

        // Load messages for the active conversation (it's about to be displayed)
        if (activeId) {
          try {
            const msgRepo = getMessageRepository()
            const activeMessages = await msgRepo.findByConversation(activeId)
            set((state) => {
              const conv = state.conversations.find((c) => c.id === activeId)
              if (conv) {
                conv.messages = activeMessages as Message[]
                // Auto-heal: restore compression baseline from context_summary messages
                healCompressionBaseline(conv)
              }
            })
          } catch (error) {
            console.error(
              '[conversation.store] Failed to load messages for active conversation:',
              error
            )
          }
        }
      } catch (error) {
        console.error('[conversation.store] Failed to load conversations:', error)
        // One-shot retry, mirroring workspace.store's initialize retry.
        // A transient failure (e.g. SQLite/OPFS hydration race on cold start)
        // previously fell through to `loaded = true` with `conversations: []`,
        // which looks like "success with no data" to the rest of the app —
        // the sidebar then renders permanently empty because the only effect
        // that re-triggers loadFromDB (`if (!loaded) loadFromDB()`) never
        // fires again. Retry once before recording the error.
        try {
          await new Promise((r) => setTimeout(r, 300))
          const retryConversations = await loadConversationsMeta()
          set((state) => {
            state.conversations = retryConversations.map((conv) => ({
              ...conv,
              mountRefCount: 0,
              collectedAssets: [],
            }))
            state.activeConversationId =
              (retryConversations.length > 0 ? retryConversations[0].id : null)
            state.loaded = true
            state.loadError = null
            state.suggestedFollowUps.clear()
            state.cancelledRunIds.clear()
          })
          console.log(
            '[conversation.store] loadFromDB retry succeeded',
            { conversationCount: retryConversations.length },
          )
        } catch (retryErr) {
          console.error(
            '[conversation.store] loadFromDB retry also failed:',
            retryErr instanceof Error ? retryErr.message : retryErr,
          )
          // Do NOT set loaded=true here. Keeping loaded=false lets the
          // WorkspaceLayout effect re-run loadFromDB (e.g. on the next store
          // change) instead of permanently locking in an empty list.
          const retryMessage =
            retryErr instanceof Error ? retryErr.message : 'Failed to load conversations'
          set((state) => {
            state.loaded = false
            state.loadError = retryMessage
          })
        }
      } finally {
        inflightLoadFromDB = null
      }
    })()
      return inflightLoadFromDB
    },

    createNew: (title?: string) => {
      const conversation = createConversation(title)
      set((state) => {
        state.conversations.unshift(conversation)
        state.activeConversationId = conversation.id
      })
      // Persist metadata (creates the conversation row) + empty messages
      const metaPersist = persistConversationMeta(conversation)
        .catch((error) => {
          console.error('[conversation.store] Failed to persist new conversation:', error)
          toast.error('对话保存失败，刷新页面后可能丢失')
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
      set((state) => {
        state.activeConversationId = id
      })

      if (id) {
        // Lazy-load messages if not already loaded
        const conv = get().conversations.find((c) => c.id === id)
        if (conv && conv.messages.length === 0) {
          try {
            const msgRepo = getMessageRepository()
            const tFetch = performance.now()
            const messages = await msgRepo.findByConversation(id)
            const tDeserialize = performance.now()
            set((state) => {
              const c = state.conversations.find((c) => c.id === id)
              if (c && c.messages.length === 0) {
                c.messages = messages as Message[]
                // Auto-heal: restore compression baseline from context_summary messages
                // for conversations created before the persistence fix.
                healCompressionBaseline(c)
              }
            })
            console.log(
              `[conversation.store] setActive(${id?.slice(0, 8)}) message load (${Math.round(performance.now() - t0)}ms)`,
              {
                fetchMs: Math.round(tDeserialize - tFetch),
                messageCount: messages.length,
                immutifyMs: Math.round(performance.now() - tDeserialize),
              }
            )
          } catch (error) {
            console.error('[conversation.store] Failed to load messages for conversation:', error)
          }
        } else {
          console.log(
            `[conversation.store] setActive(${id?.slice(0, 8)}) cached (${Math.round(performance.now() - t0)}ms)`,
            { alreadyLoaded: conv ? conv.messages.length : -1 }
          )
        }
        // NOTE: workspace switching is handled by syncFromRoute in App.tsx.
        // This store only manages conversation data; it does NOT call switchWorkspace.
      }
    },

    addMessage: (conversationId, message) => {
      set((state) => {
        const conv = state.conversations.find((c) => c.id === conversationId)
        if (conv) {
          conv.messages.push(message)
          conv.updatedAt = Date.now()

          // A user message marks the start of a new loop: bump the
          // conversation's sort position (lastAccessedAt) now — NOT on click.
          if (message.role === 'user') {
            const wsState = useConversationContextStore.getState()
            const ws = wsState.workspaces.find((w) => w.id === conversationId)
            if (ws) {
              wsState.touchWorkspaceAccessTime(conversationId)
            }
          }

          if (message.role === 'user' && conv.titleMode !== 'manual' && message.content) {
            const userMessages = conv.messages.filter((m) => m.role === 'user')
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
          toast.error('消息保存失败')
        })
        // If title was auto-generated, also persist metadata
        if (conv.titleMode === 'auto' && message.role === 'user') {
          persistConversationMeta(conv).catch(() => {})
        }
      }
    },

    updateMessages: (conversationId, messages) => {
      set((state) => {
        const conv = state.conversations.find((c) => c.id === conversationId)
        if (conv) {
          const prevUserMessageCount = conv.messages.filter((m) => m.role === 'user').length

          conv.messages = messages
          conv.updatedAt = Date.now()

          const currentUserMessageCount = messages.filter((m) => m.role === 'user').length

          // A new user message marks the start of a new loop: bump the
          // conversation's sort position (lastAccessedAt) now — NOT on click.
          if (
            currentUserMessageCount > prevUserMessageCount &&
            messages.some((m) => m.role === 'user')
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
            const firstUserMessage = messages.find((m) => m.role === 'user')
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
          toast.error('消息更新保存失败')
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
      }
    },

    deleteUserMessage: (conversationId, userMessageId) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        toast.error('请先停止当前运行，再删除消息')
        return false
      }

      let deleted = false
      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return
        const idx = conv.messages.findIndex((m) => m.id === userMessageId)
        if (idx < 0 || conv.messages[idx].role !== 'user') return
        const msgTimestamp = conv.messages[idx].timestamp
        conv.messages.splice(idx, 1)
        // Invalidate compression summary if the deleted message was within the compressed range
        get().invalidateCompressionBaseline(conv, msgTimestamp)
        conv.updatedAt = Date.now()
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
          toast.error('删除消息失败')
        })
      }
      return true
    },

    deleteAgentLoop: (conversationId, userMessageId) => {
      const state = get()
      if (state.isConversationRunning(conversationId)) {
        toast.error('请先停止当前运行，再删除对话轮次')
        return false
      }

      let deleted = false
      set((draft) => {
        const conv = draft.conversations.find((c) => c.id === conversationId)
        if (!conv) return
        const startIdx = conv.messages.findIndex((m) => m.id === userMessageId)
        if (startIdx < 0 || conv.messages[startIdx].role !== 'user') return

        const loopStartTimestamp = conv.messages[startIdx].timestamp

        const idsToDelete = new Set<string>()
        idsToDelete.add(conv.messages[startIdx].id)
        for (let i = startIdx + 1; i < conv.messages.length; i++) {
          const msg = conv.messages[i]
          if (msg.role === 'user') break
          idsToDelete.add(msg.id)
        }

        conv.messages = conv.messages.filter((msg) => !idsToDelete.has(msg.id))
        // Invalidate compression summary if the deleted loop was within the compressed range
        get().invalidateCompressionBaseline(conv, loopStartTimestamp)
        conv.updatedAt = Date.now()
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
          toast.error('删除对话轮次失败')
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
      if (conv.messages[userMsgIndex].role !== 'user') {
        toast.error(i18nText('conversation.toast.onlyUserMessageRegenerate', '只能重新生成用户消息'))
        return
      }

      const userMsgTimestamp = conv.messages[userMsgIndex].timestamp

      // Find and delete all subsequent messages in the same turn (until the next user message)
      const idsToDelete = new Set<string>()
      for (let i = userMsgIndex + 1; i < conv.messages.length; i++) {
        const msg = conv.messages[i]
        if (msg.role === 'user') break
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
      if (conv.messages[userMsgIndex].role !== 'user') {
        toast.error(i18nText('conversation.toast.onlyUserMessageEditResend', '只能编辑并重发用户消息'))
        return
      }

      const userMsgTimestamp = conv.messages[userMsgIndex].timestamp

      // Find all subsequent messages in this user message's turn that need
      // clearing (up to the next user message)
      const idsToDelete = new Set<string>()
      for (let i = userMsgIndex + 1; i < conv.messages.length; i++) {
        const msg = conv.messages[i]
        if (msg.role === 'user') break
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

      // Ensure source messages are loaded
      let sourceMessages = sourceConv.messages
      if (sourceMessages.length === 0) {
        const msgRepo = getMessageRepository()
        sourceMessages = await msgRepo.findByConversation(sourceConversationId)
      }

      if (sourceMessages.length === 0) {
        throw new Error('Cannot branch an empty conversation')
      }

      // Only include messages up to (and including) the branch point
      const branchIndex = sourceMessages.findIndex((msg) => msg.id === upToMessageId)
      if (branchIndex === -1) {
        throw new Error('Branch point message not found in source conversation')
      }
      const messagesToCopy = sourceMessages.slice(0, branchIndex + 1)

      // Create a new conversation (new ID)
      const branched = createConversation()
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
        state.activeConversationId = branched.id
      })

      // Persist conversation metadata
      const metaPersist = persistConversationMeta(branched)
        .catch((error) => {
          console.error('[conversation.store] Failed to persist branched conversation:', error)
          toast.error('分支对话保存失败，刷新页面后可能丢失')
          throw error
        })
        .finally(() => {
          if (pendingConversationMetaPersists.get(branched.id) === metaPersist) {
            pendingConversationMetaPersists.delete(branched.id)
          }
        })
      pendingConversationMetaPersists.set(branched.id, metaPersist)

      // Persist messages to SQLite
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
    },

    deleteConversations: async (ids) => {
      const uniqueIds = Array.from(new Set(ids.filter((id): id is string => !!id)))
      const successIds: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const id of uniqueIds) {
        try {
          await get().deleteConversation(id)
          successIds.push(id)
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
          toast.error('标题修改保存失败')
        })
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
      const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
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
      agentOverrideId?: string | null
    ) => {
      const state = get()
      const conv = state.conversations.find((c) => c.id === conversationId)
      if (!conv) return

      if (state.isConversationRunning(conversationId)) {
        console.warn('[conversation.store] Conversation is already running:', conversationId)
        return
      }

      // Mark the favicon as "in progress" so the user can see agent
      // status from other tabs (independent of system notifications).
      // Fires immediately; no await — canvas work is async in background.
      try {
        const { setFaviconState } = await import('@/services/favicon-indicator')
        setFaviconState('running')
      } catch {
        // favicon-indicator unavailable — non-fatal
      }

      try {
        // Ensure workspace exists and is active before the agent starts.
        // This avoids write/edit/delete tools failing with "No active workspace"
        // on first-turn chats where workspace creation/switch is still in-flight.
        const workspaceStore = useConversationContextStore.getState()
        if (workspaceStore.activeWorkspaceId !== conversationId) {
          await workspaceStore.switchWorkspace(conversationId)
        }

        // FIX (parallel isolation): Resolve directoryHandle from THIS run's
        // conversationId (= workspaceId), NOT from the global active-project
        // pointer. Previously the caller passed useAgentStore.directoryHandle
        // which is a global singleton shared by all parallel runs — switching
        // the UI view (or another tab) mid-run rewrote it and caused tools to
        // read/write the WRONG project's directory. Each run now resolves its
        // own handle so parallel runs in different projects never cross-talk.
        // The legacy `directoryHandle` parameter is kept for backward-compat
        // but overridden by the per-workspace resolution below.
        let resolvedDirHandle: FileSystemDirectoryHandle | null = directoryHandle
        try {
          const { resolveWorkspaceDirectoryHandle } = await import('@/agent/tools/tool-utils')
          const wsHandle = await resolveWorkspaceDirectoryHandle(conversationId)
          if (wsHandle) {
            resolvedDirHandle = wsHandle
          }
        } catch {
          // Fall back to the caller-provided handle if per-workspace resolution fails.
        }
        directoryHandle = resolvedDirHandle

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        let runEpoch = 0
        // Ownership is deliberately in-memory and run scoped. The overlay has
        // one pending row per path, so paths already pending when this run
        // begins are never eligible for automatic application.
        const runChangedPaths = new Set<string>()
        const pendingPathsAtRunStart = new Set<string>()
        let runOwnershipReady = false
        // Captures the auto-apply snapshot for this run (set in onLoopComplete,
        // consumed after agentLoop.run resolves to attach a run_changes card).
        let runApplyResult: { snapshotId: string } | null = null
        let latestMessages: Message[] = conv.messages
        // Compression summaries are injected into the agent loop as
        // system-context messages and mirrored into the runtime message state.
        let committed = false

        // --- Delegation handoff state ---
        // When the delegate_to tool is invoked, it calls `onDelegation`
        // (registered on toolContext below) which stashes the request here.
        // After agentLoop.run resolves we check this and restart the loop
        // with the target agent persona (one-way handoff).
        let pendingDelegation: {
          targetAgentId: string
          task: string
          reason?: string
        } | null = null
        // Per-runAgent invocation depth. Read from the conversation runtime
        // state so recursive runAgent calls can inherit & increment it.
        // MAX_DELEGATION_DEPTH prevents infinite A→B→A loops.
        const MAX_DELEGATION_DEPTH = 5
        const delegationDepth = conv.delegationDepth ?? 0

        // Acquire run lock immediately to prevent concurrent duplicate starts.
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
          rt.currentToolCall = null
          rt.activeToolCalls = []
          rt.streamingToolArgs = ''
          rt.streamingToolArgsByCallId = {}
          rt.streamingContent = ''
          rt.streamingReasoning = ''
          rt.completedContent = null
          rt.completedReasoning = null
          rt.isContentStreaming = false
          rt.isReasoningStreaming = false
          rt.contextWindowUsage = null
          rt.collectedAssets = []
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
        // Mirror run-lock state to runtime store so streaming callbacks can guard on activeRunId
        useConversationRuntimeStore.setState((state) => {
          const r = ensureRuntime(state, conversationId)
          r.runEpoch = runEpoch
          r.activeRunId = runId
          r.status = 'pending'
          r.error = null
          r.currentToolCall = null
          r.activeToolCalls = []
          r.streamingToolArgs = ''
          r.streamingToolArgsByCallId = {}
          r.streamingContent = ''
          r.streamingReasoning = ''
          r.completedContent = null
          r.completedReasoning = null
          r.isContentStreaming = false
          r.isReasoningStreaming = false
          r.contextWindowUsage = null
          r.collectedAssets = []
          r.draftAssistant = {
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

        // Also set run state on the main conversation store so that
        // commitAndPersistRunningDrafts (used by beforeunload/pagehide handlers)
        // can correctly detect running conversations and save streaming drafts.
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

        const isCurrentRunEpoch = () => {
          const rt = useConversationRuntimeStore.getState().runtimes.get(conversationId)
          return !!rt && (rt.runEpoch || 0) === runEpoch
        }

        const failRunEarly = (message: string) => {
          if (!isCurrentRun()) return
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c && c.activeRunId === runId) {
              c.status = 'error'
              c.error = message
              c.activeRunId = null
              c.draftAssistant = null
              c.currentToolCall = null
              c.activeToolCalls = []
              c.streamingToolArgs = ''
              c.streamingToolArgsByCallId = {}
              c.streamingContent = ''
              c.streamingReasoning = ''
            }
          })
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId !== runId) return
            r.status = 'error'
            r.error = message
            r.activeRunId = null
            r.draftAssistant = null
            r.currentToolCall = null
            r.activeToolCalls = []
            r.streamingToolArgs = ''
            r.streamingToolArgsByCallId = {}
            r.streamingContent = ''
            r.streamingReasoning = ''
          })

          // Persist messages on early failure so that historical messages
          // (including the user message that triggered this run) are not lost
          // if the user refreshes the page.
          const errorConv = get().conversations.find((c) => c.id === conversationId)
          if (errorConv) {
            persistMessageReplace(conversationId, errorConv.messages).catch((err) => {
              console.error('[conversation.store] Failed to persist on failRunEarly:', err)
            })
          }
        }

        // Persist conversation to SQLite when a block completes (debounced).
        // Rapid block boundaries are coalesced; the final complete handler
        // will flush immediately, so at most one debounced write runs mid-stream.
        const persistAfterBlockComplete = () => {
          const current = get().conversations.find((c) => c.id === conversationId)
          if (!current) return
          persistMessageReplace(conversationId, current.messages, false).catch((err) => {
            console.warn('[conversation.store] Block-complete persist failed:', err)
          })
        }

        const lastUserMessage = [...conv.messages].reverse().find((m) => m.role === 'user')

        const apiKeyRepo = getApiKeyRepository()
        const settingsState = useSettingsStore.getState()
        const effectiveConfig = settingsState.getEffectiveProviderConfig()
        const providerConfig =
          isCustomProviderType(providerType)
            ? effectiveConfig
            : {
                apiKeyProviderKey: providerType,
                baseUrl: LLM_PROVIDER_CONFIGS[providerType].baseURL,
                modelName: modelName || LLM_PROVIDER_CONFIGS[providerType].modelName,
              }

        if (!providerConfig?.baseUrl || !providerConfig.modelName) {
          failRunEarly('请先配置自定义服务商和模型')
          return
        }

        // Custom providers may run keyless (e.g. Ollama at localhost:11434/v1):
        // no Authorization header is sent and Ollama ignores Bearer tokens, so
        // a missing key is not a hard error for them.
        const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
        if (!apiKey && !isCustomProviderType(providerType)) {
          failRunEarly('API Key 未设置，请先在设置中配置')
          return
        }

        // Resolve runtime routing context from the current conversation/workspace.
        // Do not depend on global active-project pointer for agent prompt injection.
        let resolvedProjectId: string | null = null
        let activeAgentId: string | null = null
        let knownAgentIds: Set<string> | null = null

        try {
          const { getWorkspaceRepository } =
            await import('@/sqlite/repositories/workspace.repository')
          const workspace = await getWorkspaceRepository().findWorkspaceById(conversationId)
          resolvedProjectId = workspace?.projectId || null
        } catch {
          // Ignore workspace lookup failures; agent prompt injection will be skipped without projectId.
        }

        try {
          const { useAgentsStore } = await import('./agents.store')
          const agentsState = useAgentsStore.getState()
          activeAgentId = agentsState.activeAgentId || null
          knownAgentIds = new Set(agentsState.agents.map((agent) => agent.id.toLowerCase()))
        } catch {
          // Ignore agents-store read failures and fallback to default.
        }

        const provider = createLLMProvider({
          apiKey: apiKey || '',
          providerType,
          baseUrl: providerConfig.baseUrl,
          model: providerConfig.modelName,
          apiMode: isCustomProviderType(providerType)
            ? settingsState.customProviders.find((p) => p.id === providerType)?.apiMode || 'chat-completions'
            : undefined,
        })

        const contextManager = new ContextManager({
          maxContextTokens: provider.maxContextTokens,
          reserveTokens: maxTokens,
          enableSummarization: true,
          maxMessageGroups: provider.maxContextTokens >= 200000 ? 80 : 50,
        })

        const toolRegistry = getToolRegistry()
        const toolPolicyHooks = createToolPolicyHooks()

        const normalizedOverride = agentOverrideId?.trim() || null
        const overrideFromLatestMessage = extractFirstMentionedAgentId(lastUserMessage?.content)
        const resolvedOverride = normalizedOverride || overrideFromLatestMessage

        if (resolvedOverride) {
          const normalizedResolvedOverride = resolvedOverride.toLowerCase()
          if (!knownAgentIds || knownAgentIds.has(normalizedResolvedOverride)) {
            activeAgentId = resolvedOverride
          } else {
            console.warn(
              '[conversation.store] Ignoring unknown @agent override from latest message:',
              resolvedOverride
            )
          }
        }
        if (!activeAgentId) {
          activeAgentId = 'default'
        }

        try {
          const { getWorkspaceManager } = await import('@/opfs')
          const workspace = await (await getWorkspaceManager()).getWorkspace(conversationId)
          if (workspace) {
            for (const change of workspace.getPendingChanges()) {
              pendingPathsAtRunStart.add(change.path)
            }
            runOwnershipReady = true
          }
        } catch (error) {
          // Fail closed: without a reliable baseline, leave all changes in the
          // normal manual-review queue rather than risk applying historic work.
          console.warn('[conversation.store] Unable to establish auto-apply run boundary:', error)
        }

        const configuredMaxIterations = useSettingsStore.getState().maxIterations
        const maxIterations =
          configuredMaxIterations === 0
            ? 0
            : Number.isFinite(configuredMaxIterations)
              ? Math.max(1, Math.min(100, Math.floor(configuredMaxIterations)))
              : 20

        const agentMode = getCurrentWorkspaceAgentMode()

        // Resolve OPFS workspace dir for subagent transcript storage
        let subagentGetWorkspaceDir: (() => Promise<FileSystemDirectoryHandle>) | undefined
        try {
          const { getWorkspaceManager } = await import('@/opfs')
          const wsManager = await getWorkspaceManager()
          const wsRuntime = await wsManager.getWorkspace(conversationId)
          if (wsRuntime) {
            subagentGetWorkspaceDir = async () => wsRuntime.workspaceDir
          }
        } catch {
          // Transcript storage is optional — subagent continues without it
        }

        // `getOrCreateSubagentRuntime` keeps a workspace-scoped singleton.
        // Refresh its base context for this run before any delegated task is
        // started, so child writes contribute to the same ownership set.
        const subagentRuntime = getOrCreateSubagentRuntime({
          workspaceId: conversationId,
          provider,
          toolRegistry,
          contextManager,
          baseToolContext: {
            directoryHandle,
            workspaceId: conversationId,
            projectId: resolvedProjectId,
            currentAgentId: activeAgentId,
            agentMode,
            onWorkspacePathsChanged: (paths) => {
              for (const path of paths) runChangedPaths.add(path)
            },
          },
          getWorkspaceDir: subagentGetWorkspaceDir,
          onNotification: (event: SubagentTaskNotification | SubagentStepNotification) => {
            // ── Route step_notification events to subagent draft state ──
            if (event.event_type === 'step_notification') {
              handleSubagentStepNotification(conversationId, event)
              return
            }

            // ── Handle task_notification (status updates) ──
            const subagentEvent = {
              agentId: event.agentId,
              status: event.status,
              summary: event.summary,
              timestamp: event.timestamp,
            }
            // Update conversations store
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || !c.draftAssistant) return
              const targetStep = findSpawnStepInDraft(c.draftAssistant, event.parentToolCallId)
              if (targetStep) {
                if (!targetStep.subagentEvents) targetStep.subagentEvents = []
                targetStep.subagentEvents.push(subagentEvent)
                c.updatedAt = Date.now()
              }
            })
            // Mirror to runtime store (UI reads draftAssistant from runtime store)
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (!r || !r.draftAssistant) return
              const targetStep = findSpawnStepInDraft(r.draftAssistant, event.parentToolCallId)
              if (targetStep) {
                if (!targetStep.subagentEvents) targetStep.subagentEvents = []
                targetStep.subagentEvents.push(subagentEvent)
              }
            })
          },
        })

        const agentLoop = new AgentLoop({
          provider,
          toolRegistry,
          contextManager,
          mode: agentMode,
          sessionId: conversationId,
          toolContext: {
            directoryHandle,
            workspaceId: conversationId,
            projectId: resolvedProjectId,
            currentAgentId: activeAgentId,
            agentMode,
            onWorkspacePathsChanged: (paths) => {
              for (const path of paths) runChangedPaths.add(path)
            },
            subagentRuntime,
            askUserQuestion: async (params) => {
              const { setPendingQuestion, removePendingQuestion } =
                await import('@/store/pending-question.store')
              // Use the actual toolCallId from the LLM's tool_calls response.
              // This correlates the pending question with the UI's ToolCallDisplay.
              const toolCallId =
                params.toolCallId ?? `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
              return new Promise<{ answer: string; confirmed: boolean; timed_out: boolean }>(
                (resolve) => {
                  setPendingQuestion({
                    conversationId,
                    toolCallId,
                    question: params.question,
                    type: params.type,
                    options: params.options,
                    defaultAnswer: params.defaultAnswer,
                    context: params.context,
                    resolve: (result) => {
                      removePendingQuestion(conversationId, toolCallId)
                      resolve(result)
                    },
                  })

                  // Listen for abort signal to unblock the promise on cancellation
                  if (params.signal) {
                    const onAbort = () => {
                      removePendingQuestion(conversationId, toolCallId)
                      resolve({
                        answer: params.defaultAnswer ?? 'cancelled',
                        confirmed: false,
                        timed_out: false,
                      })
                    }
                    if (params.signal.aborted) {
                      onAbort()
                    } else {
                      params.signal.addEventListener('abort', onAbort, { once: true })
                    }
                  }
                }
              )
            },
            onDelegation: (payload) => {
              // Only honour delegation from the current run; ignore stale loops.
              if (!isCurrentRun()) return
              if (delegationDepth >= MAX_DELEGATION_DEPTH) {
                console.warn(
                  '[conversation.store] delegate_to depth limit reached, ignoring handoff',
                  { conversationId, delegationDepth, target: payload.targetAgentId }
                )
                return
              }
              pendingDelegation = payload
            },
          },
          maxIterations,
          initialConvertCallCount: conv.compressionConvertCallCount ?? 0,
          initialLastSummaryConvertCall:
            conv.compressionLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY,
          initialCompressionBaseline:
            conv.compressedContextSummary && conv.compressedContextCutoffTimestamp
              ? { summary: conv.compressedContextSummary, cutoffTimestamp: conv.compressedContextCutoffTimestamp }
              : null,
          onCompressionStateUpdate: (compressionState) => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              c.compressionConvertCallCount = compressionState.convertCallCount
              c.compressionLastSummaryConvertCall = compressionState.lastSummaryConvertCall
            })
          },
          beforeToolCall: toolPolicyHooks.beforeToolCall,
          afterToolCall: async (context) => {
            if (context.isError) return undefined
            const changeTools = new Set(['write', 'edit', 'delete'])
            if (!changeTools.has(context.toolName)) return undefined
            const { useConversationContextStore } =
              await import('@/store/conversation-context.store')
            await useConversationContextStore.getState().refreshPendingChanges(true)
            return undefined
          },
          onLoopComplete: async () => {
            // Refresh pending changes after each agent loop completes
            const { useConversationContextStore } =
              await import('@/store/conversation-context.store')
            await useConversationContextStore.getState().refreshPendingChanges()

            // Apply only changes owned by this run, only while it completed
            // normally. Aborts and elicitation do not reach onLoopComplete;
            // iteration-limit stops and delegate_to handoffs are explicitly
            // excluded as incomplete/intermediate runs.
            try {
              const runtime = useConversationRuntimeStore.getState()
              const iterationLimitReached = runtime.runtimes.get(conversationId)?.iterationLimitReached
              const wasCancelled = runtime.cancelledRunIds.has(runId)
              const { useWorkspacePreferencesStore } = await import('./workspace-preferences.store')
              const preferences = useWorkspacePreferencesStore.getState()
              // Read the policy for this run's workspace directly so a user
              // navigating to another workspace while it runs cannot alter
              // its completion behavior.
              const autoApplyEnabled =
                preferences.autoApplyOnRunCompleteByWorkspace[conversationId] ?? false
              // Only auto-apply paths first made pending by this run. A path that
              // was already pending can contain unreviewed work from an earlier
              // run, even if this run updates the same overlay file.
              const eligiblePaths = [...runChangedPaths].filter(
                (path) => !pendingPathsAtRunStart.has(path),
              )

              if (
                isCurrentRun() &&
                runOwnershipReady &&
                !wasCancelled &&
                iterationLimitReached === null &&
                !pendingDelegation &&
                autoApplyEnabled &&
                eligiblePaths.length > 0
              ) {
                const [{ getWorkspaceManager }, { autoApplyCompletedRunChanges }] = await Promise.all([
                  import('@/opfs'),
                  import('@/agent/auto-apply-run-changes'),
                ])
                const workspace = await (await getWorkspaceManager()).getWorkspace(conversationId)
                if (workspace) {
                  const applyResult = await autoApplyCompletedRunChanges(
                    workspace,
                    eligiblePaths,
                    () => useConversationContextStore.getState().refreshPendingChanges(true),
                    runId,
                  )
                  // Remember the snapshot so a "what this run changed" card can be
                  // appended to this run's message history after finalize commits.
                  if (applyResult.status === 'synced') {
                    runApplyResult = { snapshotId: applyResult.snapshotId }
                  } else if (applyResult.status === 'partial' && applyResult.snapshotId) {
                    runApplyResult = { snapshotId: applyResult.snapshotId }
                  }
                }
              }
            } catch (error) {
              // Auto-apply is best effort and must never convert an otherwise
              // successful run into an agent failure. Pending changes remain
              // available through the existing manual review queue.
              console.warn('[conversation.store] Auto-apply after completed run failed:', error)
            }

            // === Exec auto-flush snapshots (REMOVED in PR-3) ===
            // The exec tool no longer flushes pending changes to disk before
            // running commands (that was an authorization bypass). Disk sync
            // now happens exclusively through sync-to-disk (authorized) or
            // the run-level auto-apply below. Nothing to drain here anymore.

            // === Favicon handling ===
            // Always reset to idle when the loop ends — the user will see
            // the result either in-page (if viewing) or via the system
            // notification (if not). No lingering "pending" dot.
            try {
              const { setFaviconState } = await import('@/services/favicon-indicator')
              setFaviconState('idle')
            } catch {
              // non-fatal
            }

            // === Notification handling ===
            // Only notify when the user is NOT actively looking at this conversation.
            try {
              const hash = window.location.hash
              const match = hash.match(/\/workspaces?\/([^/?]+)/)
              const activeWorkspaceId = match ? decodeURIComponent(match[1]) : null
              const isVisible = document.visibilityState === 'visible'
              const isViewingConversation = activeWorkspaceId === conversationId && isVisible

              // User is viewing this conversation — don't notify.
              if (isViewingConversation) return

              const { notifyAgentComplete } = await import('@/services/agent-notification')
              const currentConv = get().conversations.find((c) => c.id === conversationId)
              if (!currentConv) return
              // Project ID sources, in priority order:
              //   1. resolvedProjectId (from workspace repo lookup at run start)
              //   2. activeProjectId from project store (sync, always present)
              // resolvedProjectId can be null if the workspace lookup at run
              // start raced or failed — fall back to the active project.
              let notifProjectId = resolvedProjectId
              if (!notifProjectId) {
                try {
                  const { useProjectStore } = await import('@/store/project.store')
                  notifProjectId = useProjectStore.getState().activeProjectId || null
                } catch {
                  // ignore
                }
              }
              if (!notifProjectId) return

              // Build a short summary from the last assistant message
              const lastAssistant = [...currentConv.messages]
                .reverse()
                .find((m) => m.role === 'assistant' && (m.content || '').trim().length > 0)
              const summary = lastAssistant
                ? summarizeForNotification(lastAssistant.content ?? '')
                : '已完成'

              await notifyAgentComplete({
                conversationId,
                projectId: notifProjectId,
                title: currentConv.title ?? 'EO2Weave Agent',
                body: summary,
              })
            } catch (err) {
              console.warn('[conversation.store] notify failed:', err)
            }
          },
          // Soft-interrupt at tool boundaries: after each tool call completes,
          // check whether a user message was queued. If so, yield the loop so
          // the runAgent flow can dequeue and start a fresh turn — matching
          // Codex/Claude Code's "interrupt at tool boundary" feel instead of
          // waiting for the entire agent run to finish.
          shouldYieldForQueue: () =>
            useConversationRuntimeStore.getState().getQueueDepth(conversationId) > 0,
        })

        setAgentLoop(conversationId, agentLoop)

        const currentMessages = conv.messages

        const finalizeRun = async (
          status: ConversationStatus,
          finalMessages?: Message[],
          error?: string
        ) => {
          // If already committed, nothing to do
          if (committed) return
          // Unregister the live loop up front; the rest of finalize only
          // touches persisted state.
          deleteAgentLoop(conversationId)

          // Only the current run is allowed to commit message state.
          // Stale callbacks from prior runs (e.g. after project/workspace switch
          // or elicitation-triggered nested run) must never overwrite UI history.
          const current = get().conversations.find((c) => c.id === conversationId)
          const isRunCurrent =
            !!current && current.activeRunId === runId && (current.runEpoch || 0) === runEpoch
          const isSameEpoch = !!current && (current.runEpoch || 0) === runEpoch
          if (!isRunCurrent && !isSameEpoch) {
            console.info('[conversation.store] skip finalize from stale run', {
              conversationId,
              runId,
              status,
            })
            return
          }

          committed = true
          const currentSnapshot = get().conversations.find((c) => c.id === conversationId)?.messages || []
          const targetMessages = reconcileMessageSnapshot(currentSnapshot, finalMessages || latestMessages)
          const derivedUsageAtFinalize = deriveContextUsageFromAssistantUsage(
            targetMessages,
            provider.maxContextTokens,
            maxTokens
          )
          const usageAtFinalize = derivedUsageAtFinalize

          // Collect any assets accumulated during this agent run before overwriting messages
          const currentConv = get().conversations.find((c) => c.id === conversationId)
          const collectedAssets = currentConv?.collectedAssets?.length
            ? [...currentConv.collectedAssets]
            : undefined

          // targetMessages may come from an Immer-frozen source.
          // Build a fresh array/object snapshot before putting it back into state.
          const finalizedMessages =
            status === 'idle' && collectedAssets && collectedAssets.length > 0
              ? (() => {
                  const cloned = targetMessages.slice()
                  for (let i = cloned.length - 1; i >= 0; i--) {
                    // Skip run_changes cards — they carry no generated assets.
                    if (cloned[i].role === 'assistant' && cloned[i].kind !== 'run_changes') {
                      cloned[i] = {
                        ...cloned[i],
                        assets: collectedAssets,
                      }
                      break
                    }
                  }
                  return cloned
                })()
              : targetMessages

          set((inner) => {
            const c = inner.conversations.find((x) => x.id === conversationId)
            if (!c) return
            if (status === 'idle') {
              c.messages = finalizedMessages
              if (usageAtFinalize) {
                c.contextWindowUsage = usageAtFinalize
                c.lastContextWindowUsage = usageAtFinalize
              }
              c.collectedAssets = []
            }
            c.status = status
            c.error = error || null
            c.currentToolCall = null
            c.activeToolCalls = []
            c.streamingToolArgs = ''
            c.streamingToolArgsByCallId = {}
            c.streamingContent = ''
            c.streamingReasoning = ''
            c.completedContent = null
            c.completedReasoning = null
            c.isContentStreaming = false
            c.isReasoningStreaming = false
            c.draftAssistant = null
            c.activeRunId = null
            if (status === 'idle') {
              inner.cancelledRunIds.delete(runId)
            }
          })
          deleteStreamingQueues(conversationId)

          // Reset runtime store for this conversation
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = status
              r.error = error || null
              r.currentToolCall = null
              r.activeToolCalls = []
              r.streamingToolArgs = ''
              r.streamingToolArgsByCallId = {}
              r.streamingContent = ''
              r.streamingReasoning = ''
              r.completedContent = null
              r.completedReasoning = null
              r.isContentStreaming = false
              r.isReasoningStreaming = false
              r.draftAssistant = null
              r.activeRunId = null
              if (status === 'idle') {
                r.collectedAssets = []
                if (usageAtFinalize) {
                  r.contextWindowUsage = usageAtFinalize
                }
                // Keep r.contextWindowUsage so the ContextUsageBar remains visible
                // after the agent loop finishes. It will be cleared when a new
                // run starts (runAgent).
              }
            }
          })

          if (status === 'idle') {
            emitComplete()
            const finalConv = get().conversations.find((c) => c.id === conversationId)
            if (finalConv)
              persistMessageReplace(conversationId, finalConv.messages).catch((err) => {
                console.error(
                  '[conversation.store] Failed to persist conversation on complete:',
                  err
                )
                toast.error('对话保存失败，部分内容可能丢失')
              })
            if (finalConv) {
              persistConversationMeta(finalConv).catch((err) => {
                console.warn(
                  '[conversation.store] Failed to persist context usage meta on complete:',
                  err
                )
              })
            }

            try {
              const { useConversationContextStore } =
                await import('@/store/conversation-context.store')
              await useConversationContextStore.getState().refreshPendingChanges(true)
            } catch (err) {
              console.warn(
                '[conversation.store] Failed to refresh pending changes on complete:',
                err
              )
            }

            // Refresh asset inventory so the AssetsPopover badge stays up-to-date
            try {
              const { useAssetInventoryStore } = await import('@/store/asset-inventory.store')
              useAssetInventoryStore.getState().refresh().catch(() => {})
            } catch {
              // Non-critical — asset inventory refresh failure should not affect the loop
            }

            // Only generate follow-up on successful (non-cancelled, non-error) completion
            const runWasCancelled = get().cancelledRunIds.has(runId)
            if (!runWasCancelled) {
              try {
                const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
                if (apiKey) {
                  const suggestion = await generateFollowUp(targetMessages, providerType, apiKey)
                  if (suggestion) {
                    get().setSuggestedFollowUp(conversationId, suggestion)
                  }
                }
              } catch (err) {
                if (process.env.NODE_ENV !== 'production') console.error('[conversation.store] Failed to generate follow-up:', err)
              }

              // Auto-generate a topic title using the current model.
              // Only fires within the first 2 user turns and only overwrites
              // titles that are still in 'auto' mode (not user-edited).
              try {
                const titleConv = get().conversations.find((c) => c.id === conversationId)
                const userTurnCount = titleConv?.messages.filter(
                  (m) => m.role === 'user' && (m.content || '').trim().length > 0
                ).length ?? 0
                if (titleConv && titleConv.titleMode !== 'manual' && userTurnCount <= 2) {
                  get().generateTitle(conversationId, false)
                }
              } catch (err) {
                if (process.env.NODE_ENV !== 'production') console.error('[conversation.store] Failed to auto-generate title:', err)
              }
            }
            // Clean up cancelled run ID tracking (moved inside set() above)
          }
        }

        // Reasoning streaming queue
        let fullReasoningAccumulator = ''
        const reasoningQueue = new StreamingQueue((_key: string, accumulated: string) => {
          fullReasoningAccumulator += accumulated
          // Write to runtime store only — avoids touching conversations[] at 60fps
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.streamingReasoning = fullReasoningAccumulator
              applyDraftAssistantEvent(r, {
                type: 'reasoning_stream_sync',
                reasoning: fullReasoningAccumulator,
              })
            }
          })
        })

        // Content streaming queue
        // Note: The accumulated value from queue is per-frame, but we maintain
        // the full accumulated content in store.state.streamingContent separately
        let fullContentAccumulator = ''
        const contentQueue = new StreamingQueue((_key: string, accumulated: string) => {
          fullContentAccumulator += accumulated
          // Write to runtime store only — avoids touching conversations[] at 60fps
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.streamingContent = fullContentAccumulator
              applyDraftAssistantEvent(r, {
                type: 'content_stream_sync',
                content: fullContentAccumulator,
              })
            }
          })
        })

        setStreamingQueues(conversationId, {
          reasoning: reasoningQueue,
          content: contentQueue,
        })

        const cleanupQueues = () => {
          reasoningQueue.destroy()
          contentQueue.destroy()
          deleteStreamingQueues(conversationId)
        }

        // Clear iteration limit flag from any previous run
        useConversationRuntimeStore.setState((state) => {
          const r = state.runtimes.get(conversationId)
          if (r) {
            r.iterationLimitReached = null
          }
        })

        const resultMessages = await agentLoop.run(currentMessages, {
          onMessageStart: () => {
            if (!isCurrentRun()) return
            // Reset accumulators for new message
            fullContentAccumulator = ''
            fullReasoningAccumulator = ''
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.streamingContent = ''
                c.streamingReasoning = ''
                c.isReasoningStreaming = false
                c.completedReasoning = ''
                c.isContentStreaming = false
                c.completedContent = ''
                applyDraftAssistantEvent(c, { type: 'message_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.streamingContent = ''
                r.streamingReasoning = ''
                r.isReasoningStreaming = false
                r.completedReasoning = ''
                r.isContentStreaming = false
                r.completedContent = ''
                applyDraftAssistantEvent(r, { type: 'message_start' })
              }
            })
          },
          onReasoningStart: () => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'streaming'
                c.isReasoningStreaming = true
                applyDraftAssistantEvent(c, { type: 'reasoning_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'streaming'
                r.isReasoningStreaming = true
                applyDraftAssistantEvent(r, { type: 'reasoning_start' })
              }
            })
            emitThinkingStart()
          },
          onReasoningDelta: (delta: string) => {
            if (!isCurrentRun()) return
            reasoningQueue.add('reasoning', delta)
            emitThinkingDelta(delta)
          },
          onReasoningComplete: (reasoning: string) => {
            if (!isCurrentRun()) return
            reasoningQueue.flushNow()
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.isReasoningStreaming = false
                c.completedReasoning = reasoning
                c.streamingReasoning = ''
                applyDraftAssistantEvent(c, {
                  type: 'reasoning_complete',
                  reasoning,
                })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.isReasoningStreaming = false
                r.completedReasoning = reasoning
                r.streamingReasoning = ''
                applyDraftAssistantEvent(r, {
                  type: 'reasoning_complete',
                  reasoning,
                })
              }
            })
          },
          onContentStart: () => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'streaming'
                c.isContentStreaming = true
                applyDraftAssistantEvent(c, { type: 'content_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'streaming'
                r.isContentStreaming = true
                applyDraftAssistantEvent(r, { type: 'content_start' })
              }
            })
          },
          onContentDelta: (delta: string) => {
            if (!isCurrentRun()) return
            contentQueue.add('content', delta)
          },
          onContentComplete: (content: string) => {
            if (!isCurrentRun()) return
            contentQueue.flushNow()
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.isContentStreaming = false
                c.completedContent = content
                c.streamingContent = ''
                applyDraftAssistantEvent(c, {
                  type: 'content_complete',
                  content,
                })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.isContentStreaming = false
                r.completedContent = content
                r.streamingContent = ''
                applyDraftAssistantEvent(r, {
                  type: 'content_complete',
                  content,
                })
              }
            })
          },
          onToolCallStart: (tc: ToolCall) => {
            if (!isCurrentRun()) return
            const existingConversation = get().conversations.find((c) => c.id === conversationId)
            const shouldEmitToolStart =
              existingConversation?.activeRunId === runId
                ? existingConversation.currentToolCall?.id !== tc.id
                : true
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'tool_calling'
                const isSameTool = c.currentToolCall?.id === tc.id
                c.currentToolCall = tc
                c.activeToolCalls = c.activeToolCalls || []
                if (!c.activeToolCalls.some((x) => x.id === tc.id)) {
                  c.activeToolCalls.push(tc)
                }
                c.streamingToolArgsByCallId = c.streamingToolArgsByCallId || {}
                if (!c.streamingToolArgsByCallId[tc.id]) {
                  c.streamingToolArgsByCallId[tc.id] = ''
                }
                applyDraftAssistantEvent(c, {
                  type: 'tool_start',
                  toolCall: tc,
                })
                // Keep already streamed args when the same tool transitions
                // from "stream preview" to actual execution.
                if (!isSameTool) {
                  c.streamingToolArgs = ''
                  if (c.draftAssistant) {
                    c.draftAssistant.toolArgs = ''
                  }
                }
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'tool_calling'
                const isSameTool = r.currentToolCall?.id === tc.id
                r.currentToolCall = tc
                r.activeToolCalls = r.activeToolCalls || []
                if (!r.activeToolCalls.some((x) => x.id === tc.id)) {
                  r.activeToolCalls.push(tc)
                }
                r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                if (!r.streamingToolArgsByCallId[tc.id]) {
                  r.streamingToolArgsByCallId[tc.id] = ''
                }
                applyDraftAssistantEvent(r, {
                  type: 'tool_start',
                  toolCall: tc,
                })
                if (!isSameTool) {
                  r.streamingToolArgs = ''
                  if (r.draftAssistant) {
                    r.draftAssistant.toolArgs = ''
                  }
                }
              }
            })
            if (shouldEmitToolStart) {
              emitToolStart({
                name: tc.function.name,
                args: tc.function.arguments,
                id: tc.id,
              })
            }
          },
          onToolCallDelta: (_index: number, argsDelta: string, toolCallId?: string) => {
            if (!isCurrentRun()) return
            // Write to runtime store only — avoids touching conversations[] at 60fps
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId && r.draftAssistant) {
                const isCurrentToolDelta = !toolCallId || r.currentToolCall?.id === toolCallId
                if (isCurrentToolDelta) {
                  r.streamingToolArgs += argsDelta
                }
                if (toolCallId) {
                  r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                  r.streamingToolArgsByCallId[toolCallId] =
                    (r.streamingToolArgsByCallId[toolCallId] || '') + argsDelta
                }
                applyDraftAssistantEvent(r, {
                  type: 'tool_delta',
                  argsDelta,
                  toolCallId,
                  isCurrentToolDelta: !!isCurrentToolDelta,
                })
              }
            })
          },
          onToolCallComplete: (tc: ToolCall, _result: string) => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                const isCurrentTool = c.currentToolCall?.id === tc.id

                if (isCurrentTool) {
                  c.currentToolCall = null
                  c.streamingToolArgs = ''
                }
                c.activeToolCalls = (c.activeToolCalls || []).filter((x) => x.id !== tc.id)

                // Check if there are more tools to execute
                const hasMoreTools = (c.activeToolCalls || []).length > 0
                if (hasMoreTools) {
                  // Continue with next tool
                  c.currentToolCall = c.activeToolCalls[c.activeToolCalls.length - 1]
                  c.streamingToolArgs =
                    (c.streamingToolArgsByCallId || {})[c.currentToolCall.id] || ''
                  // Keep status as 'tool_calling' since we're still executing tools
                  c.status = 'tool_calling'
                } else {
                  // All tools completed, waiting for next model response
                  // Set status to 'pending' to show loading effect
                  c.status = 'pending'
                }

                c.streamingToolArgsByCallId = c.streamingToolArgsByCallId || {}

                applyDraftAssistantEvent(c, {
                  type: 'tool_complete',
                  toolCall: tc,
                  result: _result,
                  isCurrentTool,
                  nextToolCall: c.currentToolCall,
                  streamedArgsByCallId: c.streamingToolArgsByCallId,
                })

                delete c.streamingToolArgsByCallId[tc.id]
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                const isCurrentTool = r.currentToolCall?.id === tc.id
                if (isCurrentTool) {
                  r.currentToolCall = null
                  r.streamingToolArgs = ''
                }
                r.activeToolCalls = (r.activeToolCalls || []).filter((x) => x.id !== tc.id)
                const hasMoreTools = (r.activeToolCalls || []).length > 0
                if (hasMoreTools) {
                  r.currentToolCall = r.activeToolCalls[r.activeToolCalls.length - 1]
                  r.streamingToolArgs =
                    (r.streamingToolArgsByCallId || {})[r.currentToolCall.id] || ''
                  r.status = 'tool_calling'
                } else {
                  r.status = 'pending'
                }
                r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                applyDraftAssistantEvent(r, {
                  type: 'tool_complete',
                  toolCall: tc,
                  result: _result,
                  isCurrentTool,
                  nextToolCall: r.currentToolCall,
                  streamedArgsByCallId: r.streamingToolArgsByCallId,
                })
                delete r.streamingToolArgsByCallId[tc.id]
              }
            })

            // ── Auto-refresh agents list when write/delete tools touch agents/ directory ──
            // Detects paths like vfs://agents/{id}/... and refreshes useAgentsStore so the
            // @-mention dropdown picks up newly created agents without a page reload.
            try {
              const toolName = tc.function.name
              if (toolName === 'write' || toolName === 'delete') {
                const args = JSON.parse(tc.function.arguments)
                const paths: string[] = args.path
                  ? [args.path]
                  : Array.isArray(args.files)
                    ? args.files.map((f: { path: string }) => f.path)
                    : Array.isArray(args.paths)
                      ? args.paths
                      : []
                const touchesAgents = paths.some((p: string) => {
                  const norm = p.replace(/^vfs:\/\/workspace\//, '')
                  return norm.startsWith('agents/') || p.startsWith('vfs://agents/')
                })
                if (touchesAgents) {
                  import('./agents.store').then(({ useAgentsStore }) => {
                    useAgentsStore.getState().refreshAgents()
                  })
                }
              }
            } catch {
              // Best-effort: never let agent-refresh failure break tool completion
            }
          },
          onContextCompressionStart: (payload) => {
            if (!isCurrentRun()) return
            emitCompressionEvent({
              phase: 'start',
              droppedGroups: payload.droppedGroups,
              droppedContentChars: payload.droppedContentChars,
            })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              if (c.status !== 'streaming' && c.status !== 'tool_calling') {
                c.status = 'pending'
              }
              applyDraftAssistantEvent(c, { type: 'compression_start' })
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                if (r.status !== 'streaming' && r.status !== 'tool_calling') {
                  r.status = 'pending'
                }
                applyDraftAssistantEvent(r, { type: 'compression_start' })
              }
            })
          },
          onContextCompressionComplete: (payload) => {
            if (!isCurrentRun()) return
            emitCompressionEvent({
              phase: 'complete',
              mode: payload.mode,
              droppedGroups: payload.droppedGroups,
              droppedContentChars: payload.droppedContentChars,
              summaryChars: payload.summaryChars,
              latencyMs: payload.latencyMs,
            })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              applyDraftAssistantEvent(c, {
                type: 'compression_complete',
                mode: payload.mode === 'skip' ? 'skip' : 'compress',
              })
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                applyDraftAssistantEvent(r, {
                  type: 'compression_complete',
                  mode: payload.mode === 'skip' ? 'skip' : 'compress',
                })
              }
            })
            // Summary message is now injected by AgentLoop directly into
            // allMessages via onMessagesUpdated, so no need to collect it here.
          },
          // SEP-1306: Handle binary elicitation for file uploads
          onElicitation: async (elicitation: any) => {
            if (!isCurrentRun()) return
            console.log('[conversation.store] SEP-1306 elicitation:', elicitation)

            try {
              // Get the server config for auth token
              const mcpManager = (await import('@/mcp/mcp-manager')).getMCPManager()
              await mcpManager.initialize()
              const server = mcpManager.getServer(elicitation.serverId)

              if (!server) {
                throw new Error(`MCP server not found: ${elicitation.serverId}`)
              }

              const authToken = server?.token

              // Show file picker and upload via ElicitationHandler
              // The elicitation object contains full BinaryElicitation data from the server
              const handler = getElicitationHandler()
              const metadata = await handler.handleBinaryElicitation(
                {
                  mode: elicitation.mode,
                  message: elicitation.message,
                  requestedSchema: elicitation.requestedSchema || {
                    type: 'object',
                    properties: {},
                  },
                  uploadEndpoints: elicitation.uploadEndpoints || {},
                },
                {
                  // Pass tool args for OPFS file lookup (priority)
                  toolArgs: elicitation.args,
                  // Pass directory handle for OPFS access
                  directoryHandle,
                },
                authToken
              )

              // Add tool result message with the file metadata
              // This completes the pending tool call with the upload result
              // IMPORTANT: Tell the LLM to retry with the new download_url using natural language
              const { createToolMessage } = await import('@/agent/message-types')

              // Get the file field name from uploadEndpoints (dynamic, not hardcoded)
              const uploadEndpoints = elicitation.uploadEndpoints || {}
              const fileFieldName = Object.keys(uploadEndpoints)[0] || 'file'

              // Extract original args excluding the file field (we'll replace it)
              const originalArgs = { ...(elicitation.args || {}) }
              delete originalArgs[fileFieldName]

              // Build natural language instruction for LLM to retry
              let retryInstruction = `文件已上传成功。请重新调用 ${elicitation.toolName} 工具，使用以下参数：\n\n`
              retryInstruction += `{\n`
              retryInstruction += `  "${fileFieldName}": {\n`
              retryInstruction += `    "download_url": "${metadata.download_url}",\n`
              retryInstruction += `    "file_id": "${metadata.file_id}"\n`
              retryInstruction += `  }`

              // Add other original args (like question)
              for (const [key, value] of Object.entries(originalArgs)) {
                retryInstruction += `,\n  "${key}": ${JSON.stringify(value)}`
              }
              retryInstruction += `\n}`

              const toolResultMsg = createToolMessage({
                toolCallId: elicitation.toolCallId || 'unknown',
                name: elicitation.toolName,
                content: retryInstruction,
              })

              get().addMessage(conversationId, toolResultMsg)

              // Resume agent loop with the tool result
              // First, manually clean up the previous agentLoop state
              deleteAgentLoop(conversationId)
              set((state) => {
                const c = state.conversations.find((c) => c.id === conversationId)
                if (c) {
                  c.status = 'idle'
                  c.error = null
                  c.activeRunId = null
                  c.draftAssistant = null
                }
              })

              // Now start a new agent loop with the updated messages
              await get().runAgent(
                conversationId,
                providerType,
                modelName,
                maxTokens,
                directoryHandle,
                activeAgentId
              )
            } catch (error) {
              console.error('[conversation.store] Elicitation failed:', error)
              const errorMsg = error instanceof Error ? error.message : String(error)

              // Add tool result with error
              const { createToolMessage } = await import('@/agent/message-types')
              const errorResultMsg = createToolMessage({
                toolCallId: elicitation.toolCallId || 'unknown',
                name: elicitation.toolName,
                content: JSON.stringify({
                  error: `文件上传失败: ${errorMsg}`,
                }),
              })
              get().addMessage(conversationId, errorResultMsg)

              deleteAgentLoop(conversationId)
              set((state) => {
                const c = state.conversations.find((c) => c.id === conversationId)
                if (c) {
                  c.status = 'error'
                  c.error = errorMsg
                }
              })
              emitError(errorMsg)
            }
          },
          onMessagesUpdated: (msgs: Message[]) => {
            if (!isCurrentRun() && !isCurrentRunEpoch()) return
            const previous = get().conversations.find((x) => x.id === conversationId)?.messages || []
            const currentDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
            const messagesWithReasoningDurations = attachReasoningDurations(msgs, currentDraft)
            const reconciled = reconcileMessageSnapshot(previous, messagesWithReasoningDurations)
            latestMessages = reconciled
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || (c.runEpoch || 0) !== runEpoch) return
              c.messages = reconciled
              c.compressedContextSummary =
                reconciled.find((msg) => msg.kind === 'context_summary')?.content || c.compressedContextSummary || null
              c.compressedContextCutoffTimestamp =
                reconciled.find((msg) => msg.kind === 'context_summary')?.timestamp ||
                c.compressedContextCutoffTimestamp ||
                null
              c.updatedAt = Date.now()
              // Evict draft entries already committed to messages.
              // This prevents commitDraftToMessages (cancel path) from duplicating them.
              if (c.draftAssistant) {
                // Clean up tool calls/results already in committed messages
                const committedToolCallIds = new Set(
                  reconciled
                    .filter((m) => m.role === 'assistant' && m.toolCalls)
                    .flatMap((m) => m.toolCalls!.map((tc) => tc.id))
                )
                if (committedToolCallIds.size > 0) {
                  c.draftAssistant.toolCalls = c.draftAssistant.toolCalls.filter(
                    (tc) => !committedToolCallIds.has(tc.id)
                  )
                  for (const id of committedToolCallIds) {
                    delete c.draftAssistant.toolResults[id]
                  }
                }
                // Clean up reasoning/content already in committed messages.
                // The last committed assistant message carries the full text and
                // reasoning from this iteration — subsequent commits must not replay them.
                const lastAssistant = [...reconciled].reverse().find((m) => m.role === 'assistant')
                if (lastAssistant) {
                  if (lastAssistant.reasoning) {
                    c.draftAssistant.reasoning = ''
                  }
                  if (lastAssistant.content) {
                    c.draftAssistant.content = ''
                  }
                }
                // Remove completed steps whose content is now in committed messages
                c.draftAssistant.steps = c.draftAssistant.steps.filter((s) => {
                  if (s.streaming) return true
                  if (s.type === 'tool_call' && committedToolCallIds.has(s.toolCall.id)) return false
                  if ((s.type === 'reasoning' || s.type === 'content') && lastAssistant) return false
                  return true
                })
              }
            })
            const latestAssistant = [...reconciled]
              .reverse()
              .find((m) => m.role === 'assistant' && m.usage)
            if (latestAssistant?.usage) {
              const modelMaxTokens = provider.maxContextTokens
              const reserveTokens = maxTokens
              const maxInputTokens = Math.max(1, modelMaxTokens - reserveTokens)
              const usedTokens =
                latestAssistant.usage.totalTokens ??
                latestAssistant.usage.promptTokens + latestAssistant.usage.completionTokens
              const usagePercent = Math.max(0, Math.min(100, (usedTokens / modelMaxTokens) * 100))
              const usage: ContextWindowUsage = {
                usedTokens,
                maxTokens: maxInputTokens,
                reserveTokens,
                usagePercent,
                modelMaxTokens,
              }
              set((state) => {
                const c = state.conversations.find((x) => x.id === conversationId)
                if (!c || (c.runEpoch || 0) !== runEpoch) return
                c.contextWindowUsage = usage
                c.lastContextWindowUsage = usage
              })
              useConversationRuntimeStore.setState((state) => {
                const r = ensureRuntime(state, conversationId)
                if ((r.runEpoch || 0) === runEpoch) {
                  r.contextWindowUsage = usage
                }
              })
            }
            // Persist immediately — this callback fires at block boundaries
            // (message_end), so it's the right time to save.
            persistAfterBlockComplete()
            // Sync draft eviction to runtime store
            const committedIds = new Set(
              reconciled
                .filter((m) => m.role === 'assistant' && m.toolCalls)
                .flatMap((m) => m.toolCalls!.map((tc) => tc.id))
            )
            const lastAssistantMsg = [...reconciled].reverse().find((m) => m.role === 'assistant')
            if (committedIds.size > 0 || lastAssistantMsg) {
              useConversationRuntimeStore.setState((state) => {
                const r = state.runtimes.get(conversationId)
                if (r?.draftAssistant && (r.runEpoch || 0) === runEpoch) {
                  if (committedIds.size > 0) {
                    r.draftAssistant.toolCalls = r.draftAssistant.toolCalls.filter(
                      (tc) => !committedIds.has(tc.id)
                    )
                    for (const id of committedIds) {
                      delete r.draftAssistant.toolResults[id]
                    }
                  }
                  if (lastAssistantMsg) {
                    if (lastAssistantMsg.reasoning) {
                      r.draftAssistant.reasoning = ''
                    }
                    if (lastAssistantMsg.content) {
                      r.draftAssistant.content = ''
                    }
                  }
                  r.draftAssistant.steps = r.draftAssistant.steps.filter((s) => {
                    if (s.streaming) return true
                    if (s.type === 'tool_call' && committedIds.has(s.toolCall.id)) return false
                    if ((s.type === 'reasoning' || s.type === 'content') && lastAssistantMsg) return false
                    return true
                  })
                }
              })
            }
          },
          onComplete: async (msgs: Message[]) => {
            if (!isCurrentRun() && !isCurrentRunEpoch()) return
            const previous = get().conversations.find((x) => x.id === conversationId)?.messages || []
            const currentDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
            const messagesWithReasoningDurations = attachReasoningDurations(msgs, currentDraft)
            const reconciled = reconcileMessageSnapshot(previous, messagesWithReasoningDurations)
            console.info('[#LoopStop] store_onComplete', {
              conversationId,
              runId,
              messagesCount: reconciled.length,
            })
            latestMessages = reconciled
            // Attach the auto-apply snapshot card to this run's message history so
            // the user sees "what this run changed". onComplete runs right after
            // onLoopComplete (where auto-apply set runApplyResult), and is the
            // first/effective finalize point — the later finalizeRun call after
            // agentLoop.run resolves is short-circuited by the `committed` guard.
            if (runApplyResult) {
              latestMessages = [...latestMessages, createRunChangesMessage(runApplyResult.snapshotId)]
            }
            reasoningQueue.flushNow()
            contentQueue.flushNow()
            cleanupQueues()
            await finalizeRun('idle', latestMessages)
          },
          onError: (err: Error) => {
            if (!isCurrentRun()) return
            console.error('[#LoopStop] store_onError', {
              conversationId,
              runId,
              error: err.message,
            })
            reasoningQueue.flushNow()
            contentQueue.flushNow()
            cleanupQueues()
            deleteAgentLoop(conversationId)
            deleteStreamingQueues(conversationId)
            set((inner) => {
              const c = inner.conversations.find((x) => x.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'error'
                c.error = err.message
                c.activeRunId = null
                c.draftAssistant = null
              }
            })
            // Reset runtime store on error
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (r) {
                r.status = 'error'
                r.error = err.message
                r.activeRunId = null
                r.draftAssistant = null
              }
            })
            // Persist messages on error so that historical messages are not lost
            // on page refresh. Without this, only the in-memory store retains
            // messages after an LLM error.
            const errorConv = get().conversations.find((x) => x.id === conversationId)
            if (errorConv) {
              persistMessageReplace(conversationId, errorConv.messages).catch((persistErr) => {
                console.error('[conversation.store] Failed to persist on onError:', persistErr)
              })
            }
            emitError(err.message)
          },
          onIterationLimitReached: (limit: number) => {
            if (!isCurrentRun()) return
            console.info('[#LoopStop] iteration_limit_reached', {
              conversationId,
              runId,
              limit,
            })
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (r) {
                r.iterationLimitReached = limit
              }
            })
          },
        })
        const previousMessages = get().conversations.find((x) => x.id === conversationId)?.messages || []
        latestMessages = reconcileMessageSnapshot(previousMessages, resultMessages)
        await finalizeRun('idle', latestMessages)

        // ─── delegate_to handoff ───────────────────────────────────────────
        // If delegate_to was called during this run, restart the loop with the
        // target agent persona. finalizeRun above already cleaned up the
        // current run's state (status='idle', activeRunId=null, loop deleted),
        // so we can safely start a fresh run.
        //
        // We inject ONE synthetic user-role "delegation note" message before
        // restarting. This is required by the LLM API: the previous run ended
        // with an assistant turn, and the API rejects "Cannot continue from
        // message role: assistant" without an intervening user/tool message.
        // The note carries the task framing + a `delegationNote` metadata
        // flag so the UI can render it as a system card instead of a user
        // chat bubble.
        if (pendingDelegation && isCurrentRunEpoch()) {
          const { targetAgentId, task, reason } = pendingDelegation
          pendingDelegation = null

          // Dynamic import to avoid circular dependency
          // (agents.store → project.store → conversation.store).
          const { useAgentsStore } = await import('./agents.store')
          const agentsState = useAgentsStore.getState()
          const sourceAgent = agentsState.agents.find((a) => a.id === activeAgentId)
          const targetAgent = agentsState.agents.find((a) => a.id === targetAgentId)

          // Sync the agents store so the UI shows the target persona active.
          void agentsState.setActiveAgent(targetAgentId)

          // Inject the delegation note as a user-role message. The content
          // doubles as the target agent's framing; `delegationNote` metadata
          // marks it as system-injected so the UI can render it specially.
          const note: Message = {
            id: `${Date.now()}-delegation-${Math.random().toString(36).slice(2, 9)}`,
            role: 'user',
            content: `[Delegated task from ${sourceAgent?.name ?? activeAgentId}]: ${task}`,
            timestamp: Date.now(),
            delegationNote: {
              fromAgentId: activeAgentId ?? 'default',
              fromAgentName: sourceAgent?.name,
              task,
              ...(reason ? { reason } : {}),
            },
          }
          get().addMessage(conversationId, note)

          // Stash the incremented depth on the conversation so the recursive
          // runAgent picks it up (Conversation.delegationDepth is in-memory only).
          set((state) => {
            const c = state.conversations.find((x) => x.id === conversationId)
            if (c) c.delegationDepth = delegationDepth + 1
          })

          console.info('[conversation.store] delegate_to handoff', {
            conversationId,
            from: activeAgentId,
            to: targetAgentId,
            targetName: targetAgent?.name,
            depth: delegationDepth + 1,
          })

          // Restart with the target agent persona. agentOverrideId forces the
          // persona even if the latest message @mentions someone else.
          await get().runAgent(
            conversationId,
            providerType,
            modelName,
            maxTokens,
            directoryHandle,
            targetAgentId
          )
          return
        }

        // Clean exit with no delegation — clear the depth counter so the next
        // user-initiated turn starts fresh.
        if (delegationDepth !== 0) {
          set((state) => {
            const c = state.conversations.find((x) => x.id === conversationId)
            if (c) c.delegationDepth = 0
          })
        }
      } catch (error) {
        // Flush streaming queues BEFORE destroy so any buffered
        // reasoning/content deltas are applied to the draft before we commit.
        const queues = getStreamingQueues(conversationId)
        if (queues) {
          queues.reasoning.flushNow()
          queues.content.flushNow()
          queues.reasoning.destroy()
          queues.content.destroy()
        }
        deleteStreamingQueues(conversationId)

        if (error instanceof Error && error.name === 'AbortError') {
          deleteAgentLoop(conversationId)

          let abortCommittedPartial = false
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              // Sync draft from runtime store before committing
              const rtDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
              if (rtDraft && !c.draftAssistant) {
                c.draftAssistant = rtDraft
              }
              abortCommittedPartial = commitDraftToMessages(c)
              if (abortCommittedPartial) {
                c.updatedAt = Date.now()
              }
              c.status = 'idle'
              c.activeRunId = null
              c.draftAssistant = null
            }
          })
          // Reset runtime store
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = 'idle'
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
          // Persist committed partial messages to prevent data loss
          if (abortCommittedPartial) {
            const abortConv = get().conversations.find((c) => c.id === conversationId)
            if (abortConv) {
              persistMessageReplace(conversationId, abortConv.messages).catch((persistErr) => {
                console.error('[conversation.store] Failed to persist on AbortError partial commit:', persistErr)
              })
            }
          }
          // Do NOT return here — fall through to consume queued messages
          // so that messages enqueued during the cancelled run are processed.
        } else {
          deleteAgentLoop(conversationId)
          deleteStreamingQueues(conversationId)
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              c.status = 'error'
              c.error = error instanceof Error ? error.message : String(error)
              c.activeRunId = null
              c.draftAssistant = null
            }
          })
          // Reset runtime store on generic error
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = 'error'
              r.error = error instanceof Error ? error.message : String(error)
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
          // Persist messages on generic error to prevent data loss on page refresh
          const catchConv = get().conversations.find((c) => c.id === conversationId)
          if (catchConv) {
            persistMessageReplace(conversationId, catchConv.messages).catch((persistErr) => {
              console.error('[conversation.store] Failed to persist on catch:', persistErr)
            })
          }
        } // end else (non-AbortError path — errors do NOT consume queue)
      }

      // ── Consume queued messages ──
      // After a successful (idle) run, check if messages were queued during execution.
      // If so, dequeue the next one and trigger a new agent run.
      const finalStatus = get().conversations.find((c) => c.id === conversationId)?.status
      if (finalStatus === 'idle') {
        const nextMsg = useConversationRuntimeStore.getState().dequeueMessage(conversationId)
        if (nextMsg) {
          const userMsg = createUserMessage(nextMsg.text, nextMsg.assets, nextMsg.pageContext)
          const currentConv = get().conversations.find((c) => c.id === conversationId)
          if (currentConv) {
            get().updateMessages(conversationId, [...currentConv.messages, userMsg])
            // Schedule the next run on the next microtask to avoid re-entrancy.
            // FIX (parallel isolation): Pass null — runAgent now resolves the
            // directoryHandle from conversationId internally, so the global
            // active-project pointer can no longer cross-contaminate this run.
            queueMicrotask(() => {
              get().runAgent(
                conversationId,
                providerType,
                modelName,
                maxTokens,
                null,
                nextMsg.agentOverrideId ?? null,
              )
            })
          }
        }
      }
    },

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
              toast.error('停止后保存草稿失败，部分内容可能丢失')
            })
        }
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
          }
        })
        persistMessageReplace(conversationId, messagesBeforeCompact).catch((err) => {
          console.error('[conversation.store] Failed to persist /compact user message:', err)
        })
      }

      // 2. Create provider / contextManager / toolRegistry (same as runAgent)
      const settingsState = useSettingsStore.getState()
      const { hasApiKey: hasKey, providerType: pType, modelName: mName } = settingsState
      if (!hasKey) {
        toast.error(i18nText('conversation.toast.noApiKey', '未配置 API Key'))
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
      const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
      if (!apiKey) {
        toast.error(i18nText('conversation.toast.noApiKey', '未配置 API Key'))
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

      const agentLoop = new AgentLoop({
        provider,
        toolRegistry,
        contextManager,
        toolContext: {
          directoryHandle,
          workspaceId: conversationId,
          projectId: undefined,
          currentAgentId: 'default',
          agentMode: 'act',
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
              const summaryMsg = msgs.find((msg) => msg.kind === 'context_summary')
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
          const summaryMsg = resultMessages.find((m) => m.kind === 'context_summary')
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
          const { createUserMessage: createMsg } = await import('@/agent/message-types')
          const userMsg = createMsg(nextMsg.text, nextMsg.assets, nextMsg.pageContext)
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
    },

    // ── Runtime state actions ──
    setConversationStatus: (id: string, status: ConversationStatus) => {
      set((state) => {
        const c = state.conversations.find((c) => c.id === id)
        if (c) c.status = status
      })
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
