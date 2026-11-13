import type { Message } from '../message-types'
import type { AgentCallbacks, CompressionSummaryMode } from './types'
import type { CompressionBaselineState } from './context-compression'
import { estimateCompressionTokens, projectCompressionHistory, resolveSummaryTokenBudget, selectCompressionRange, serializeCompressionHistory } from './compression-history'

export interface CompressHistoryInput {
  messages: Message[]
  effectiveCapacityTokens: number
  modelMaxOutputTokens?: number
  signal?: AbortSignal
  callbacks?: AgentCallbacks
  generateContextSummaryWithLLM: (content: string, maxTokens: number, messages?: Message[]) => Promise<{ summary: string | null; mode: CompressionSummaryMode }>
}

export async function compressHistory(input: CompressHistoryInput): Promise<{
  summary: string
  mode: CompressionSummaryMode
  baseline: CompressionBaselineState
  messages: Message[]
} | null> {
  input.signal?.throwIfAborted()
  const projected = projectCompressionHistory(input.messages)
  const range = selectCompressionRange(projected, input.effectiveCapacityTokens)
  if (!range) return null
  const content = serializeCompressionHistory(range.messages)
  const budget = resolveSummaryTokenBudget(input.effectiveCapacityTokens, input.modelMaxOutputTokens, estimateCompressionTokens(range.messages))
  const started = Date.now()
  const metrics = { droppedGroups: range.messages.length, droppedContentChars: content.length }
  input.callbacks?.onContextCompressionStart?.(metrics)
  let summary: string | null = null
  let mode: CompressionSummaryMode = 'skip'
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        input.signal?.throwIfAborted()
        const generated = await input.generateContextSummaryWithLLM(content, budget, range.messages)
        input.signal?.throwIfAborted()
        const text = generated.summary?.trim()
        if (!text) throw new Error('The model returned an empty context summary.')
        const baseline: CompressionBaselineState = {
          summary: text,
          cutoffTimestamp: range.cutoffTimestamp,
          throughMessageId: range.throughMessageId,
          preservedMessageIds: range.preservedMessageIds,
        }
        const messages = projectCompressionHistory(projected, baseline)
        if (estimateCompressionTokens(messages) >= estimateCompressionTokens(projected)) {
          throw new Error('Context summary did not usefully shrink the selected history.')
        }
        if (estimateCompressionTokens(messages) > input.effectiveCapacityTokens) {
          throw new Error('Context checkpoint and retained messages cannot fit the available input capacity.')
        }
        summary = text
        mode = generated.mode
        return { summary, mode, baseline, messages }
      } catch (error) {
        input.signal?.throwIfAborted()
        if (attempt === 1) throw error
      }
    }
    return null
  } finally {
    input.callbacks?.onContextCompressionComplete?.({ ...metrics, mode, summary, summaryChars: summary?.length ?? 0, latencyMs: Date.now() - started })
  }
}
