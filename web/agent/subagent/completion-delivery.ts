import type { Message } from '@/agent/message-types'
import type { SubagentCompletion, SubagentContinuation, SubagentDeliveryPhase } from './async-types'
import type { SubagentCompletionRepository } from '@/sqlite/repositories/subagent-completion.repository'

type DeliveryRepository = Pick<
  SubagentCompletionRepository,
  | 'listRecoverable'
  | 'listProcessing'
  | 'reserveDelivery'
  | 'markDelivered'
  | 'claim'
  | 'markHandled'
  | 'markBlocked'
  | 'markError'
  | 'suppress'
>
export interface CompletionDeliveryDependencies {
  repository: DeliveryRepository
  isBusy(conversationId: string): boolean
  validateOrigin(completion: SubagentCompletion): Promise<boolean>
  appendNotification(
    conversationId: string,
    message: Message,
    eligible: () => boolean
  ): Promise<boolean>
  dispatch(conversationId: string, origin: SubagentContinuation): Promise<void>
  withLock<T>(key: string, operation: () => Promise<T>): Promise<T>
  onPhase?(completion: SubagentCompletion, phase: SubagentDeliveryPhase): void
  onError(error: unknown): void
}

/** Outbox acceptance and owning-run receipts are separate durable operations. */
export class CompletionDeliveryCoordinator {
  private scheduled = new Set<string>()
  private reschedule = new Set<string>()
  private flushing = new Map<string, Promise<void>>()
  private generations = new Map<string, number>()
  private stopped = new Set<string>()
  private stopping = new Map<string, Promise<void>>()
  private dispatchRequests = new Map<string, string[]>()
  private requested = new Set<string>()
  private claims = new Map<string, SubagentCompletion[]>()

  constructor(private readonly deps: CompletionDeliveryDependencies) {}

  schedule(id: string): void {
    if (this.stopped.has(id)) return
    if (this.flushing.has(id)) {
      this.reschedule.add(id)
      return
    }
    if (this.scheduled.has(id)) return
    this.scheduled.add(id)
    queueMicrotask(() => {
      this.scheduled.delete(id)
      void this.flush(id).catch(this.deps.onError)
    })
  }

  flush(id: string): Promise<void> {
    const running = this.flushing.get(id)
    if (running) return running
    const work = this.deliver(id).finally(() => {
      this.flushing.delete(id)
      if (this.reschedule.delete(id)) this.schedule(id)
    })
    this.flushing.set(id, work)
    return work
  }

  private async deliver(id: string): Promise<void> {
    const generation = this.generations.get(id) ?? 0
    const eligible = () => !this.stopped.has(id) && (this.generations.get(id) ?? 0) === generation
    const free = () => eligible() && !this.deps.isBusy(id)
    if (!free()) return
    let accepted: SubagentCompletion[] = []
    await this.deps.withLock(`subagent-delivery:${id}`, async () => {
      if (!free()) return
      const rows = (await this.deps.repository.listRecoverable(id)).filter(
        (r) => r.status === 'pending' || r.status === 'delivered'
      )
      if (!free() || !rows.length) return
      const first = rows[0]
      if (!(await this.deps.validateOrigin(first))) {
        for (const row of rows) await this.phase(row, 'suppressed')
        return
      }
      if (!first.continuation) {
        await this.phase(first, 'blocked', 'Original model configuration is unavailable')
        return
      }
      if (!free()) return
      const compatible = (r: SubagentCompletion) =>
        JSON.stringify(r.continuation) === JSON.stringify(first.continuation)
      // A reserved group is immutable even when newer completions arrive.
      let group = first.deliveryReserved
        ? rows.filter((r) => r.notificationMessageId === first.notificationMessageId)
        : rows.filter((r) => r.status === 'pending' && !r.deliveryReserved && compatible(r))
      if (!first.deliveryReserved) {
        group = await this.deps.repository.reserveDelivery(
          group.map((r) => r.id),
          `subagent-completion:${first.id}`
        )
      }
      if (!group.length || !free()) return
      try {
        const message = completionMessage(group)
        if (!(await this.deps.appendNotification(id, message, free)) || !eligible()) return
        for (const row of group) {
          if (row.status === 'pending') await this.phase(row, 'delivered')
        }
        accepted = group
      } catch (error) {
        for (const row of group) await this.phase(row, 'error', String(error))
        this.deps.onError(error)
      }
    })
    if (!accepted.length || !free()) return
    // The history lock is released before entering the normal dispatcher.
    await this.deps.withLock(`subagent-dispatch:${id}`, async () => {
      if (!free()) return
      const rows = await this.deps.repository.listRecoverable(id)
      const current = rows.filter(
        (r) => accepted.some((a) => a.id === r.id) && r.status === 'delivered'
      )
      if (!current.length || !free() || current.some((r) => this.requested.has(r.id))) return
      current.forEach((r) => this.requested.add(r.id))
      this.dispatchRequests.set(
        id,
        current.map((r) => r.id)
      )
      try {
        await this.deps.dispatch(id, current[0].continuation!)
        // Promise<void> also resolves for queued work and caught failures.
        // Only claimRun/finishRun may acknowledge an actual loop execution.
      } catch (error) {
        for (const row of current) await this.phase(row, 'blocked', String(error))
        this.deps.onError(error)
      } finally {
        this.dispatchRequests.delete(id)
      }
    })
  }

  deferDispatch(id: string): void {
    for (const eventId of this.dispatchRequests.get(id) ?? []) this.requested.delete(eventId)
  }

