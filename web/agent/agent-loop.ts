/**
 * Agent Loop - orchestrates the LLM conversation with tool calling.
 *
 * Flow:
 * 1. User message → inject skills and MCP services into system prompt
 * 2. ContextManager trims to token window
 * 3. Call LLM (streaming) with tools
 * 4. If tool_calls → execute tools → append results → loop
 * 5. If stop → return final response
 * 6. Max 20 iterations
 */

import type { ToolContext } from './tools/tool-types'
import type { Message } from './message-types'
import { ContextManager } from './context-manager'
import { ToolRegistry } from './tool-registry'
import { getUniversalSystemPrompt } from './prompts/universal-system-prompt'
import { PiAIProvider } from './llm/pi-ai-provider'
import { type AgentMode } from './agent-mode'
import { generateContextSummaryWithLLM } from './loop/context-summary'
import { getCompressionCutoffTimestamp, type CompressionBaselineState } from './loop/context-compression'
import { buildRuntimeEnhancedPrompt, triggerPrefetchForMessages } from './loop/enhancements'
import { executePiCoreLoop } from './loop/pi-core-runner'
import { extractTextContent } from './loop/message-mappers'
import type { AgentCallbacks, AgentLoopConfig } from './loop/types'
import { generateId } from './message-types'
import { ensureToolCallResults } from './loop/tool-call-results'

export type {
  AfterToolCallHookContext,
  AfterToolCallHookResult,
  AgentCallbacks,
  AgentLoopConfig,
  BeforeToolCallHookContext,
  BeforeToolCallHookResult,
  CompressionSummaryMode,
} from './loop/types'

const MAX_ITERATIONS = 20
const DEFAULT_SYSTEM_PROMPT = getUniversalSystemPrompt()
const DEFAULT_TOOL_TIMEOUT = 30000
const TOOL_TIMEOUT_EXEMPTIONS = new Set<string>([
  'spawn_subagent', 'batch_spawn', 'ask_user_question', 'generate_image', 'search_tools',
  // exec manages its own timeout internally (per-call override, default 120s,
  // hard cap 600s). The outer wrapper timer starts when the tool call begins —
  // before exec_auth queueing and the serializeExecExecution chain — so a 30s
  // outer timer would kill parallel calls that were still waiting to run.
  'exec',
  // Page action tools — interact with the upstream page which may involve
  // complex editors (ProseMirror, Yjs协同) that take unbounded time.
  'page_snapshot', 'page_text_content', 'page_find_elements', 'page_synthesize_locators',
  'page_click', 'page_fill', 'page_type', 'page_scroll', 'page_evaluate',
  'page_screenshot',
])
const COMPRESSED_MEMORY_PREFIX = 'Earlier conversation summary:'

export class AgentLoop {
  private provider: PiAIProvider
  private toolRegistry: ToolRegistry
  private contextManager: ContextManager
  private toolContext: ToolContext
  private maxIterations: number
  private baseSystemPrompt: string
  private abortController: AbortController | null = null
  private sessionId?: string
  private onLoopComplete?: () => Promise<void>
  private toolExecutionTimeout: number
  private beforeToolCall?: AgentLoopConfig['beforeToolCall']
  private afterToolCall?: AgentLoopConfig['afterToolCall']
  private onCompressionStateUpdate?: AgentLoopConfig['onCompressionStateUpdate']
  private compressionBaseline: CompressionBaselineState | null
  private skipEnhancements: boolean
  private disableThinking: boolean
  private convertCallCount = 0
  private lastSummaryConvertCall = Number.NEGATIVE_INFINITY
  private mode: AgentMode
  private shouldYieldForQueue?: () => boolean

  constructor(config: AgentLoopConfig) {
    this.provider = config.provider
    this.toolRegistry = config.toolRegistry
    this.contextManager = config.contextManager
    this.toolContext = config.toolContext
    if (!this.toolContext.readFileState) {
      this.toolContext.readFileState = new Map()
    }
    this.maxIterations = config.maxIterations ?? MAX_ITERATIONS
    this.baseSystemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT
    this.sessionId = config.sessionId
    this.onLoopComplete = config.onLoopComplete
    this.toolExecutionTimeout = config.toolExecutionTimeout || DEFAULT_TOOL_TIMEOUT
    this.beforeToolCall = config.beforeToolCall
    this.afterToolCall = config.afterToolCall
    this.onCompressionStateUpdate = config.onCompressionStateUpdate
    this.compressionBaseline = config.initialCompressionBaseline ?? null
    this.mode = config.mode || 'act'
    this.skipEnhancements = config.skipEnhancements ?? false
    this.disableThinking = config.disableThinking ?? false
    this.shouldYieldForQueue = config.shouldYieldForQueue
    // Keep toolContext.agentMode in sync so tools (e.g. bash) can read it
    this.toolContext.agentMode = this.mode
    // Expose provider to tool executors (e.g. search_tools subagent)
    this.toolContext.provider = this.provider
    this.convertCallCount = config.initialConvertCallCount ?? 0
    this.lastSummaryConvertCall =
      config.initialLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY
    this.contextManager.setSystemPrompt(this.baseSystemPrompt)
  }

