import { getSQLiteDB } from '../sqlite-database'
import type { ManagedMCPTask } from '@/mcp/task-types'

export interface MCPTaskInputRecord {
  taskId: string
  inputId: string
  fingerprint: string
  kind: string
  request: unknown
  response?: unknown
  submission: 'pending' | 'answered' | 'submitted'
}
export class MCPTaskRepository {
  async list(projectId?: string): Promise<ManagedMCPTask[]> {
    const rows = await getSQLiteDB().queryAll<{ record_json: string }>(
      `SELECT record_json FROM mcp_tasks${projectId ? ' WHERE project_id = ?' : ''} ORDER BY updated_at DESC`,
      projectId ? [projectId] : []
    )
    return rows.map((row) => JSON.parse(row.record_json))
  }
  async get(id: string): Promise<ManagedMCPTask | undefined> {
    const row = await getSQLiteDB().queryFirst<{ record_json: string }>(
      'SELECT record_json FROM mcp_tasks WHERE id = ?',
      [id]
    )
    return row ? JSON.parse(row.record_json) : undefined
  }
  async save(task: ManagedMCPTask): Promise<void> {
    await getSQLiteDB().execute(
      `INSERT INTO mcp_tasks
      (id, server_id, endpoint_id, generation, remote_task_id, project_id, conversation_id,
       remote_status, observation, created_at, updated_at, notified_at, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation, remote_task_id=excluded.remote_task_id,
      remote_status=excluded.remote_status, observation=excluded.observation, updated_at=excluded.updated_at,
      notified_at=excluded.notified_at, record_json=excluded.record_json`,
      [
        task.id,
        task.serverId,
        task.endpointId,
        task.reference?.generation ?? null,
        task.reference?.taskId ?? null,
        task.context.projectId,
        task.context.conversationId,
        task.remoteStatus ?? null,
        task.observation,
        task.createdAt,
        task.updatedAt,
        task.notifiedAt ?? null,
        JSON.stringify(task),
      ]
    )
  }
  async delete(id: string) {
    await getSQLiteDB().execute('DELETE FROM mcp_task_inputs WHERE task_id = ?', [id])
    await getSQLiteDB().execute('DELETE FROM mcp_tasks WHERE id = ?', [id])
  }
  async input(taskId: string, inputId: string): Promise<MCPTaskInputRecord | undefined> {
    const row = await getSQLiteDB().queryFirst<{
      fingerprint: string
      kind: string
      request_json: string
      response_json: string | null
      submission: MCPTaskInputRecord['submission']
    }>('SELECT * FROM mcp_task_inputs WHERE task_id = ? AND input_id = ?', [taskId, inputId])
    return row
      ? {
          taskId,
          inputId,
          fingerprint: row.fingerprint,
          kind: row.kind,
          request: JSON.parse(row.request_json),
          response: row.response_json ? JSON.parse(row.response_json) : undefined,
          submission: row.submission,
        }
      : undefined
  }
  async saveInput(input: MCPTaskInputRecord) {
    await getSQLiteDB().execute(
      `INSERT INTO mcp_task_inputs (task_id, input_id, fingerprint, kind, request_json, response_json, submission)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, input_id) DO UPDATE SET
      response_json=excluded.response_json, submission=excluded.submission`,
      [
        input.taskId,
        input.inputId,
        input.fingerprint,
        input.kind,
        JSON.stringify(input.request),
        input.response === undefined ? null : JSON.stringify(input.response),
        input.submission,
      ]
    )
  }
}
