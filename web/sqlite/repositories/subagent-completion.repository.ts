import type { SubagentCompletion, SubagentDeliveryPhase } from '@/agent/subagent/async-types'
import { getSQLiteDB, parseJSON, toJSON } from '../sqlite-database'
import { saveSubagentTask, type StoredSubagentTask } from './subagent.repository'

interface CompletionRow {
  snapshot_json: string
  status: SubagentDeliveryPhase
  notification_message_id: string | null
  parent_run_id: string | null
  delivery_error: string | null
  updated_at: number
}

function fromRow(row: CompletionRow): SubagentCompletion {
  return {
    ...parseJSON<SubagentCompletion>(row.snapshot_json, {} as SubagentCompletion),
    ...(row.notification_message_id ? { notificationMessageId: row.notification_message_id } : {}),
    ...(row.notification_message_id ? { deliveryReserved: true } : {}),
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.delivery_error ? { deliveryError: row.delivery_error } : {}),
  }
}

/** Durable outbox. All state transitions use conditional writes in one transaction. */
export class SubagentCompletionRepository {
  async finishExecution(input: {
    task: StoredSubagentTask
    completion: SubagentCompletion
  }): Promise<SubagentCompletion> {
    return getSQLiteDB().transaction(async (tx) => {
      const persisted = await tx.queryFirst<{ stopped: number }>(
        'SELECT stopped FROM subagent_tasks WHERE agent_id = ? AND workspace_id = ?',
        [input.task.agentId, input.task.workspaceId]
      )
      if (!persisted) throw new Error('Subagent task no longer exists')
      const existing = await tx.queryFirst<CompletionRow>(
        'SELECT * FROM subagent_completions WHERE id = ?',
        [input.completion.id]
      )
      if (existing) return fromRow(existing)
      const suppressed =
        input.task.stopped || persisted?.stopped === 1 || input.task.execution?.suppressed
      const completion = {
        ...input.completion,
        status: suppressed ? ('suppressed' as const) : input.completion.status,
      }
      const task = { ...input.task, stopped: Boolean(suppressed) }
      if (suppressed && task.execution) task.execution = { ...task.execution, suppressed: true }
      await saveSubagentTask(tx, task.workspaceId, task)
      await tx.execute(
        `INSERT INTO subagent_completions
          (id, agent_id, execution_id, conversation_id, status, snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [
          completion.id,
          completion.agentId,
          completion.executionId,
          completion.conversationId,
          completion.status,
          toJSON(completion),
          completion.createdAt,
          completion.updatedAt,
        ]
      )
      return completion
    })
  }

  async find(id: string): Promise<SubagentCompletion | null> {
    const row = await getSQLiteDB().queryFirst<CompletionRow>(
      'SELECT * FROM subagent_completions WHERE id = ?',
      [id]
    )
    return row ? fromRow(row) : null
  }

  async listProcessing(conversationId: string): Promise<SubagentCompletion[]> {
    const rows = await getSQLiteDB().queryAll<CompletionRow>(
      "SELECT * FROM subagent_completions WHERE conversation_id = ? AND status = 'processing' ORDER BY created_at, id",
      [conversationId]
    )
    return rows.map(fromRow)
  }

  async listRecoverable(conversationId?: string): Promise<SubagentCompletion[]> {
    const rows = await getSQLiteDB().queryAll<CompletionRow>(
      `SELECT * FROM subagent_completions WHERE status IN ('pending', 'delivered', 'blocked', 'error')
       ${conversationId ? 'AND conversation_id = ?' : ''} ORDER BY created_at, id`,
      conversationId ? [conversationId] : []
    )
    return rows.map(fromRow)
  }

  /** Reserve before history append. Recovery reuses this message ID after a crash. */
  async reserveDelivery(
    ids: string[],
    notificationMessageId: string
  ): Promise<SubagentCompletion[]> {
    if (!ids.length) return []
    return getSQLiteDB().transaction(async (tx) => {
      const rows = await tx.queryAll<CompletionRow & { id: string }>(
        `SELECT * FROM subagent_completions WHERE id IN (${ids.map(() => '?').join(', ')})
         AND status = 'pending' AND notification_message_id IS NULL`,
        ids
      )
      if (rows.length !== new Set(ids).size) return []
      for (const row of rows) {
        await tx.execute(
          'UPDATE subagent_completions SET notification_message_id = ?, updated_at = ? WHERE id = ?',
          [notificationMessageId, Date.now(), row.id]
        )
      }
      return rows.map((row) => ({ ...fromRow(row), notificationMessageId, deliveryReserved: true }))
    })
  }

  markDelivered(id: string): Promise<boolean> {
    return this.transition(id, ['pending', 'blocked', 'error'], 'delivered')
  }
  claim(id: string, runId: string): Promise<boolean> {
    return this.transition(id, ['delivered'], 'processing', runId)
  }
  consume(id: string): Promise<boolean> {
    return this.transition(id, ['pending'], 'consumed')
  }
  markHandled(id: string, runId?: string): Promise<boolean> {
    return this.transition(id, ['processing'], 'handled', undefined, undefined, runId)
  }
  suppress(id: string, expectedRunId?: string): Promise<boolean> {
    return this.transition(id, ['pending', 'delivered', 'processing', 'blocked', 'error'], 'suppressed', undefined, undefined, expectedRunId)
  }
  markBlocked(id: string, error: string): Promise<boolean> {
    return this.transition(
      id,
      ['pending', 'delivered', 'blocked', 'error'],
      'blocked',
      undefined,
      error
    )
  }
  markError(id: string, error: string, expectedRunId?: string): Promise<boolean> {
    return this.transition(
      id,
      ['pending', 'delivered', 'processing', 'blocked', 'error'],
      'error',
      undefined,
      error,
      expectedRunId
    )
  }

  /** The task flag and existing outbox rows change together; a later finish sees the flag. */
  async suppressAgent(conversationId: string, agentId: string): Promise<void> {
    await getSQLiteDB().transaction(async (tx) => {
      await tx.execute(
        'UPDATE subagent_tasks SET stopped = 1 WHERE workspace_id = ? AND agent_id = ?',
        [conversationId, agentId]
      )
      await tx.execute(
        `UPDATE subagent_completions SET status = 'suppressed', updated_at = ?
         WHERE conversation_id = ? AND agent_id = ? AND status IN ('pending', 'delivered', 'blocked', 'error')`,
        [Date.now(), conversationId, agentId]
      )
    })
  }

  async cleanupConversation(conversationId: string): Promise<void> {
    await getSQLiteDB().execute('DELETE FROM subagent_completions WHERE conversation_id = ?', [
      conversationId,
    ])
  }

  private async transition(
    id: string,
    from: SubagentDeliveryPhase[],
    to: SubagentDeliveryPhase,
    runId?: string,
    error?: string,
    expectedRunId?: string
  ): Promise<boolean> {
    return getSQLiteDB().transaction(async (tx) => {
      await tx.execute(
        `UPDATE subagent_completions SET status = ?, parent_run_id = COALESCE(?, parent_run_id),
         delivery_error = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')}) ${expectedRunId ? 'AND parent_run_id = ?' : ''} ${to === 'consumed' ? 'AND notification_message_id IS NULL' : ''}`,
        [
          to,
          runId ?? null,
          error ?? null,
          Date.now(),
          id,
          ...from,
          ...(expectedRunId ? [expectedRunId] : []),
        ]
      )
      return ((await tx.queryFirst<{ count: number }>('SELECT changes() AS count'))?.count ?? 0) > 0
    })
  }
}

let repository: SubagentCompletionRepository | undefined
export function getSubagentCompletionRepository(): SubagentCompletionRepository {
  return (repository ??= new SubagentCompletionRepository())
}
