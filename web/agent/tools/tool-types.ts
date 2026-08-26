/**
 * Tool system types for Agent tool calling.
 * Compatible with OpenAI function calling format.
 */

import type { PiAIProvider } from '../llm/pi-ai-provider'

/** JSON Schema subset for tool parameter definitions */
export interface JSONSchemaProperty {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: JSONSchemaProperty
  properties?: Record<string, JSONSchemaProperty>
  required?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  oneOf?: JSONSchemaProperty[]
}

export interface JSONSchema {
  type: 'object'
  properties: Record<string, JSONSchemaProperty>
  required?: string[]
}

export type SubagentTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

// ---------------------------------------------------------------------------
// SubAgent Error System (§4.7)
// ---------------------------------------------------------------------------

/** SubAgent error codes — covers all client (4xx) and system (5xx) errors. */
export const SubagentErrorCode = {
  // Client errors (4xx)
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  INVALID_AGENT_TYPE: 'INVALID_AGENT_TYPE',
  TIMEOUT_EXCEEDS_MAX: 'TIMEOUT_EXCEEDS_MAX',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_ALREADY_COMPLETED: 'TASK_ALREADY_COMPLETED',
  NAME_CONFLICT: 'NAME_CONFLICT',
  QUEUE_FULL: 'QUEUE_FULL',
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  CONCURRENCY_LIMIT: 'CONCURRENCY_LIMIT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  // System errors (5xx)
  PERSISTENCE_WRITE_FAILED: 'PERSISTENCE_WRITE_FAILED',
  TRANSCRIPT_NOT_FOUND: 'TRANSCRIPT_NOT_FOUND',
  TRANSCRIPT_CORRUPTED: 'TRANSCRIPT_CORRUPTED',
  PROCESS_ZOMBIE: 'PROCESS_ZOMBIE',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
} as const

export type SubagentErrorCodeType = (typeof SubagentErrorCode)[keyof typeof SubagentErrorCode]

/** Structured error thrown by the subagent runtime and caught by tool executors. */
export class SubagentError extends Error {
  readonly code: SubagentErrorCodeType
  readonly field?: string
  readonly recoverable: boolean

  constructor(code: SubagentErrorCodeType, message: string, options?: { field?: string; recoverable?: boolean }) {
    super(message)
    this.name = 'SubagentError'
    this.code = code
    this.field = options?.field
    this.recoverable = options?.recoverable ?? false
  }
}

export interface SubagentTaskUsage {
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  duration_ms: number
  tool_calls: number
  provider?: string
  model?: string
  input_cost_usd?: number
  output_cost_usd?: number
  cache_read_cost_usd?: number
  estimated_cost_usd?: number
  cost_complete?: boolean
}

export interface SubagentTaskSummary {
  agentId: string
  name?: string
  description: string
  status: SubagentTaskStatus
  created_at: number
  updated_at: number
}

export interface SubagentTaskNotification {
  event_type: 'task_notification'
  agentId: string
  /** Parent spawn_subagent / batch_spawn tool-call ID, when available. */
  parentToolCallId?: string
  status: SubagentTaskStatus
  summary: string
  result?: string
  result_schema_id?: string
  result_json?: Record<string, unknown>
  exit_reason?: 'completed' | 'error' | 'signal' | 'timeout' | 'rejected' | 'stopped'
  usage?: SubagentTaskUsage
  error?: {
    code: string
    message: string
    recoverable: boolean
  }
  timestamp: number
}

/**
 * SubAgent Step Notification — real-time streaming events from subagent's
 * internal AgentLoop. Each notification carries a DraftAssistantEvent
 * (the same event type used by the main agent's draft pipeline) so the
 * UI can render subagent steps identically to main agent steps.
 */
export interface SubagentStepNotification {
  event_type: 'step_notification'
  agentId: string
  /** Parent spawn_subagent / batch_spawn tool-call ID, when available. */
  parentToolCallId?: string
  step: import('@/store/draft-assistant').DraftAssistantEvent
  timestamp: number
}

/**
 * SubAgent role type — controls what kind of behavior the subagent should adopt.
 *
 * - 'general-purpose': default, no special behavior modification
 * - 'explorer': read-only investigation, no file modifications
 * - 'worker': code-changing subtask, must list modified files
 * - 'awaiter': long-running command awaiter, no unrelated actions
 */
export type SubagentType = 'general-purpose' | 'explorer' | 'worker' | 'awaiter'

export interface SpawnSubagentInput {
  description: string
  prompt: string
  name?: string
  mode?: 'plan' | 'act'
  timeout_ms?: number
  /** Subagent role — controls behavior suffix appended to system prompt. */
  subagent_type?: SubagentType
  /** Internal UI correlation ID for the parent spawn tool call. */
  parentToolCallId?: string
}

export interface BatchSpawnSubagentInput {
  tasks: Array<SpawnSubagentInput>
  max_concurrency?: number
}

export interface SpawnSubagentResult {
  status: 'completed'
  agentId: string
  content: string
  usage?: SubagentTaskUsage
}

