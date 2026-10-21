import type { ContextSource } from '@/agent/context/journal'
import type { AgentMode } from '../agent-mode'
import type { CompressionBaselineState } from './context-compression'
import type { ContextManager } from '../context-manager'
import type { PiAIProvider } from '../llm/pi-ai-provider'
import type { Message, ToolCall } from '../message-types'
import type { ToolRegistry } from '../tool-registry'
import type { ToolContext } from '../tools/tool-types'

export type CompressionSummaryMode = 'llm' | 'fallback' | 'skip'

export interface BeforeToolCallHookContext {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
}

export interface BeforeToolCallHookResult {
  block?: boolean
  reason?: string
}

export interface AfterToolCallHookContext {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
  content: string
  details: Record<string, unknown>
  isError: boolean
}

export interface AfterToolCallHookResult {
  content?: string
  details?: Record<string, unknown>
  isError?: boolean
}

export interface AgentCallbacks {
  /** Durability barrier: reject to prevent dispatch when context cannot be saved. */
  onContextCommit?: (messages: Message[]) => Promise<void>

  /** Called when a new assistant message starts */
  onMessageStart?: () => void
  /** Called when reasoning stream starts (first reasoning_content delta) */
  onReasoningStart?: () => void
  /** Called with streaming reasoning/thinking deltas (GLM-4.7+) */
  onReasoningDelta?: (delta: string) => void
  /** Called when reasoning stream completes (before content/tool_call starts) */
  onReasoningComplete?: (reasoning: string) => void
  /** Called when content stream starts (first content delta) */
  onContentStart?: () => void
  /** Called with streaming content deltas */
  onContentDelta?: (delta: string) => void
  /** Called when content streaming completes (before tool_call starts) */
  onContentComplete?: (content: string) => void
  /** Called when the LLM requests a tool call */
  onToolCallStart?: (toolCall: ToolCall) => void
  /** Called with streaming tool call argument deltas (tool_stream mode) */
  onToolCallDelta?: (index: number, argsDelta: string, toolCallId?: string) => void
  /** Called when a tool execution completes */
  onToolCallComplete?: (toolCall: ToolCall, result: string) => void
  /** Called when messages are updated mid-loop (e.g. after assistant msg or tool result) */
  onMessagesUpdated?: (messages: Message[]) => void
  /** Called when the entire agent loop finishes */
  onComplete?: (messages: Message[]) => void
  /** Called on error */
  onError?: (error: Error) => void
  /**
   * Called when SEP-1306 binary elicitation is detected
   * The agent loop will be paused; caller should handle file upload
   * and resume the agent with the file metadata as a tool result.
   */
  onElicitation?: (elicitation: {
    mode: 'binary'
    message: string
    toolName: string
    args: Record<string, unknown>
    serverId: string
    toolCallId: string
  }) => void
  /** Called when a tool execution times out */
  onToolTimeout?: (toolCall: ToolCall) => void
  /** Called when agent stops due to maxIterations limit */
  onIterationLimitReached?: (limit: number) => void
  /** Called when context compression starts */
  onContextCompressionStart?: (payload: { droppedGroups: number; droppedContentChars: number }) => void
  /** Called when context compression completes */
  onContextCompressionComplete?: (payload: {
    mode: CompressionSummaryMode
    summary: string | null
    droppedGroups: number
    droppedContentChars: number
    summaryChars: number
    latencyMs: number
  }) => void
}

export interface AgentLoopConfig {
  /** Additional environment providers; committed by the same durable context journal. */
  contextSources?: ContextSource[]
  provider: PiAIProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  toolContext: ToolContext
  systemPrompt?: string
  maxIterations?: number
  /** Optional session ID for memory tracking */
  sessionId?: string
  /** Callback when loop completes (before onComplete) - for side effects like refresh */
  onLoopComplete?: () => Promise<void>
  /** Tool execution timeout in milliseconds (default: 30000ms) */
  toolExecutionTimeout?: number
  /** Optional hook called before tool execution */
  beforeToolCall?: (
    context: BeforeToolCallHookContext
  ) => Promise<BeforeToolCallHookResult | undefined> | BeforeToolCallHookResult | undefined
  /** Optional hook called after tool execution */
  afterToolCall?: (
    context: AfterToolCallHookContext
  ) => Promise<AfterToolCallHookResult | undefined> | AfterToolCallHookResult | undefined
  /** Agent execution mode: 'plan' (read-only) or 'act' (full access). Defaults to 'act'. */
  mode?: AgentMode
  /**
   * When true, skip system prompt enhancements (skills injection, MCP summaries,
   * tool docs, prefetch, etc.). Used by specialized subagents that provide
   * their own self-contained system prompt.
   */
  skipEnhancements?: boolean
  /** Initial convert call counter for context compression cadence (cross-run continuity). */
  initialConvertCallCount?: number
  /** Initial summary convert-call marker for compression cadence (cross-run continuity). */
  initialLastSummaryConvertCall?: number
  /** Callback when compression counters are updated after a run. */
  onCompressionStateUpdate?: (state: {
    convertCallCount: number
    lastSummaryConvertCall: number
  }) => void
  /**
   * Restored compression baseline from a previous run's persisted state.
   * When provided, `convertAgentMessagesToLlm` will prepend the summary
   * and filter out messages older than the cutoff timestamp.
   */
  initialCompressionBaseline?: CompressionBaselineState | null
  /**
   * When true, force-disable thinking/reasoning for this loop instance
   * regardless of the global settings store. Useful for lightweight
   * subagents (e.g. tool-searcher) that don't need deep reasoning.
   */
  disableThinking?: boolean
  /**
   * Optional soft-interrupt hook forwarded to `executePiCoreLoop` /
   * `processPiLoopEvents`. When this returns `true` after a tool execution
   * completes, the loop yields early so the caller can dequeue a queued
   * user message and start a fresh turn (Codex/Claude Code-style
   * "interrupt at tool boundary" behavior).
   *
   * Typically wired to:
   *   useConversationRuntimeStore.getState().getQueueDepth(conversationId) > 0
   */
  shouldYieldForQueue?: () => boolean
}
