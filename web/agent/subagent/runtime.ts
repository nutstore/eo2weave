import { SubagentStreamTrace } from './stream-trace'
import type { DraftAssistantEvent } from '@/store/draft-assistant'
import type {
  SubagentAcceptedReceipt, SubagentBatchAcceptance, SubagentCompletion,
  SubagentContinuation, SubagentExecutionMetadata,
} from './async-types'
import { useSubagentTaskStore } from '@/store/subagent-task.store'
import { type AgentMode } from '@/agent/agent-mode'
import { AgentLoop } from '@/agent/agent-loop'
import { ContextManager } from '@/agent/context-manager'
import { createUserMessage, generateId, type Message } from '@/agent/message-types'
import type { PiAIProvider } from '@/agent/llm/pi-ai-provider'
import type { ToolRegistry } from '@/agent/tool-registry'
import type {
  BatchSpawnSubagentInput,
  SpawnSubagentInput,
  SpawnSubagentResult,
  SubagentRuntime,
  SubagentTaskNotification,
  SubagentStepNotification,
  SubagentTaskStatus,
  SubagentTaskSummary,
  SubagentTaskUsage,
  SubagentType,
  ToolContext,
} from '@/agent/tools/tool-types'
import { SubagentError, SubagentErrorCode } from '@/agent/tools/tool-types'
import { TranscriptWriter, getTranscriptDir, getTranscriptFile } from './transcript'
import { buildSubagentSystemPrompt } from './role-prompts'

type SubagentExecution = SubagentExecutionMetadata & {
  deps: SubagentRuntimeDeps
  contextConfig: ReturnType<ContextManager['getConfig']>
  completion?: SubagentCompletion
  terminalPromise?: Promise<void>
  startedAt?: number
  priorMessageIds?: Set<string>
  trace?: SubagentStreamTrace
}
type QueuedSubagentMessage = { message: string; enqueued_at: number; execution?: SubagentExecution }
type SubagentTaskInternal = {
  execution?: SubagentExecution
  latestExecution?: SubagentExecution
  agentId: string
  accepted: boolean
  terminalPersisting?: boolean
  name?: string
  description: string
  status: SubagentTaskStatus
  created_at: number
  updated_at: number
  last_activity_at: number
  mode: AgentMode
  messages: Message[]
  queue: QueuedSubagentMessage[]
  max_queue_size: number
  overflow_action: 'reject' | 'drop_oldest'
  message_timeout_ms: number
  timeout_ms: number
  usage?: SubagentTaskUsage
  error?: { code: string; message: string }
  loop?: AgentLoop
  /** Tool context owned by the currently executing attempt. */
  toolContext?: ToolContext
  processing: boolean
  processingPromise?: Promise<void>
  stopped: boolean
  lifecycle_version: number
  running_notification_armed: boolean
  run_timeout?: ReturnType<typeof setTimeout>
  transcriptWriter?: TranscriptWriter
  /** Subagent role — controls behavior suffix appended to system prompt. */
  subagent_type: SubagentType
  /** Parent spawn_subagent / batch_spawn call that owns this task's UI. */
  parentToolCallId?: string
}

export type SubagentRuntimeDeps = {
  workspaceId: string
  continuation?: SubagentContinuation
  onCompletionReady?: (completion: SubagentCompletion) => void | Promise<void>
  onAsyncWorkspacePathsChanged?: (paths: readonly string[]) => void
  provider: PiAIProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  baseToolContext: ToolContext
  onNotification?: (event: SubagentTaskNotification | SubagentStepNotification) => void
  /** Returns the OPFS workspace directory for transcript storage. Optional — transcript disabled if not provided. */
  getWorkspaceDir?: () => Promise<FileSystemDirectoryHandle>
}

const SUBAGENT_SYSTEM_PROMPT = `You are a sub-agent executing a specific task. Follow the instructions precisely.

## CRITICAL RULES
1. **Probe before scale**: When working with unknown data or APIs, read 1 sample first to understand the structure before processing all items. Do NOT skip directly to bulk operations.
2. **Handle pagination**: If results have has_more/next_key/next_page tokens, process page by page. Do not assume a single call returns everything.
3. **Fail gracefully**: If the primary approach fails, try an alternative approach. If all approaches fail, output a clear summary of what was attempted and what went wrong.

When done, provide a concise summary of what you accomplished.
If you encounter errors, describe them clearly including what you tried and what failed.`

const SUBAGENT_CONTROL_TOOLS = new Set([
  'spawn_subagent',
  'batch_spawn',
  'send_message_to_subagent',
  'stop_subagent',
  'resume_subagent',
  'get_subagent_status',
  'list_subagents',
])

// A subagent without an explicit deadline used to run until the tab closed: the
// only bound was the 20-request cap per queued message. Ten minutes covers the
// longest legitimate member (a multi-step edit + verification) while keeping a
// stuck stream from holding an execution slot forever. `timeout_ms: 0` still
// opts out explicitly.
const DEFAULT_EXECUTION_TIMEOUT_MS = 600000
const MAX_EXECUTION_TIMEOUT_MS = 3600000
const DEFAULT_ENQUEUE_TIMEOUT_MS = 5000
const DEFAULT_STOP_TIMEOUT_MS = 10000
const DEFAULT_QUEUE_SIZE = 100
const DEFAULT_OVERFLOW_ACTION: 'reject' | 'drop_oldest' = 'reject'
const DEFAULT_MESSAGE_TIMEOUT_MS = 300000
const SUMMARY_MAX_CHARS = 500
const CAS_MAX_RETRIES = 3
const CAS_RETRY_DELAY_MS = 10
const DEFAULT_MAX_CONCURRENT = 5

class SubagentRuntimeImpl implements SubagentRuntime {
  private tasks = new Map<string, SubagentTaskInternal>()
  private nameToId = new Map<string, string>()
  private repositories = import('@/sqlite')
  private deps: SubagentRuntimeDeps
  private hydrationPromise: Promise<void>
  private activeExecutionSlots = 0
  private executionWaiters: Array<() => void> = []
  private completions = new Map<string, SubagentCompletion>()
  private disposed = false

  constructor(deps: SubagentRuntimeDeps) {
    this.deps = deps
    this.hydrationPromise = this.hydrateFromSQLite()
  }

  updateDeps(deps: SubagentRuntimeDeps): void {
    this.deps = deps
  }

