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

type SubagentTaskInternal = {
  agentId: string
  name?: string
  description: string
  status: SubagentTaskStatus
  created_at: number
  updated_at: number
  last_activity_at: number
  mode: AgentMode
  messages: Message[]
  queue: Array<{ message: string; enqueued_at: number }>
  max_queue_size: number
  overflow_action: 'reject' | 'drop_oldest'
  message_timeout_ms: number
  timeout_ms: number
  usage?: SubagentTaskUsage
  error?: { code: string; message: string }
  loop?: AgentLoop
  /**
   * The mutable context object retained by a cached AgentLoop. It must be
   * refreshed in place when the workspace runtime is reused by a later run.
   */
  toolContext?: ToolContext
  /** Cached id of the tool call currently receiving streaming arg deltas. */
  currentToolCallId?: string
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

type RuntimeDeps = {
  workspaceId: string
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

const DEFAULT_EXECUTION_TIMEOUT_MS = 0 // 0 = no timeout
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
  private deps: RuntimeDeps
  private hydrationPromise: Promise<void>
  // Streaming buffers for delta accumulation (reasoning, content, tool args)
  // These accumulate partial deltas before emitting a full snapshot event.
  private reasoningBuffers = new Map<string, string>()
  private contentBuffers = new Map<string, string>()
  private toolArgBuffers = new Map<string, string>()
  private activeExecutionSlots = 0
  private executionWaiters: Array<() => void> = []

  constructor(deps: RuntimeDeps) {
    this.deps = deps
    this.hydrationPromise = this.hydrateFromSQLite()
  }

  updateDeps(deps: RuntimeDeps): void {
    this.deps = deps

    // A subagent task keeps its AgentLoop so it can be resumed. AgentLoop also
    // keeps the original ToolContext object by reference, so replacing deps
    // alone would make resumed child writes report to a stale parent run.
    // Update that exact object in place while preserving child-specific state.
    for (const task of this.tasks.values()) {
      if (!task.toolContext) continue
      Object.assign(task.toolContext, deps.baseToolContext, {
        isSubagent: true,
        agentMode: task.mode,
        subagentRuntime: undefined,
      })
    }
  }

  /** Graceful shutdown — mark all active tasks as failed(SESSION_INTERRUPTED). */
  shutdown(): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'pending') {
        task.status = 'failed'
        task.error = { code: 'SESSION_INTERRUPTED', message: 'Tab closed while subagent was active.' }
        task.updated_at = now
        task.last_activity_at = now
        this.clearRunTimeout(task)
        // Close transcript if open (fire-and-forget)
        if (task.transcriptWriter) {
          task.transcriptWriter.close().catch(() => {})
          task.transcriptWriter = undefined
        }
      }
    }
    this.persistToSQLite()
  }

  async spawn(
    input: SpawnSubagentInput
  ): Promise<SpawnSubagentResult> {
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
      name,
      description,
      status: 'pending',
      created_at: now,
      updated_at: now,
      last_activity_at: now,
      mode,
      messages: [],
      queue: [{ message: prompt, enqueued_at: now }],
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

    this.tasks.set(agentId, task)
    if (name) this.nameToId.set(name, agentId)
    // Await the initial persist so the row exists in SQLite before CAS transitions start.
    // Without this, saveBatch (DELETE ALL + INSERT) can race with transitionStatus (UPDATE + SELECT changes()).
    await this.persistToSQLiteAsync()

    // Always block until the subagent completes
    await this.ensureProcessing(task)
    const latest = this.tasks.get(agentId)
    if (!latest) {
      throw new SubagentError(SubagentErrorCode.TASK_NOT_FOUND, `subagent ${agentId} not found`)
    }
    if (latest.status !== 'completed') {
      const errCode = latest.error?.code || SubagentErrorCode.RESOURCE_EXHAUSTED
      throw new SubagentError(errCode as keyof typeof SubagentErrorCode, `subagent finished with status ${latest.status}`)
    }
    const result: SpawnSubagentResult = {
      status: 'completed',
      agentId,
      content: this.extractLatestAssistantContent(latest.messages),
      usage: latest.usage,
    }

    // Keep completed task in store so get_subagent_status / resume_subagent / list_subagents can still find it
    return result
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
      this.ensureProcessing(task)
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
    this.ensureProcessing(task)
    return {
      success: true,
      message: 'queued',
      queued_at: enqueue.queued_at,
      queue_position: enqueue.queue_position,
    }
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
    this.setStatus(task, 'pending')
    task.stopped = false
    task.error = undefined
    this.clearRunTimeout(task)
    task.queue.push({ message: prompt, enqueued_at: Date.now() })
    task.updated_at = Date.now()
    task.last_activity_at = task.updated_at
    this.persistToSQLite()
    this.ensureProcessing(task)
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
      error: task.error,
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

  async batchSpawn(input: BatchSpawnSubagentInput): Promise<{
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
  }> {
    await this.ensureHydrated()
    const tasks = Array.isArray(input.tasks) ? input.tasks : []
    const maxConcurrency = Number.isFinite(input.max_concurrency)
      ? Math.max(1, Math.min(DEFAULT_MAX_CONCURRENT, Math.floor(Number(input.max_concurrency))))
      : 5

    const completed: Array<{ task_index: number; agentId: string; content: string; usage?: SubagentTaskUsage }> = []
    const failed: Array<{ task_index: number; agentId: string; reason: string; error_code: string }> = []

    // Create internal tasks concurrently, then start processing
    const internalTasks: Array<{ index: number; task: SubagentTaskInternal }> = []
    for (let i = 0; i < tasks.length; i++) {
      const taskSpec = tasks[i]
      try {
        const description = (taskSpec.description || '').trim()
        const prompt = (taskSpec.prompt || '').trim()
        const name = typeof taskSpec.name === 'string' ? taskSpec.name.trim() : undefined
        if (!description) throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'description is required', { field: 'description' })
        if (!prompt) throw new SubagentError(SubagentErrorCode.INVALID_INPUT, 'prompt is required', { field: 'prompt' })
        if (name) {
          const existing = this.nameToId.get(name)
          if (existing) throw new SubagentError(SubagentErrorCode.NAME_CONFLICT, `name "${name}" already exists`)
        }
        const subagentType: SubagentType = taskSpec.subagent_type ?? 'general-purpose'
        // Keep batch_spawn consistent with spawn: explorer tasks must never
        // receive the Act-mode tool set.
        const mode = subagentType === 'explorer' ? 'plan' : taskSpec.mode || this.deps.baseToolContext.agentMode || 'act'
        const timeoutMs = this.parseExecutionTimeout(taskSpec.timeout_ms)
        const now = Date.now()
        const agentId = `subagent_${generateId()}`
        const task: SubagentTaskInternal = {
          agentId,
          name,
          description,
          status: 'pending',
          created_at: now,
          updated_at: now,
          last_activity_at: now,
          mode,
          messages: [],
          queue: [{ message: prompt, enqueued_at: now }],
          max_queue_size: DEFAULT_QUEUE_SIZE,
          overflow_action: DEFAULT_OVERFLOW_ACTION,
          message_timeout_ms: DEFAULT_MESSAGE_TIMEOUT_MS,
          timeout_ms: timeoutMs,
          processing: false,
          stopped: false,
          lifecycle_version: 0,
          running_notification_armed: false,
          subagent_type: subagentType,
          parentToolCallId: taskSpec.parentToolCallId,
        }
        this.tasks.set(agentId, task)
        if (name) this.nameToId.set(name, agentId)
        internalTasks.push({ index: i, task })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const subagentError = error instanceof SubagentError ? error : null
        failed.push({
          task_index: i,
          agentId: '',
          reason: message,
          error_code: subagentError?.code || 'BATCH_SPAWN_FAILED',
        })
      }
    }
    // Await the initial persist so rows exist in SQLite before CAS transitions start.
    await this.persistToSQLiteAsync()

    // Start processing up to maxConcurrency tasks in parallel
    let cursor = 0
    const workers = Array.from({ length: Math.min(maxConcurrency, internalTasks.length) }).map(async () => {
      while (cursor < internalTasks.length) {
        const item = internalTasks[cursor++]
        if (!item) break
        const { index, task } = item
        try {
          await this.ensureProcessing(task)
          const latest = this.tasks.get(task.agentId)
          if (!latest || latest.status !== 'completed') {
            failed.push({
              task_index: index,
              agentId: task.agentId,
              reason: latest?.error?.message || `subagent finished with status ${latest?.status || 'unknown'}`,
              error_code: latest?.error?.code || 'SUBAGENT_FAILED',
            })
          } else {
            completed.push({
              task_index: index,
              agentId: task.agentId,
              content: this.extractLatestAssistantContent(latest.messages),
              usage: latest.usage,
            })
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failed.push({
            task_index: index,
            agentId: task.agentId,
            reason: message,
            error_code: 'BATCH_SPAWN_FAILED',
          })
        }
      }
    })
    await Promise.all(workers)

    // Sort by task_index for deterministic output
    completed.sort((a, b) => a.task_index - b.task_index)
    failed.sort((a, b) => a.task_index - b.task_index)

    return { completed, failed }
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

      task.running_notification_armed = true
      await this.openTranscript(task)
      const runningTransition = await this.applyStatusTransition(
        task,
        ['pending', 'running'],
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
        const loop = this.ensureLoop(task)
        const userMsg = createUserMessage(queued.message)
        task.messages.push(userMsg)
        await this.appendTranscript(task, userMsg)
        const startedAt = Date.now()
        task.messages = await loop.run(task.messages, {
          onMessageStart: () => this.emitStep(task, { type: 'message_start' }),
          onReasoningStart: () => this.emitStep(task, { type: 'reasoning_start' }),
          onReasoningDelta: (delta) => {
            this.reasoningBuffers.set(task.agentId, (this.reasoningBuffers.get(task.agentId) || '') + delta)
            this.emitStep(task, {
              type: 'reasoning_stream_sync',
              reasoning: this.reasoningBuffers.get(task.agentId) || '',
            })
          },
          onReasoningComplete: (reasoning) => {
            this.reasoningBuffers.delete(task.agentId)
            this.emitStep(task, { type: 'reasoning_complete', reasoning })
          },
          onContentStart: () => this.emitStep(task, { type: 'content_start' }),
          onContentDelta: (delta) => {
            this.contentBuffers.set(task.agentId, (this.contentBuffers.get(task.agentId) || '') + delta)
            this.emitStep(task, {
              type: 'content_stream_sync',
              content: this.contentBuffers.get(task.agentId) || '',
            })
          },
          onContentComplete: (content) => {
            this.contentBuffers.delete(task.agentId)
            this.emitStep(task, { type: 'content_complete', content })
          },
          onToolCallStart: (toolCall) => {
            // Cache the active tool call id so delta callbacks (which may
            // receive an undefined toolCallId) can find the buffer.
            task.currentToolCallId = toolCall.id
            this.emitStep(task, { type: 'tool_start', toolCall })
          },
          onToolCallDelta: (_index, argsDelta, toolCallId) => {
            // Resolve the buffer key from either the explicit id (when the
            // provider tracks it) or the cached one (when the provider passes
            // undefined because there's only one active tool call).
            const resolvedId = toolCallId || task.currentToolCallId
            if (!resolvedId) {
              // No active tool call to attribute deltas to — drop them.
              this.emitStep(task, {
                type: 'tool_delta',
                argsDelta,
                toolCallId: undefined,
                isCurrentToolDelta: false,
              })
              return
            }
            const key = `${task.agentId}:${resolvedId}`
            this.toolArgBuffers.set(key, (this.toolArgBuffers.get(key) || '') + argsDelta)
            const isCurrentToolDelta = !toolCallId || toolCallId === task.currentToolCallId
            this.emitStep(task, {
              type: 'tool_delta',
              argsDelta,
              toolCallId: resolvedId,
              isCurrentToolDelta,
            })
          },
          onToolCallComplete: (toolCall, result) => {
            const key = `${task.agentId}:${toolCall.id}`
            const streamedArgs = this.toolArgBuffers.get(key) || ''
            this.toolArgBuffers.delete(key)
            // Build streamedArgsByCallId snapshot for the reducer
            const streamedArgsByCallId: Record<string, string> = {}
            for (const [k, v] of this.toolArgBuffers) {
              if (k.startsWith(`${task.agentId}:`)) {
                streamedArgsByCallId[k.slice(task.agentId.length + 1)] = v
              }
            }
            if (streamedArgs) streamedArgsByCallId[toolCall.id] = streamedArgs
            // Clear cached id once the tool call is complete so a subsequent
            // onToolCallStart can re-populate it.
            if (task.currentToolCallId === toolCall.id) {
              task.currentToolCallId = undefined
            }
            this.emitStep(task, {
              type: 'tool_complete',
              toolCall,
              result,
              isCurrentTool: true,
              nextToolCall: null,
              streamedArgsByCallId,
            })
          },
          onContextCompressionStart: () => this.emitStep(task, { type: 'compression_start' }),
          onContextCompressionComplete: (payload) => this.emitStep(task, { type: 'compression_complete', mode: payload.mode === 'skip' ? 'skip' : 'compress' }),
        })
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

        const assistantUsages = task.messages
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
            duration_ms: Math.max(0, completedAt - startedAt),
            tool_calls: task.messages.filter((msg) => msg.role === 'tool').length,
            ...(providers.size === 1 ? { provider: [...providers][0] } : {}),
            ...(models.size === 1 ? { model: [...models][0] } : {}),
            input_cost_usd: inputCost,
            output_cost_usd: outputCost,
            cache_read_cost_usd: cacheReadCost,
            estimated_cost_usd: inputCost + outputCost + cacheReadCost,
            cost_complete: costComplete,
          }
        }
        const finalResult = this.extractLatestAssistantContent(task.messages)
        const structured = this.parseStructuredResult(finalResult)
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

  private ensureLoop(task: SubagentTaskInternal): AgentLoop {
    if (task.loop) return task.loop

    const contextConfig = this.deps.contextManager.getConfig()
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
      systemPrompt: finalSystemPrompt,
    })
    const taskContext: ToolContext = {
      ...this.deps.baseToolContext,
      isSubagent: true,
      agentMode: task.mode,
      subagentRuntime: undefined,
      readFileState: new Map(),
    }
    task.toolContext = taskContext

    task.loop = new AgentLoop({
      provider: this.deps.provider,
      toolRegistry: this.deps.toolRegistry,
      contextManager: subContextManager,
      systemPrompt: finalSystemPrompt,
      toolContext: taskContext,
      mode: task.mode,
      beforeToolCall: ({ toolName }) => {
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
    if (typeof raw !== 'number') return 0 // no timeout by default
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
  }

  private async applyStatusTransition(
    task: SubagentTaskInternal,
    fromStatus: SubagentTaskStatus | SubagentTaskStatus[],
    toStatus: SubagentTaskStatus
  ): Promise<boolean> {
    const expectedStatuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus]
    let lastPersistedStatus: SubagentTaskStatus | null = null
    for (let attempt = 1; attempt <= CAS_MAX_RETRIES; attempt += 1) {
      const updatedAt = Date.now()
      const persisted = await this.persistStatusTransition(task, fromStatus, toStatus, updatedAt)
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
      const { getSubagentRepository } = await import('@/sqlite')
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
          queue: task.queue,
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
      const { getSubagentRepository } = await import('@/sqlite')
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
    task.queue.push({ message, enqueued_at: enqueuedAt })
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
    task.queue = task.queue.filter((item) => now - item.enqueued_at <= maxAge)
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
      this.deps.onNotification?.({
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

  /** Emit a streaming step event from the subagent's internal AgentLoop. */
  private emitStep(
    task: SubagentTaskInternal,
    step: import('@/store/draft-assistant').DraftAssistantEvent
  ): void {
    try {
      const notification: SubagentStepNotification = {
        event_type: 'step_notification',
        agentId: task.agentId,
        parentToolCallId: task.parentToolCallId,
        step,
        timestamp: Date.now(),
      }
      this.deps.onNotification?.(notification)
    } catch (error) {
      // Step notification failures are non-fatal — don't break the subagent
      console.debug('[SubagentRuntime] step notification delivery failed', {
        agentId: task.agentId,
        stepType: step.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async ensureHydrated(): Promise<void> {
    await this.hydrationPromise
  }

  private persistToSQLite(): void {
    void this.persistToSQLiteInternal()
  }

  /** Awaitable version — use when subsequent CAS depends on the row existing. */
  private async persistToSQLiteAsync(): Promise<void> {
    await this.persistToSQLiteInternal()
  }

  private async persistToSQLiteInternal(): Promise<void> {
    try {
      const { getSubagentRepository } = await import('@/sqlite')
      const repo = getSubagentRepository()
      const serializable = Array.from(this.tasks.values()).map((task) => this.toStoredTask(task))
      await repo.saveBatch(this.deps.workspaceId, serializable)
    } catch {
      // ignore persistence failures for runtime continuity
    }
  }

  private async hydrateFromSQLite(): Promise<void> {
    try {
      const { getSubagentRepository } = await import('@/sqlite')
      const repo = getSubagentRepository()
      const parsed = await repo.findByWorkspaceId(this.deps.workspaceId)
      for (const item of parsed) {
        const revived: SubagentTaskInternal = {
          agentId: item.agentId,
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
          queue: item.queue,
          max_queue_size: DEFAULT_QUEUE_SIZE,
          overflow_action: DEFAULT_OVERFLOW_ACTION,
          message_timeout_ms: DEFAULT_MESSAGE_TIMEOUT_MS,
          timeout_ms: DEFAULT_EXECUTION_TIMEOUT_MS,
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
        this.tasks.set(revived.agentId, revived)
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
  } {
    return {
      agentId: task.agentId,
      workspaceId: this.deps.workspaceId,
      name: task.name,
      description: task.description,
      status: task.status,
      mode: task.mode,
      messages: task.messages,
      queue: task.queue,
      usage: task.usage,
      error: task.error,
      stopped: task.stopped,
      created_at: task.created_at,
      updated_at: task.updated_at,
      last_activity_at: task.last_activity_at,
      subagent_type: task.subagent_type,
      parentToolCallId: task.parentToolCallId,
    }
  }

  // -------------------------------------------------------------------------
  // Transcript helpers
  // -------------------------------------------------------------------------

  private async openTranscript(task: SubagentTaskInternal): Promise<void> {
    if (!this.deps.getWorkspaceDir) return
    try {
      const wsDir = await this.deps.getWorkspaceDir()
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
    // Clean up streaming buffers for this task
    this.reasoningBuffers.delete(task.agentId)
    this.contentBuffers.delete(task.agentId)
    // Clean up tool arg buffers (keys are `${agentId}:${callId}`)
    for (const key of this.toolArgBuffers.keys()) {
      if (key.startsWith(`${task.agentId}:`)) {
        this.toolArgBuffers.delete(key)
      }
    }
    task.currentToolCallId = undefined
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

export function getOrCreateSubagentRuntime(input: {
  workspaceId: string
  provider: PiAIProvider
  toolRegistry: ToolRegistry
  contextManager: ContextManager
  baseToolContext: ToolContext
  onNotification?: (event: SubagentTaskNotification | SubagentStepNotification) => void
  /** Returns the OPFS workspace directory for transcript storage. Optional. */
  getWorkspaceDir?: () => Promise<FileSystemDirectoryHandle>
}): SubagentRuntime {
  const key = input.workspaceId || 'default'
  const existing = runtimeRegistry.get(key)
  const deps: RuntimeDeps = {
    workspaceId: key,
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
