import type { ToolExecution, TaskView } from '@modelcontextprotocol/ext-tasks/client'
import { MCPTaskRepository } from '@/sqlite/repositories/mcp-task.repository'
import { getMCPClient, type MCPClientService } from '@/services/mcp-client.service'
import type { MCPToolCallResult } from './mcp-types'
import type { ManagedMCPTask, MCPInvocation, MCPInvocationContext } from './task-types'
import { isTaskTerminal, needsTaskObservation } from './task-types'

type Execution = ToolExecution<MCPToolCallResult, MCPInvocationContext | undefined>
const BACKOFF = [2000, 5000, 10000, 30000]
const EMPTY: readonly ManagedMCPTask[] = []
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
function describeError(error: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if (!messages.includes(error.message)) messages.push(error.message)
    error = error.cause
  }
  return messages.length ? messages.join(': ') : String(error)
}
function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const detail = error as Error & { code?: string | number; status?: number }
  if (
    detail.status === 401 ||
    detail.status === 403 ||
    detail.status === 404 ||
    typeof detail.code === 'number'
  )
    return false
  return (
    (detail.status ?? 0) >= 500 ||
    error.name === 'TimeoutError' ||
    error instanceof TypeError ||
    /network|disconnected|fetch failed|request timed out|REQUEST_TIMEOUT/i.test(error.message) ||
    retryable(error.cause)
  )
}
function smallSnapshot(snapshot: TaskView): TaskView {
  const raw = Object.fromEntries(Object.entries(snapshot.raw).filter(([key]) => key !== 'result'))
  return { ...snapshot, raw }
}

