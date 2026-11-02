import { messagesToChatMessages, type ChatMessage } from '../llm/llm-provider'
import type { Message } from '../message-types'
import type { ContextManager } from '../context-manager'
import { isToolEnvelopeV2 } from '../tools/tool-envelope'
import { isExpectedAgentAbort } from '@/lib/agent-abort'

export interface ContextOverflowPayload {
  maxContextLimit: number
  reserveTokens: number
  inputBudget: number
  historyTokens: number
  toolResultTokens: number
  totalInputTokens: number
}

export interface EnsureLatestToolResultFitsContextInput {
  internalMessages: Message[]
  trimmedMessages: ChatMessage[]
  maxContextTokens: number
  reserveTokens: number
  contextManager: ContextManager
  estimateTokens: (messages: ChatMessage[]) => number
}

/**
 * Metadata recorded into the overflow file header so that the calling
 * tool/args/trace can be recovered from the asset file alone (e.g. when
 * debugging why a 60MB tool result was produced). The header is the only
 * persistent record of "which tool, with which args, produced this overflow".
 */
export interface OverflowMetadata {
  toolName: string
  toolCallId?: string
  args: Record<string, unknown>
  /** Unix epoch milliseconds — also used as the asset filename suffix. */
  timestamp: number
  estimatedTokens: number
  availableTokens: number
  workspaceId?: string
}

export interface TruncateLargeToolResultInput {
  rawResult: string
  toolName: string
  /** Tool call arguments — recorded into the overflow file header for debugging. */
  args?: Record<string, unknown>
  /** Tool call id (matches the LLM-side tool_call_id) — recorded into the overflow file header. */
  toolCallId?: string
  /** Workspace id — recorded into the overflow file header for debugging. */
  workspaceId?: string
  /** Real token usage from the last API response. When absent (e.g. first turn), skip truncation entirely. */
  existingTokens?: number
  maxContextTokens: number
  reserveTokens: number
  estimateTextTokens: (text: string) => number
  /** Optional: write overflow content to assets and return the asset path. */
  writeToAssets?: (
    content: string,
    toolName: string,
    metadata: OverflowMetadata
  ) => Promise<string | null>
}

export interface ExecuteToolWithTimeoutInput {
  toolName: string
  args: Record<string, unknown>
  timeoutMs: number | null
  runAbortSignal?: AbortSignal
  externalAbortSignal?: AbortSignal
  execute: (abortSignal: AbortSignal) => Promise<string>
}

export function coerceToolArgs(params: unknown): Record<string, unknown> {
  if (params == null) return {}
  if (typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, unknown>
  }
  throw new Error('invalid_arguments: Tool arguments must be a JSON object')
}

export async function executeToolWithTimeout(input: ExecuteToolWithTimeoutInput): Promise<string> {
  const timeoutController = new AbortController()
  const cleanupListeners: Array<() => void> = []

  const attachAbort = (signal: AbortSignal | undefined) => {
    if (!signal) return
    // Forward the source signal's reason so tools can tell WHY they were
    // cancelled (user Stop vs internal teardown) instead of a bare abort.
    const onAbort = () => timeoutController.abort(signal.reason)
    signal.addEventListener('abort', onAbort)
    cleanupListeners.push(() => signal.removeEventListener('abort', onAbort))
    if (signal.aborted) timeoutController.abort(signal.reason)
  }

  attachAbort(input.runAbortSignal)
  attachAbort(input.externalAbortSignal)

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let didTimeout = false
  const timeoutPromise =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? new Promise<string>((_, reject) => {
          const timeoutMs = input.timeoutMs as number
          timeoutId = setTimeout(() => {
            didTimeout = true
            reject(new Error(`Tool "${input.toolName}" timed out after ${timeoutMs}ms`))
            timeoutController.abort()
          }, timeoutMs)
        })
      : null

  // Reject with the source signal's semantic reason when one is present
  // (user Stop vs internal teardown), keeping the tool-specific context for
  // plain aborts. Timeout rejections keep their own message.
  const abortRejection = () =>
    didTimeout
      ? new Error(`Tool "${input.toolName}" timed out after ${input.timeoutMs}ms`)
      : isExpectedAgentAbort(timeoutController.signal.reason)
        ? timeoutController.signal.reason
        : new Error(`Tool "${input.toolName}" was aborted`)

  const abortPromise = new Promise<string>((_, reject) => {
    if (timeoutController.signal.aborted) {
      reject(abortRejection())
      return
    }
    const onAbort = () => reject(abortRejection())
    timeoutController.signal.addEventListener('abort', onAbort, { once: true })
    cleanupListeners.push(() => timeoutController.signal.removeEventListener('abort', onAbort))
  })

  try {
    const racers: Array<Promise<string>> = [input.execute(timeoutController.signal), abortPromise]
    if (timeoutPromise) {
      racers.push(timeoutPromise)
    }
    return await Promise.race(racers)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    for (const cleanup of cleanupListeners) cleanup()
  }
}