  async claimRun(id: string, runId: string, input: Message[], retryFailed = true): Promise<number> {
    const notifications = new Map(
      input
        .filter((m) => m.subagentCompletion)
        .map((m) => [m.id, new Set(m.subagentCompletion!.eventIds)])
    )
    if (!notifications.size || this.stopped.has(id)) return 0
    const claimed: SubagentCompletion[] = []
    for (const row of await this.deps.repository.listRecoverable(id)) {
      if (!notifications.get(row.notificationMessageId)?.has(row.id)) continue
      if (row.status === 'blocked' || row.status === 'error') {
        if (!retryFailed) continue
        await this.phase(row, 'delivered')
      }
      if (await this.deps.repository.claim(row.id, runId)) {
        this.publishPhase(row, 'processing')
        claimed.push(row)
      }
    }
    this.claims.set(runId, claimed)
    return claimed.length
  }

  async finishRun(
    _id: string,
    runId: string,
    outcome: 'success' | 'error' | 'suppressed',
    error?: string
  ): Promise<void> {
    const rows = this.claims.get(runId) ?? []
    this.claims.delete(runId)
    for (const row of rows) {
      if (outcome === 'success') {
        if (await this.deps.repository.markHandled(row.id, runId)) this.publishPhase(row, 'handled')
      } else {
        const deliveryError = error ?? 'Continuation failed'
        const changed =
          outcome === 'suppressed'
            ? await this.deps.repository.suppress(row.id, runId)
            : await this.deps.repository.markError(row.id, deliveryError, runId)
        if (changed)
          this.publishPhase(row, outcome, outcome === 'error' ? deliveryError : undefined)
      }
      this.requested.delete(row.id)
    }
  }

  /** Synchronous invalidation precedes cancellation, persistence, and all awaits. */
  stop(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.stopped.add(id)
    this.scheduled.delete(id)
    this.reschedule.delete(id)
    for (const [runId, rows] of this.claims) {
      if (rows.some((row) => row.conversationId === id)) {
        rows.forEach((row) => this.requested.delete(row.id))
        this.claims.delete(runId)
      }
    }
    const stopping = this.suppressConversation(id).catch(this.deps.onError)
    this.stopping.set(id, stopping)
    void stopping.finally(() => {
      if (this.stopping.get(id) === stopping) this.stopping.delete(id)
    })
  }

  private async suppressConversation(id: string): Promise<void> {
    const rows = [
      ...(await this.deps.repository.listRecoverable(id)),
      ...(await this.deps.repository.listProcessing(id)),
    ]
    for (const row of rows) await this.phase(row, 'suppressed')
  }

  async activate(id: string): Promise<void> {
    const generation = this.generations.get(id) ?? 0
    await this.stopping.get(id)
    if ((this.generations.get(id) ?? 0) === generation) this.stopped.delete(id)
  }

  async retry(id: string): Promise<void> {
    await this.activate(id)
    for (const row of await this.deps.repository.listRecoverable(id)) {
      this.requested.delete(row.id)
      if (row.status === 'blocked' || row.status === 'error') {
        // Reservation must remain intact when retrying a failed history write.
        if (row.deliveryReserved) await this.phase(row, 'delivered')
      }
    }
    await this.flush(id)
  }

  async recover(id: string): Promise<void> {
    for (const row of await this.deps.repository.listProcessing(id)) {
      await this.phase(row, 'error', 'Previous continuation was interrupted. Retry manually.')
    }
    this.schedule(id)
  }

  async blockUnstarted(id: string, error: string): Promise<void> {
    if (!this.requested.size) return
    for (const row of await this.deps.repository.listRecoverable(id)) {
      if (row.status === 'delivered' && this.requested.has(row.id))
        await this.phase(row, 'blocked', error)
    }
  }

  private publishPhase(
    row: SubagentCompletion,
    phase: SubagentDeliveryPhase,
    deliveryError?: string
  ): void {
    this.deps.onPhase?.({ ...row, status: phase, deliveryError }, phase)
  }

  private async phase(
    row: SubagentCompletion,
    phase: 'delivered' | 'blocked' | 'error' | 'suppressed',
    error = ''
  ): Promise<void> {
    const changed =
      phase === 'delivered'
        ? await this.deps.repository.markDelivered(row.id)
        : phase === 'suppressed'
          ? await this.deps.repository.suppress(row.id)
          : phase === 'blocked'
            ? await this.deps.repository.markBlocked(row.id, error)
            : await this.deps.repository.markError(row.id, error)
    if (changed)
      this.publishPhase(row, phase, phase === 'blocked' || phase === 'error' ? error : undefined)
  }
}

export function completionMessage(rows: SubagentCompletion[]): Message {
  return {
    id: rows[0].notificationMessageId,
    role: 'user',
    timestamp: rows[0].createdAt,
    subagentCompletion: { eventIds: rows.map((r) => r.id) },
    content: rows
      .map((r) =>
        [
          `Subagent ${r.name ?? r.agentId}: ${r.taskStatus}`,
          r.description,
          r.error ? `${r.error.code}: ${r.error.message}` : r.result,
          r.changedPaths.length ? `Changed paths: ${r.changedPaths.join(', ')}` : '',
          `Trace: subagent ${r.agentId}, execution ${r.executionId}`,
        ]
          .filter(Boolean)
          .join('\n')
      )
      .join('\n\n'),
  }
}
