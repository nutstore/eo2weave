/**
 * Context Manager - manages token window and message truncation.
 * Ensures messages fit within the LLM's context window while
 * preserving tool_call/tool_result pairs.
 *
 * Features:
 * - Token budget management
 * - Tool call/tool_result pair preservation
 * - Message summarization for long conversations
 * - Smart truncation with preserve important content
 */

import type { ChatMessage } from './llm/llm-provider'
import { estimateMessageTokens, estimateStringTokens } from './llm/token-counter'
import { resolveCompressionTriggerTokens } from './loop/context-compression'

const COMPRESSED_MEMORY_PREFIXES = [
  'Earlier conversation summary:',
  'Compressed memory of earlier conversation:',
]

function isCompressedMemoryMessage(content: string): boolean {
  return COMPRESSED_MEMORY_PREFIXES.some((prefix) => content.startsWith(prefix))
}

export interface ContextManagerConfig {
  maxContextTokens: number
  /** Reserve tokens for the response */
  reserveTokens?: number
  /** System prompt (always included) */
  systemPrompt?: string
  /** Enable message summarization for long conversations */
  enableSummarization?: boolean
  /** Maximum number of message groups to keep */
  maxMessageGroups?: number
  /** Absolute compression cap (Settings → Advanced); see resolveCompressionTriggerTokens */
  compressionAbsoluteCapEnabled?: boolean
  compressionAbsoluteCap?: number
}

export interface TrimResult {
  messages: ChatMessage[]
  wasTruncated: boolean
  droppedGroups: number
  droppedContent?: string
}

/**
 * Summarization options for compressing old messages
 */
export interface SummarizationOptions {
  /** Whether to create summary of dropped messages */
  createSummary: boolean
  /** Summary prompt template */
  summaryPrompt?: string
  /** Maximum tokens for summary */
  maxSummaryTokens?: number
  /** Summary generation strategy */
  summaryStrategy?: 'heuristic' | 'external'
  /**
   * Real token usage from the last model API response.
   * Computed as last assistant message's usage.input + usage.output.
   * When provided, proactive compression uses this for the trigger threshold
   * check (usedRealTokens > budget * 0.85) instead of the heuristic estimate.
   */
  usedRealTokens?: number
}

export class ContextManager {
  private static readonly PROACTIVE_COMPRESSION_TARGET = 0.7
  private maxTokens: number
  private reserveTokens: number
  private systemPrompt: string
  private enableSummarization: boolean
  private maxMessageGroups: number
  private compressionAbsoluteCapEnabled: boolean
  private compressionAbsoluteCap: number | undefined

  constructor(config: ContextManagerConfig) {
    this.maxTokens = config.maxContextTokens
    this.reserveTokens = config.reserveTokens ?? 4096
    this.systemPrompt = config.systemPrompt ?? ''
    this.enableSummarization = config.enableSummarization ?? false
    this.maxMessageGroups = config.maxMessageGroups ?? 50
    this.compressionAbsoluteCapEnabled = config.compressionAbsoluteCapEnabled ?? true
    this.compressionAbsoluteCap = config.compressionAbsoluteCap
  }

