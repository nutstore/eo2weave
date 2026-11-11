import type { ChatMessage } from '../llm/llm-provider'
import { generateId, type Message } from '../message-types'

/**
 * Compression trigger threshold as a fraction of the model's context window.
 * When real token usage exceeds this ratio, context compression is activated.
 * Adjust this value to control when compression kicks in (default: 0.85).
 */
export const COMPRESSION_TRIGGER_RATIO = 0.85

/**
 * Default for the absolute compression cap (Settings → Advanced → context
 * compression). 200K matches the context window of the models this app
 * targets most, so the cap only binds when a model advertises a larger
 * window than the user is willing to pay for per turn.
 */
export const DEFAULT_COMPRESSION_ABSOLUTE_CAP = 200_000

export interface CompressionTriggerInput {
  /** The model's advertised context window. */
  maxContextTokens: number
  /** Whether the absolute cap is enabled (Settings toggle). */
  absoluteCapEnabled?: boolean
  /** Absolute cap in tokens; ignored when disabled. */
  absoluteCap?: number
}

/**
 * Tokens at which compression starts: min(ratio × window, absolute cap).
 *
 * Every compression gate must go through this function. A ratio-only gate
 * leaves a path that grows unbounded on models with very large windows.
 */
export function resolveCompressionTriggerTokens(input: CompressionTriggerInput): number {
  const ratioTrigger = Math.floor(input.maxContextTokens * COMPRESSION_TRIGGER_RATIO)
  if (!input.absoluteCapEnabled) return ratioTrigger
  const cap = Math.floor(input.absoluteCap ?? DEFAULT_COMPRESSION_ABSOLUTE_CAP)
  if (!Number.isFinite(cap) || cap <= 0) return ratioTrigger
  return Math.min(ratioTrigger, cap)
}

export interface CompressionBaselineState {
  summary: string
  cutoffTimestamp: number
  throughMessageId?: string
}

export function injectSummaryMessage(
  messages: ChatMessage[],
  summary: string,
  compressedMemoryPrefix: string
): ChatMessage[] {
  // Inject as a user message so internalToPiMessages() can correctly map it
  // (system-role ChatMessages are silently dropped by internalToPiMessages).
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `${compressedMemoryPrefix}\n${summary}`,
  }

  return [summaryMessage, ...messages]
}

/**
 * Find cutoff timestamp for rebuilding context after compression.
 * We drop all current messages covered by the summary, and keep only messages
 * that arrive after compression.
 */
export function getCompressionCutoffTimestamp(messages: Message[]): number | null {
  const latestTimestamp = messages.reduce<number | null>((max, msg) => {
    if (typeof msg.timestamp !== 'number') return max
    if (max == null || msg.timestamp > max) return msg.timestamp
    return max
  }, null)
  if (latestTimestamp == null) return null
  // Set cutoff strictly after the latest summarized message so the immediate
  // compressed request can be summary-only.
  return latestTimestamp + 1
}

/**
 * Rebuild model input context from compression baseline:
 * [summary] + [messages at/after cutoff].
 */
export function applyCompressionBaseline(
  messages: Message[],
  baseline: CompressionBaselineState,
  _compressedMemoryPrefix: string
): Message[] {
  const boundaryIndex = baseline.throughMessageId
    ? messages.findIndex(message => message.id === baseline.throughMessageId) : -1
  const latestSummary = messages.map(message => message.kind).lastIndexOf('context_summary')
  const retained = boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1)
    : latestSummary >= 0 ? messages.slice(latestSummary + 1) : messages.filter(
    (msg) => typeof msg.timestamp === 'number' && msg.timestamp >= baseline.cutoffTimestamp
  )

  // Create the summary as a user-role message with kind='context_summary'.
  // Using role='user' ensures that regardless of which conversion path the
  // message takes (messagesToChatMessages → trimmed → internalToPiMessages, or
  // direct internalToPiMessages), it always reaches the LLM as a user message.
  // Previously this used createAssistantMessage which set role='assistant';
  // that role leaked through when the conversion pipeline lost the `kind` field.
  const summaryMessage: Message = {
    id: generateId(),
    role: 'user',
    // Store raw summary without prefix — internalToPiMessages() will prepend
    // the prefix when mapping to PiMessage for the LLM.
    content: baseline.summary,
    kind: 'context_summary',
    timestamp: Math.max(0, baseline.cutoffTimestamp - 1),
  }
  return [summaryMessage, ...retained]
}
