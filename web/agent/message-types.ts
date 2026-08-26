/**
 * Agent message types for AI conversation system.
 * Compatible with OpenAI chat completion format.
 */

import type { AssetMeta } from '@/types/asset'
import type { FlowInstance } from '@/agent/flow/types'
import { parseThinkTags } from './think-tags'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** AI-generated image, stored inline in the message */
export interface GeneratedImage {
  /** base64 encoded image data */
  data: string
  /** MIME type, e.g. "image/png" */
  mimeType: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

export interface ToolResult {
  toolCallId: string
  name: string
  content: string // JSON string or plain text
  /**
   * Optional multimodal parts (e.g. screenshot images). When present, the
   * tool result is rendered as a multimodal message (text + image parts)
   * so vision-capable models can see the image directly. For text-only
   * models, the image parts are filtered out at request-build time.
   */
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

/** Token usage stats for a message */
export interface MessageUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  /** Accumulated NON-CACHE input tokens across all assistant messages in this turn */
  accumulatedPromptTokens?: number
  /** Accumulated cache-read tokens across all assistant messages in this turn */
  accumulatedCacheTokens?: number
  /** Accumulated output tokens across all assistant messages in this turn */
  accumulatedCompletionTokens?: number
  /** Provider/model that produced this usage. Persisted for historical exports. */
  provider?: string
  model?: string
  /** Price and cost frozen when the response was received. */
  pricing?: import('./usage-cost').UsagePricingSnapshot
  cost?: import('./usage-cost').UsageCostSnapshot
}

export interface Message {
  id: string
  role: MessageRole
  content: string | null
  /**
   * Multimodal content parts (text + images) for vision-capable models.
   * When present, sent to the LLM as-is and not flattened to a text string.
   * Mirrors pi-ai's UserMessage.content array format.
   */
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  /** UI-only classification for special assistant records */
  kind?: 'normal' | 'context_summary' | 'run_changes'
  /**
   * Present only on `kind === 'run_changes'` assistant records. Points at the
   * auto-apply snapshot that captured everything this agent run changed, so
   * the message-stream UI can render a "what this run changed" card that
   * stays persisted with the run's message history.
   */
  runChanges?: { snapshotId: string }
  /** Chain-of-thought reasoning content (GLM-4.7+), not sent back to API */
  reasoning?: string | null
  /** Elapsed wall-clock time for this message's reasoning block, in milliseconds. */
  reasoningDurationMs?: number
  toolCalls?: ToolCall[]
  toolCallId?: string // For tool role messages
  name?: string // Tool name for tool role messages
  timestamp: number
  /** Token usage for this assistant message (from API response) */
  usage?: MessageUsage
  /** File assets attached to this message (user uploads or agent-generated) */
  assets?: AssetMeta[]
  /** AI-generated images from /image command (base64, inline display) */
  images?: GeneratedImage[]
  /**
   * Present only on user-role messages synthetically injected by the
   * `delegate_to` handoff. Lets the UI render the message as a
   * "delegation note" card (rather than a user chat bubble) and lets
   * downstream logic distinguish it from real user input.
   */
  delegationNote?: {
    fromAgentId: string
    fromAgentName?: string
    task: string
    reason?: string
  }
  /**
   * Frozen snapshot of the upstream page context at the moment this user
   * message was sent. Populated only when CreatorWeave runs in side-panel
   * mode (opened from a WebMCP-enabled page). The UI does NOT render this
   * field; it is appended to the user message text at LLM-send time (see
   * message-mappers.ts), analogous to how image OCR text is attached.
   *
   * Storing it per-message (rather than injecting into system prompt)
   * keeps the system prompt stable so prompt caching still hits across
   * turns in the same conversation.
   */
  pageContext?: {
    hostname?: string | null
    url?: string | null
    title?: string | null
    selectedText?: string | null
    /** Arbitrary business fields from the upstream provider (stringified when sent) */
    providerContext?: unknown
    /** WebMCP tools available on the upstream hostname (frozen per-message).
     *  Name + description + full name only — schemas are NOT embedded;
     *  the LLM fetches them via search_tools (search + schema in one call).
     *  Frozen at capture time so the conversation history shows what the
     *  agent actually saw, and stale snapshots age out with the message. */
    webmcpTools?: Array<{ name: string; description: string; fullName: string }>
  }
}

export type DraftAssistantStep =
  | {
      id: string
      timestamp?: number
      type: 'reasoning'
      content: string
      streaming: boolean
      /** Frozen when the reasoning stream completes; absent while still streaming. */
      durationMs?: number
    }
  | {
      id: string
      timestamp?: number
      type: 'content'
      content: string
      streaming: boolean
    }
  | {
      id: string
      timestamp?: number
      type: 'tool_call'
      toolCall: ToolCall
      args: string
      result?: string
      streaming: boolean
      /** SubAgent progress events bridged from runtime notifications during blocking spawn */
      subagentEvents?: Array<{
        agentId: string
        status: string
        summary: string
        timestamp: number
      }>
    }
  | {
      id: string
      timestamp?: number
      type: 'compression'
      content: string
      streaming: boolean
    }

/** Runtime status for a conversation */
export type ConversationStatus = 'idle' | 'pending' | 'streaming' | 'tool_calling' | 'error'
export type ConversationTitleMode = 'auto' | 'manual'

export interface ContextWindowUsage {
  /** Actual input tokens sent to model this turn */
  usedTokens: number
  /** Effective input budget E = modelMaxTokens - reserveTokens */
  maxTokens: number
  /** Reserved tokens for model output */
  reserveTokens: number
  /** Usage percent = usedTokens / maxTokens * 100 */
  usagePercent: number
  /** Raw model context limit M (for diagnostics/UI) */
  modelMaxTokens?: number
}

export interface Conversation {
  id: string
  title: string
  /** Whether title is auto-generated or manually edited by user */
  titleMode?: ConversationTitleMode
  messages: Message[]
  createdAt: number
  updatedAt: number
  /** Runtime status (not persisted) */
  status: ConversationStatus
  /** Agent execution mode per-conversation: 'plan' (read-only) or 'act' (full access). Not persisted. */
  agentMode: 'plan' | 'act'
  /** Streaming content being received (not persisted) */
  streamingContent: string
  /** Streaming reasoning content (not persisted) */
  streamingReasoning: string
  /** Whether reasoning is actively streaming (not persisted) */
  isReasoningStreaming: boolean
  /** Complete reasoning content (not persisted) */
  completedReasoning: string | null
  /** Whether content is actively streaming (not persisted) */
  isContentStreaming: boolean
  /** Complete content (not persisted) */
  completedContent: string | null
  /** Currently executing tool call (not persisted) */
  currentToolCall: ToolCall | null
  /** All currently executing tool calls (not persisted) */
  activeToolCalls?: ToolCall[]
  /** Streaming tool call arguments (not persisted) */
  streamingToolArgs: string
  /** Streaming args keyed by tool call id (not persisted) */
  streamingToolArgsByCallId?: Record<string, string>
  /** Error message (not persisted) */
  error: string | null
  /** Active run id for guarding stale callbacks (not persisted) */
  activeRunId?: string | null
  /** Monotonic run counter for this conversation (not persisted) */
  runEpoch?: number
  /** Streaming draft projection rendered in UI (not persisted) */
  draftAssistant?: {
    reasoning: string
    content: string
    toolCalls: ToolCall[]
    toolResults: Record<string, string>
    toolCall: ToolCall | null
    toolArgs: string
    steps: DraftAssistantStep[]
    activeReasoningStepId?: string | null
    activeContentStepId?: string | null
    activeToolStepId?: string | null
    activeCompressionStepId?: string | null
  } | null
  /** Runtime context window usage for the active model call (not persisted) */
  contextWindowUsage?: ContextWindowUsage | null
  /** Last persisted context window usage snapshot */
  lastContextWindowUsage?: ContextWindowUsage | null
  /** Number of mounted views consuming this conversation (not persisted) */
  mountRefCount?: number
  /** Runtime convert call counter for context compression cadence (not persisted) */
  compressionConvertCallCount?: number
  /** Runtime marker for last summary convert call (not persisted) */
  compressionLastSummaryConvertCall?: number
  /** Persisted compressed context summary injected into future model inputs */
  compressedContextSummary?: string | null
  /** Persisted cutoff timestamp for rebuilding compressed context */
  compressedContextCutoffTimestamp?: number | null
  /** Persisted visual-flow working copy for this conversation. */
  flowInstance?: FlowInstance | null
  /** Assets collected during current agent run (not persisted, moved to assistant message on commit) */
  collectedAssets?: AssetMeta[]
  /**
   * Runtime counter for delegate_to handoffs in the current turn (not persisted).
   * Prevents infinite A→B→A delegation loops; capped at MAX_DELEGATION_DEPTH.
   */
  delegationDepth?: number
}

/** Generate a unique message ID */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** Create a user message */
export function createUserMessage(
  content: string,
  assets?: AssetMeta[],
  pageContext?: Message['pageContext'],
): Message {
  return {
    id: generateId(),
    role: 'user',
    content,
    timestamp: Date.now(),
    assets,
    ...(pageContext ? { pageContext } : {}),
  }
}

/** Create an assistant message */
export function createAssistantMessage(
  content: string | null,
  toolCalls?: ToolCall[],
  usage?: MessageUsage,
  reasoning?: string | null,
  kind: Message['kind'] = 'normal',
  assets?: AssetMeta[]
): Message {
  const rawContent = content || ''
  const parsedThink = parseThinkTags(rawContent)
  const normalizedContent = parsedThink.hasThinkTag ? parsedThink.content : rawContent
  const normalizedReasoning =
    reasoning && reasoning.trim().length > 0
      ? reasoning
      : parsedThink.reasoning
        ? parsedThink.reasoning
        : null

  return {
    id: generateId(),
    role: 'assistant',
    content: normalizedContent || null,
    kind,
    reasoning: normalizedReasoning || null,
    toolCalls,
    usage,
    timestamp: Date.now(),
    assets,
  }
}

/** Create a tool result message */
export function createToolMessage(result: ToolResult): Message {
  return {
    id: generateId(),
    role: 'tool',
    content: result.content,
    // Pass through contentParts (e.g. screenshot images) so vision-capable
    // models can see them. The agent loop's message mapper emits these as
    // image_url content parts when the target model supports vision.
    contentParts: result.contentParts,
    toolCallId: result.toolCallId,
    name: result.name,
    timestamp: Date.now(),
  }
}

/**
 * Create a UI-only "run changes" card message.
 *
 * Never sent to the model (see internalToPiMessages) and rendered as a
 * dedicated card in the message stream. It persists with the run's message
 * history so the change summary survives reloads.
 */
export function createRunChangesMessage(snapshotId: string): Message {
  return {
    id: generateId(),
    role: 'assistant',
    content: null,
    kind: 'run_changes',
    runChanges: { snapshotId },
    timestamp: Date.now(),
  }
}

/** Create a new conversation */
export function createConversation(title?: string): Conversation {
  const id = generateId()
  const now = Date.now()
  return {
    id,
    title: title || `Chat ${new Date(now).toLocaleString()}`,
    // Always start in 'auto' mode so the title can be auto-generated after
    // the first agent run. Callers that pass a title (e.g. 'New conversation',
    // or the first 30 chars of the user's message) are passing placeholders,
    // not user-confirmed titles. Only updateTitle() (user rename) and
    // generateTitle(manual=true) set titleMode to 'manual'.
    titleMode: 'auto' as const,
    messages: [],
    createdAt: now,
    updatedAt: now,
    // Runtime state (not persisted)
    status: 'idle',
    agentMode: 'act',
    streamingContent: '',
    streamingReasoning: '',
    isReasoningStreaming: false,
    completedReasoning: null,
    isContentStreaming: false,
    completedContent: null,
    currentToolCall: null,
    activeToolCalls: [],
    streamingToolArgs: '',
    streamingToolArgsByCallId: {},
    error: null,
    activeRunId: null,
    runEpoch: 0,
    draftAssistant: null,
    contextWindowUsage: null,
    lastContextWindowUsage: null,
    mountRefCount: 0,
    compressionConvertCallCount: 0,
    compressionLastSummaryConvertCall: Number.NEGATIVE_INFINITY,
    compressedContextSummary: null,
    compressedContextCutoffTimestamp: null,
    collectedAssets: [],
  }
}