/** Page-owned task observation; neither an Agent run nor a component owns its lifetime. */
export class MCPTaskManager {
  private records = new Map<string, ManagedMCPTask>()
  private snapshot: readonly ManagedMCPTask[] = EMPTY
  private listeners = new Set<() => void>()
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; execution?: Execution }
  >()
  private channel?: BroadcastChannel
  private initialization?: Promise<void>
  private disposed = false
  constructor(
    private repository = new MCPTaskRepository(),
    private client: MCPClientService = getMCPClient()
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot
  getServerSnapshot = () => EMPTY
  private changed() {
    this.snapshot = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
    for (const listener of this.listeners) listener()
  }
  private async save(task: ManagedMCPTask) {
    return this.recordLock(task.id, async () => {
      const latest = await this.repository.get(task.id)
      // Observation snapshots must not undo a concurrent user presentation update.
      task = { ...task, composer: latest?.composer ?? task.composer, updatedAt: Date.now() }
      return this.publish(task)
    })
  }
  private recordLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    return typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request(`mcp-record:${id}`, work)
      : work()
  }
  private async publish(task: ManagedMCPTask) {
    await this.repository.save(task)
    this.records.set(task.id, task)
    this.changed()
    this.channel?.postMessage({ type: 'changed', id: task.id })
    return task
  }
  async updateComposer(projectId: string, id: string, patch: Partial<NonNullable<ManagedMCPTask['composer']>>) {
    this.get(projectId, id)
    return this.recordLock(id, async () => {
      const task = (await this.repository.get(id)) ?? this.get(projectId, id)
      if (task.context.projectId !== projectId) throw new Error('MCP task not found in this project')
      return this.publish({
        ...task,
        updatedAt: Date.now(),
        composer: { eligible: true, ...task.composer, ...patch },
      })
    })
  }
  async reload(projectId: string, id: string) {
    await this.refresh(id)
    return this.get(projectId, id)
  }
  initialize() {
    return (this.initialization ??= this.load().catch((error) => {
      this.initialization = undefined
      throw error
    }))
  }
  private async load() {
    for (const task of await this.repository.list()) this.records.set(task.id, task)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('creatorweave:mcp-tasks:v1')
      this.channel.onmessage = (event) => {
        const { type, id } = event.data ?? {}
        if (typeof id !== 'string') return
        if (type === 'pause') this.active.get(id)?.controller.abort()
        if (type === 'changed') void this.refresh(id).catch(console.error)
        if (type === 'resume') {
          const task = this.records.get(id)
          if (task) this.observe(task)
        }
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide)
      window.addEventListener('online', this.onOnline)
      window.addEventListener('pageshow', this.onPageShow)
    }
    this.client.on('server:updated', this.onConfigurationChange)
    this.client.on('server:removed', this.onConfigurationChange)
    this.changed()
    for (const task of this.records.values()) {
      if (!task.composer && !isTaskTerminal(task))
        await this.updateComposer(task.context.projectId, task.id, { eligible: true })
      if (task.composer?.queued && typeof navigator !== 'undefined' && navigator.locks) {
        // Queues are page-local. A released ownership lock means the queued intent was lost.
        await navigator.locks.request(`mcp-queue:${task.id}`, { ifAvailable: true }, async lock => {
          if (lock) await this.updateComposer(task.context.projectId, task.id, { queued: false })
        })
      }
      if (task.observation === 'submitting') {
        // No request replay, including when the page died just before dispatch.
        if (typeof navigator !== 'undefined' && navigator.locks)
          await navigator.locks.request(
            `mcp-submit:${task.id}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) return
              const latest = await this.repository.get(task.id)
              if (latest?.observation === 'submitting')
                await this.save({
                  ...latest,
                  observation: 'submission_unknown',
                  error:
                    'Submission interrupted; remote outcome is unknown. Do not resubmit automatically.',
                })
            }
          )
      } else if (
        needsTaskObservation(task) &&
        (task.observation === 'observing' || task.observation === 'attention')
      )
        this.observe(task)
      else if (isTaskTerminal(task) && task.settledAt) void this.notify(task).catch(console.error)
    }
  }
  private onPageHide = () => {
    for (const active of this.active.values()) active.controller.abort()
  }
  private onPageShow = () => {
    void Promise.all(
      [...this.active.values()]
        .filter((active) => active.controller.signal.aborted)
        .map((active) => active.promise)
    ).then(this.onOnline)
  }
  private onOnline = () => {
    for (const task of this.records.values())
      if (needsTaskObservation(task) && task.observation === 'observing') this.observe(task)
  }
  private onConfigurationChange = (event: { serverId: string }) => {
    for (const task of this.records.values()) {
      if (task.serverId !== event.serverId || !needsTaskObservation(task)) continue
      this.active.get(task.id)?.controller.abort()
      void this.save({
        ...task,
        observation: 'paused',
        error: 'MCP service configuration changed; review before resuming',
      }).catch(console.error)
    }
  }
  private async refresh(id: string) {
    const task = await this.repository.get(id)
    if (task) this.records.set(id, task)
    else this.records.delete(id)
    this.changed()
    if (
      task &&
      needsTaskObservation(task) &&
      (task.observation === 'observing' || task.observation === 'attention')
    )
      this.observe(task)
  }
  list(projectId: string, conversationId?: string) {
    return this.snapshot.filter(
      (task) =>
        task.context.projectId === projectId &&
        (!conversationId || task.context.conversationId === conversationId)
    )
  }
  get(projectId: string, id: string): ManagedMCPTask {
    const task = this.records.get(id)
    if (!task || task.context.projectId !== projectId)
      throw new Error('MCP task not found in this project')
    return task
  }
  async invoke(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: MCPInvocationContext,
    signal?: AbortSignal
  ): Promise<MCPInvocation> {
    await this.initialize()
    signal?.throwIfAborted()
    const id = crypto.randomUUID()
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`mcp-submit:${id}`, { signal }, () =>
        this.submit(id, serverId, toolName, args, context, signal)
      )
    }
    // Ordinary calls still work without Web Locks; durable task ownership does not.
    if (this.client.getRuntime(serverId).tasks.capabilities.execution)
      throw new Error('Web Locks are required for background MCP Tasks')
    return this.submit(id, serverId, toolName, args, context, signal)
  }
  private async submit(
    id: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    context: MCPInvocationContext,
    signal?: AbortSignal
  ): Promise<MCPInvocation> {
    const runtime = this.client.getRuntime(serverId)
    const task: ManagedMCPTask = {
      id,
      serverId,
      endpointId: runtime.endpointId,
      context,
      toolName,
      untrusted: true,
      observation: 'submitting',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancellationSupported: runtime.tasks.capabilities.cancellation,
      legacySession:
        runtime.client.getProtocolEra() === 'legacy'
          ? {
              connectionId: runtime.connectionId,
              sessionId:
                'sessionId' in runtime.transport
                  ? typeof runtime.transport.sessionId === 'string'
                    ? runtime.transport.sessionId
                    : undefined
                  : undefined,
              protocolVersion: runtime.initialization.protocolVersion,
              capabilities: runtime.initialization.capabilities,
            }
          : undefined,
    }
    await this.save(task)
    let execution: Execution | undefined
    let handedOff = false
    try {
      signal?.throwIfAborted()
      execution = await this.client.startTool(
        serverId,
        { name: toolName, arguments: args },
        { ...context, localTaskId: task.id },
        signal
      )
      if (execution.kind === 'immediate') {
        const { resultFromTaskOutcome } = await import('@modelcontextprotocol/ext-tasks/client')
        const result = resultFromTaskOutcome(await execution.result())
        await this.repository.delete(task.id)
        this.records.delete(task.id)
        this.changed()
        return { kind: 'result', result }
      }
      task.reference = execution.serializeReference()
      task.remoteStatus = 'working'
      task.composer = { eligible: true }
      await execution.handoff(async (reference) => {
        signal?.throwIfAborted()
        await this.save({ ...task, reference, observation: 'observing' })
        // Saving the reference is the durable handoff boundary.
        handedOff = true
      })
      await execution.result()
      const managed = this.records.get(task.id)!
      this.observe(managed)
      return { kind: 'task', task: managed }
    } catch (error) {
      if (handedOff) {
        const managed = this.records.get(task.id)!
        this.observe(managed)
        return { kind: 'task', task: managed }
      }
      if (execution?.kind === 'task') await execution.cancel().catch(() => {})
      const failed = {
        ...task,
        composer: { eligible: true, ...task.composer },
        observation: task.reference ? ('paused' as const) : ('submission_unknown' as const),
        error: `${describeError(error)}. Submission must not be replayed automatically.`,
      }
      try {
        await this.save(failed)
      } catch {
        this.records.set(task.id, failed)
        this.changed()
      }
      if (error instanceof Error) Object.assign(error, { localTaskId: task.id })
      throw error
    } finally {
      if (execution) {
        await execution.detach()
        runtime.executions.delete(execution)
      }
    }
  }
  private observe(task: ManagedMCPTask) {
    // `active` only dedupes observations within THIS tab. Cross-tab ownership is
    // the per-remote-task Web Lock taken in `owner.promise` at the bottom of this
    // method — see executionLockName(). It is named after the remote task, not
    // after this record, so grep for `locks.request`, not for `mcp-observe`.
    if (this.disposed || this.active.has(task.id) || !needsTaskObservation(task)) return
    const controller = new AbortController()
    const owner = {
      controller,
      promise: Promise.resolve(),
      execution: undefined as Execution | undefined,
    }
    this.active.set(task.id, owner)
    const work = async () => {
      const latest = await this.repository.get(task.id)
      if (
        !latest ||
        !needsTaskObservation(latest) ||
        (latest.observation !== 'observing' && latest.observation !== 'attention')
      )
        return
      let attempt = 0
      while (!controller.signal.aborted) {
        let session: Awaited<ReturnType<MCPClientService['recoverySession']>> | undefined
        try {
          const current = this.records.get(task.id) ?? latest
          session = await this.client.recoverySession(current)
          const execution = await session.resume(current.reference!, {
            applicationContext: { ...current.context, localTaskId: task.id },
            signal: controller.signal,
            requestTimeoutMs: this.client.getServer(current.serverId)?.timeout ?? 30000,
          })
          owner.execution = execution
          const settlement = await execution.settle({
            signal: controller.signal,
            close: false,
            onEvent: async (event) => {
              if (event.type !== 'task' || controller.signal.aborted) return
              attempt = 0
              const current = this.records.get(task.id)!
              await this.save({
                ...current,
                snapshot: smallSnapshot(event.task),
                remoteStatus: event.task.status,
                observation: event.task.status === 'input_required' ? 'attention' : 'observing',
                error: undefined,
              })
            },
          })
          const currentTask = this.records.get(task.id)!
          const { outcome } = settlement
          // A library driver can settle with a local transport error. Only server
          // terminal snapshots or cancellation outcomes change remote terminal state.
          if (outcome.status === 'failed' && outcome.task?.status !== 'failed') throw outcome.error
          let next: ManagedMCPTask = {
            ...currentTask,
            remoteStatus: outcome.status,
            observation: 'paused',
            cancellationRequested: false,
            error: outcome.status === 'failed' ? outcome.error.message : undefined,
          }
          if (outcome.status === 'completed') next = await this.storeResult(next, outcome.result)
          next = await this.save({ ...next, settledAt: Date.now() })
          await this.notify(next).catch(console.error)
          return
        } catch (error) {
          if (controller.signal.aborted) return
          const current = this.records.get(task.id)!
          if (retryable(error)) {
            await this.save({
              ...current,
              observation: 'observing',
              error: describeError(error),
            })
            await delay(BACKOFF[Math.min(attempt++, BACKOFF.length - 1)], controller.signal)
          } else {
            await this.save({
              ...current,
              observation: 'paused',
              error: describeError(error),
            })
            return
          }
        } finally {
          await owner.execution?.detach().catch(() => {})
          await owner.execution?.result().catch(() => {})
          if (owner.execution) session?.untrack(owner.execution)
          owner.execution = undefined
          await session?.release().catch(() => {})
        }
      }
    }
    owner.promise = (async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await navigator.locks.request(
          this.executionLockName(task),
          { signal: controller.signal },
          work
        )
      } else throw new Error('Web Locks are required for safe MCP task observation')
    })()
      .catch(async (error) => {
        if (!controller.signal.aborted) {
          const current = this.records.get(task.id)
          if (current) {
            // Keep an in-memory copy even if durable storage itself failed.
            const paused = {
              ...current,
              observation: 'paused' as const,
              error: describeError(error),
            }
            this.records.set(task.id, paused)
            this.changed()
            await this.repository.save(paused).catch(() => {})
          }
        }
      })
      .finally(() => {
        if (this.active.get(task.id) === owner) this.active.delete(task.id)
      })
  }
  private async storeResult(task: ManagedMCPTask, result: MCPToolCallResult) {
    task = { ...task, resultIsError: result.isError === true }
    const data = JSON.stringify(result)
    if (data.length <= 256000) return { ...task, result }
    const { getMCPResultAssets } = await import('./result-assets')
    const resultAssetId = `mcp_task_${task.id}.json`
    await (await getMCPResultAssets(task.context.projectId)).writeFile(resultAssetId, data)
    return { ...task, result: undefined, resultAssetId }
  }
  async result(projectId: string, id: string): Promise<MCPToolCallResult | undefined> {
    const task = this.get(projectId, id)
    if (!task.resultAssetId) return task.result
    const { getMCPResultAssets } = await import('./result-assets')
    const file = await (
      await getMCPResultAssets(task.context.projectId)
    ).readFile(task.resultAssetId, { encoding: 'text' })
    return JSON.parse(String(file.content))
  }
  /**
   * The one lock that serialises *remote* work on a task: observation and
   * pause() both take it, so two tabs (or a tab plus a paused observer) can
   * never drive the same remote task concurrently.
   *
   * Keyed by the REMOTE identity (endpoint + generation + remote task id), not
   * by the local record id — a page reload can mint a new local id for the same
   * remote task, and the lock must still match. The other lock names in this
   * area (`mcp-record:` / `mcp-submit:` / `mcp-notify:` / `mcp-queue:` here,
   * `mcp-delivery:` in continue-task) are keyed by the local record id; this one
   * is the exception, which is why it has its own helper instead of an inline
   * string.
   */
  private executionLockName(task: ManagedMCPTask) {
    return `mcp-task:${task.endpointId}:${task.reference?.generation}:${task.reference?.taskId}`
  }
  async pause(projectId: string, id: string) {
    const task = this.get(projectId, id)
    this.active.get(id)?.controller.abort()
    this.channel?.postMessage({ type: 'pause', id })
    await this.active.get(id)?.promise
    const save = async () => {
      const latest = (await this.repository.get(id)) ?? this.get(projectId, id)
      return this.save({ ...latest, observation: 'paused' })
    }
    return typeof navigator !== 'undefined' && navigator.locks && task.reference
      ? navigator.locks.request(this.executionLockName(task), save)
      : save()
  }
  async resume(projectId: string, id: string) {
    let task = this.get(projectId, id)
    if (!task.reference) throw new Error('Unknown submission cannot be resumed or replayed')
    if (!needsTaskObservation(task)) return task
    task = await this.pause(projectId, id)
    if (!needsTaskObservation(task)) return task
    task = await this.save({ ...task, observation: 'observing', error: undefined })
    this.observe(task)
    this.channel?.postMessage({ type: 'resume', id })
    return task
  }
  async cancel(projectId: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const task = this.get(projectId, id)
    if (!task.reference || isTaskTerminal(task)) return task
    if (!task.cancellationSupported) throw new Error('Server does not support task cancellation')
    await this.save({ ...task, cancellationRequested: true })
    let recovery: Awaited<ReturnType<MCPClientService['recoverySession']>> | undefined
    try {
      recovery = await this.client.recoverySession(task)
      await recovery.session.task(task.reference.taskId).cancel(signal)
      // Do not invent a cancelled state; keep observing authoritative server state.
      await this.resume(projectId, id)
    } catch (error) {
      await this.save({
        ...this.get(projectId, id),
        cancellationRequested: false,
        error: describeError(error),
      })
      throw error
    } finally {
      await recovery?.release()
    }
    return this.get(projectId, id)
  }
  async wait(projectId: string, id: string, seconds = 10, signal?: AbortSignal) {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const deadline = Date.now() + Math.min(30, Math.max(0, seconds)) * 1000
    try {
      while (!this.get(projectId, id).settledAt && Date.now() < deadline)
        await delay(Math.min(250, deadline - Date.now()), controller.signal)
      return this.get(projectId, id)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  async remove(projectId: string, id: string) {
    const task = this.get(projectId, id)
    if (!isTaskTerminal(task) || !task.settledAt)
      throw new Error('Only terminal task history can be removed')
    await this.repository.delete(id)
    this.records.delete(id)
    this.changed()
    this.channel?.postMessage({ type: 'changed', id })
  }
  private async notify(task: ManagedMCPTask) {
    if (!isTaskTerminal(task) || task.notifiedAt) return
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`mcp-notify:${task.id}`, async () => {
        const latest = await this.repository.get(task.id)
        if (!latest || latest.notifiedAt) return
        await this.deliverNotification(latest)
      })
    }
    await this.deliverNotification(task)
  }
  private async deliverNotification(task: ManagedMCPTask) {
    await this.save({ ...task, notifiedAt: Date.now() })
    if (typeof window === 'undefined') return
    const [{ toast }, { i18nText }] = await Promise.all([
      import('sonner'),
      import('@/store/conversation-message-ops'),
    ])
    toast.info(i18nText('mcp.tasks.finished', 'MCP task finished'), {
      description: `${task.serverId}: ${task.toolName} (${task.remoteStatus})`,
    })
  }
  async dispose() {
    this.disposed = true
    this.onPageHide()
    await Promise.all([...this.active.values()].map((active) => active.promise))
    this.channel?.close()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide)
      window.removeEventListener('online', this.onOnline)
      window.removeEventListener('pageshow', this.onPageShow)
    }
    this.client.off('server:updated', this.onConfigurationChange)
    this.client.off('server:removed', this.onConfigurationChange)
  }
}
let instance: MCPTaskManager | undefined
export function getMCPTaskManager() {
  return (instance ??= new MCPTaskManager())
}
