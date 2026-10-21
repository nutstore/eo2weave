//=============================================================================
// Conversation message operations — pure helpers extracted from
// conversation.store.sqlite.ts (Task B2, docs/plans/2026-09-19-split-large-files.md).
//
// Everything in this file is a pure function or explicitly parameterized
// helper: none of them close over the store instance or module state.
// Bodies are moved verbatim (signatures unchanged) except for added
// `export` keywords; handleSubagentStepNotification intentionally stays in
// the facade because it calls useConversationStoreSQLite directly.
//=============================================================================

import { t as translateStatic } from '@creatorweave/i18n'
import type {
  Conversation,
  Message,
  MessageUsage,
  ToolCall,
  DraftAssistantStep,
  ContextWindowUsage,
} from '@/agent/message-types'
import type { AssetMeta } from '@/types/asset'
import {
  createAssistantMessage,
  createToolMessage,
  isHumanUserMessage,
} from '@/agent/message-types'
import { createEmptyRuntime } from './conversation-runtime.store'
import type { ConversationRuntime } from './conversation-runtime.store'
import { useI18nStore } from '@/i18n/store'

/** Default conversation name when title is not available */
export const DEFAULT_CONVERSATION_NAME = 'New Chat'

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
export function makeSyntheticAskUserResult(argsJson: string): string {
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
export function ensureRuntime(state: import('./conversation-runtime.store').ConversationRuntimeState, convId: string): ConversationRuntime {
  let rt = state.runtimes.get(convId)
  if (!rt) {
    rt = createEmptyRuntime()
    state.runtimes.set(convId, rt)
  }
  return rt
}

export function i18nText(key: string, fallback: string): string {
  const locale = useI18nStore.getState().locale
  const translated = translateStatic(locale, key)
  return translated === key ? fallback : translated
}

/** Add completed reasoning durations to freshly committed assistant messages. */
export function attachReasoningDurations(
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
export function commitDraftToMessages(conv: {
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

//=============================================================================
// Helpers
//=============================================================================

/**
 * Produce a short text summary suitable for a system notification body.
 * Trims whitespace, normalises newlines, and truncates to ~60 chars with
 * an ellipsis. If the input is empty, returns '已完成'.
 */
export function summarizeForNotification(content: string, maxChars = 60): string {
  const normalised = content.replace(/\s+/g, ' ').trim()
  if (!normalised) return '已完成'
  if (normalised.length <= maxChars) return normalised
  return normalised.slice(0, maxChars) + '…'
}

//=============================================================================
// Title Management
//=============================================================================

const MAX_TITLE_LENGTH = 30

export function truncateTitle(content: string): string {
  let trimmed = content.trim()
  trimmed = trimmed.replace(/\s+/g, ' ')
  if (trimmed.length <= MAX_TITLE_LENGTH) {
    return trimmed
  }
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1) + '…'
}

export function updateAutoTitleAfterMessageDelete(conv: Conversation): void {
  if (conv.titleMode === 'manual') return

  const firstUserMessage = conv.messages.find((m) => isHumanUserMessage(m) && m.content)
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
/**
 * Merge an incoming message snapshot into the previous one.
 * Exported for unit testing (pure function, no store access).
 */
export function reconcileMessageSnapshot(previous: Message[], incoming: Message[]): Message[] {
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

/**
 * Merge for writes that arrive while a conversation is metadata-only
 * (`messagesLoaded === false`): the caller built its snapshot from an EMPTY
 * in-memory state, so the snapshot can never be a legitimate replacement of
 * a longer DB history — the merge must be strictly additive (update matching
 * ids in place, append unseen). Unlike `reconcileMessageSnapshot`, there is
 * no "large non-overlapping snapshot = replacement" branch: that heuristic
 * exists for re-mapped regenerate snapshots, which cannot originate from
 * empty memory, and it would truncate short histories (e.g. 2 persisted rows
 * + 1 externally appended message already passes its 0.5 size ratio).
 */
export function mergeUnloadedWriteSnapshot(previous: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return previous
  if (previous.length === 0) return incoming
  // Defensive: if incoming happens to fully cover previous, taking incoming
  // loses nothing.
  const incomingIds = new Set(incoming.map((m) => m.id))
  if (previous.every((m) => incomingIds.has(m.id))) return incoming
  const merged = previous.slice()
  const indexById = new Map(merged.map((m, idx) => [m.id, idx]))
  for (const msg of incoming) {
    const idx = indexById.get(msg.id)
    if (idx === undefined) {
      merged.push(msg)
      indexById.set(msg.id, merged.length - 1)
    } else {
      merged[idx] = msg
    }
  }
  return merged
}

export function deriveContextUsageFromAssistantUsage(
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
export function healCompressionBaseline(conv: Conversation): void {
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
