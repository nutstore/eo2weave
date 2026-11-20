import type { SubagentAcceptedReceipt, SubagentBatchAcceptance } from '@/agent/subagent/async-types'
import type { TeamTaskHandoff } from '@/agent/team/team-manifest'
/**
 * Tool system types for Agent tool calling.
 * Compatible with OpenAI function calling format.
 */

import type { PiAIProvider } from '../llm/pi-ai-provider'
import type { Message } from '../message-types'
import type { CodeToolCapabilities } from '@/services/code-execution'

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
  minLength?: number
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
  // The caller canceled (e.g. an aborted run_code script), not a task failure.
  CANCELED: 'CANCELED',
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
  /** Last execution steps for failed notifications — lets the parent self-diagnose. */
  execution_tail?: string
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

/**
 * Subagent capability boundary. Declared by a caller (ephemeral member) or read
 * from an actor's meta.json; both are merged, and the intersection wins.
 */
export interface SubagentCapabilities {
  /**
   * Tool classes this execution may use. Omitted = every class the mode allows.
   * Classes are coarse on purpose (read/write/shell/external/orchestrate) so a
   * newly added tool cannot slip in through a stale allowlist.
   */
  classes?: import('./tool-capabilities').ToolCapabilityClass[]
  /** Shorthand: only read tools, and the execution is forced into plan mode. */
  readonly?: boolean
}

export interface SpawnSubagentInput {
  description: string
  prompt: string
  name?: string
  mode?: 'plan' | 'act'
  timeout_ms?: number
  /** Subagent role — controls behavior suffix appended to system prompt. */
  subagent_type?: SubagentType
  /**
   * Optional actor: run this execution as an existing project agent so its
   * persona files (SOUL/IDENTITY/AGENTS/USER/MEMORY) apply. `null` or omitted
   * means anonymous — no persona is injected at all.
   */
  as?: string | null
  /**
   * Inline role statement for an ephemeral member. Reaches the model through the
   * system prompt and is never persisted, so it creates no agent directory.
   */
  role?: string
  /** Capability boundary for this execution (merged with the actor's meta). */
  capabilities?: SubagentCapabilities
  /**
   * Team board task this execution fulfils. The lead writes it into the run's
   * `manifest.json` (status `running`) and the member sees only this task.
   */
  task_id?: string
  /** What the lead expects back, what to read first, what to produce. */
  handoff?: TeamTaskHandoff
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

/** One projected execution-history message returned by get_subagent_trace. */
export interface SubagentTraceMessage {
  role: Message['role']
  content?: string | null
  /** Set when content exceeded the per-message projection cap. */
  content_truncated?: boolean
  tool_calls?: Message['toolCalls']
  tool_call_id?: Message['toolCallId']
  tool_name?: Message['name']
  timestamp?: number
}

export interface SubagentRuntime {
  acknowledge(input: { agentId: string; executionId: string }): Promise<void>
  start(input: SpawnSubagentInput): Promise<SubagentAcceptedReceipt>
  batchStart(input: BatchSpawnSubagentInput): Promise<SubagentBatchAcceptance>
  spawn(input: SpawnSubagentInput, options?: { signal?: AbortSignal }): Promise<SpawnSubagentResult>
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
  /** Stop every pending/running task owned by this runtime. */
  stopAll(input?: { force?: boolean; backgroundOnly?: boolean }): Promise<{ stopped: string[] }>
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
  /** Read a child's execution history (the trace humans see in the detail panel). */
  getTrace(input: {
    agentId: string
    execution_id?: string
    limit?: number
    offset?: number
  }): Promise<{
    agentId: string
    executionId: string
    status: SubagentTaskStatus
    description: string
    total: number
    offset: number
    truncated: boolean
    messages: SubagentTraceMessage[]
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
  source?: 'workspace' | 'native' | 'opfs' | 'agent' | 'assets' | 'skills' | 'provider' | 'native_fallback' | 'team'
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
  /** Invocation-scoped tool capability, supplied only to run_code. */
  codeTools?: CodeToolCapabilities
  /** Adapter-owned Bash lane, independent of a waiting outer Bash invocation. */
  bashExecutor?: typeof import('./bash-worker/client').bashExec
  /** Root directory handle for file operations */
  directoryHandle: FileSystemDirectoryHandle | null
  /** True when this tool call originates from a delegated subagent. */
  isSubagent?: boolean
  /**
   * Tool classes this execution is limited to (see tools/tool-capabilities).
   * Context sources that merely *document* a capability outside this set must
   * stay silent — otherwise the model is handed a manual for a door it cannot
   * open, and spends turns trying.
   */
  capabilityClasses?: readonly import('./tool-capabilities').ToolCapabilityClass[]
  /**
   * Team board run key for this execution (`vfs://team/{runKey}/...`).
   * Absent means "no active board"; the team namespace then refuses every path
   * rather than inventing a run directory.
   */
  teamRunKey?: string
  /**
   * Team board task this execution fulfils. Also the fallback write slot for an
   * anonymous member, so it must travel with the member's own context.
   */
  teamTaskId?: string
  /** Workspace ID bound to the current agent run */
  toolCallId?: string
  workspaceId?: string | null
  /** Canonical transcript bound by the runtime, including delegated child histories. */
  conversationHistory?: { id: string; read: () => Promise<readonly Message[]> }
  /** Active project ID for cross-namespace VFS routing */
  projectId?: string | null
  /**
   * Folder-less conversation (kind='direct'): folder-dependent tools are
   * never registered and name-based execution of them is rejected.
   */
  directMode?: boolean
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