  /** Get current agent mode */
  getMode(): AgentMode {
    return this.mode
  }

  /** Set agent mode */
  setMode(mode: AgentMode): void {
    this.mode = mode
    // Keep toolContext.agentMode in sync so tools (e.g. bash) can read it
    this.toolContext.agentMode = mode
  }

  /** Update system prompt (e.g. when skills are injected) */
  setSystemPrompt(prompt: string): void {
    this.baseSystemPrompt = prompt
    this.contextManager.setSystemPrompt(prompt)
  }

  /** Cancel the current agent loop */
  cancel(): void {
    this.abortController?.abort()
  }

  private async runWithPiAgentCore(
    messages: Message[],
    callbacks?: AgentCallbacks
  ): Promise<Message[]> {
    const signal = this.abortController?.signal
    if (!signal) return messages

    let allMessages = messages
    let shouldStopForElicitation = false
    let reachedMaxIterations = false
    try {
      const result = await executePiCoreLoop({
        signal,
        initialMessages: messages,
        callbacks,
        baseSystemPrompt: this.baseSystemPrompt,
        mode: this.mode,
        toolRegistry: this.toolRegistry,
        beforeToolCall: this.beforeToolCall,
        afterToolCall: this.afterToolCall,
        getToolContext: () => this.toolContext,
        setToolContext: (context) => {
          this.toolContext = context
        },
        provider: this.provider,
        contextManager: this.contextManager,
        toolExecutionTimeout: this.toolExecutionTimeout,
        toolTimeoutExemptions: TOOL_TIMEOUT_EXEMPTIONS,
        maxIterations: this.maxIterations,
        convertCallCount: this.convertCallCount,
        lastSummaryConvertCall: this.lastSummaryConvertCall,
        compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX,
        generateContextSummaryWithLLM: (droppedContent, maxSummaryTokens) =>
          generateContextSummaryWithLLM({
            provider: this.provider,
            droppedContent,
            maxSummaryTokens,
            compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX,
          }),
        onAbortRequested: () => this.abortController?.abort(),
        initialCompressionBaseline: this.compressionBaseline,
        disableThinking: this.disableThinking,
        shouldYieldForQueue: this.shouldYieldForQueue,
        sessionId: this.sessionId,
      })
      allMessages = result.allMessages
      shouldStopForElicitation = result.shouldStopForElicitation
      reachedMaxIterations = result.reachedMaxIterations
      this.convertCallCount = result.convertCallCount
      this.lastSummaryConvertCall = result.lastSummaryConvertCall
      this.onCompressionStateUpdate?.({
        convertCallCount: this.convertCallCount,
        lastSummaryConvertCall: this.lastSummaryConvertCall,
      })
    } catch (error) {
      if (signal.aborted) {
        console.warn('[#LoopStop] aborted_during_pi_core_run', {
          reason: 'signal_aborted',
          messagesCount: allMessages.length,
        })
        const patched = ensureToolCallResults(allMessages)
        callbacks?.onComplete?.(patched)
        return patched
      }
      console.error('[#LoopStop] pi_core_run_error', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    if (shouldStopForElicitation) {
      console.warn('[#LoopStop] stop_for_elicitation', {
        messagesCount: allMessages.length,
      })
      const patched = ensureToolCallResults(allMessages)
      callbacks?.onComplete?.(patched)
      return patched
    }

    if (reachedMaxIterations) {
      console.warn('[#LoopStop] stop_for_max_iterations', {
        maxIterations: this.maxIterations,
      })
      // Abort the signal to stop any in-flight LLM requests inside the
      // pi-agent-core generator (especially the push-based cw-openai-fetch
      // stream whose async IIFE would otherwise keep running).
      this.abortController?.abort()
      callbacks?.onIterationLimitReached?.(this.maxIterations)
    }

    if (this.onLoopComplete) {
      try {
        await this.onLoopComplete()
      } catch (error) {
        console.warn('[AgentLoop] onLoopComplete callback failed:', error)
      }
    }

    const finalMessages = ensureToolCallResults(allMessages)
    callbacks?.onComplete?.(finalMessages)
    console.info('[#LoopStop] completed_normally', {
      messagesCount: finalMessages.length,
    })
    return finalMessages
  }

  /**
   * Compact-only run: generate a context summary from existing messages,
   * inject a context_summary message, and return immediately.
   * Does NOT enter the agent loop (no LLM conversation, no tool calls).
   */
  async runCompactOnly(messages: Message[], callbacks?: AgentCallbacks): Promise<Message[]> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      // Extract content from non-summary messages for summarization
      const nonSummaryMessages = messages.filter((msg) => msg.kind !== 'context_summary')
      const droppedContent = nonSummaryMessages
        .map((msg) => {
          // For multimodal messages, use the text representation for compression.
          const text = extractTextContent(msg.contentParts ?? msg.content)
          if (msg.role === 'user') return `User: ${(text || '').slice(0, 800)}`
          if (msg.role === 'assistant') return `Assistant: ${(text || '').slice(0, 800)}`
          if (msg.role === 'tool') return `Tool result: ${(text || '').slice(0, 600)}`
          return ''
        })
        .filter(Boolean)
        .join('\n')

      const droppedContentChars = droppedContent.length
      const droppedGroups = nonSummaryMessages.length

      if (droppedContent.length === 0) {
        // Nothing to compress
        callbacks?.onComplete?.(messages)
        return messages
      }

      // Notify compression start
      callbacks?.onContextCompressionStart?.({ droppedGroups, droppedContentChars })

      // Generate summary via LLM
      const summaryTokenBudget = Math.min(
        2400,
        Math.max(500, Math.floor((this.contextManager.getConfig().maxContextTokens || 128000) * 0.02)),
      )
      const startedAt = Date.now()
      const { summary, mode } = await generateContextSummaryWithLLM({
        provider: this.provider,
        droppedContent,
        maxSummaryTokens: summaryTokenBudget,
        compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX,
        signal,
      })

      // Check for cancellation
      if (signal.aborted) {
        callbacks?.onComplete?.(messages)
        return messages
      }

      const latencyMs = Date.now() - startedAt

      let resultMessages = messages

      if (summary) {
        // Compute cutoff timestamp — this determines what the compression baseline
        // covers.  The full message list is NOT modified; only the baseline metadata
        // is persisted so that the next LLM call uses the trimmed context.
        const cutoffTimestamp = getCompressionCutoffTimestamp(messages)
        if (typeof cutoffTimestamp === 'number') {
          this.compressionBaseline = { summary, cutoffTimestamp }
        }

        // Update compression state counters
        this.convertCallCount++
        this.lastSummaryConvertCall = this.convertCallCount
        this.onCompressionStateUpdate?.({
          convertCallCount: this.convertCallCount,
          lastSummaryConvertCall: this.lastSummaryConvertCall,
        })

        // Build result for compression baseline only (NOT used to replace UI messages)
        const summaryMessage: Message = {
          id: generateId(),
          role: 'user',
          content: summary,
          kind: 'context_summary',
          timestamp: Math.max(0, (cutoffTimestamp ?? Date.now()) - 1),
        }

        // Include original messages so the store can extract the summary.
        // The store's onMessagesUpdated will ONLY read the summary metadata,
        // not replace c.messages.
        resultMessages = [summaryMessage, ...messages]

        // Notify messages updated so the store can persist the summary
        callbacks?.onMessagesUpdated?.(resultMessages)
      }

      // Notify compression complete
      callbacks?.onContextCompressionComplete?.({
        mode,
        summary,
        droppedGroups,
        droppedContentChars,
        summaryChars: summary?.length || 0,
        latencyMs,
      })

      if (this.onLoopComplete) {
        try { await this.onLoopComplete() } catch { /* ignore: best-effort notification, never fail the loop */ }
      }

      callbacks?.onComplete?.(resultMessages)
      return resultMessages
    } catch (error) {
      if (signal.aborted) {
        callbacks?.onComplete?.(messages)
        return messages
      }
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[AgentLoop] runCompactOnly error:', err)
      callbacks?.onError?.(err)
      throw err
    } finally {
      this.abortController = null
    }
  }

