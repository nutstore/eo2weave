import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Message as PiMessage, Model } from '@earendil-works/pi-ai'
import {
  applyCompressionBaseline,
  getCompressionCutoffTimestamp,
  injectSummaryMessage,
  resolveCompressionTriggerTokens,
  type CompressionBaselineState,
} from './context-compression'
import { internalToPiMessages, piToInternalMessage, extractTextContent } from './message-mappers'
import { messagesToChatMessages } from '../llm/llm-provider'
import { generateId, type Message } from '../message-types'
import type { AgentCallbacks, CompressionSummaryMode } from './types'
import type { PiAIProvider } from '../llm/pi-ai-provider'

export interface ConvertAgentMessagesToLlmInput {
  sessionId?: string
  agentMessages: PiAgentMessage[]
  model: Model<Api>
  provider: PiAIProvider
  callbacks?: AgentCallbacks
  compressedMemoryPrefix: string
  convertCallCount: number
  lastSummaryConvertCall: number
  compressionBaseline: CompressionBaselineState | null
  maxContextTokens: number
  reserveTokens: number
  /** Absolute cap from Settings → Advanced (see resolveCompressionTriggerTokens). */
  compressionAbsoluteCapEnabled?: boolean
  compressionAbsoluteCap?: number
  generateContextSummaryWithLLM: (
    droppedContent: string,
    maxSummaryTokens: number
  ) => Promise<{ summary: string | null; mode: CompressionSummaryMode }>
  onSummaryInjected?: (summary: string, cutoffTimestamp: number, throughMessageId?: string) => void
}

export interface ConvertAgentMessagesToLlmResult {
  piMessages: PiMessage[]
  convertCallCount: number
  lastSummaryConvertCall: number
  compressionBaseline: CompressionBaselineState | null
}

/**
 * Extract the real token usage from the most recent assistant message
 * in the agent message list.  Returns totalTokens when available; otherwise
 * falls back to input + output + cacheRead tokens.
 * This is the accurate "context already consumed" number.
 */
function extractLastTurnUsedTokens(agentMessages: PiAgentMessage[]): number | null {
  for (let i = agentMessages.length - 1; i >= 0; i--) {
    const msg = agentMessages[i]
    if (msg.role === 'assistant') {
      const usage = (msg as unknown as {
        usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number }
      }).usage
      if (usage) {
        if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) {
          return usage.totalTokens
        }
        const input = typeof usage.input === 'number' ? usage.input : 0
        const output = typeof usage.output === 'number' ? usage.output : 0
        const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0
        const total = input + output + cacheRead
        if (total > 0) {
          return total
        }
      }
    }
  }
  return null
}

/**
 * When the summarizer is unavailable the transcript must survive (#268): dropping
 * it would make the model forget the task. Shrink the bulky parts instead —
 * old long tool outputs and assistant dumps carry most of the tokens, while the
 * first user message (the task) and the recent tail stay intact.
 */
const SHRINK_KEEP_TAIL = 6
const SHRINK_LIMITS: Record<string, number> = { assistant: 4000, tool: 1200, user: 4000, system: 4000 }

function shrinkOversizedHistory(messages: Message[]): Message[] {
  const keepFrom = messages.length - SHRINK_KEEP_TAIL
  return messages.map((message, index) => {
    if (index === 0 || index >= keepFrom) return message
    const limit = SHRINK_LIMITS[message.role] ?? SHRINK_LIMITS.user

    if (message.contentParts?.length) {
      let changed = false
      const parts = message.contentParts.map(part => {
        if (part.type !== 'text' || part.text.length <= limit) return part
        changed = true
        return {
          type: 'text' as const,
          text: `${part.text.slice(0, limit)}\n…[truncated ${part.text.length - limit} chars]`,
        }
      })
      return changed ? { ...message, contentParts: parts } : message
    }

    if (typeof message.content === 'string' && message.content.length > limit) {
      return {
        ...message,
        content: `${message.content.slice(0, limit)}\n…[truncated ${message.content.length - limit} chars]`,
      }
    }
    return message
  })
}