export interface SubagentRuntime {
  spawn(input: SpawnSubagentInput): Promise<SpawnSubagentResult>
  sendMessage(input: {
    to: string
    message: string
    timeout_ms?: number
    overflow_action?: 'reject' | 'drop_oldest'
  }): Promise<{
    success: boolean
    message: string
    queued_at?: number
    queue_position?: number
    resumed?: boolean
    resume_error?: { code: string; message: string; recoverable: boolean }
  }>
  stop(input: {
    agentId: string
    force?: boolean
    timeout_ms?: number
  }): Promise<{ success: boolean; already_stopped?: boolean }>
  resume(input: {
    agentId: string
    prompt: string
    timeout_ms?: number
  }): Promise<{
    status: 'resumed'
    agentId: string
    resumed_from: string | null
    transcript_entries_recovered: number
  }>
  getStatus(input: {
    agentId: string
  }): Promise<{
    agentId: string
    status: SubagentTaskStatus
    description: string
    created_at: number
    updated_at: number
    last_activity_at: number
    queue_depth: number
    usage?: SubagentTaskUsage
    error?: { code: string; message: string }
  }>
  list(input: {
    status?: string
    limit?: number
    offset?: number
  }): Promise<{
    agents: SubagentTaskSummary[]
    total: number
  }>
  batchSpawn(input: BatchSpawnSubagentInput): Promise<{
    completed: Array<{
      task_index: number
      agentId: string
      content: string
      usage?: SubagentTaskUsage
    }>
    failed: Array<{
      task_index: number
      agentId: string
      reason: string
      error_code: string
    }>
  }>
  /** Graceful shutdown: marks all active tasks as failed(SESSION_INTERRUPTED). */
  shutdown(): void
}

export interface ReadFileStateEntry {
  content: string
  timestamp: number
  offset?: number
  limit?: number
  isPartialView?: boolean
  source?: 'workspace' | 'native' | 'opfs' | 'agent' | 'assets' | 'skills' | 'native_fallback'
}

/** Tool definition in OpenAI function calling format */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JSONSchema
  }
}

/** Context provided to tool executors */
export interface ToolContext {
  /** Root directory handle for file operations */
  directoryHandle: FileSystemDirectoryHandle | null
  /** True when this tool call originates from a delegated subagent. */
  isSubagent?: boolean
  /** Workspace ID bound to the current agent run */
  workspaceId?: string | null
  /** Active project ID for cross-namespace VFS routing */
  projectId?: string | null
  /** Current acting agent ID for VFS ACL checks */
  currentAgentId?: string | null
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Current context token usage (optional, for tools to self-regulate) */
  contextUsage?: {
    usedTokens: number
    maxTokens: number
  }
  /** Agent execution mode: 'plan' (read-only) or 'act' (full access) */
  agentMode?: 'plan' | 'act'
  /** The LLM provider from the current agent loop — available to tool executors that need LLM access */
  provider?: PiAIProvider
  /** Subagent runtime for delegated execution */
  subagentRuntime?: SubagentRuntime
  /** Per-run cache of file content that was read by tools, keyed by normalized target path */
  readFileState?: Map<string, ReadFileStateEntry>
  /**
   * Records workspace paths successfully mutated by this agent run. The owner
   * is the run lifecycle, which can use it to safely scope end-of-run work.
   */
  onWorkspacePathsChanged?: (paths: readonly string[]) => void
  /**
   * Ask user question handler. When provided, the ask_user_question tool will
   * call this to show a question card in the UI and wait for the user's response.
   * If not provided (e.g. in subagent contexts), the tool falls back to default_answer.
   */
  askUserQuestion?: (params: {
    question: string
    type: AskQuestionType
    options?: Array<string | { label: string; description?: string; recommended?: boolean }>
    defaultAnswer?: string
    context?: {
      affected_files?: string[]
      preview?: string
    }
    signal?: AbortSignal
    /** The tool call ID from the LLM response — used to correlate UI with pending question */
    toolCallId?: string
  }) => Promise<{
    answer: string
    confirmed: boolean
    timed_out: boolean
  }>
  /**
   * The current tool call ID from the LLM's tool_calls response.
   * Available during tool execution so tools like ask_user_question
   * can correlate their pending question with the UI's toolCall display.
   */
  currentToolCallId?: string
  /**
   * Called by the delegate_to tool to signal that the main agent wants to
   * hand off control. The store reads this after the loop completes and
   * restarts with the target agent persona. Set by conversation.store on
   * AgentLoop construction.
   */
  onDelegation?: (payload: {
    targetAgentId: string
    task: string
    reason?: string
  }) => void
}

/** Ask user question type */
export type AskQuestionType = 'yes_no' | 'single_choice' | 'multi_choice' | 'free_text'

/** Tool executor function signature */
export type ToolExecutor = (args: Record<string, unknown>, context: ToolContext) => Promise<string>

/** Prompt doc for a single tool — used to auto-generate Available Tools section */
export interface ToolPromptDoc {
  /** Grouping category for display ordering (e.g. 'file-ops', 'git', 'subagent') */
  category: string
  /** Section heading (e.g. '### Git Tools'). If omitted, lines are appended to the previous section. */
  section?: string
  /** One or more markdown lines describing the tool usage. */
  lines: string[]
}

/** Complete tool registration entry */
export interface ToolEntry {
  definition: ToolDefinition
  executor: ToolExecutor
  /** Prompt doc for auto-generating system prompt Available Tools section */
  promptDoc?: ToolPromptDoc
}