  /** Graceful shutdown — mark all active tasks as failed(SESSION_INTERRUPTED). */
  shutdown(persist = true): void {
    if (this.disposed) return
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'pending') {
        task.status = 'failed'
        task.stopped = true
        task.error = { code: 'SESSION_INTERRUPTED', message: 'Tab closed while subagent was active.' }
        task.updated_at = now
        task.last_activity_at = now
        this.publishTask(task)
        this.clearRunTimeout(task)
        // Abort any in-flight LLM run so the subagent loop actually stops.
        task.loop?.cancel()
        // Close transcript if open (fire-and-forget)
        if (task.transcriptWriter) {
          task.transcriptWriter.close().catch(() => {})
          task.transcriptWriter = undefined
        }
      }
    }
    if (persist) this.persistToSQLite()
    else this.disposed = true
  }

  /** All agentIds owned by this runtime (for caller-side UI state cleanup). */
  agentIds(): string[] {
    return Array.from(this.tasks.keys())
  }

  /**
   * Drop the live AgentLoop / ToolContext references of a terminal task.
   *
   * These closures (provider, a sub-ContextManager with its own message list,
   * tool registry references) are the heavy live objects retained per
   * subagent; without this, a workspace that spawns many subagents keeps one
   * loop per task alive for the lifetime of the runtime — a monotonic memory
   * leak. Dropping them is safe: `ensureLoop` recreates both on a later
   * resume, and the task's `messages` (needed for persistence and the detail
   * panel's DB fallback) are untouched.
   */
  private releaseTaskRuntime(task: SubagentTaskInternal): void {
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'killed') return
    // A resumed task re-enters processing with a fresh loop — never release
    // while a run is in flight (the ensureProcessing finally will re-check).
    if (task.processing) return
    task.loop = undefined
    task.toolContext = undefined
    if (task.execution) task.execution.trace = undefined
  }

  private createExecution(isAsync: boolean): SubagentExecution {
    const deps = { ...this.deps, baseToolContext: { ...this.deps.baseToolContext } }
    return {
      executionId: generateId(), isAsync, conversationId: deps.workspaceId,
      continuation: deps.continuation ? {
        parentRunId: deps.continuation.parentRunId, providerType: deps.continuation.providerType,
        modelName: deps.continuation.modelName, maxTokens: deps.continuation.maxTokens,
        agentOverrideId: deps.continuation.agentOverrideId, projectId: deps.continuation.projectId,
      } : undefined,
      suppressed: false, changedPaths: [], deps,
      contextConfig: { ...deps.contextManager.getConfig() },
    }
  }

  private async createTask(input: SpawnSubagentInput, isAsync: boolean): Promise<SubagentTaskInternal> {
    await this.ensureHydrated()
    const description = (input.description || '').trim()
    const prompt = (input.prompt || '').trim()
    const name = typeof input.name === 'string' ? input.name.trim() : undefined
    const subagentType: SubagentType = input.subagent_type ?? 'general-purpose'
    // Explorer is a capability boundary, not just a prompt convention. Force
    // Plan mode so write tools are never exposed, even if a caller supplies
    // mode: 'act'.
    const mode = subagentType === 'explorer' ? 'plan' : input.mode || this.deps.baseToolContext.agentMode || 'act'
    const timeoutMs = this.parseExecutionTimeout(input.timeout_ms)

    if (!description) {
      throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'description is required', { field: 'description' })
    }
    if (!prompt) {
      throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'prompt is required', { field: 'prompt' })
    }
    if (name) {
      const existing = this.nameToId.get(name)
      if (existing) {
        throw new SubagentError(SubagentErrorCode.NAME_CONFLICT, `name "${name}" already exists`)
      }
    }

    const now = Date.now()
    const agentId = `subagent_${generateId()}`
    const task: SubagentTaskInternal = {
      agentId,
      accepted: false,
      name,
      description,
      status: 'pending',
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      mode,
      messages: [],
      queue: [],
      max_queue_size: DEFAULT_QUEUE_SIZE,
      overflow_action: DEFAULT_OVERFLOW_ACTION,
      message_timeout_ms: DEFAULT_MESSAGE_TIMEOUT_MS,
      timeout_ms: timeoutMs,
      processing: false,
      stopped: false,
      lifecycle_version: 0,
      running_notification_armed: false,
      subagent_type: subagentType,
      parentToolCallId: input.parentToolCallId,
    }

    const execution = this.createExecution(isAsync)
    task.execution = execution
    task.latestExecution = execution
    task.queue.push({ message: prompt, enqueued_at: now, execution })
    this.tasks.set(agentId, task)
    if (name) this.nameToId.set(name, agentId)
    // Acceptance is durable; no scheduler work starts before this row exists.
    try {
      const { getSubagentRepository } = await this.repositories
      await getSubagentRepository().saveBatch(this.deps.workspaceId, [this.toStoredTask(task)])
      task.accepted = true
    } catch (error) {
      this.tasks.delete(agentId)
      if (name) this.nameToId.delete(name)
      throw error
    }
    this.publishTask(task)
    return task
  }

  async start(input: SpawnSubagentInput): Promise<SubagentAcceptedReceipt> {
    const task = await this.createTask(input, true)
    this.detach(task)
    return this.receipt(task)
  }

  private receipt(task: SubagentTaskInternal): SubagentAcceptedReceipt {
    return { agentId: task.agentId, status: task.status === 'running' ? 'running' : 'pending',
      description: task.description, ...(task.name ? { name: task.name } : {}) }
  }

  private detach(task: SubagentTaskInternal): void {
    void this.ensureProcessing(task).catch((error) => {
      console.error('[SubagentRuntime] detached execution failed', task.agentId, error)
    })
  }

  async spawn(input: SpawnSubagentInput): Promise<SpawnSubagentResult> {
    const task = await this.createTask(input, false)
    await this.ensureProcessing(task)
    if (task.status !== 'completed') {
      throw new SubagentError((task.error?.code || SubagentErrorCode.RESOURCE_EXHAUSTED) as keyof typeof SubagentErrorCode,
        `subagent finished with status ${task.status}`)
    }
    return { status: 'completed', agentId: task.agentId,
      content: this.extractLatestAssistantContent(task.messages), usage: task.usage }
  }

  async sendMessage(input: {
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
  }> {
    await this.ensureHydrated()
    const to = (input.to || '').trim()
    const message = (input.message || '').trim()
    if (!message) {
      return {
        success: false,
        message: 'INVALID_MESSAGE',
      }
    }
    const task = this.getByIdOrName(to)
    if (!task) {
      return {
        success: false,
        message: 'TASK_NOT_FOUND',
      }
    }

    if (task.status === 'completed') {
      return {
        success: false,
        message: 'TASK_ALREADY_COMPLETED',
      }
    }
    const parsedEnqueueTimeout = this.parseEnqueueTimeout(input.timeout_ms)
    if (!parsedEnqueueTimeout.ok) {
      return {
        success: false,
        message: 'INVALID_INPUT',
      }
    }
    const overflowAction = input.overflow_action || task.overflow_action

    this.pruneExpiredQueue(task)
    if (task.status === 'failed' || task.status === 'killed') {
      this.setStatus(task, 'pending')
      task.stopped = false
      task.error = undefined
      const enqueue = await this.enqueueWithPolicy(task, message, {
        overflow_action: overflowAction,
        timeout_ms: parsedEnqueueTimeout.timeout_ms,
      })
      if (!enqueue.success) {
        return {
          success: false,
          message: enqueue.message,
        }
      }
      task.updated_at = enqueue.queued_at
      task.last_activity_at = enqueue.queued_at
      this.persistToSQLite()
      this.detach(task)
      return {
        success: true,
        message: 'resumed',
        queued_at: enqueue.queued_at,
        queue_position: enqueue.queue_position,
        resumed: true,
      }
    }

    const enqueue = await this.enqueueWithPolicy(task, message, {
      overflow_action: overflowAction,
      timeout_ms: parsedEnqueueTimeout.timeout_ms,
    })
    if (!enqueue.success) {
      return {
        success: false,
        message: enqueue.message,
      }
    }
    task.updated_at = enqueue.queued_at
    task.last_activity_at = enqueue.queued_at
    this.persistToSQLite()
    this.detach(task)
    return {
      success: true,
      message: 'queued',
      queued_at: enqueue.queued_at,
      queue_position: enqueue.queue_position,
    }
  }

  /** Dismiss an attempt from the task strip without triggering result delivery. */
  async acknowledge(input: { agentId: string; executionId: string }): Promise<void> {
    await this.ensureHydrated()
    const task = this.tasks.get(input.agentId)
    const execution = task?.latestExecution
    if (!task || !execution || execution.executionId !== input.executionId) return
    const { getSubagentRepository } = await this.repositories
    await getSubagentRepository().acknowledge(this.deps.workspaceId, input.agentId, input.executionId)
    execution.acknowledged = true
    if (task.latestExecution === execution) this.publishTask(task)
  }

  async stop(input: {
    agentId: string
    force?: boolean
    timeout_ms?: number
  }): Promise<{ success: boolean; already_stopped?: boolean }> {
    await this.ensureHydrated()
    const task = this.getByIdOrName((input.agentId || '').trim())
    if (!task) {
      throw new SubagentError(SubagentErrorCode.TASK_NOT_FOUND, `subagent ${input.agentId} not found`)
    }
    await this.suppressTask(task)
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') {
      return { success: true, already_stopped: true }
    }
    const parsedStopTimeout = this.parseStopTimeout(input.timeout_ms)
    if (!parsedStopTimeout.ok) {
      throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'timeout_ms must be a non-negative number', { field: 'timeout_ms' })
    }
    if (input.force) {
      await this.killTask(task, {
        code: 'STOPPED_FORCE',
        message: 'Subagent stopped by force.',
        recoverable: false,
      })
      return { success: true }
    }
    task.stopped = true
    task.running_notification_armed = false
    task.loop?.cancel()
    const processingPromise = task.processingPromise
    if (processingPromise) {
      const didFinish = await this.waitForPromiseOrTimeout(processingPromise, parsedStopTimeout.timeout_ms)
      if (!didFinish) {
        await this.killTask(task, {
          code: 'STOPPED_FORCE_TIMEOUT',
          message: `Subagent stop timed out after ${parsedStopTimeout.timeout_ms}ms; force stopped.`,
          recoverable: false,
        })
        return { success: true }
      }
    }
    await this.killTask(task, {
      code: 'STOPPED',
      message: 'Subagent stopped.',
      recoverable: false,
    })
    return { success: true }
  }

  /**
   * Stop every pending/running task owned by this runtime.
   *
   * Every member is marked stopped and has its loop cancelled and run timer
   * cleared in one synchronous pass before the kills are awaited, so a caller
   * that aborts a parent run cannot leave members running behind it. Returns
   * the agentIds it stopped.
   */
  async stopAll(input: { force?: boolean; backgroundOnly?: boolean } = {}): Promise<{ stopped: string[] }> {
    await this.ensureHydrated()
    const targets = Array.from(this.tasks.values()).filter((task) => {
      if (input.backgroundOnly && !task.latestExecution?.isAsync) return false
      if (task.status === 'pending' || task.status === 'running') return true
      const execution = task.latestExecution
      const projection = useSubagentTaskStore.getState().tasks[task.agentId]
      const current = projection?.executionId === execution?.executionId ? projection : undefined
      const phase = current?.deliveryPhase ?? execution?.completion?.status
      return execution?.isAsync && !execution.acknowledged && !current?.acknowledged &&
        phase !== undefined && ['pending', 'delivered', 'blocked', 'error'].includes(phase)
    })
    for (const task of targets) {
      task.stopped = true
      task.running_notification_armed = false
      task.loop?.cancel()
      this.clearRunTimeout(task)
    }
    await Promise.all(targets.map((task) => this.suppressTask(task)))
    await Promise.all(
      targets.filter((task) => task.status === 'pending' || task.status === 'running').map((task) =>
        this.killTask(task, {
          code: input.force ? 'STOPPED_FORCE' : 'STOPPED',
          message: input.force ? 'Subagent stopped by force.' : 'Subagent stopped.',
          recoverable: false,
        }).catch(() => {
          // A member that finished between the snapshot and the kill keeps its
          // own terminal state; nothing to report.
        })
      )
    )
    return { stopped: targets.map((task) => task.agentId) }
  }

  async resume(input: {
    agentId: string
    prompt: string
    timeout_ms?: number
  }): Promise<{
    status: 'resumed'
    agentId: string
    resumed_from: string | null
    transcript_entries_recovered: number
  }> {
    await this.ensureHydrated()
    const task = this.getByIdOrName((input.agentId || '').trim())
    if (!task) {
      throw new SubagentError(SubagentErrorCode.TASK_NOT_FOUND, `subagent ${input.agentId} not found`)
    }
    const prompt = (input.prompt || '').trim()
    if (!prompt) {
      throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'prompt is required', { field: 'prompt' })
    }
    const recovered = task.messages.length
    // If no in-memory messages, try loading from transcript
    if (recovered === 0) {
      const transcriptMessages = await this.loadTranscriptMessages(task.agentId)
      if (transcriptMessages.length > 0) {
        task.messages = transcriptMessages
      }
    }
    const transcriptRecovered = task.messages.length
    if (typeof input.timeout_ms === 'number') {
      task.timeout_ms = this.parseExecutionTimeout(input.timeout_ms)
    }
    if (!task.processing) {
      this.setStatus(task, 'pending')
      task.error = undefined
      this.clearRunTimeout(task)
    }
    task.stopped = false
    const execution = this.createExecution(task.latestExecution?.isAsync ?? false)
    task.latestExecution = execution
    task.queue.push({ message: prompt, enqueued_at: Date.now(), execution })
    task.updated_at = Date.now()
    task.last_activity_at = task.updated_at
    this.persistToSQLite()
    this.detach(task)
    return {
      status: 'resumed',
      agentId: task.agentId,
      resumed_from: null,
      transcript_entries_recovered: transcriptRecovered,
    }
  }

  async getStatus(input: {
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
  }> {
    await this.ensureHydrated()
    const task = this.getByIdOrName((input.agentId || '').trim())
    if (!task) {
      throw new SubagentError(SubagentErrorCode.TASK_NOT_FOUND, `subagent ${input.agentId} not found`)
    }
    return {
      agentId: task.agentId,
      status: task.status,
      description: task.description,
      created_at: task.created_at,
      updated_at: task.updated_at,
      last_activity_at: task.last_activity_at,
      queue_depth: task.queue.length,
      usage: task.usage,
      // Omit when unset: a top-level `error: null` in the tool payload makes
      // the tool card render a failure badge even though the call succeeded.
      ...(task.error ? { error: task.error } : {}),
    }
  }

  async list(input: {
    status?: string
    limit?: number
    offset?: number
  }): Promise<{
    agents: SubagentTaskSummary[]
    total: number
  }> {
    await this.ensureHydrated()
    const statusFilter = typeof input.status === 'string' ? input.status.trim() : ''
    const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Number(input.limit))) : 50
    const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(Number(input.offset))) : 0

    const all = Array.from(this.tasks.values())
      .filter((task) => !statusFilter || task.status === statusFilter)
      .sort((a, b) => b.updated_at - a.updated_at)

    return {
      agents: all.slice(offset, offset + limit).map((task) => ({
        agentId: task.agentId,
        name: task.name,
        description: task.description,
        status: task.status,
        created_at: task.created_at,
        updated_at: task.updated_at,
      })),
      total: all.length,
    }
  }

  private async createBatch(input: BatchSpawnSubagentInput, isAsync: boolean): Promise<{
    items: Array<{ task_index: number; task: SubagentTaskInternal }>
    rejected: SubagentBatchAcceptance['rejected']
  }> {
    const items: Array<{ task_index: number; task: SubagentTaskInternal }> = []
    const rejected: SubagentBatchAcceptance['rejected'] = []
    for (const [task_index, spec] of (input.tasks || []).entries()) {
      try { items.push({ task_index, task: await this.createTask(spec, isAsync) }) }
      catch (error) { rejected.push({ task_index, reason: error instanceof Error ? error.message : String(error),
        error_code: error instanceof SubagentError ? error.code : 'BATCH_SPAWN_FAILED' }) }
    }
    return { items, rejected }
  }

  private runBatch(items: Array<{ task_index: number; task: SubagentTaskInternal }>, limit?: number): Promise<void> {
    const concurrency = Number.isFinite(limit) ? Math.max(1, Math.min(5, Math.floor(Number(limit)))) : 5
    let cursor = 0
    return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++]
        try { await this.ensureProcessing(item.task) }
        catch (error) { console.error('[SubagentRuntime] batch execution failed', item.task.agentId, error) }
      }
    })).then(() => undefined)
  }

  async batchStart(input: BatchSpawnSubagentInput): Promise<SubagentBatchAcceptance> {
    const { items, rejected } = await this.createBatch(input, true)
    const accepted = items.map(({ task_index, task }) => ({ ...this.receipt(task), task_index }))
    void this.runBatch(items, input.max_concurrency).catch((error) => console.error('[SubagentRuntime] batch failed', error))
    return { accepted, rejected }
  }

  async batchSpawn(input: BatchSpawnSubagentInput): ReturnType<SubagentRuntime['batchSpawn']> {
    const { items, rejected } = await this.createBatch(input, false)
    await this.runBatch(items, input.max_concurrency)
    const completed: Awaited<ReturnType<SubagentRuntime['batchSpawn']>>['completed'] = []
    const failed = rejected.map((entry) => ({ ...entry, agentId: '' }))
    for (const { task_index, task } of items) {
      if (task.status === 'completed') completed.push({ task_index, agentId: task.agentId,
        content: this.extractLatestAssistantContent(task.messages), usage: task.usage })
      else failed.push({ task_index, agentId: task.agentId, reason: task.error?.message || task.status,
        error_code: task.error?.code || 'SUBAGENT_FAILED' })
    }
    return { completed, failed: failed.sort((a, b) => a.task_index - b.task_index) }
  }

  private async killTask(
    task: SubagentTaskInternal,
    input: { code: string; message: string; recoverable: boolean }
  ): Promise<void> {
    task.stopped = true
    task.running_notification_armed = false
    task.error = { code: input.code, message: input.message }
    const transitioned = await this.applyStatusTransition(task, ['pending', 'running', 'failed'], 'killed')
    if (!transitioned) {
      return
    }
    this.clearRunTimeout(task)
    await this.completeExecution(task)
    for (const queued of task.queue) {
      const execution = queued.execution
      if (execution && execution !== task.execution && !execution.completion) {
        execution.suppressed = true
        execution.terminalPromise = this.persistCompletion(task, execution)
        await execution.terminalPromise
      }
    }
    task.queue = []
    this.emitNotification({
      event_type: 'task_notification',
      agentId: task.agentId,
      status: 'killed',
      summary: this.toSummary(task.error.message),
      exit_reason: 'stopped',
      error: {
        code: task.error.code,
        message: task.error.message,
        recoverable: input.recoverable,
      },
      timestamp: Date.now(),
    })
    task.loop?.cancel()
    // Pending tasks never enter ensureProcessing, so nothing would release
    // their refs; mid-run kills are covered by the processing guard inside
    // releaseTaskRuntime (the ensureProcessing finally re-releases).
    this.releaseTaskRuntime(task)
  }

  private getByIdOrName(idOrName: string): SubagentTaskInternal | undefined {
    if (!idOrName) return undefined
    const direct = this.tasks.get(idOrName)
    if (direct) return direct
    const mapped = this.nameToId.get(idOrName)
    return mapped ? this.tasks.get(mapped) : undefined
  }

  private ensureProcessing(task: SubagentTaskInternal): Promise<void> {
    if (task.processing && task.processingPromise) {
      return task.processingPromise
    }
    task.processing = true
    task.processingPromise = this.processWithExecutionSlot(task).finally(() => {
      task.processing = false
      task.processingPromise = undefined
      this.persistToSQLite()
      if (task.queue.length > 0 && !task.stopped && task.latestExecution !== task.execution) {
        this.setStatus(task, 'pending')
        this.detach(task)
        return
      }
      // Queue drained into a terminal state — release the live loop/context.
      this.releaseTaskRuntime(task)
    })
    return task.processingPromise
  }

  private async processWithExecutionSlot(task: SubagentTaskInternal): Promise<void> {
    await this.acquireExecutionSlot()
    try {
      await this.processQueue(task)
    } finally {
      this.releaseExecutionSlot()
    }
  }

  private acquireExecutionSlot(): Promise<void> {
    if (this.activeExecutionSlots < DEFAULT_MAX_CONCURRENT) {
      this.activeExecutionSlots += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => this.executionWaiters.push(resolve))
  }

  private releaseExecutionSlot(): void {
    const next = this.executionWaiters.shift()
    if (next) {
      next()
      return
    }
    this.activeExecutionSlots -= 1
  }

  private async processQueue(task: SubagentTaskInternal): Promise<void> {
    console.info('[SubagentRuntime] processQueue.start', {
      agentId: task.agentId,
      status: task.status,
      queueDepth: task.queue.length,
    })
    while (task.queue.length > 0) {
      if (task.status === 'killed' || task.stopped) {
        task.running_notification_armed = false
        this.clearRunTimeout(task)
        await this.closeTranscript(task)
        return
      }
      this.pruneExpiredQueue(task)
      if (task.queue.length === 0) {
        // All messages expired before processing — mark as failed
        if (task.status === 'pending') {
          task.error = { code: 'QUEUE_EMPTY', message: 'All queued messages expired before processing.' }
          await this.applyStatusTransition(task, 'pending', 'failed')
          await this.completeExecution(task)
          this.emitNotification({
            event_type: 'task_notification',
            agentId: task.agentId,
            status: 'failed',
            summary: this.toSummary(task.error.message),
            exit_reason: 'error',
            error: { code: task.error.code, message: task.error.message, recoverable: true },
            timestamp: Date.now(),
          })
        }
        return
      }
      const queued = task.queue.shift()
      if (!queued) return

      task.execution = queued.execution ?? this.createExecution(false)
      task.terminalPersisting = false
      task.loop = undefined
      task.toolContext = undefined
      task.error = undefined
      task.usage = undefined
      task.running_notification_armed = true
      await this.openTranscript(task)
      const runningTransition = await this.applyStatusTransition(
        task,
        ['pending', 'running', 'completed'],
        'running'
      )
      if (!runningTransition) {
        task.running_notification_armed = false
        return
      }
      const runningVersion = task.lifecycle_version
      this.armRunTimeout(task, runningVersion)
      console.info('[SubagentRuntime] processQueue.running', {
        agentId: task.agentId,
        lifecycle_version: runningVersion,
        queueDepth: task.queue.length,
      })

      try {
        const execution = task.execution
        const loop = this.ensureLoop(task, execution, runningVersion)
        const isCurrent = () => this.isCurrentExecution(task, execution, runningVersion)
        const emitStep = (step: DraftAssistantEvent) => this.emitStep(task, execution, runningVersion, step)
        const userMsg = createUserMessage(queued.message)
        task.messages.push(userMsg)
        await this.appendTranscript(task, userMsg)
        execution.startedAt = Date.now()
        execution.priorMessageIds = new Set(task.messages.map((message) => message.id))
        const trace = new SubagentStreamTrace(task.messages, execution.executionId)
        execution.trace = trace
        let reasoningBuffer = ''
        let contentBuffer = ''
        let currentToolCallId: string | undefined
        const toolArgBuffers = new Map<string, string>()
        const resultMessages = await loop.run(task.messages, {
          onMessagesUpdated: (messages) => {
            if (!isCurrent()) return
            trace.replaceMessages(messages)
            task.messages = trace.messages()
            task.last_activity_at = Date.now()
            this.publishTask(task)
            this.persistToSQLite()
          },
          onMessageStart: () => {
            if (!isCurrent()) return
            reasoningBuffer = ''
            contentBuffer = ''
            emitStep({ type: 'message_start' })
          },
          onReasoningStart: () => emitStep({ type: 'reasoning_start' }),
          onReasoningDelta: (delta) => {
            if (!isCurrent()) return
            reasoningBuffer += delta
            emitStep({
              type: 'reasoning_stream_sync',
              reasoning: reasoningBuffer,
            })
          },
          onReasoningComplete: (reasoning) => {
            if (!isCurrent()) return
            reasoningBuffer = ''
            emitStep({ type: 'reasoning_complete', reasoning })
          },
          onContentStart: () => emitStep({ type: 'content_start' }),
          onContentDelta: (delta) => {
            if (!isCurrent()) return
            contentBuffer += delta
            emitStep({
              type: 'content_stream_sync',
              content: contentBuffer,
            })
          },
          onContentComplete: (content) => {
            if (!isCurrent()) return
            contentBuffer = ''
            emitStep({ type: 'content_complete', content })
          },
          onToolCallStart: (toolCall) => {
            if (!isCurrent()) return
            // Cache the active tool call id so delta callbacks (which may
            // receive an undefined toolCallId) can find the buffer.
            currentToolCallId = toolCall.id
            emitStep({ type: 'tool_start', toolCall })
          },
          onToolCallDelta: (_index, argsDelta, toolCallId) => {
            if (!isCurrent()) return
            // Resolve the buffer key from either the explicit id (when the
            // provider tracks it) or the cached one (when the provider passes
            // undefined because there's only one active tool call).
            const resolvedId = toolCallId || currentToolCallId
            if (!resolvedId) {
              // No active tool call to attribute deltas to — drop them.
              emitStep({
                type: 'tool_delta',
                argsDelta,
                toolCallId: undefined,
                isCurrentToolDelta: false,
              })
              return
            }
            const key = resolvedId
            toolArgBuffers.set(key, (toolArgBuffers.get(key) || '') + argsDelta)
            const isCurrentToolDelta = !toolCallId || toolCallId === currentToolCallId
            emitStep({
              type: 'tool_delta',
              argsDelta,
              toolCallId: resolvedId,
              isCurrentToolDelta,
            })
          },
          onToolCallComplete: (toolCall, result) => {
            if (!isCurrent()) return
            const key = toolCall.id
            const streamedArgs = toolArgBuffers.get(key) || ''
            toolArgBuffers.delete(key)
            // Build streamedArgsByCallId snapshot for the reducer
            const streamedArgsByCallId: Record<string, string> = {}
            for (const [callId, args] of toolArgBuffers) streamedArgsByCallId[callId] = args
            if (streamedArgs) streamedArgsByCallId[toolCall.id] = streamedArgs
            // Clear cached id once the tool call is complete so a subsequent
            // onToolCallStart can re-populate it.
            if (currentToolCallId === toolCall.id) currentToolCallId = undefined
            emitStep({
              type: 'tool_complete',
              toolCall,
              result,
              isCurrentTool: true,
              nextToolCall: null,
              streamedArgsByCallId,
            })
          },
          onContextCompressionStart: () => emitStep({ type: 'compression_start' }),
          onContextCompressionComplete: (payload) => emitStep({ type: 'compression_complete', mode: payload.mode === 'skip' ? 'skip' : 'compress' }),
        })
        if (!isCurrent()) return
        trace.replaceMessages(resultMessages)
        task.messages = trace.messages()
        await this.flushTranscript(task)
        console.info('[SubagentRuntime] processQueue.loopDone', {
          agentId: task.agentId,
          status: task.status,
          stopped: task.stopped,
          lifecycle_version: task.lifecycle_version,
          runningVersion,
          messagesCount: task.messages.length,
        })
        if (
          task.stopped ||
          task.status !== 'running' ||
          task.lifecycle_version !== runningVersion
        ) {
          task.running_notification_armed = false
          this.clearRunTimeout(task)
          return
        }
        task.running_notification_armed = false
        const transitionedToCompleted = await this.applyStatusTransition(task, 'running', 'completed')
        console.info('[SubagentRuntime] processQueue.completed', {
          agentId: task.agentId,
          transitioned: transitionedToCompleted,
          status: task.status,
        })
        if (!transitionedToCompleted) {
          this.clearRunTimeout(task)
          return
        }
        const completedAt = task.updated_at
        this.clearRunTimeout(task)

        this.collectUsage(task, execution)
        const finalResult = this.extractLatestAssistantContent(task.messages)
        const structured = this.parseStructuredResult(finalResult)
        await this.completeExecution(task)
        this.emitNotification({
          event_type: 'task_notification',
          agentId: task.agentId,
          status: 'completed',
          summary: this.toSummary(`Subagent "${task.description}" completed.`),
          result: finalResult,
          result_schema_id: structured ? 'subagent.result.v1' : undefined,
          result_json: structured || undefined,
          exit_reason: 'completed',
          usage: task.usage,
          timestamp: completedAt,
        })
        await this.closeTranscript(task)
      } catch (error) {
        if (
          task.stopped ||
          task.status !== 'running' ||
          task.lifecycle_version !== runningVersion
        ) {
          task.running_notification_armed = false
          this.clearRunTimeout(task)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        task.running_notification_armed = false
        task.error = { code: 'SUBAGENT_FAILED', message }
        const transitionedToFailed = await this.applyStatusTransition(task, 'running', 'failed')
        if (!transitionedToFailed) {
          this.clearRunTimeout(task)
          return
        }
        this.clearRunTimeout(task)
        await this.completeExecution(task)
        this.emitNotification({
          event_type: 'task_notification',
          agentId: task.agentId,
          status: 'failed',
          summary: this.toSummary(`Subagent "${task.description}" failed.`),
          exit_reason: 'error',
          error: {
            code: task.error.code,
            message: task.error.message,
            recoverable: true,
          },
          timestamp: task.updated_at,
        })
        await this.closeTranscript(task)
        return
      }
    }
  }

  private ensureLoop(task: SubagentTaskInternal, execution: SubagentExecution, lifecycleVersion: number): AgentLoop {
    if (task.loop) return task.loop

    const deps = execution.deps
    const contextConfig = execution.contextConfig
    // Build the role-specific system prompt by appending behavior suffix
    // based on subagent_type. For 'general-purpose', returns base unchanged.
    const finalSystemPrompt = buildSubagentSystemPrompt(
      SUBAGENT_SYSTEM_PROMPT,
      task.subagent_type ?? 'general-purpose'
    )
    const subContextManager = new ContextManager({
      maxContextTokens: contextConfig.maxContextTokens,
      reserveTokens: contextConfig.reserveTokens,
      enableSummarization: contextConfig.enableSummarization,
      maxMessageGroups: contextConfig.maxMessageGroups,
      compressionAbsoluteCapEnabled: contextConfig.compressionAbsoluteCapEnabled,
      compressionAbsoluteCap: contextConfig.compressionAbsoluteCap,
      systemPrompt: finalSystemPrompt,
    })
    const taskContext: ToolContext = {
      ...deps.baseToolContext,
      isSubagent: true,
      agentMode: task.mode,
      subagentRuntime: undefined,
      readFileState: new Map(),
      onWorkspacePathsChanged: (paths) => {
        if (!this.isCurrentExecution(task, execution, lifecycleVersion)) return
        execution.changedPaths = [...new Set([...execution.changedPaths, ...paths])]
        if (execution.isAsync) deps.onAsyncWorkspacePathsChanged?.(paths)
        else deps.baseToolContext.onWorkspacePathsChanged?.(paths)
      },
    }
    task.toolContext = taskContext

    task.loop = new AgentLoop({
      provider: deps.provider,
      toolRegistry: deps.toolRegistry,
      contextManager: subContextManager,
      systemPrompt: finalSystemPrompt,
      toolContext: taskContext,
      mode: task.mode,
      // Forward the workspace session id so codex-oauth requests carry
      // prompt_cache_key (see pi-core-runner onPayload). Without it, every
      // subagent request pays full-price input tokens and may land on a
      // different cache shard than the parent conversation.
      sessionId: taskContext.workspaceId ?? undefined,
      beforeToolCall: ({ toolName }) => {
        if (!this.isCurrentExecution(task, execution, lifecycleVersion)) {
          return { block: true, reason: 'Subagent execution is no longer active.' }
        }
        if (task.running_notification_armed) {
          task.running_notification_armed = false
          this.emitNotification({
            event_type: 'task_notification',
            agentId: task.agentId,
            status: 'running',
            summary: this.toSummary(`Subagent "${task.description}" is running.`),
            timestamp: Date.now(),
          })
        }
        if (SUBAGENT_CONTROL_TOOLS.has(toolName)) {
          return {
            block: true,
            reason: `Tool "${toolName}" is blocked in subagent runtime.`,
          }
        }
        return undefined
      },
    })

    return task.loop
  }

  private extractLatestAssistantContent(messages: Message[]): string {
    const assistant = [...messages].reverse().find((msg) => msg.role === 'assistant')
    return (assistant?.content || '').trim()
  }

  private parseStructuredResult(content: string): Record<string, unknown> | null {
    const trimmed = content.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      return null
    }
  }

  private parseExecutionTimeout(raw: number | undefined): number {
    if (typeof raw !== 'number') return DEFAULT_EXECUTION_TIMEOUT_MS
    if (!Number.isFinite(raw) || raw < 0) {
      throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'timeout_ms must be a non-negative number', { field: 'timeout_ms' })
    }
    const normalized = Math.floor(raw)
    if (normalized === 0) return 0 // 0 = no timeout
    if (normalized > MAX_EXECUTION_TIMEOUT_MS) {
      throw new SubagentError(SubagentErrorCode.TIMEOUT_EXCEEDS_MAX, `timeout_ms must be ≤${MAX_EXECUTION_TIMEOUT_MS}`, { field: 'timeout_ms' })
    }
    return normalized
  }

  private parseEnqueueTimeout(
    raw: number | undefined
  ): { ok: true; timeout_ms: number } | { ok: false } {
    if (typeof raw !== 'number') return { ok: true, timeout_ms: DEFAULT_ENQUEUE_TIMEOUT_MS }
    if (!Number.isFinite(raw) || raw < 0) return { ok: false }
    const normalized = Math.floor(raw)
    if (normalized > MAX_EXECUTION_TIMEOUT_MS) return { ok: false }
    return { ok: true, timeout_ms: normalized }
  }

  private parseStopTimeout(raw: number | undefined): { ok: true; timeout_ms: number } | { ok: false } {
    if (typeof raw !== 'number') return { ok: true, timeout_ms: DEFAULT_STOP_TIMEOUT_MS }
    if (!Number.isFinite(raw) || raw < 0) return { ok: false }
    const normalized = Math.floor(raw)
    if (normalized > MAX_EXECUTION_TIMEOUT_MS) return { ok: false }
    return { ok: true, timeout_ms: normalized }
  }

  private setStatus(task: SubagentTaskInternal, next: SubagentTaskStatus): void {
    if (task.status === next) return
    task.status = next
    task.lifecycle_version += 1
    this.publishTask(task)
  }

  private async applyStatusTransition(
    task: SubagentTaskInternal,
    fromStatus: SubagentTaskStatus | SubagentTaskStatus[],
    toStatus: SubagentTaskStatus
  ): Promise<boolean> {
    const expectedStatuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus]
    if (!expectedStatuses.includes(task.status)) return false
    if (task.execution?.isAsync && (toStatus === 'completed' || toStatus === 'failed' || toStatus === 'killed')) {
      task.terminalPersisting = true
      this.setStatus(task, toStatus)
      task.updated_at = Date.now()
      task.last_activity_at = task.updated_at
      return true
    }
    let lastPersistedStatus: SubagentTaskStatus | null = null
    for (let attempt = 1; attempt <= CAS_MAX_RETRIES; attempt += 1) {
      const updatedAt = Date.now()
      const persisted = await this.persistStatusTransition(task, fromStatus, toStatus, updatedAt)
      if (toStatus === 'running' && task.stopped) return false
      if (persisted.applied) {
        this.setStatus(task, toStatus)
        task.updated_at = updatedAt
        task.last_activity_at = updatedAt
        if (!persisted.usedCAS) {
          this.persistToSQLite()
        }
        return true
      }
      const currentStatus = persisted.currentStatus || null
      lastPersistedStatus = currentStatus
      if (!persisted.usedCAS) {
        this.setStatus(task, toStatus)
        task.updated_at = updatedAt
        task.last_activity_at = updatedAt
        this.persistToSQLite()
        return true
      }

      const retriable = currentStatus === null || expectedStatuses.includes(currentStatus)
      if (retriable && attempt < CAS_MAX_RETRIES) {
        await this.sleep(CAS_RETRY_DELAY_MS * attempt)
        continue
      }

      if (currentStatus && task.status !== currentStatus) {
        this.setStatus(task, currentStatus)
      }
      return false
    }

    const readback = await this.readPersistedStatus(task.agentId)
    if (readback === toStatus) {
      this.setStatus(task, toStatus)
      return true
    }
    if (readback && task.status !== readback) {
      this.setStatus(task, readback)
      return false
    }
    if (lastPersistedStatus && task.status !== lastPersistedStatus) {
      this.setStatus(task, lastPersistedStatus)
      return false
    }
    return false
  }

  private async persistStatusTransition(
    task: SubagentTaskInternal,
    fromStatus: SubagentTaskStatus | SubagentTaskStatus[],
    toStatus: SubagentTaskStatus,
    updatedAt: number
  ): Promise<{ applied: boolean; currentStatus?: SubagentTaskStatus; usedCAS: boolean }> {
    if (typeof process !== 'undefined' && process.env.VITEST) {
      return { applied: true, usedCAS: false }
    }
    try {
      const { getSubagentRepository } = await this.repositories
      const repo = getSubagentRepository() as {
        transitionStatus?: (input: {
          workspaceId: string
          agentId: string
          fromStatus: SubagentTaskStatus | SubagentTaskStatus[]
          toStatus: SubagentTaskStatus
          mode: AgentMode
          messages: Message[]
          queue: Array<{ message: string; enqueued_at: number }>
          usage?: SubagentTaskUsage
          error?: { code: string; message: string }
          stopped: boolean
          updated_at: number
          last_activity_at: number
        }) => Promise<{ applied: boolean; currentStatus?: SubagentTaskStatus }>
      }
      if (typeof repo.transitionStatus === 'function') {
        const result = await repo.transitionStatus({
          workspaceId: this.deps.workspaceId,
          agentId: task.agentId,
          fromStatus,
          toStatus,
          mode: task.mode,
          messages: task.messages,
          queue: task.queue.map(({ message, enqueued_at }) => ({ message, enqueued_at })),
          usage: task.usage,
          error: task.error,
          stopped: task.stopped,
          updated_at: updatedAt,
          last_activity_at: updatedAt,
        })
        return {
          applied: result.applied,
          currentStatus: result.currentStatus,
          usedCAS: true,
        }
      }
    } catch {
      // Ignore persistence conflict checks when SQLite is unavailable.
    }
    return { applied: true, usedCAS: false }
  }

  private async readPersistedStatus(agentId: string): Promise<SubagentTaskStatus | null> {
    try {
      const { getSubagentRepository } = await this.repositories
      const repo = getSubagentRepository() as {
        getStatus?: (workspaceId: string, agentId: string) => Promise<SubagentTaskStatus | null>
      }
      if (typeof repo.getStatus === 'function') {
        return await repo.getStatus(this.deps.workspaceId, agentId)
      }
    } catch {
      // Ignore readback failures; caller keeps in-memory state.
    }
    return null
  }

  private enqueueMessage(
    task: SubagentTaskInternal,
    message: string,
    enqueuedAt: number,
    options?: { overflow_action?: 'reject' | 'drop_oldest' }
  ): { success: true; queue_position: number } | { success: false; message: 'QUEUE_FULL' } {
    this.pruneExpiredQueue(task, enqueuedAt)
    const overflowAction = options?.overflow_action || task.overflow_action
    if (task.queue.length >= task.max_queue_size) {
      if (overflowAction === 'drop_oldest') {
        task.queue.shift()
      } else {
        return { success: false, message: 'QUEUE_FULL' }
      }
    }
    const execution = this.createExecution(task.latestExecution?.isAsync ?? false)
    task.latestExecution = execution
    task.queue.push({ message, enqueued_at: enqueuedAt, execution })
    return { success: true, queue_position: task.queue.length }
  }

  private async enqueueWithPolicy(
    task: SubagentTaskInternal,
    message: string,
    options: {
      overflow_action: 'reject' | 'drop_oldest'
      timeout_ms: number
    }
  ): Promise<
    | { success: true; queue_position: number; queued_at: number }
    | { success: false; message: 'QUEUE_FULL' | 'TASK_ALREADY_COMPLETED' }
  > {
    if (options.overflow_action === 'drop_oldest') {
      const queuedAt = Date.now()
      const enqueue = this.enqueueMessage(task, message, queuedAt, {
        overflow_action: options.overflow_action,
      })
      if (!enqueue.success) {
        return { success: false, message: enqueue.message }
      }
      return { success: true, queue_position: enqueue.queue_position, queued_at: queuedAt }
    }

    const deadline = Date.now() + options.timeout_ms
    // eslint-disable-next-line no-constant-condition -- bounded polling loop, exits via return on completion, successful enqueue, or deadline
    while (true) {
      if (task.status === 'completed') {
        return { success: false, message: 'TASK_ALREADY_COMPLETED' }
      }
      const queuedAt = Date.now()
      const enqueue = this.enqueueMessage(task, message, queuedAt, {
        overflow_action: 'reject',
      })
      if (enqueue.success) {
        return { success: true, queue_position: enqueue.queue_position, queued_at: queuedAt }
      }
      if (Date.now() >= deadline) {
        return { success: false, message: 'QUEUE_FULL' }
      }
      await this.sleep(Math.max(1, Math.min(50, deadline - Date.now())))
    }
  }

  private pruneExpiredQueue(task: SubagentTaskInternal, now = Date.now()): void {
    if (task.queue.length === 0) return
    const maxAge = task.message_timeout_ms
    // Accepted background executions retain their identity until they run or are explicitly stopped.
    task.queue = task.queue.filter((item) => item.execution?.isAsync || now - item.enqueued_at <= maxAge)
  }

  private armRunTimeout(task: SubagentTaskInternal, lifecycleVersion: number): void {
    this.clearRunTimeout(task)
    if (!task.timeout_ms) return // 0 = no timeout
    task.run_timeout = setTimeout(() => {
      void this.handleRunTimeout(task, lifecycleVersion)
    }, task.timeout_ms)
  }

  private async handleRunTimeout(task: SubagentTaskInternal, lifecycleVersion: number): Promise<void> {
    task.run_timeout = undefined
    if (task.status !== 'running') return
    if (task.lifecycle_version !== lifecycleVersion) return
    task.running_notification_armed = false
    task.error = {
      code: 'SUBAGENT_TIMEOUT',
      message: `Subagent timed out after ${task.timeout_ms}ms.`,
    }
    const transitionedToFailed = await this.applyStatusTransition(task, 'running', 'failed')
    if (!transitionedToFailed) {
      return
    }
    await this.completeExecution(task)
    this.emitNotification({
      event_type: 'task_notification',
      agentId: task.agentId,
      status: 'failed',
      summary: this.toSummary(`Subagent "${task.description}" timed out.`),
      exit_reason: 'timeout',
      error: {
        code: task.error.code,
        message: task.error.message,
        recoverable: true,
      },
      timestamp: task.updated_at,
    })
    task.loop?.cancel()
  }

  private clearRunTimeout(task: SubagentTaskInternal): void {
    if (!task.run_timeout) return
    clearTimeout(task.run_timeout)
    task.run_timeout = undefined
  }

  private toSummary(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed
    return trimmed.slice(0, SUMMARY_MAX_CHARS)
  }

  private async waitForPromiseOrTimeout(target: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    if (timeoutMs <= 0) return false
    return Promise.race([
      target.then(() => true, () => true),
      this.sleep(timeoutMs).then(() => false),
    ])
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  private emitNotification(event: SubagentTaskNotification): void {
    try {
      const parentToolCallId = this.tasks.get(event.agentId)?.parentToolCallId
      const task = this.tasks.get(event.agentId)
      ;(task?.execution?.deps ?? this.deps).onNotification?.({
        ...event,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      })
    } catch (error) {
      console.warn('[SubagentRuntime] task notification delivery failed', {
        agentId: event.agentId,
        status: event.status,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private isCurrentExecution(task: SubagentTaskInternal, execution: SubagentExecution, lifecycleVersion: number): boolean {
    return !this.disposed && !task.stopped && task.status === 'running' &&
      task.execution === execution && task.lifecycle_version === lifecycleVersion
  }

  /** Keep the live and persisted trace synchronized with the owning execution's stream. */
  private emitStep(
    task: SubagentTaskInternal,
    execution: SubagentExecution,
    lifecycleVersion: number,
    step: DraftAssistantEvent
  ): void {
    if (!this.isCurrentExecution(task, execution, lifecycleVersion)) return
    execution.trace?.apply(step)
    if (execution.trace) task.messages = execution.trace.messages()
    task.last_activity_at = Date.now()
    this.publishTask(task, step.type)
    try {
      const notification: SubagentStepNotification = {
        event_type: 'step_notification',
        agentId: task.agentId,
        parentToolCallId: task.parentToolCallId,
        step,
        timestamp: Date.now(),
      }
      execution.deps.onNotification?.(notification)
    } catch (error) {
      // Step notification failures are non-fatal — don't break the subagent
      console.debug('[SubagentRuntime] step notification delivery failed', {
        agentId: task.agentId,
        stepType: step.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private executionMetadata(execution: SubagentExecution): SubagentExecutionMetadata {
    const { executionId, isAsync, conversationId, continuation, suppressed, acknowledged, changedPaths } = execution
    return { executionId, isAsync, conversationId, continuation, suppressed, acknowledged, changedPaths: [...changedPaths] }
  }

  private collectUsage(task: SubagentTaskInternal, execution: SubagentExecution): void {
    if (!execution.priorMessageIds) return
    const executionMessages = task.messages.filter((message) => !execution.priorMessageIds!.has(message.id))
    const assistantUsages = executionMessages
      .filter((msg) => msg.role === 'assistant' && msg.usage)
      .map((msg) => msg.usage!)
    if (assistantUsages.length > 0) {
      const providers = new Set(assistantUsages.map((usage) => usage.provider).filter(Boolean))
      const models = new Set(assistantUsages.map((usage) => usage.model).filter(Boolean))
      const costComplete = assistantUsages.every((usage) => usage.cost != null)
      const inputCost = assistantUsages.reduce((sum, usage) => sum + (usage.cost?.inputUsd ?? 0), 0)
      const outputCost = assistantUsages.reduce((sum, usage) => sum + (usage.cost?.outputUsd ?? 0), 0)
      const cacheReadCost = assistantUsages.reduce((sum, usage) => sum + (usage.cost?.cacheReadUsd ?? 0), 0)
      task.usage = {
        total_tokens: assistantUsages.reduce((sum, usage) => sum + usage.totalTokens, 0),
        input_tokens: assistantUsages.reduce((sum, usage) => sum + usage.promptTokens, 0),
        output_tokens: assistantUsages.reduce((sum, usage) => sum + usage.completionTokens, 0),
        cache_read_tokens: assistantUsages.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0),
        duration_ms: Math.max(0, Date.now() - (execution.startedAt ?? Date.now())),
        tool_calls: executionMessages.filter((msg) => msg.role === 'tool').length,
        ...(providers.size === 1 ? { provider: [...providers][0] } : {}),
        ...(models.size === 1 ? { model: [...models][0] } : {}),
        input_cost_usd: inputCost,
        output_cost_usd: outputCost,
        cache_read_cost_usd: cacheReadCost,
        estimated_cost_usd: inputCost + outputCost + cacheReadCost,
        cost_complete: costComplete,
      }
    }
  }

  private async completeExecution(task: SubagentTaskInternal): Promise<void> {
    const execution = task.execution
    if (!execution) return
    if (execution.terminalPromise) return execution.terminalPromise
    this.collectUsage(task, execution)
    execution.terminalPromise = this.persistCompletion(task, execution).catch((error) => {
      task.status = 'failed'
      task.error = { code: 'TERMINAL_PERSISTENCE_FAILED', message: error instanceof Error ? error.message : String(error) }
      const completion = { ...this.makeCompletion(task, execution), status: 'error' as const }
      execution.completion = completion
      this.completions.set(completion.id, completion)
      this.publishTask(task, 'Terminal persistence failed; resume to retry.', true)
      throw error
    })
    return execution.terminalPromise
  }

  private makeCompletion(task: SubagentTaskInternal, execution: SubagentExecution): SubagentCompletion {
    const id = `${task.agentId}:${execution.executionId}`
    const priorMessageIds = execution.priorMessageIds
    const executionMessages = priorMessageIds
      ? task.messages.filter((message) => !priorMessageIds.has(message.id))
      : []
    return {
      id, agentId: task.agentId, executionId: execution.executionId,
      conversationId: execution.conversationId, projectId: execution.continuation?.projectId ?? execution.deps.baseToolContext.projectId,
      parentToolCallId: task.parentToolCallId, continuation: execution.continuation,
      notificationMessageId: `subagent-completion:${id}`,
      status: execution.suppressed || task.stopped || !execution.isAsync ? 'suppressed' : 'pending',
      taskStatus: task.status, description: task.description, name: task.name,
      result: this.extractLatestAssistantContent(executionMessages),
      messages: structuredClone(task.messages),
      usage: task.usage, error: task.error, changedPaths: [...execution.changedPaths],
      createdAt: Date.now(), updatedAt: Date.now(),
    }
  }

  private async persistCompletion(task: SubagentTaskInternal, execution: SubagentExecution): Promise<void> {
    const completion = this.makeCompletion(task, execution)
    const id = completion.id
    if (execution.isAsync) {
      const { getSubagentCompletionRepository } = await this.repositories
      const persisted = await getSubagentCompletionRepository().finishExecution({ task: this.toStoredTask(task), completion })
      if (persisted) completion.status = persisted.status
    } else await this.persistToSQLiteAsync()
    if (execution.suppressed || task.stopped) completion.status = 'suppressed'
    task.terminalPersisting = false
    execution.completion = completion
    this.completions.set(id, completion)
    this.publishTask(task)
    if (completion.status === 'pending') {
      try {
        void Promise.resolve(execution.deps.onCompletionReady?.(completion)).catch((error) => {
          console.warn('[SubagentRuntime] completion ready callback failed', error)
        })
      } catch (error) { console.warn('[SubagentRuntime] completion ready callback failed', error) }
    }
  }

  private async suppressTask(task: SubagentTaskInternal): Promise<void> {
    task.stopped = true
    for (const execution of [task.execution, task.latestExecution, ...task.queue.map((entry) => entry.execution)]) {
      if (execution) execution.suppressed = true
    }
    for (const completion of this.completions.values()) {
      if (completion.agentId === task.agentId && ['pending', 'delivered', 'blocked', 'error'].includes(completion.status)) completion.status = 'suppressed'
    }
    if (task.latestExecution?.isAsync) {
      const { getSubagentCompletionRepository } = await this.repositories
      await getSubagentCompletionRepository().suppressAgent(this.deps.workspaceId, task.agentId)
    }
    this.publishTask(task)
  }

  private publishTask(task: SubagentTaskInternal, recentActivity?: string, force = false): void {
    if (task.terminalPersisting && !force) return
    const execution = task.latestExecution
    const previous = useSubagentTaskStore.getState().tasks[task.agentId]
    const deliveryPhase = previous?.executionId === execution?.executionId ? previous?.deliveryPhase : undefined
    useSubagentTaskStore.getState().publish({
      agentId: task.agentId, conversationId: execution?.conversationId ?? this.deps.workspaceId,
      parentToolCallId: task.parentToolCallId, name: task.name, description: task.description,
      role: task.subagent_type, status: task.status, createdAt: task.created_at, updatedAt: task.updated_at,
      lastActivity: task.last_activity_at, recentActivity: recentActivity ?? previous?.recentActivity, usage: task.usage, error: task.error,
      isAsync: execution?.isAsync ?? false, executionId: execution?.executionId, acknowledged: execution?.acknowledged,
      deliveryError: previous?.executionId === execution?.executionId ? previous?.deliveryError : execution?.completion?.deliveryError,
      deliveryPhase: deliveryPhase === 'processing' || deliveryPhase === 'handled'
        ? deliveryPhase
        : execution?.completion?.status === 'pending'
          ? deliveryPhase ?? 'pending'
          : execution?.completion?.status ?? deliveryPhase, messages: [...task.messages],
    })
  }

  private async ensureHydrated(): Promise<void> {
    await this.hydrationPromise
  }

  private persistToSQLite(): void {
    void this.persistToSQLiteInternal()
  }

  /** Awaitable version — use when subsequent CAS depends on the row existing. */
  private async persistToSQLiteAsync(): Promise<void> {
    const { getSubagentRepository } = await this.repositories
    await getSubagentRepository().saveBatch(this.deps.workspaceId, Array.from(this.tasks.values()).filter((task) => task.accepted && !task.terminalPersisting).map((task) => this.toStoredTask(task)))
  }

  private async persistToSQLiteInternal(): Promise<void> {
    if (this.disposed) return
    try {
      const { getSubagentRepository } = await this.repositories
      const repo = getSubagentRepository()
      if (this.disposed) return
      const serializable = Array.from(this.tasks.values()).filter((task) => task.accepted && !task.terminalPersisting).map((task) => this.toStoredTask(task))
      await repo.saveBatch(this.deps.workspaceId, serializable)
    } catch {
      // ignore persistence failures for runtime continuity
    }
  }

  private async hydrateFromSQLite(): Promise<void> {
    try {
      const { getSubagentRepository } = await this.repositories
      const repo = getSubagentRepository()
      const parsed = await repo.findByWorkspaceId(this.deps.workspaceId)
      for (const item of parsed) {
        const revived: SubagentTaskInternal = {
          agentId: item.agentId,
          accepted: true,
          name: item.name,
          description: item.description,
          status:
            item.status === 'running' || item.status === 'pending' ? 'failed' : item.status,
          error:
            item.status === 'running' || item.status === 'pending'
              ? { code: 'SESSION_INTERRUPTED', message: 'Subagent interrupted by session restart.' }
              : item.error,
          created_at: item.created_at,
          updated_at: item.updated_at,
          last_activity_at: item.last_activity_at,
          mode: item.mode,
          messages: item.messages,
          queue: [],
          max_queue_size: DEFAULT_QUEUE_SIZE,
          overflow_action: DEFAULT_OVERFLOW_ACTION,
          message_timeout_ms: DEFAULT_MESSAGE_TIMEOUT_MS,
          timeout_ms: item.timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS,
          usage: item.usage,
          processing: false,
          processingPromise: undefined,
          loop: undefined,
          stopped: item.stopped ?? false,
          lifecycle_version: 0,
          running_notification_armed: false,
          run_timeout: undefined,
          transcriptWriter: undefined,
          subagent_type: (item.subagent_type as SubagentType | undefined) ?? 'general-purpose',
          parentToolCallId: item.parentToolCallId,
        }
        const execution = item.execution
          ? { ...this.createExecution(item.execution.isAsync), ...item.execution }
          : { ...this.createExecution(false), executionId: `legacy:${item.agentId}` }
        revived.execution = execution
        revived.latestExecution = execution
        if (revived.status !== 'pending' && revived.status !== 'running') {
          const { getSubagentCompletionRepository } = await this.repositories
          const persisted = item.execution ? await getSubagentCompletionRepository().find(`${item.agentId}:${execution.executionId}`) : null
          const completion = persisted ?? {
            ...this.makeCompletion(revived, execution),
            result: revived.status === 'completed' ? this.extractLatestAssistantContent(revived.messages) : '',
            status: 'suppressed' as const,
          }
          execution.completion = completion
          this.completions.set(completion.id, completion)
        }
        this.tasks.set(revived.agentId, revived)
        this.publishTask(revived)
        // Only register name for failed tasks (resumable); completed/killed are stale
        if (revived.name && revived.status === 'failed') {
          this.nameToId.set(revived.name, revived.agentId)
        }
      }
    } catch {
      // ignore hydration failures; runtime remains usable in-memory
    }
  }

  private toStoredTask(task: SubagentTaskInternal): {
    execution?: SubagentExecutionMetadata
    agentId: string
    workspaceId: string
    name?: string
    description: string
    status: SubagentTaskStatus
    mode: AgentMode
    messages: Message[]
    queue: Array<{ message: string; enqueued_at: number }>
    usage?: SubagentTaskUsage
    error?: { code: string; message: string }
    stopped: boolean
    created_at: number
    updated_at: number
    last_activity_at: number
    subagent_type: SubagentType
    parentToolCallId?: string
    timeout_ms?: number
  } {
    return {
      agentId: task.agentId,
      workspaceId: this.deps.workspaceId,
      execution: task.latestExecution ? this.executionMetadata(task.latestExecution) : undefined,
      name: task.name,
      description: task.description,
      status: task.queue.length && task.latestExecution !== task.execution && !task.stopped ? 'pending' : task.status,
      mode: task.mode,
      messages: task.messages,
      queue: task.queue.map(({ message, enqueued_at }) => ({ message, enqueued_at })),
      usage: task.usage,
      error: task.error,
      stopped: task.stopped,
      created_at: task.created_at,
      updated_at: task.updated_at,
      last_activity_at: task.last_activity_at,
      subagent_type: task.subagent_type,
      parentToolCallId: task.parentToolCallId,
      timeout_ms: task.timeout_ms,
    }
  }

  // -------------------------------------------------------------------------
  // Transcript helpers
  // -------------------------------------------------------------------------

  private async openTranscript(task: SubagentTaskInternal): Promise<void> {
    const deps = task.execution?.deps ?? this.deps
    if (!deps.getWorkspaceDir) return
    try {
      const wsDir = await deps.getWorkspaceDir()
      const dir = await getTranscriptDir(wsDir, task.agentId)
      const file = await getTranscriptFile(dir)
      const writer = new TranscriptWriter(file, task.agentId)
      await writer.open()
      // Append existing in-memory messages (for resumed tasks)
      for (const msg of task.messages) {
        await writer.append(msg)
      }
      task.transcriptWriter = writer
    } catch {
      // Transcript failure is non-fatal — task continues without persistence
    }
  }

  private async appendTranscript(task: SubagentTaskInternal, message: Message): Promise<void> {
    if (!task.transcriptWriter) return
    try {
      await task.transcriptWriter.append(message)
    } catch {
      // Non-fatal
    }
  }

  private async flushTranscript(task: SubagentTaskInternal): Promise<void> {
    if (!task.transcriptWriter) return
    try {
      // Append any new messages that loop.run added
      // The writer only tracks what was explicitly appended, so we flush the full list
      // to ensure nothing is missed after loop.run replaces the messages array
      for (const msg of task.messages) {
        await task.transcriptWriter.append(msg)
      }
    } catch {
      // Non-fatal
    }
  }

  private async closeTranscript(task: SubagentTaskInternal): Promise<void> {
    if (!task.transcriptWriter) return
    try {
      await task.transcriptWriter.close()
    } catch {
      // Non-fatal
    }
    task.transcriptWriter = undefined
  }

  private async loadTranscriptMessages(agentId: string): Promise<Message[]> {
    if (!this.deps.getWorkspaceDir) return []
    try {
      const wsDir = await this.deps.getWorkspaceDir()
      const dir = await getTranscriptDir(wsDir, agentId)
      const exists = await (async () => {
        try { await dir.getFileHandle('transcript.jsonl'); return true } catch { return false }
      })()
      if (!exists) return []
      const file = await getTranscriptFile(dir)
      const { TranscriptReader } = await import('./transcript')
      const reader = new TranscriptReader(file)
      const result = await reader.read()
      return result.messages
    } catch {
      // Transcript load failure is non-fatal
      return []
    }
  }

}

const runtimeRegistry = new Map<string, SubagentRuntimeImpl>()

/** Global beforeunload handler — registered once. */
let beforeunloadRegistered = false

function registerBeforeunload(): void {
  if (beforeunloadRegistered) return
  if (typeof window === 'undefined') return
  beforeunloadRegistered = true
  window.addEventListener('beforeunload', () => {
    for (const runtime of runtimeRegistry.values()) {
      runtime.shutdown()
    }
  })
}

export function __resetSubagentRuntimeRegistryForTests(): void {
  runtimeRegistry.clear()
  beforeunloadRegistered = false
}

export function getOrCreateSubagentRuntime(input: SubagentRuntimeDeps): SubagentRuntime {
  const key = input.workspaceId || 'default'
  const existing = runtimeRegistry.get(key)
  const deps: SubagentRuntimeDeps = {
    workspaceId: key,
    continuation: input.continuation,
    onCompletionReady: input.onCompletionReady,
    onAsyncWorkspacePathsChanged: input.onAsyncWorkspacePathsChanged,
    provider: input.provider,
    toolRegistry: input.toolRegistry,
    contextManager: input.contextManager,
    baseToolContext: input.baseToolContext,
    onNotification: input.onNotification,
    getWorkspaceDir: input.getWorkspaceDir,
  }
  if (existing) {
    existing.updateDeps(deps)
    return existing
  }
  const created = new SubagentRuntimeImpl(deps)
  runtimeRegistry.set(key, created)
  registerBeforeunload()
  return created
}

/**
 * Look up the runtime for a workspace without creating one.
 *
 * Cancellation paths need this: calling `getOrCreateSubagentRuntime` just to
 * stop work would build a provider/registry/context manager for a conversation
 * that may have no subagents at all.
 */
export function peekSubagentRuntime(workspaceId: string): SubagentRuntime | undefined {
  return runtimeRegistry.get(workspaceId || 'default')
}

/**
 * Dispose the runtime owned by a workspace — used when the workspace's
 * conversation is deleted. Without this, runtimeRegistry keeps one
 * SubagentRuntime (with every task it ever spawned) alive forever.
 *
 * @returns the agentIds that belonged to the disposed runtime, so callers can
 *          clean up their own per-agent UI state (subagentDrafts etc.).
 */
export function disposeSubagentRuntime(workspaceId: string): string[] {
  const key = workspaceId || 'default'
  const runtime = runtimeRegistry.get(key)
  if (!runtime) return []
  runtimeRegistry.delete(key)
  runtime.shutdown(false)
  return runtime.agentIds()
}
