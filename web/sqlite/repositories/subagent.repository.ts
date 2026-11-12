import type { SubagentExecutionMetadata } from '@/agent/subagent/async-types'
import type { SQLiteTransaction } from '../sqlite-database'
import type { AgentMode } from '@/agent/agent-mode'
import type { Message } from '@/agent/message-types'
import type { SubagentTaskStatus, SubagentTaskUsage, SubagentType } from '@/agent/tools/tool-types'
import { boolToInt, getSQLiteDB, intToBool, parseJSON, toJSON } from '../sqlite-database'

interface SubagentTaskRow {
  execution_json: string | null
  agent_id: string
  workspace_id: string
  name: string | null
  description: string
  status: string
  mode: string
  subagent_type: string
  parent_tool_call_id: string | null
  timeout_ms: number | null
  messages_json: string
  queue_json: string
  usage_json: string | null
  error_json: string | null
  stopped: number
  created_at: number
  updated_at: number
  last_activity_at: number
}

export interface StoredSubagentTask {
  execution?: SubagentExecutionMetadata
  agentId: string
  workspaceId: string
  name?: string
  description: string
  status: SubagentTaskStatus
  mode: AgentMode
  subagent_type: SubagentType
  parentToolCallId?: string
  timeout_ms?: number
  messages: Message[]
  queue: Array<{ message: string; enqueued_at: number }>
  usage?: SubagentTaskUsage
  error?: { code: string; message: string }
  stopped: boolean
  created_at: number
  updated_at: number
  last_activity_at: number
}

export interface TransitionSubagentStatusInput {
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
}

export interface TransitionSubagentStatusResult {
  applied: boolean
  currentStatus?: SubagentTaskStatus
}

export class SubagentRepository {
  async findByWorkspaceId(workspaceId: string): Promise<StoredSubagentTask[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SubagentTaskRow>(
      `SELECT *
         FROM subagent_tasks
        WHERE workspace_id = ?
        ORDER BY updated_at DESC`,
      [workspaceId]
    )
    return rows.map((row) => this.rowToTask(row))
  }

  async getStatus(workspaceId: string, agentId: string): Promise<SubagentTaskStatus | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ status: string }>(
      `SELECT status
         FROM subagent_tasks
        WHERE workspace_id = ?
          AND agent_id = ?`,
      [workspaceId, agentId]
    )
    return (row?.status as SubagentTaskStatus | undefined) || null
  }

  async saveBatch(workspaceId: string, tasks: StoredSubagentTask[]): Promise<void> {
    const db = getSQLiteDB()
    await db.transaction(async (tx) => {
      for (const task of tasks) {
        await saveSubagentTask(tx, workspaceId, task)
      }
    })
  }

  async deleteTask(workspaceId: string, agentId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `DELETE FROM subagent_tasks
        WHERE workspace_id = ?
          AND agent_id = ?`,
      [workspaceId, agentId]
    )
  }

  async transitionStatus(
    input: TransitionSubagentStatusInput
  ): Promise<TransitionSubagentStatusResult> {
    const db = getSQLiteDB()
    const fromStatuses = Array.isArray(input.fromStatus) ? input.fromStatus : [input.fromStatus]
    if (fromStatuses.length === 0) {
      return { applied: false }
    }

    const placeholders = fromStatuses.map(() => '?').join(', ')
    // Wrap UPDATE + changes() in a transaction so no other async operation
    // (e.g. saveBatch) can interleave between them and corrupt the changes() count.
    return db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE subagent_tasks
            SET status = ?,
                mode = ?,
                messages_json = ?,
                queue_json = ?,
                usage_json = ?,
                error_json = ?,
                stopped = ?,
                updated_at = ?,
                last_activity_at = ?
          WHERE workspace_id = ?
            AND agent_id = ?
            AND status IN (${placeholders})`,
        [
          input.toStatus,
          input.mode,
          toJSON(input.messages),
          toJSON(input.queue),
          toJSON(input.usage || null),
          toJSON(input.error || null),
          boolToInt(input.stopped),
          input.updated_at,
          input.last_activity_at,
          input.workspaceId,
          input.agentId,
          ...fromStatuses,
        ]
      )
      const changed = await tx.queryFirst<{ count: number }>('SELECT changes() as count')
      if ((changed?.count || 0) > 0) {
        return { applied: true }
      }
      const current = await tx.queryFirst<{ status: string }>(
        `SELECT status
           FROM subagent_tasks
          WHERE workspace_id = ?
            AND agent_id = ?`,
        [input.workspaceId, input.agentId]
      )
      return {
        applied: false,
        currentStatus: current?.status as SubagentTaskStatus | undefined,
      }
    })
  }

  private rowToTask(row: SubagentTaskRow): StoredSubagentTask {
    return {
      execution: parseJSON<SubagentExecutionMetadata | null>(row.execution_json || '', null) || undefined,
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      name: row.name || undefined,
      description: row.description,
      status: row.status as SubagentTaskStatus,
      mode: row.mode === 'plan' ? 'plan' : 'act',
      subagent_type: row.subagent_type as SubagentType,
      parentToolCallId: row.parent_tool_call_id || undefined,
      timeout_ms: row.timeout_ms ?? undefined,
      messages: parseJSON<Message[]>(row.messages_json, []),
      queue: parseJSON<Array<{ message: string; enqueued_at: number }>>(row.queue_json, []),
      usage: parseJSON<SubagentTaskUsage | null>(row.usage_json || '', null) || undefined,
      error: parseJSON<{ code: string; message: string } | null>(row.error_json || '', null) || undefined,
      stopped: intToBool(row.stopped),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_activity_at: row.last_activity_at,
    }
  }
}

/** Shared transaction primitive for terminal task + completion atomicity. */
export async function saveSubagentTask(tx: SQLiteTransaction, workspaceId: string, task: StoredSubagentTask): Promise<void> {
  await tx.execute(
    `INSERT INTO subagent_tasks (
        agent_id, workspace_id, name, description, status, mode, subagent_type, parent_tool_call_id, timeout_ms,
        messages_json, queue_json, usage_json, error_json, stopped,
        created_at, updated_at, last_activity_at, execution_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       workspace_id = excluded.workspace_id,
       name = excluded.name,
       description = excluded.description,
       status = excluded.status,
       mode = excluded.mode,
       subagent_type = excluded.subagent_type,
       parent_tool_call_id = excluded.parent_tool_call_id,
       timeout_ms = excluded.timeout_ms,
       messages_json = excluded.messages_json,
       queue_json = excluded.queue_json,
       usage_json = excluded.usage_json,
       error_json = excluded.error_json,
       stopped = excluded.stopped,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       last_activity_at = excluded.last_activity_at,
       execution_json = excluded.execution_json
     WHERE excluded.updated_at >= subagent_tasks.updated_at`,
    [
      task.agentId,
      workspaceId,
      task.name || null,
      task.description,
      task.status,
      task.mode,
      task.subagent_type,
      task.parentToolCallId || null,
      task.timeout_ms ?? null,
      toJSON(task.messages),
      toJSON(task.queue),
      toJSON(task.usage || null),
      toJSON(task.error || null),
      boolToInt(task.stopped),
      task.created_at,
      task.updated_at,
      task.last_activity_at,
      toJSON(task.execution || null),
    ]
  )
}

let subagentRepoInstance: SubagentRepository | null = null

export function getSubagentRepository(): SubagentRepository {
  if (!subagentRepoInstance) {
    subagentRepoInstance = new SubagentRepository()
  }
  return subagentRepoInstance
}
