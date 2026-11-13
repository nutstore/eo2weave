import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Message as PiMessage, Model } from '@earendil-works/pi-ai'
import { resolveCompressionTriggerTokens, type CompressionBaselineState } from './context-compression'
import { projectCompressionHistory, estimateCompressionTokens } from './compression-history'
import { compressHistory } from './compression-runner'
import { internalToPiMessages, piToInternalMessage } from './message-mappers'
import { messagesToChatMessages } from '../llm/llm-provider'
import type { Message } from '../message-types'
import type { ToolDefinition } from '../tools/tool-types'
import type { AgentCallbacks, CompressionSummaryMode } from './types'
import type { PiAIProvider } from '../llm/pi-ai-provider'

export interface ConvertAgentMessagesToLlmInput {
  sessionId?: string
  signal?: AbortSignal
  systemPrompt?: string
  tools?: ToolDefinition[]
  /** Current runtime state, staged before admission and rebuilt after compaction. */
  getContextUpdate?: (visibleMessages: Message[], afterCompression: boolean) => Message | null
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
  /** False for paths that must never summarize (e.g. scheduled runs). */
  compressionEnabled?: boolean
  /** Absolute cap from Settings → Advanced (see resolveCompressionTriggerTokens). */
  compressionAbsoluteCapEnabled?: boolean
  compressionAbsoluteCap?: number
  generateContextSummaryWithLLM: (
    droppedContent: string,
    maxSummaryTokens: number,
    messages?: Message[]
  ) => Promise<{ summary: string | null; mode: CompressionSummaryMode }>
  onSummaryInjected?: (summary: string, cutoffTimestamp: number, throughMessageId?: string, preservedMessageIds?: string[]) => void
}

export interface ConvertAgentMessagesToLlmResult {
  piMessages: PiMessage[]
  contextUpdate?: Message | null
  convertCallCount: number
  lastSummaryConvertCall: number
  compressionBaseline: CompressionBaselineState | null
}

export function resolveCompressionInputBudget(
  maxContextTokens: number,
  reserveTokens: number,
  systemPrompt = '',
  tools: ToolDefinition[] = []
): number {
  const fixedOverheadTokens = Math.ceil(new TextEncoder().encode(JSON.stringify({ system: systemPrompt, tools })).length / 2)
  return Math.max(1, maxContextTokens - reserveTokens) - fixedOverheadTokens - Math.ceil(maxContextTokens * 0.05)
}

export function assertCompressionInputFits(messages: Message[], availableInputTokens: number): void {
  if (estimateCompressionTokens(messages) > availableInputTokens) {
    throw new Error('The complete conversation and current instructions cannot fit the available model context capacity.')
  }
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

export async function convertAgentMessagesToLlm(
  input: ConvertAgentMessagesToLlmInput
): Promise<ConvertAgentMessagesToLlmResult> {
  input.signal?.throwIfAborted()
  const convertCallCount = input.convertCallCount + 1
  let lastSummaryConvertCall = input.lastSummaryConvertCall
  let compressionBaseline = input.compressionBaseline

  const internalMessagesRaw = input.agentMessages
    .map((m) => piToInternalMessage(m))
    .filter((m): m is NonNullable<typeof m> => m !== null)
  const internalMessages = projectCompressionHistory(internalMessagesRaw, compressionBaseline)
  if (compressionBaseline) {
    console.info('[AgentLoop] Using compression baseline', {
      convertCallCount,
      cutoffTimestamp: compressionBaseline.cutoffTimestamp,
      summaryChars: compressionBaseline.summary.length,
      rawMessageCount: internalMessagesRaw.length,
      effectiveMessageCount: internalMessages.length,
    })
  }

  const maxContextTokens = Math.min(input.maxContextTokens || Infinity, input.model.contextWindow || input.provider.maxContextTokens || 128000)
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
    reserveTokens,
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
  // Cooldown: a summary written on the previous convert must not be redone
  // immediately. Without it, a conversation whose fixed overhead (system prompt
  // + tool schemas) already exceeds the cap would re-summarize every turn.
  // Exactly one convert is skipped: counters restored from an inconsistent
  // snapshot must fail open (compress) rather than suppress the cap forever.
  const summarizedLastCall = convertCallCount - lastSummaryConvertCall === 1
  const shouldAllowCompression =
    input.compressionEnabled !== false &&
    !summarizedLastCall &&
    typeof usedRealTokens === 'number' && usedRealTokens >= compressionTriggerThreshold &&
    (!compressionBaseline || internalMessages.some(message => message.kind !== 'context_summary' && message.role === 'assistant'))
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

  const availableInputTokens = resolveCompressionInputBudget(maxContextTokens, reserveTokens, input.systemPrompt, input.tools)
  let contextUpdate = input.getContextUpdate?.(internalMessages, false) ?? null
  const initialCandidate = contextUpdate ? [...internalMessages, contextUpdate] : internalMessages
  const requiresOverflowRecovery = estimateCompressionTokens(initialCandidate) > availableInputTokens
  let outputMessages = internalMessages
  // The real-usage gate controls proactive compression. Newly added content
  // still needs a fit check before dispatch, including during cooldown.
  if (shouldAllowCompression || (requiresOverflowRecovery && input.compressionEnabled !== false)) {
    try {
      const rebuiltContext = input.getContextUpdate?.(internalMessages, true) ?? null
      const contextTokens = rebuiltContext ? estimateCompressionTokens([rebuiltContext]) : 0
      const compressed = await compressHistory({
        messages: internalMessages,
        effectiveCapacityTokens: Math.min(availableInputTokens - contextTokens, compressionTriggerThreshold),
        modelMaxOutputTokens: input.model.maxTokens,
        signal: input.signal,
        callbacks: input.callbacks,
        generateContextSummaryWithLLM: input.generateContextSummaryWithLLM,
      })
      input.signal?.throwIfAborted()
      if (compressed) {
        assertCompressionInputFits(rebuiltContext ? [...compressed.messages, rebuiltContext] : compressed.messages, availableInputTokens)
        compressionBaseline = compressed.baseline
        outputMessages = compressed.messages
        contextUpdate = rebuiltContext
        lastSummaryConvertCall = convertCallCount
        input.onSummaryInjected?.(compressed.summary, compressionBaseline.cutoffTimestamp, compressionBaseline.throughMessageId, compressionBaseline.preservedMessageIds)
      }
    } catch (error) {
      input.signal?.throwIfAborted()
      // Preserve every source message on failure; an oversized request must fail visibly.
      if (requiresOverflowRecovery) throw error
      console.error('[AgentLoop] Context compression failed; retaining the complete transcript', error)
    }
  }

  assertCompressionInputFits(contextUpdate ? [...outputMessages, contextUpdate] : outputMessages, availableInputTokens)
  input.signal?.throwIfAborted()
  return {
    piMessages: [
      ...internalToPiMessages(outputMessages, input.model, input.compressedMemoryPrefix),
      ...(contextUpdate ? internalToPiMessages([contextUpdate], input.model, input.compressedMemoryPrefix) : []),
    ],
    contextUpdate,
    convertCallCount,
    lastSummaryConvertCall,
    compressionBaseline,
  }
}
