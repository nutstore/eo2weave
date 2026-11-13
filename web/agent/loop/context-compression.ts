import { projectCompressionHistory } from './compression-history'
import type { ChatMessage } from '../llm/llm-provider'
import type { Message } from '../message-types'

/**
 * Compression trigger threshold as a fraction of the model's context window.
 * When real token usage exceeds this ratio, context compression is activated.
 * Adjust this value to control when compression kicks in (default: 0.85).
 */
export const COMPRESSION_TRIGGER_RATIO = 0.85

/** Default optional early-compression threshold, independent of model capacity. */
export const DEFAULT_COMPRESSION_ABSOLUTE_CAP = 400_000

export interface CompressionTriggerInput {
  /** The model's advertised context window. */
  maxContextTokens: number
  /** Capacity reserved for the next model response. */
  reserveTokens?: number
  /**
   * Whether the absolute cap is enabled (Settings toggle). Only an EXPLICIT
   * `false` turns it off: `undefined` means "on", so a caller that predates the
   * setting cannot silently land on the unbounded ratio-only gate. Pass `false`
   * deliberately where the cap must not apply (headless schedules).
   */
  absoluteCapEnabled?: boolean
  /** Absolute cap in tokens; ignored when disabled or non-positive. */
  absoluteCap?: number
}

/**
 * Tokens at which compression starts: min(ratio × window, absolute cap).
 *
 * Every compression gate must go through this function. A ratio-only gate
 * leaves a path that grows unbounded on models with very large windows.
 */
export function resolveCompressionTriggerTokens(input: CompressionTriggerInput): number {
  const safetyTokens = Math.ceil(input.maxContextTokens * 0.05)
  const inputLimit = Math.max(1, input.maxContextTokens - Math.max(0, input.reserveTokens ?? 0) - safetyTokens)
  const ratioTrigger = Math.min(Math.floor(input.maxContextTokens * COMPRESSION_TRIGGER_RATIO), inputLimit)
  if (input.absoluteCapEnabled === false) return ratioTrigger
  const cap = Math.floor(input.absoluteCap ?? DEFAULT_COMPRESSION_ABSOLUTE_CAP)
  if (!Number.isFinite(cap) || cap <= 0) return ratioTrigger
  return Math.min(ratioTrigger, cap)
}

export interface CompressionBaselineState {
  summary: string
  cutoffTimestamp: number
  throughMessageId?: string
  preservedMessageIds?: string[]
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
  return projectCompressionHistory(messages, baseline)
}

/** Restore the authoritative checkpoint boundary, independently of its UI timestamp. */
export function restoreCompressionBaseline(messages: Message[]): CompressionBaselineState | null {
  const marker = messages.findLast(message => message.kind === 'context_summary')
  if (!marker?.content) return null
  return {
    summary: marker.content,
    cutoffTimestamp: marker.compressionBoundary?.cutoffTimestamp ?? marker.timestamp + 1,
    throughMessageId: marker.compressionBoundary?.throughMessageId,
    preservedMessageIds: marker.compressionBoundary?.preservedMessageIds,
  }
}
