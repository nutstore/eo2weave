/**
 * useActiveConversation — selects the active conversation's persisted data.
 *
 * IMPORTANT: This hook does NOT subscribe to streaming/high-frequency data
 * (draftAssistant, streamingContent, etc.). That data is subscribed directly
 * inside ConversationMessages to prevent parent components from re-rendering
 * on every streaming token (~60fps).
 *
 * Only low-frequency data is exposed: messages, status, error, context-window usage.
 */

import { useConversationStore } from '@/store/conversation.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useShallow } from 'zustand/react/shallow'
import type { ContextWindowUsage, Message } from '@/agent/message-types'

const EMPTY_MESSAGES: Message[] = []

const NULL_SLICE: ActiveConversationSlice = {
  convId: null,
  messages: EMPTY_MESSAGES,
  status: 'idle' as const,
  error: null,
  dismissedError: null,
  contextWindowUsage: null,
}

export interface ActiveConversationSlice {
  convId: string | null
  messages: Message[]
  status: 'idle' | 'pending' | 'tool_calling' | 'streaming' | 'error'
  error: string | null
  /** Error the user dismissed for the current run (issue #370), trimmed like `error`. */
  dismissedError: string | null
  contextWindowUsage: {
    usagePercent: number
    usedTokens: number
    maxTokens: number
    reserveTokens: number
    modelMaxTokens?: number
  } | null
}

function deriveUsageFromLatestAssistantMessage(
  messages: Message[],
  baseUsage: ContextWindowUsage | null,
): ContextWindowUsage | null {
  const latestAssistantWithUsage = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.usage)

  if (!latestAssistantWithUsage?.usage) return null

  const usedTokens =
    latestAssistantWithUsage.usage.promptTokens +
    latestAssistantWithUsage.usage.completionTokens +
    (latestAssistantWithUsage.usage.cacheReadTokens ?? 0)
  if (!baseUsage) return null
  const modelMaxTokens = baseUsage.modelMaxTokens ?? baseUsage.maxTokens + baseUsage.reserveTokens
  const usagePercent = Math.max(0, Math.min(100, (usedTokens / modelMaxTokens) * 100))

  return {
    ...baseUsage,
    usedTokens,
    usagePercent,
    modelMaxTokens,
  }
}

/**
 * Reads persisted data (messages, lastContextWindowUsage) from the main store
 * and low-frequency runtime data (status, error, contextWindowUsage)
 * from the runtime store.
 *
 * Streaming data (draftAssistant, streamingContent, etc.) is intentionally
 * excluded — it is subscribed directly in ConversationMessages.
 */
export function useActiveConversation(): ActiveConversationSlice {
  // Persisted data from main store
  const convSlice = useConversationStore(
    useShallow((s) => {
      if (!s.activeConversationId) return null
      const conv = s.conversations.find((c) => c.id === s.activeConversationId)
      if (!conv) return null
      return {
        id: conv.id,
        messages: conv.messages || EMPTY_MESSAGES,
        lastContextWindowUsage: conv.lastContextWindowUsage || null,
      }
    }),
  )

  // Low-frequency runtime data from runtime store.
  // Only select fields that change at low rates (status transitions, error events),
  // NOT per-token streaming fields.
  const rtSlice = useConversationRuntimeStore(
    useShallow((s) => {
      if (!convSlice) return null
      const rt = s.runtimes.get(convSlice.id)
      if (!rt) return null
      return {
        status: rt.status,
        error: rt.error,
        dismissedError: rt.dismissedError,
        contextWindowUsage: rt.contextWindowUsage,
      }
    }),
  )

  if (!convSlice) return NULL_SLICE
  const rt = rtSlice
  const assistantUsage = deriveUsageFromLatestAssistantMessage(
    convSlice.messages,
    convSlice.lastContextWindowUsage || rt?.contextWindowUsage || null,
  )

  return {
    convId: convSlice.id,
    messages: convSlice.messages,
    status: rt?.status || 'idle',
    error: rt?.status === 'error' ? rt.error?.trim() || null : null,
    dismissedError: rt?.dismissedError?.trim() || null,
    contextWindowUsage: assistantUsage,
  }
}