export function buildContextOverflowError(payload: ContextOverflowPayload): Error {
  return new Error(
    JSON.stringify({
      error: 'context_overflow',
      message:
        'Tool result is too large for current model context. Use filters like max_results, glob, or start_line to limit the output size.',
      modelContextLimit: payload.maxContextLimit,
      reserveTokens: payload.reserveTokens,
      inputBudget: payload.inputBudget,
      historyTokens: payload.historyTokens,
      toolResultTokens: payload.toolResultTokens,
      totalInputTokens: payload.totalInputTokens,
      suggestion: 'For search: use max_results parameter. For read: use start_line and line_count parameters.',
    })
  )
}

export function ensureLatestToolResultFitsContext(input: EnsureLatestToolResultFitsContextInput): ChatMessage[] {
  const latestTool = [...input.internalMessages].reverse().find((msg) => msg.role === 'tool')
  if (!latestTool || !latestTool.toolCallId) return input.trimmedMessages

  const toolStillIncluded = input.trimmedMessages.some(
    (msg) =>
      msg.role === 'tool' &&
      msg.tool_call_id === latestTool.toolCallId &&
      typeof msg.content === 'string' &&
      msg.content === latestTool.content
  )
  if (toolStillIncluded) return input.trimmedMessages

  const allMessages = messagesToChatMessages(input.internalMessages)
  const historyOnlyMessages = messagesToChatMessages(
    input.internalMessages.filter((msg) => msg.id !== latestTool.id)
  )
  const totalInputTokens = input.estimateTokens(allMessages)
  const historyTokens = input.estimateTokens(historyOnlyMessages)
  const toolResultTokens = Math.max(0, totalInputTokens - historyTokens)
  const inputBudget = Math.max(1, input.maxContextTokens - input.reserveTokens)

  // First fallback: degrade the latest tool result to a compact summary message,
  // then retry trimming without summary generation.
  const degradedToolContent = JSON.stringify({
    tool_result_truncated: true,
    toolCallId: latestTool.toolCallId,
    toolName: latestTool.name,
    originalToolTokens: toolResultTokens,
    note: 'too_large',
  })

  const degradedInternalMessages = input.internalMessages.map((msg) =>
    msg.id === latestTool.id ? { ...msg, content: degradedToolContent } : msg
  )
  const retrimmedMessages = input.contextManager.trimMessages(
    messagesToChatMessages(degradedInternalMessages),
    { createSummary: false }
  ).messages

  const degradedToolIncluded = retrimmedMessages.some(
    (msg) =>
      msg.role === 'tool' &&
      msg.tool_call_id === latestTool.toolCallId &&
      typeof msg.content === 'string' &&
      msg.content === degradedToolContent
  )
  if (degradedToolIncluded) {
    return retrimmedMessages
  }

  // If even degraded content cannot fit, fail explicitly.
  throw buildContextOverflowError({
    maxContextLimit: input.maxContextTokens,
    reserveTokens: input.reserveTokens,
    inputBudget,
    historyTokens,
    toolResultTokens,
    totalInputTokens,
  })
}

