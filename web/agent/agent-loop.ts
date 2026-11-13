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

import { collectContextSources, type ContextSource } from '@/agent/context/journal'
import { createRuntimeContextSources, collectRuntimeContext } from '@/agent/context/sources'
import type { ToolContext } from './tools/tool-types'
import type { Message } from './message-types'
import { ContextManager } from './context-manager'
import { ToolRegistry } from './tool-registry'
import { getUniversalSystemPrompt } from './prompts/universal-system-prompt'
import { PiAIProvider } from './llm/pi-ai-provider'
import { type AgentMode } from './agent-mode'
import { generateContextSummaryWithLLM } from './loop/context-summary'
import { resolveCompressionTriggerTokens, restoreCompressionBaseline, type CompressionBaselineState } from './loop/context-compression'
import { buildRuntimeEnhancedPrompt, triggerPrefetchForMessages } from './loop/enhancements'
import { executePiCoreLoop } from './loop/pi-core-runner'
import { abortReasonMessage, createAgentAbortReason, AgentAbortReasonName } from '@/lib/agent-abort'
import { compressHistory } from './loop/compression-runner'
import { estimateCompressionTokens } from './loop/compression-history'
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
  private contextSources: ContextSource[]
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
    this.contextSources = config.contextSources ?? []
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

  /** Cancel the current agent loop. Internal (non-user) paths pass their own semantic reason. */
  cancel(reason: AgentAbortReasonName = AgentAbortReasonName.ByUser): void {
    this.abortController?.abort(createAgentAbortReason(reason))
  }

  private async runWithPiAgentCore(
    messages: Message[],
    callbacks?: AgentCallbacks,
    invocationController?: AbortController | null,
    invocationCompression?: { baseline: CompressionBaselineState | null; convertCallCount: number; lastSummaryConvertCall: number }
  ): Promise<Message[]> {
    // Use the CALLER's captured controller when provided (run() captured it
    // right after creating it); fall back to the instance field otherwise.
    // Overlapping runs must abort and read THEIR OWN signal, not whichever
    // run is currently the latest.
    const controller = invocationController !== undefined ? invocationController : this.abortController
    const signal = controller?.signal
    if (!signal) return messages

    let allMessages = messages
    let shouldStopForElicitation = false
    let reachedMaxIterations = false
    try {
      const result = await executePiCoreLoop({
        signal,
        initialMessages: messages,
        callbacks,
        collectContext: this.skipEnhancements && this.contextSources.length === 0 ? undefined : (() => {
          const sources = [...(this.skipEnhancements ? [] : createRuntimeContextSources(() => ({
            baseSystemPrompt: this.baseSystemPrompt, messages, mode: this.mode,
            toolContext: this.toolContext, sessionId: this.sessionId,
          }))), ...this.contextSources]
          return () => this.skipEnhancements ? collectContextSources(sources) : collectRuntimeContext(sources)
        })(),
        baseSystemPrompt: this.baseSystemPrompt,
        mode: this.mode,
        toolRegistry: this.toolRegistry,
        beforeToolCall: this.beforeToolCall,
        afterToolCall: this.afterToolCall,
        getToolContext: () => this.toolContext,
        provider: this.provider,
        contextManager: this.contextManager,
        toolExecutionTimeout: this.toolExecutionTimeout,
        toolTimeoutExemptions: TOOL_TIMEOUT_EXEMPTIONS,
        maxIterations: this.maxIterations,
        convertCallCount: invocationCompression ? invocationCompression.convertCallCount : this.convertCallCount,
        lastSummaryConvertCall: invocationCompression ? invocationCompression.lastSummaryConvertCall : this.lastSummaryConvertCall,
        compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX,
        generateContextSummaryWithLLM: (droppedContent, maxSummaryTokens, sourceMessages, replay) =>
          generateContextSummaryWithLLM({
            provider: this.provider,
            droppedContent,
            messages: sourceMessages,
            systemPrompt: replay?.systemPrompt ?? this.contextManager.getConfig().systemPrompt ?? this.baseSystemPrompt,
            tools: replay?.tools ?? this.toolRegistry.getToolDefinitionsForMode(this.mode, { directMode: this.toolContext.directMode }),
            signal,
            maxSummaryTokens,
            compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX,
          }),
        onAbortRequested: () => controller?.abort(createAgentAbortReason(AgentAbortReasonName.Internal)),
        // Per-invocation compression state: captured by run() BEFORE any await
        // point (including an explicitly captured null), so an overlapping
        // run's commits can never leak into this invocation's
        // trimming/compaction input.
        initialCompressionBaseline: invocationCompression ? invocationCompression.baseline : this.compressionBaseline,
        disableThinking: this.disableThinking,
        shouldYieldForQueue: this.shouldYieldForQueue,
        sessionId: this.sessionId,
      })
      // Commit compression state only while this invocation still owns the
      // instance (a newer overlapping run must not have its baseline or
      // counters clobbered by an older, slower run finishing last).
      // NOTE: executePiCoreLoop reads this.compressionBaseline for trimming
      // during the run; overlapping runs are prevented at the store layer (a
      // new run replaces the registered loop before starting), so the read
      // path cannot race in practice — the commit-side guard below protects
      // the one overlap window that exists (older run finishing last).
      if (this.abortController === controller) {
        this.compressionBaseline = result.compressionBaseline ?? this.compressionBaseline
        this.convertCallCount = result.convertCallCount
        this.lastSummaryConvertCall = result.lastSummaryConvertCall
        this.onCompressionStateUpdate?.({
          convertCallCount: this.convertCallCount,
          lastSummaryConvertCall: this.lastSummaryConvertCall,
        })
      }
      allMessages = result.allMessages
      shouldStopForElicitation = result.shouldStopForElicitation
      reachedMaxIterations = result.reachedMaxIterations
    } catch (error) {
      if (signal.aborted) {
        console.warn('[#LoopStop] aborted_during_pi_core_run', {
          reason: abortReasonMessage(signal.reason) ?? 'signal_aborted',
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
      // Abort this run's signal to stop any in-flight LLM requests inside the
      // pi-agent-core generator (especially the push-based cw-openai-fetch
      // stream whose async IIFE would otherwise keep running).
      controller?.abort(createAgentAbortReason(AgentAbortReasonName.IterationLimit))
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
    // Same overlapping-run guard as run(): only this invocation's controller.
    const controller = this.abortController
    const signal = controller.signal

    try {
      const config = this.contextManager.getConfig()
      const model = this.provider.getModel()
      const tools = this.toolRegistry.getToolDefinitionsForMode(this.mode, { directMode: this.toolContext.directMode })
      const systemPrompt = config.systemPrompt || this.baseSystemPrompt
      const capacity = Math.min(config.maxContextTokens, this.provider.maxContextTokens)
      const fixedTokens = Math.ceil(new TextEncoder().encode(JSON.stringify({ systemPrompt, tools })).length / 2)
      const available = Math.max(1, capacity - (config.reserveTokens ?? 0) - fixedTokens - Math.ceil(capacity * 0.05))
      const compressed = await compressHistory({
        messages,
        effectiveCapacityTokens: Math.min(available, resolveCompressionTriggerTokens({
          maxContextTokens: capacity,
          reserveTokens: config.reserveTokens,
          absoluteCapEnabled: config.compressionAbsoluteCapEnabled,
          absoluteCap: config.compressionAbsoluteCap,
        })),
        modelMaxOutputTokens: model.maxTokens,
        signal,
        callbacks,
        generateContextSummaryWithLLM: (droppedContent, maxSummaryTokens, sourceMessages) => generateContextSummaryWithLLM({
          provider: this.provider, droppedContent, messages: sourceMessages, systemPrompt, tools,
          maxSummaryTokens, compressedMemoryPrefix: COMPRESSED_MEMORY_PREFIX, signal,
        }),
      })
      if (!compressed) {
        callbacks?.onComplete?.(messages)
        return messages
      }
      if (estimateCompressionTokens(compressed.messages) > available) {
        throw new Error('The compressed conversation still exceeds the model input budget.')
      }
      signal.throwIfAborted()
      const summaryMessage: Message = {
        id: generateId(), role: 'user', kind: 'context_summary', content: compressed.summary,
        compressionBoundary: {
          throughMessageId: compressed.baseline.throughMessageId!,
          cutoffTimestamp: compressed.baseline.cutoffTimestamp,
          preservedMessageIds: compressed.baseline.preservedMessageIds,
        },
        timestamp: Math.max(0, compressed.baseline.cutoffTimestamp - 1),
      }
      const resultMessages = [...messages, summaryMessage]
      await callbacks?.onContextCommit?.(resultMessages)
      signal.throwIfAborted()
      if (this.abortController !== controller) return messages
      this.compressionBaseline = compressed.baseline
      this.convertCallCount++
      this.lastSummaryConvertCall = this.convertCallCount
      this.onCompressionStateUpdate?.({ convertCallCount: this.convertCallCount, lastSummaryConvertCall: this.lastSummaryConvertCall })
      callbacks?.onMessagesUpdated?.(resultMessages)

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
      // Clear the instance reference only if a newer run has not already
      // replaced it — otherwise we would orphan the newer run's controller.
      if (this.abortController === controller) this.abortController = null
    }
  }

  /**
   * Run the agent loop with a list of messages.
   * Appends new assistant/tool messages and returns the full updated list.
   */
  async run(messages: Message[], callbacks?: AgentCallbacks): Promise<Message[]> {
    this.abortController = new AbortController()
    // Capture this invocation's controller locally: if a second run() starts
    // before this one finishes, the earlier run's teardown must not abort the
    // newer run's signal or null out its controller.
    const controller = this.abortController
    const signal = controller.signal
    // Capture ALL per-invocation state BEFORE the first await so an
    // overlapping run's commits can never leak into this invocation.
    this.compressionBaseline = restoreCompressionBaseline(messages) ?? this.compressionBaseline
    const invocationCompression = {
      baseline: this.compressionBaseline,
      convertCallCount: this.convertCallCount,
      lastSummaryConvertCall: this.lastSummaryConvertCall,
    }

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
      return await this.runWithPiAgentCore(messages, callbacks, controller, invocationCompression)
    } catch (error) {
      if (signal.aborted) {
        console.warn('[#LoopStop] run_aborted', {
          reason: abortReasonMessage(signal.reason) ?? 'signal_aborted_outer',
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
      controller.abort(createAgentAbortReason(AgentAbortReasonName.LifecycleTeardown))
      // Clear the instance reference only if a newer run() has not already
      // replaced it — otherwise we would orphan the newer run's controller.
      if (this.abortController === controller) this.abortController = null
    }
  }
}
