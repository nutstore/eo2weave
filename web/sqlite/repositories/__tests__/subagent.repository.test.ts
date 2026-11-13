import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentRepository } from '../subagent.repository'

const hoisted = vi.hoisted(() => {
  const db = {
    queryAll: vi.fn(),
    queryFirst: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  }
  db.transaction.mockImplementation(async (callback: (tx: typeof db) => Promise<void>) => callback(db))
  return { db }
})

vi.mock('../../sqlite-database', async () => {
  const actual = await vi.importActual<typeof import('../../sqlite-database')>(
    '../../sqlite-database'
  )
  return {
    ...actual,
    getSQLiteDB: () => hoisted.db,
  }
})

describe('SubagentRepository', () => {
  beforeEach(() => {
    hoisted.db.queryAll.mockReset()
    hoisted.db.queryFirst.mockReset()
    hoisted.db.execute.mockReset()
    hoisted.db.transaction.mockReset()
    hoisted.db.transaction.mockImplementation(async (callback: (tx: typeof hoisted.db) => Promise<void>) => callback(hoisted.db))
  })

  it.each([1, 0])('reports whether the owned checkpoint update applies (%s rows)', async (count) => {
    hoisted.db.queryFirst.mockResolvedValueOnce({ count })
    const messages = [{ id: 'checkpoint', role: 'assistant' as const, content: 'summary', timestamp: 1 }]
    const result = await new SubagentRepository().commitMessages({
      workspaceId: 'parent', agentId: 'child', executionId: 'latest-accepted-execution', messages,
    })

    expect(result).toEqual({ applied: count === 1 })
    expect(hoisted.db.transaction).toHaveBeenCalledOnce()
    const [sql, params] = hoisted.db.execute.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/SET\s+messages_json = \?\s+WHERE/)
    expect(sql).toContain('workspace_id = ?')
    expect(sql).toContain('agent_id = ?')
    expect(sql).toContain("json_extract(execution_json, '$.executionId') = ?")
    expect(sql).toContain("status IN ('pending', 'running')")
    expect(sql).toContain('stopped = 0')
    expect(params).toEqual([JSON.stringify(messages), 'parent', 'child', 'latest-accepted-execution'])
    expect(hoisted.db.queryFirst).toHaveBeenCalledWith('SELECT changes() as count')
  })

  it('returns applied=true when CAS transition updates one row', async () => {
    hoisted.db.queryFirst
      .mockResolvedValueOnce({ count: 1 }) // SELECT changes()
      .mockResolvedValueOnce(null)

    const repo = new SubagentRepository()
    const result = await repo.transitionStatus({
      workspaceId: 'w1',
      agentId: 'a1',
      fromStatus: ['pending', 'running'],
      toStatus: 'completed',
      mode: 'act',
      messages: [],
      queue: [],
      stopped: false,
      updated_at: 1,
      last_activity_at: 1,
    })

    expect(result.applied).toBe(true)
    expect(hoisted.db.execute).toHaveBeenCalledTimes(1)
    const sql = hoisted.db.execute.mock.calls[0]?.[0] as string
    expect(sql).toContain('status IN (?, ?)')
  })

  it('returns currentStatus when CAS transition conflicts', async () => {
    hoisted.db.queryFirst
      .mockResolvedValueOnce({ count: 0 }) // SELECT changes()
      .mockResolvedValueOnce({ status: 'killed' }) // SELECT status

    const repo = new SubagentRepository()
    const result = await repo.transitionStatus({
      workspaceId: 'w1',
      agentId: 'a1',
      fromStatus: 'running',
      toStatus: 'completed',
      mode: 'act',
      messages: [],
      queue: [],
      stopped: false,
      updated_at: 2,
      last_activity_at: 2,
    })

    expect(result.applied).toBe(false)
    expect(result.currentStatus).toBe('killed')
    expect(hoisted.db.queryFirst).toHaveBeenCalledTimes(2)
  })

  it('getStatus returns null when row is missing', async () => {
    hoisted.db.queryFirst.mockResolvedValueOnce(null)

    const repo = new SubagentRepository()
    const status = await repo.getStatus('w1', 'missing')

    expect(status).toBeNull()
  })

  it('saveBatch uses upsert without workspace-wide delete', async () => {
    const repo = new SubagentRepository()
    await repo.saveBatch('w1', [
      {
        agentId: 'a1',
        workspaceId: 'w1',
        description: 'desc',
        status: 'pending',
        mode: 'act',
        subagent_type: 'explorer',
        parentToolCallId: 'tool-call-1',
        messages: [],
        queue: [],
        stopped: false,
        created_at: 1,
        updated_at: 1,
        last_activity_at: 1,
      },
    ])

    expect(hoisted.db.transaction).toHaveBeenCalledTimes(1)
    expect(hoisted.db.execute).toHaveBeenCalledTimes(1)
    const sql = hoisted.db.execute.mock.calls[0]?.[0] as string
    expect(sql).toContain('ON CONFLICT(agent_id) DO UPDATE SET')
    expect(sql).not.toContain('DELETE FROM subagent_tasks')
    expect(sql).toContain('subagent_type')
    expect(sql).toContain('parent_tool_call_id')
    expect(hoisted.db.execute.mock.calls[0]?.[1][6]).toBe('explorer')
    expect(hoisted.db.execute.mock.calls[0]?.[1][7]).toBe('tool-call-1')
  })

  it('restores the persisted subagent type', async () => {
    hoisted.db.queryAll.mockResolvedValueOnce([
      {
        agent_id: 'a1',
        workspace_id: 'w1',
        name: null,
        description: 'desc',
        status: 'failed',
        mode: 'act',
        subagent_type: 'worker',
        parent_tool_call_id: 'tool-call-2',
        messages_json: '[]',
        queue_json: '[]',
        usage_json: null,
        error_json: null,
        stopped: 0,
        created_at: 1,
        updated_at: 2,
        last_activity_at: 2,
      },
    ])

    const repo = new SubagentRepository()
    const [task] = await repo.findByWorkspaceId('w1')

    expect(task.subagent_type).toBe('worker')
    expect(task.parentToolCallId).toBe('tool-call-2')
  })
})
