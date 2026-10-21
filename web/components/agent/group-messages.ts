/**
 * group-messages.ts - Groups flat Message[] into Turn[] for UI rendering.
 *
 * A "Turn" is either a single user message or a consecutive run of
 * assistant (+ tool) messages between two user messages.
 * Token usage is aggregated across all assistant messages in the turn.
 */

import type { Message, MessageUsage } from '@/agent/message-types'
import { getMessageRecordType, isConversationUserMessage } from '@/agent/message-types'

export type Turn =
  | { type: 'user'; message: Message }
  | {
      type: 'assistant'
      messages: Message[] // assistant messages only (tool msgs excluded)
      timestamp: number // last assistant message timestamp
      totalUsage: MessageUsage | null
    }

/**
 * Walk through a flat message list and produce Turn groups.
 *
 * Rules:
 * - system / tool messages are skipped (tool results are looked up via toolResults map)
 * - user message → standalone UserTurn
 * - consecutive assistant messages → single AssistantTurn with aggregated usage
 */
export function groupMessagesIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = []
  let currentAssistant: Message[] | null = null

  const flushAssistant = () => {
    if (currentAssistant && currentAssistant.length > 0) {
      const usage = aggregateUsage(currentAssistant)
      turns.push({
        type: 'assistant',
        messages: currentAssistant,
        timestamp: currentAssistant[currentAssistant.length - 1].timestamp,
        totalUsage: usage,
      })
      currentAssistant = null
    }
  }

  for (const msg of messages) {
    const type = getMessageRecordType(msg)
    if (type === 'system' || type === 'tool_result' || type === 'context_update') {
      continue
    }

    if (isConversationUserMessage(msg)) {
      flushAssistant()
      turns.push({ type: 'user', message: msg })
    } else if (type === 'assistant_output' || type === 'run_changes' || type === 'context_summary') {
      if (!currentAssistant) {
        currentAssistant = []
      }
      currentAssistant.push(msg)
    }
  }

  flushAssistant()
  return turns
}

function aggregateUsage(messages: Message[]): MessageUsage | null {
  // Find the last assistant message with usage (for per-message display + cache)
  let lastUsage: MessageUsage | null = null
  // Accumulate three independent counters across all LLM calls in this turn
  let accInput = 0       // non-cache input (promptTokens, the "fresh" portion)
  let accCache = 0       // cache-read input (cacheReadTokens, the discounted portion)
  let accCompletion = 0  // output (completionTokens)

  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].usage
    if (!usage) continue
    accInput += usage.promptTokens
    accCache += usage.cacheReadTokens || 0
    accCompletion += usage.completionTokens
    // Keep the last (most recent) usage for per-message fields + cache
    if (!lastUsage) {
      lastUsage = usage
    }
  }

  if (!lastUsage) return null

  return {
    promptTokens: lastUsage.promptTokens,
    completionTokens: lastUsage.completionTokens,
    totalTokens: lastUsage.totalTokens,
    cacheReadTokens: lastUsage.cacheReadTokens || 0,
    accumulatedPromptTokens: accInput,
    accumulatedCacheTokens: accCache,
    accumulatedCompletionTokens: accCompletion,
  }
}