  /** Update system prompt */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
  }

  /**
   * Trim messages to fit within token budget.
   * Strategy: Keep system prompt + recent messages, remove older ones.
   * Never split tool_call/tool_result pairs.
   *
   * @param messages - Full message history
   * @param options - Optional summarization settings
   * @returns Trimmed messages with metadata about truncation
   */
  trimMessages(messages: ChatMessage[], options?: SummarizationOptions): TrimResult {
    const budget = this.maxTokens - this.reserveTokens

    // System message always included
    const systemMessage: ChatMessage | null = this.systemPrompt
      ? { role: 'system', content: this.systemPrompt }
      : null

    const systemTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0
    const availableTokens = budget - systemTokens

    if (availableTokens <= 0) {
      // System prompt alone exceeds budget - truncate it
      const truncatedPrompt = this.truncateToTokens(this.systemPrompt, budget - 100)
      return {
        messages: [{ role: 'system', content: truncatedPrompt }],
        wasTruncated: true,
        droppedGroups: 0,
      }
    }

    // Group messages: keep tool_calls and their results together
    const groups = this.groupMessages(messages)
    const candidateGroups =
      groups.length > this.maxMessageGroups ? groups.slice(-this.maxMessageGroups) : groups
    const droppedByGroupLimit = groups.length - candidateGroups.length

    // Fill from newest to oldest
    const selectedGroups: ChatMessage[][] = []
    let usedTokens = 0
    let droppedGroups = droppedByGroupLimit

    for (let i = candidateGroups.length - 1; i >= 0; i--) {
      const group = candidateGroups[i]
      const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)

      if (usedTokens + groupTokens <= availableTokens) {
        selectedGroups.unshift(group)
        usedTokens += groupTokens
      } else {
        // Can't fit this group - count dropped
        droppedGroups++
      }
    }

    // Proactive compression: when we're close to the context ceiling, summarize
    // oldest groups early to preserve headroom for follow-up turns and tool output.
    // Use real token usage (usage.input + usage.output from last API response) for
    // the trigger check when available, falling back to heuristic estimate.
    if (
      this.enableSummarization &&
      options?.createSummary &&
      droppedGroups === 0 &&
      selectedGroups.length > 1
    ) {
      const proactiveTrigger = this.getCompressionTriggerTokens()
      const proactiveTarget = Math.floor(budget * ContextManager.PROACTIVE_COMPRESSION_TARGET)
      // Use real tokens when available; otherwise fall back to heuristic
      const triggerTokens = options.usedRealTokens != null && options.usedRealTokens > 0
        ? options.usedRealTokens
        : usedTokens + systemTokens
      if (triggerTokens >= proactiveTrigger) {
        // Recompute current token count each iteration so the loop can exit
        // early once the target is reached — avoids over-trimming to the
        // minimum group count.
        let currentTokens = usedTokens + systemTokens
        while (selectedGroups.length > 1 && currentTokens > proactiveTarget) {
          const droppedGroup = selectedGroups.shift()
          if (!droppedGroup) break
          const droppedTokens = droppedGroup.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
          usedTokens -= droppedTokens
          currentTokens -= droppedTokens
          droppedGroups++
        }
      }
    }

    // Also check proactive compression when groups were already dropped but usage
    // is still high — this handles cases where a few large groups were dropped
    // early but the remaining messages still fill most of the budget.
    if (
      this.enableSummarization &&
      options?.createSummary &&
      droppedGroups > 0 &&
      selectedGroups.length > 1
    ) {
      const proactiveTrigger = this.getCompressionTriggerTokens()
      const proactiveTarget = Math.floor(budget * ContextManager.PROACTIVE_COMPRESSION_TARGET)
      // Use real tokens when available; otherwise recompute from selected groups
      const triggerTokens = options.usedRealTokens != null && options.usedRealTokens > 0
        ? options.usedRealTokens
        : selectedGroups.flat().reduce((sum, msg) => sum + estimateMessageTokens(msg), 0) + systemTokens
      if (triggerTokens >= proactiveTrigger) {
        // Recompute current tokens each iteration for early exit.
        let currentTokens = selectedGroups
          .flat()
          .reduce((sum, msg) => sum + estimateMessageTokens(msg), 0) + systemTokens
        while (selectedGroups.length > 1 && currentTokens > proactiveTarget) {
          const droppedGroup = selectedGroups.shift()
          if (!droppedGroup) break
          const droppedTokens = droppedGroup.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
          usedTokens -= droppedTokens
          currentTokens -= droppedTokens
          droppedGroups++
        }
      }
    }

    // If summarization is enabled and we dropped groups, create a summary
    let summaryMessage: ChatMessage | null = null
    let droppedContentForExternalSummary: string | undefined
    const shouldSummarize = this.enableSummarization && droppedGroups > 0 && options?.createSummary
    if (shouldSummarize) {
      const droppedContent = this.extractDroppedContent(groups, selectedGroups)
      if (droppedContent.length > 0) {
        if (options.summaryStrategy === 'external') {
          droppedContentForExternalSummary = droppedContent
        } else {
          const summary = this.createSummary(
            droppedContent,
            options.summaryPrompt,
            options.maxSummaryTokens ?? 500
          )
          if (summary) {
            summaryMessage = {
              role: 'system',
              content: summary,
            }
          }
        }
      }
    }

    // Build final message list
    const result: ChatMessage[] = []
    if (systemMessage) {
      result.push(systemMessage)
    }
    if (summaryMessage) {
      result.push(summaryMessage)
    }
    for (const group of selectedGroups) {
      result.push(...group)
    }

    return {
      messages: result,
      wasTruncated: droppedGroups > 0,
      droppedGroups,
      droppedContent: droppedContentForExternalSummary,
    }
  }

  /**
   * Extract content from dropped groups for summarization
   */
  private extractDroppedContent(
    allGroups: ChatMessage[][],
    selectedGroups: ChatMessage[][]
  ): string {
    // Track selected message indices by counting from the end
    const selectedCount = selectedGroups.flat().length
    const totalCount = allGroups.flat().length
    const droppedCount = totalCount - selectedCount

    if (droppedCount <= 0) {
      return ''
    }

    // Extract key content from dropped messages - take more messages for better context
    const droppedMessages = allGroups.flat().slice(0, droppedCount).slice(-50) // Last 50 dropped messages

    // Extract key content from dropped messages
    const parts: string[] = []
    for (const msg of droppedMessages) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        // Preserve full user content - it's critical for understanding intent
        parts.push(`User: ${msg.content}`)
      } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
        if (isCompressedMemoryMessage(msg.content)) {
          continue
        }
        // Keep more assistant content - reasoning and decisions matter
        parts.push(`Assistant: ${msg.content.slice(0, 800)}`)
      } else if (msg.role === 'tool' && typeof msg.content === 'string') {
        // Tool results - preserve file paths, search results, errors
        parts.push(`Tool result: ${msg.content.slice(0, 600)}`)
      }
    }

    return parts.join('\n')
  }

  /**
   * Create a summary of dropped messages
   */
  private createSummary(droppedContent: string, customPrompt?: string, maxTokens?: number): string {
    const targetTokens = maxTokens ?? 500
    const lines = droppedContent
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const userHighlights: string[] = []
    const assistantHighlights: string[] = []
    const toolHighlights: string[] = []

    for (const line of lines) {
      if (line.startsWith('User:') && userHighlights.length < 6) {
        userHighlights.push(line.slice(5).trim())
        continue
      }
      if (line.startsWith('Assistant:') && assistantHighlights.length < 6) {
        assistantHighlights.push(line.slice(10).trim())
        continue
      }
      if (line.startsWith('Tool result:') && toolHighlights.length < 4) {
        toolHighlights.push(line.slice(12).trim())
      }
    }

    const summaryParts: string[] = []
    summaryParts.push(customPrompt?.trim() || 'Compressed memory of earlier conversation:')
    if (userHighlights.length > 0) {
      summaryParts.push('User intents:')
      summaryParts.push(...userHighlights.map((item) => `- ${item}`))
    }
    if (assistantHighlights.length > 0) {
      summaryParts.push('Assistant outputs:')
      summaryParts.push(...assistantHighlights.map((item) => `- ${item}`))
    }
    if (toolHighlights.length > 0) {
      summaryParts.push('Key tool findings:')
      summaryParts.push(...toolHighlights.map((item) => `- ${item}`))
    }

    return this.truncateToTokens(summaryParts.join('\n'), targetTokens)
  }

  /**
   * Group messages so that assistant messages with tool_calls
   * are kept together with their corresponding tool result messages.
   */
  private groupMessages(messages: ChatMessage[]): ChatMessage[][] {
    const groups: ChatMessage[][] = []
    let i = 0

    while (i < messages.length) {
      const msg = messages[i]

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Start a group: assistant with tool_calls + all following tool results
        const group: ChatMessage[] = [msg]
        const toolCallIds = new Set(msg.tool_calls.map((tc) => tc.id))
        i++

        while (i < messages.length && messages[i].role === 'tool') {
          const toolMsg = messages[i]
          if (toolMsg.tool_call_id && toolCallIds.has(toolMsg.tool_call_id)) {
            group.push(toolMsg)
            i++
          } else {
            break
          }
        }

        groups.push(group)
      } else {
        // Single message group
        groups.push([msg])
        i++
      }
    }

    return groups
  }

  /** Truncate a string to approximately the given token count */
  private truncateToTokens(text: string, maxTokens: number): string {
    // Rough estimate: 3 chars per token
    const maxChars = maxTokens * 3
    if (text.length <= maxChars) return text
    return text.slice(0, maxChars) + '\n...[truncated]'
  }

  /** Estimate token count for current context */
  estimateContextTokens(messages: ChatMessage[]): number {
    const systemTokens = this.systemPrompt ? estimateStringTokens(this.systemPrompt) + 4 : 0
    const messageTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
    return systemTokens + messageTokens + 3 // conversation overhead
  }

  /**
   * Aggressively trim messages to fit within a specific token target.
   * Used by the agent loop to enforce headroom after context compression.
   * Unlike trimMessages, this does not produce summaries — it just drops
   * the oldest message groups until the target is met.
   */
  trimMessagesToTarget(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
    // Separate system message
    const systemMessage: ChatMessage | null =
      messages[0]?.role === 'system' ? messages[0] : null
    const rest = systemMessage ? messages.slice(1) : messages
    const systemTokens = systemMessage ? estimateMessageTokens(systemMessage) : 0
    const available = targetTokens - systemTokens

    if (available <= 0) {
      return systemMessage ? [systemMessage] : []
    }

    const groups = this.groupMessages(rest)

    // Fill from newest to oldest within target
    const selectedGroups: ChatMessage[][] = []
    let usedTokens = 0

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i]
      const groupTokens = group.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
      if (usedTokens + groupTokens <= available) {
        selectedGroups.unshift(group)
        usedTokens += groupTokens
      }
      // else: drop older groups silently
    }

    const result: ChatMessage[] = []
    if (systemMessage) result.push(systemMessage)
    for (const group of selectedGroups) result.push(...group)
    return result
  }

  /** Get current configuration */
  getConfig(): ContextManagerConfig {
    return {
      maxContextTokens: this.maxTokens,
      reserveTokens: this.reserveTokens,
      systemPrompt: this.systemPrompt,
      enableSummarization: this.enableSummarization,
      maxMessageGroups: this.maxMessageGroups,
      compressionAbsoluteCapEnabled: this.compressionAbsoluteCapEnabled,
      compressionAbsoluteCap: this.compressionAbsoluteCap,
    }
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<ContextManagerConfig>): void {
    if (config.maxContextTokens !== undefined) this.maxTokens = config.maxContextTokens
    if (config.reserveTokens !== undefined) this.reserveTokens = config.reserveTokens
    if (config.systemPrompt !== undefined) this.systemPrompt = config.systemPrompt
    if (config.enableSummarization !== undefined)
      this.enableSummarization = config.enableSummarization
    if (config.maxMessageGroups !== undefined) this.maxMessageGroups = config.maxMessageGroups
    if (config.compressionAbsoluteCapEnabled !== undefined)
      this.compressionAbsoluteCapEnabled = config.compressionAbsoluteCapEnabled
    if (config.compressionAbsoluteCap !== undefined)
      this.compressionAbsoluteCap = config.compressionAbsoluteCap
  }

  /**
   * Tokens at which proactive compression starts: min(ratio x window, absolute
   * cap). Both proactive gates below must use this, never the raw ratio.
   */
  private getCompressionTriggerTokens(): number {
    return resolveCompressionTriggerTokens({
      maxContextTokens: this.maxTokens,
      absoluteCapEnabled: this.compressionAbsoluteCapEnabled,
      absoluteCap: this.compressionAbsoluteCap,
    })
  }
}