export async function truncateLargeToolResult(input: TruncateLargeToolResultInput): Promise<string> {
  // Use real token usage when available; otherwise assume 0 (first turn).
  // We still need to truncate/write-to-assets oversized results to avoid context overflow.
  const existingTokens = input.existingTokens ?? 0

  // Calculate the maximum token budget for the tool result (total budget - existing messages - reserve).
  // Leave an extra 10% margin to account for estimation errors.
  const availableForTool = Math.max(
    1000, // Minimum 1000 tokens
    (input.maxContextTokens - input.reserveTokens - existingTokens) * 0.9
  )

  // If the result fits within the budget, no truncation needed.
  const estimatedResultTokens = input.estimateTextTokens(input.rawResult)
  if (estimatedResultTokens <= availableForTool) {
    return input.rawResult
  }

  console.warn(
    `[AgentLoop] Tool result too large for context: result=${estimatedResultTokens}, available=${Math.floor(availableForTool)}, tool=${input.toolName}`
  )

  // ── Overflow to assets: write oversized content to an assets file and return the path ──
  if (input.writeToAssets) {
    // Parse once, reuse for both content extraction and overflow envelope
    let envelopeParsed: unknown = undefined
    let envelopeData: Record<string, unknown> | undefined = undefined
    try {
      envelopeParsed = JSON.parse(input.rawResult.trim()) as unknown
      if (isToolEnvelopeV2(envelopeParsed) && envelopeParsed.ok && envelopeParsed.data && typeof envelopeParsed.data === 'object') {
        envelopeData = envelopeParsed.data as Record<string, unknown>
      }
    } catch { /* not JSON — will write raw result as-is */ }

    // Strip the envelope wrapper and write only the payload:
    //   1. data.content (string) → write as-is (read/bash/ocr plain text)
    //   2. data (object)         → pretty-print JSON without the ok/tool/version wrapper
    //   3. valid non-envelope JSON → pretty-print the parsed JSON
    //   4. non-JSON              → write raw result as-is
    // This avoids wrapping the content in a redundant envelope that the LLM cannot paginate.
    const contentToWrite =
      envelopeData && typeof envelopeData.content === 'string'
        ? envelopeData.content
        : envelopeData
          ? JSON.stringify(envelopeData, null, 2)
          : envelopeParsed !== undefined
            ? JSON.stringify(envelopeParsed, null, 2)
            : input.rawResult

    const assetPath = await input.writeToAssets(contentToWrite, input.toolName, {
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      args: input.args ?? {},
      timestamp: Date.now(),
      estimatedTokens: estimatedResultTokens,
      availableTokens: Math.floor(availableForTool),
      workspaceId: input.workspaceId,
    })
    if (assetPath) {
      // Build an overflow envelope that preserves the original metadata
      const baseOverflow = {
        overflow: true,
        contentSavedTo: `vfs://assets/${assetPath}`,
        estimatedTokens: estimatedResultTokens,
        availableTokens: Math.floor(availableForTool),
      }

      const overflowData: Record<string, unknown> = envelopeData
        ? {
            // Preserve original metadata so the LLM knows file type, size, etc.
            path: envelopeData.path,
            kind: envelopeData.kind,
            metadata: envelopeData.metadata,
            ...(envelopeData.entries ? { entries: envelopeData.entries } : {}),
            ...baseOverflow,
          }
        : baseOverflow

      return JSON.stringify({
        ok: true,
        tool: input.toolName,
        version: 2,
        data: overflowData,
        meta: {
          hint: [
            `Content is too large to fit in context (${estimatedResultTokens} tokens, available ${Math.floor(availableForTool)}).`,
            `The actual content has been saved as a plain text file at: vfs://assets/${assetPath}`,
            `To read it, use read(path="vfs://assets/${assetPath}", start_line=N, line_count=M) with pagination — do NOT read the entire file at once.`,
            `Start with start_line=1, line_count=100 to see the first 100 lines, then increment start_line to page through the rest.`,
          ].join('\n'),
        },
      })
    }
  }

  // ── Fallback: writeToAssets unavailable or failed, fall back to truncation ──

  // Try parsing as JSON for smart truncation
  const trimmed = input.rawResult.trim()
  try {
    const parsed = JSON.parse(trimmed) as unknown

    // Special handling for search tool results
    const searchPayload =
      input.toolName === 'search' && isToolEnvelopeV2(parsed) && parsed.ok
        ? parsed.data
        : parsed
    if (
      input.toolName === 'search' &&
      searchPayload &&
      typeof searchPayload === 'object' &&
      'results' in searchPayload &&
      'totalMatches' in searchPayload &&
      Array.isArray((searchPayload as { results?: unknown[] }).results)
    ) {
      const searchResult = searchPayload as {
        results: Array<{
          path: string
          line: number
          match: string
          column?: number
          preview?: string
        }>
        totalMatches: number
        scannedFiles?: number
        truncated?: boolean
        message?: string
      }

      // Binary search for the maximum number of results that fit (including 0)
      let left = 0
      let right = Math.min(searchResult.results.length, 200) // Cap at 200 results
      let bestCount = 0
      const emptySearchSummary = {
        ...searchResult,
        results: [],
        truncated: true,
        originalTotalMatches: searchResult.totalMatches,
        message: `Found ${searchResult.totalMatches} matches in ${searchResult.scannedFiles || 0} files. Results too large to display. Use filters like glob, path, or reduce search scope.`,
      }
      let bestResult: Record<string, unknown> =
        input.toolName === 'search' && isToolEnvelopeV2(parsed) && parsed.ok
          ? { ...parsed, data: emptySearchSummary }
          : emptySearchSummary

      while (left <= right) {
        const mid = Math.floor((left + right) / 2)
        const testResults = searchResult.results.slice(0, mid).map((hit) => ({
          path: hit.path,
          line: hit.line,
          match: hit.match,
        }))

        const testResult = {
          ...searchResult,
          results: testResults,
          truncated: true,
          originalTotalMatches: searchResult.totalMatches,
          message: `Found ${searchResult.totalMatches} matches in ${searchResult.scannedFiles || 0} files. Showing first ${testResults.length} results.`,
        }

        const candidateResult =
          input.toolName === 'search' && isToolEnvelopeV2(parsed) && parsed.ok
            ? { ...parsed, data: testResult }
            : testResult

        const testTokens = input.estimateTextTokens(JSON.stringify(candidateResult))

        if (testTokens <= availableForTool) {
          bestCount = testResults.length
          bestResult =
            input.toolName === 'search' && isToolEnvelopeV2(parsed) && parsed.ok
              ? { ...parsed, data: testResult }
              : testResult
          left = mid + 1
        } else {
          right = mid - 1
        }
      }

      // If not even one result fits, return summary only
      if (bestCount === 0) {
        return JSON.stringify(bestResult)
      }

      return JSON.stringify(bestResult)
    }

    // Other JSON results: return a valid JSON envelope with truncated content
    const truncateRatio = availableForTool / estimatedResultTokens
    const truncateAt = Math.floor(input.rawResult.length * truncateRatio * 0.8)
    const truncatedContent = input.rawResult.slice(0, truncateAt)
    return JSON.stringify({
      ok: true,
      tool: input.toolName,
      version: 2,
      data: {
        truncated: true,
        content: truncatedContent,
        estimatedTokens: estimatedResultTokens,
        availableTokens: Math.floor(availableForTool),
      },
      meta: {
        hint: `Result truncated: ${estimatedResultTokens} tokens, available ${Math.floor(availableForTool)}. Use filters to reduce output.`,
      },
    })
  } catch {
    // Non-JSON results: direct truncation (plain text, no JSON envelope needed)
    const truncateRatio = availableForTool / estimatedResultTokens
    const truncateAt = Math.floor(input.rawResult.length * truncateRatio * 0.8)
    return (
      input.rawResult.slice(0, truncateAt) +
      `\n\n... [Result truncated due to size: ${estimatedResultTokens} tokens, available ${Math.floor(availableForTool)} tokens. Use filters to reduce output.]`
    )
  }
}

export function normalizeToolResult(
  rawResult: string
): { content: string; details: Record<string, unknown>; isError: boolean } {
  const details: Record<string, unknown> = { raw: rawResult }
  const trimmed = rawResult.trim()
  if (!trimmed) {
    return { content: '', details, isError: false }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    details.parsed = parsed
    if (isToolEnvelopeV2(parsed)) {
      details.tool = parsed.tool
      details.version = parsed.version
      if (!parsed.ok) {
        details.errorCode = parsed.error.code
        details.error = parsed.error.message
        return {
          content: `Error [${parsed.error.code}]: ${parsed.error.message}`,
          details,
          isError: true,
        }
      }
      return { content: rawResult, details, isError: false }
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      const errorMessage = (parsed as { error: string }).error
      details.error = errorMessage
      return { content: `Error: ${errorMessage}`, details, isError: true }
    }
  } catch {
    // Non-JSON output is a valid tool result.
  }

  const isError = /^error:/i.test(trimmed)
  return {
    content: rawResult,
    details,
    isError,
  }
}