  /**
   * Run the agent loop with a list of messages.
   * Appends new assistant/tool messages and returns the full updated list.
   */
  async run(messages: Message[], callbacks?: AgentCallbacks): Promise<Message[]> {
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    if (this.skipEnhancements) {
      // Use the base system prompt as-is (no skills, memory, or MCP summaries).
      this.contextManager.setSystemPrompt(this.baseSystemPrompt)
    } else {
      // Phase 2 P1: Trigger predictive file loading before processing
      await triggerPrefetchForMessages(messages, this.toolContext, this.sessionId)

      // Inject matching skills and MCP services into system prompt
      const enhancedPrompt = await buildRuntimeEnhancedPrompt({
        baseSystemPrompt: this.baseSystemPrompt,
        messages,
        mode: this.mode,
        toolContext: this.toolContext,
        sessionId: this.sessionId,
      })
      this.contextManager.setSystemPrompt(enhancedPrompt)
    }

    try {
      return await this.runWithPiAgentCore(messages, callbacks)
    } catch (error) {
      if (signal.aborted) {
        console.warn('[#LoopStop] run_aborted', {
          reason: 'signal_aborted_outer',
          messagesCount: messages.length,
        })
        callbacks?.onComplete?.(messages)
        return messages
      }
      const err = error instanceof Error ? error : new Error(String(error))
      console.error('[#LoopStop] run_error', {
        error: err.message,
      })
      callbacks?.onError?.(err)
      throw err
    } finally {
      // Abort the run signal on teardown. Tools forward this signal as their
      // context.abortSignal; global UI-level queues (e.g. the exec auth modal
      // queue in exec-auth.store) listen on it to deny their pending requests.
      // Without this, requests left unconsumed when the loop ends (aborted,
      // errored, or completed while a prompt-level auth was still queued)
      // survive as stale popups that keep surfacing across later loops.
      this.abortController?.abort()
      this.abortController = null
    }
  }
}