export async function convertAgentMessagesToLlm(
  input: ConvertAgentMessagesToLlmInput
): Promise<ConvertAgentMessagesToLlmResult> {
  const convertCallCount = input.convertCallCount + 1
  let lastSummaryConvertCall = input.lastSummaryConvertCall
  let compressionBaseline = input.compressionBaseline

  const internalMessagesRaw = input.agentMessages
    .map((m) => piToInternalMessage(m))
    .filter((m): m is NonNullable<typeof m> => m !== null)
  const internalMessages = compressionBaseline
    ? applyCompressionBaseline(internalMessagesRaw, compressionBaseline, input.compressedMemoryPrefix)
    : internalMessagesRaw
  if (compressionBaseline) {
    console.info('[AgentLoop] Using compression baseline', {
      convertCallCount,
      cutoffTimestamp: compressionBaseline.cutoffTimestamp,
      summaryChars: compressionBaseline.summary.length,
      rawMessageCount: internalMessagesRaw.length,
      effectiveMessageCount: internalMessages.length,
    })
  }

  const maxContextTokens = input.maxContextTokens || input.provider.maxContextTokens || 128000
  const reserveTokens = input.reserveTokens ?? 0
  const inputBudget = Math.max(1, maxContextTokens - reserveTokens)
  const chatMessages = messagesToChatMessages(internalMessages)
  const preTrimTokens = input.provider.estimateTokens(chatMessages)

  // --- Real token usage for compression trigger ---
  // Each assistant message records usage.input (prompt tokens) and usage.output
  // (completion tokens).  On the next turn, the output becomes part of the input,
  // so "context already consumed" = input + output of the last assistant message.
  // If the user deletes messages, the next API call will correct the numbers.
  const usedRealTokens = extractLastTurnUsedTokens(input.agentMessages)

  const compressionTriggerThreshold = resolveCompressionTriggerTokens({
    maxContextTokens,
    absoluteCapEnabled: input.compressionAbsoluteCapEnabled,
    absoluteCap: input.compressionAbsoluteCap,
  })

  if (usedRealTokens !== null) {
    console.info('[AgentLoop] Real token usage from last turn', {
      sessionId: input.sessionId,
      model: input.model.id,
      convertCallCount,
      usedRealTokens,
      inputBudget,
      maxContextTokens,
      usagePercent: Number(((usedRealTokens / maxContextTokens) * 100).toFixed(2)),
      triggerThreshold: compressionTriggerThreshold,
    })
  }

  // Only use real token usage from the last API response for the compression
  // gate.  The heuristic estimate (preTrimTokens) is inaccurate and can
  // trigger compression as early as 40% real usage.
  const shouldAllowCompression =
    typeof usedRealTokens === 'number' && usedRealTokens >= compressionTriggerThreshold &&
    (!compressionBaseline || internalMessagesRaw.some(message => message.role === 'assistant' && message.timestamp >= compressionBaseline!.cutoffTimestamp))
  console.info('[AgentLoop] Compression gate evaluation', {
    sessionId: input.sessionId,
    provider: input.model.provider,
    model: input.model.id,
    convertCallCount,
    preTrimTokens,
    usedRealTokens,
    compressionTriggerThreshold,
    maxContextTokens,
    allowCompression: shouldAllowCompression,
  })

  const summaryTokenBudget = Math.min(2400, Math.max(500, Math.floor(maxContextTokens * 0.02)))

  // No silent trimming.  When compression is not triggered, send all messages
  // as-is.  When compression IS triggered, the summary replaces all old
  // messages — no trimming needed either.
  //
  // We track the output as `Message[]` (NOT ChatMessage[]) because
  // messagesToChatMessages() strips `contentParts` (image data), which
  // destroys multimodal context.  The output path must stay in Message-space
  // to preserve user-uploaded images across LLM rounds.
  let outputMessages: Message[] = internalMessages
  let trimmed = chatMessages // ChatMessage-space mirror, used only for token metrics

  if (shouldAllowCompression) {
    // Compression: generate summary via LLM, then replace all messages with [summary].
    const droppedContent = internalMessages
      .filter((msg) => msg.kind !== 'context_summary' && msg.kind !== 'run_changes' && msg.kind !== 'context_update')
      .map((msg) => {
        // For multimodal messages (with images), use the extracted text only.
        // The LLM doing compression can't see the images anyway, so this is safe.
        const text = extractTextContent(msg.contentParts ?? msg.content)
        if (msg.role === 'user') return `User: ${(text || '').slice(0, 800)}`
        if (msg.role === 'assistant') return `Assistant: ${(text || '').slice(0, 800)}`
        if (msg.role === 'tool') return `Tool result: ${(text || '').slice(0, 600)}`
        return ''
      })
      .filter(Boolean)
      .join('\n')

    const droppedContentChars = droppedContent.length
    const droppedGroups = internalMessages.length

    if (droppedContent.length > 0) {
      input.callbacks?.onContextCompressionStart?.({ droppedGroups, droppedContentChars })
      const startedAt = Date.now()
      let summary: string | null = null
      let mode: CompressionSummaryMode = 'llm'
      try {
        const generated = await input.generateContextSummaryWithLLM(droppedContent, summaryTokenBudget)
        summary = generated.summary
        mode = generated.mode
      } catch (firstError) {
        // One retry: most empty/failed summaries are transient. If it fails
        // again the turn must still run with the transcript intact — dropping
        // history would silently make the model forget the task (#268).
        try {
          const retried = await input.generateContextSummaryWithLLM(droppedContent, summaryTokenBudget)
          summary = retried.summary
          mode = retried.mode
        } catch (retryError) {
          console.error('[AgentLoop] Context compression failed twice; keeping the transcript and shrinking oversized messages', {
            sessionId: input.sessionId,
            provider: input.model.provider,
            model: input.model.id,
            error: retryError instanceof Error ? retryError.message : String(retryError),
            firstError: firstError instanceof Error ? firstError.message : String(firstError),
            droppedGroups,
            droppedContentChars,
          })
          // No baseline is written: the conversation stays whole and the next
          // turn retries compression once the transient cause is gone.
          outputMessages = shrinkOversizedHistory(internalMessages)
          trimmed = messagesToChatMessages(outputMessages)
          mode = 'skip'
          summary = null
        }
      }
      const latencyMs = Date.now() - startedAt

      if (summary) {
        lastSummaryConvertCall = convertCallCount
        const cutoffTimestamp = getCompressionCutoffTimestamp(internalMessagesRaw)
        if (typeof cutoffTimestamp === 'number') {
          compressionBaseline = { summary, cutoffTimestamp, throughMessageId: internalMessagesRaw.at(-1)?.id }
        }

        // Build the summary in Message-space (preserving kind='context_summary'
        // so internalToPiMessages emits a stable system-context block instead
        // of being treated as a fresh user turn).  Mirror into ChatMessage-space
        // only for token-counting metrics below.
        outputMessages = [
          {
            id: generateId(),
            role: 'user',
            content: summary,
            kind: 'context_summary',
            timestamp:
              typeof cutoffTimestamp === 'number'
                ? Math.max(0, cutoffTimestamp - 1)
                : Date.now(),
          },
        ]
        trimmed = injectSummaryMessage([], summary, input.compressedMemoryPrefix)

        if (typeof cutoffTimestamp === 'number') {
          input.onSummaryInjected?.(summary, cutoffTimestamp, compressionBaseline?.throughMessageId)
        }
      }

      const postCompressionTokens = input.provider.estimateTokens(trimmed)
      const postCompressionUsagePercent = Math.max(
        0,
        Math.min(100, (postCompressionTokens / inputBudget) * 100)
      )
      console.info('[AgentLoop] Context compression complete', {
        sessionId: input.sessionId,
        convertCallCount,
        mode,
        droppedGroups,
        droppedContentChars,
        summaryChars: summary?.length || 0,
        compressionBaselineCutoff: compressionBaseline?.cutoffTimestamp ?? null,
        postCompressionTokens,
        inputBudget,
        postCompressionUsagePercent: Number(postCompressionUsagePercent.toFixed(2)),
      })
      input.callbacks?.onContextCompressionComplete?.({
        mode,
        summary,
        droppedGroups,
        droppedContentChars,
        summaryChars: summary?.length || 0,
        latencyMs,
      })
    }
  }

  return {
    piMessages: internalToPiMessages(outputMessages, input.model, input.compressedMemoryPrefix),
    convertCallCount,
    lastSummaryConvertCall,
    compressionBaseline,
  }
}
