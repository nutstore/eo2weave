import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import schema from '../../sqlite-schema.sql?raw'
import { initializeSchema } from '../../migrations'
import type { SQLiteTransaction } from '../../sqlite-database'
import type { StoredSubagentTask } from '../subagent.repository'
import type { SubagentCompletion } from '@/agent/subagent/async-types'
import { SubagentRepository } from '../subagent.repository'
import { SubagentCompletionRepository } from '../subagent-completion.repository'

const holder = vi.hoisted(() => ({
  adapter: null as (SQLiteTransaction & { transaction: unknown }) | null,
}))
vi.mock('../../sqlite-database', async (original) => ({
  ...(await original<typeof import('../../sqlite-database')>()),
  getSQLiteDB: () => holder.adapter,
}))

let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>
let db: InstanceType<typeof sqlite.oo1.DB>
beforeAll(async () => {
  sqlite = await sqlite3InitModule()
})
beforeEach(() => {
  db = new sqlite.oo1.DB(':memory:')
  db.exec(schema)
  const adapter = {
    async execute(sql: string, params: unknown[] = []) {
      db.exec({ sql, bind: params as never })
    },
    async queryAll<T>(sql: string, params: unknown[] = []) {
      return db.exec({
        sql,
        bind: params as never,
        returnValue: 'resultRows',
        rowMode: 'object',
      }) as T[]
    },
    async queryFirst<T>(sql: string, params: unknown[] = []) {
      return (await this.queryAll<T>(sql, params))[0] ?? null
    },
    async transaction<T>(callback: (tx: SQLiteTransaction) => Promise<T>) {
      db.exec('BEGIN')
      try {
        const result = await callback(adapter)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  holder.adapter = adapter
})
afterEach(() => {
  db?.close()
})

function task(): StoredSubagentTask {
  return {
    agentId: 'a1',
    workspaceId: 'c1',
    description: 'work',
    status: 'completed',
    mode: 'act',
    subagent_type: 'worker',
    messages: [{ id: 'm1', role: 'assistant', content: 'full result', timestamp: 1 }],
    queue: [],
    stopped: false,
    created_at: 1,
    updated_at: 2,
    last_activity_at: 2,
    execution: {
      executionId: 'e1',
      isAsync: true,
      conversationId: 'c1',
      suppressed: false,
      changedPaths: ['a.ts'],
    },
  }
}
function completion(): SubagentCompletion {
  return {
    id: 'a1:e1',
    agentId: 'a1',
    executionId: 'e1',
    conversationId: 'c1',
    notificationMessageId: 'subagent-completion:a1:e1',
    status: 'pending',
    taskStatus: 'completed',
    description: 'work',
    result: 'full result',
    messages: task().messages,
    changedPaths: ['a.ts'],
    createdAt: 2,
    updatedAt: 2,
  }
}

describe('durable subagent completions', () => {
  it('blocks only a still-delivered receipt when recovering an unclaimed dispatch', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.markDelivered('a1:e1')
    expect(await outbox.markBlocked('a1:e1', 'No receipt claimed', 'delivered')).toBe(true)
    await outbox.markDelivered('a1:e1')
    await outbox.claim('a1:e1', 'other-owner')
    await outbox.markError('a1:e1', 'Actual provider failure', 'other-owner')
    expect(await outbox.markBlocked('a1:e1', 'No receipt claimed', 'delivered')).toBe(false)
    expect(await outbox.find('a1:e1')).toMatchObject({ status: 'error', deliveryError: 'Actual provider failure' })
  })
  it('scopes suppression to the selected execution while preserving a later attempt and other task results', async () => {
    const tasks = new SubagentRepository()
    const outbox = new SubagentCompletionRepository()
    await tasks.saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    const later = { ...task(), updated_at: 3, execution: { ...task().execution!, executionId: 'e2' } }
    await tasks.saveBatch('c1', [later])
    await outbox.finishExecution({ task: later, completion: { ...completion(), id: 'a1:e2', executionId: 'e2' } })
    const other = { ...task(), agentId: 'other' }
    await tasks.saveBatch('c1', [other])
    await outbox.finishExecution({ task: other, completion: { ...completion(), agentId: 'other', id: 'other:e1' } })
    await outbox.suppressAgent('c1', 'a1', 'e1')
    expect((await outbox.find('a1:e1'))?.status).toBe('suppressed')
    expect((await outbox.find('a1:e2'))?.status).toBe('pending')
    expect((await outbox.find('other:e1'))?.status).toBe('pending')
    expect((await tasks.findByWorkspaceId('c1')).find(row => row.agentId === 'a1')?.stopped).toBe(false)
  })

  it('persists acknowledgement per attempt without changing completion delivery or losing it to a later save', async () => {
    const tasks = new SubagentRepository()
    const outbox = new SubagentCompletionRepository()
    await tasks.saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await tasks.acknowledge('c1', 'a1', 'e1')
    await tasks.saveBatch('c1', [{ ...task(), updated_at: 3 }])
    expect((await tasks.findByWorkspaceId('c1'))[0].execution?.acknowledged).toBe(true)
    expect((await outbox.find('a1:e1'))?.status).toBe('pending')
    await tasks.saveBatch('c1', [{ ...task(), updated_at: 4, execution: { ...task().execution!, executionId: 'e2' } }])
    await tasks.acknowledge('c1', 'a1', 'e1')
    expect((await tasks.findByWorkspaceId('c1'))[0].execution?.acknowledged).toBeUndefined()
  })

  it('atomically saves full trace and one idempotent completion', async () => {
    const tasks = new SubagentRepository()
    const outbox = new SubagentCompletionRepository()
    await tasks.saveBatch('c1', [{ ...task(), status: 'running', messages: [] }])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.finishExecution({ task: task(), completion: completion() })
    expect((await tasks.findByWorkspaceId('c1'))[0]).toMatchObject({
      messages: task().messages,
      execution: task().execution,
    })
    expect(await outbox.listRecoverable('c1')).toEqual([completion()])
  })

  it('does not regress a later attempt or delivery phase when finish is retried', async () => {
    const tasks = new SubagentRepository()
    const outbox = new SubagentCompletionRepository()
    await tasks.saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.markDelivered('a1:e1')
    await tasks.saveBatch('c1', [
      { ...task(), status: 'running', execution: { ...task().execution!, executionId: 'e2' } },
    ])
    expect(await outbox.finishExecution({ task: task(), completion: completion() })).toMatchObject({
      status: 'delivered',
    })
    expect((await tasks.findByWorkspaceId('c1'))[0]).toMatchObject({
      status: 'running',
      execution: { executionId: 'e2' },
    })
  })

  it('separates delivered from actual processing and consumes only pending results', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    expect(await outbox.markDelivered('a1:e1')).toBe(true)
    expect((await outbox.listRecoverable('c1'))[0].status).toBe('delivered')
    expect(await outbox.consume('a1:e1')).toBe(false)
    expect(await outbox.claim('a1:e1', 'run1')).toBe(true)
    expect(await outbox.claim('a1:e1', 'run2')).toBe(false)
    await outbox.markHandled('a1:e1')
    expect(await outbox.listRecoverable('c1')).toEqual([])
  })

  it('consumes a pending completion once', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    expect(await outbox.consume('a1:e1')).toBe(true)
    expect(await outbox.consume('a1:e1')).toBe(false)
    expect(await outbox.markDelivered('a1:e1')).toBe(false)
  })

  it('suppresses terminal creation racing an earlier stop and existing completions', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.suppressAgent('c1', 'a1')
    await outbox.finishExecution({ task: task(), completion: completion() })
    expect((await outbox.find('a1:e1'))?.status).toBe('suppressed')
    expect(await outbox.listRecoverable('c1')).toEqual([])
    await new SubagentRepository().saveBatch('c1', [{ ...task(), agentId: 'a2' }])
    await outbox.finishExecution({
      task: { ...task(), agentId: 'a2' },
      completion: { ...completion(), id: 'a2:e1', agentId: 'a2' },
    })
    await outbox.suppressAgent('c1', 'a2')
    expect((await outbox.find('a2:e1'))?.status).toBe('suppressed')
  })

  it('does not recreate a task deleted before late completion', async () => {
    const tasks = new SubagentRepository()
    const outbox = new SubagentCompletionRepository()
    await tasks.saveBatch('c1', [task()])
    await tasks.deleteTask('c1', 'a1')
    await expect(
      outbox.finishExecution({ task: task(), completion: completion() })
    ).rejects.toThrow('no longer exists')
    expect(await tasks.findByWorkspaceId('c1')).toEqual([])
    expect(await outbox.listRecoverable('c1')).toEqual([])
  })

  it('exposes interrupted processing separately and fences handling by run identity', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.markDelivered('a1:e1')
    await outbox.claim('a1:e1', 'actual-run')
    expect(await outbox.listProcessing('c1')).toEqual([
      expect.objectContaining({ parentRunId: 'actual-run' }),
    ])
    expect(await outbox.markHandled('a1:e1', 'stale-run')).toBe(false)
    expect(await outbox.markHandled('a1:e1', 'actual-run')).toBe(true)
  })

  it('reserves one durable message identity before history acceptance and excludes wait consumption', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    expect(await outbox.reserveDelivery(['a1:e1'], 'group-message')).toEqual([
      expect.objectContaining({ status: 'pending', notificationMessageId: 'group-message' }),
    ])
    expect(await outbox.consume('a1:e1')).toBe(false)
    expect(await outbox.reserveDelivery(['a1:e1'], 'another-message')).toEqual([])
    expect((await outbox.listRecoverable('c1'))[0].notificationMessageId).toBe('group-message')
    expect(await outbox.markDelivered('a1:e1')).toBe(true)
  })

  it('fences processing error and suppression receipts to the actual owning run', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task()])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.markDelivered('a1:e1'); await outbox.claim('a1:e1', 'new-run')
    expect(await outbox.markError('a1:e1', 'Old failure', 'old-run')).toBe(false)
    expect(await outbox.suppress('a1:e1', 'old-run')).toBe(false)
    expect((await outbox.find('a1:e1'))?.status).toBe('processing')
    expect(await outbox.suppress('a1:e1', 'new-run')).toBe(true)
    expect(await outbox.markHandled('a1:e1', 'new-run')).toBe(false)
  })

  it('reserves a batch atomically when one completion was already consumed', async () => {
    const outbox = new SubagentCompletionRepository()
    await new SubagentRepository().saveBatch('c1', [task(), { ...task(), agentId: 'a2' }])
    await outbox.finishExecution({ task: task(), completion: completion() })
    await outbox.finishExecution({
      task: { ...task(), agentId: 'a2' },
      completion: { ...completion(), id: 'a2:e1', agentId: 'a2' },
    })
    await outbox.consume('a2:e1')
    expect(await outbox.reserveDelivery(['a1:e1', 'a2:e1'], 'group-message')).toEqual([])
    expect(await outbox.consume('a1:e1')).toBe(true)
  })

  it('keeps migration v22 and fresh schema physically equivalent', async () => {
    const freshTaskColumns = db.exec({
      sql: 'PRAGMA table_info(subagent_tasks)',
      returnValue: 'resultRows',
      rowMode: 'object',
    })
    const freshCompletionColumns = db.exec({
      sql: 'PRAGMA table_info(subagent_completions)',
      returnValue: 'resultRows',
      rowMode: 'object',
    })
    db.exec('DROP TABLE subagent_completions')
    db.exec('ALTER TABLE subagent_tasks DROP COLUMN execution_json')
    db.exec('PRAGMA user_version = 21')
    await initializeSchema(db)
    expect(db.exec({ sql: 'PRAGMA user_version', returnValue: 'resultRows' })).toEqual([[22]])
    const upgradedTasks = db.exec({
      sql: 'PRAGMA table_info(subagent_tasks)',
      returnValue: 'resultRows',
      rowMode: 'object',
    })
    const withoutOrder = (columns: unknown) =>
      (columns as Array<{ name: string; cid: number }>)
        .map(({ cid: _cid, ...column }) => column)
        .sort((a, b) => a.name.localeCompare(b.name))
    expect(withoutOrder(upgradedTasks)).toEqual(withoutOrder(freshTaskColumns))
    expect(
      db.exec({
        sql: 'PRAGMA table_info(subagent_completions)',
        returnValue: 'resultRows',
        rowMode: 'object',
      })
    ).toEqual(freshCompletionColumns)
    await initializeSchema(db)
  })

  it('rolls back the terminal snapshot when outbox insertion fails', async () => {
    const tasks = new SubagentRepository()
    await tasks.saveBatch('c1', [{ ...task(), status: 'running', messages: [] }])
    db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON subagent_completions BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    )
    await expect(
      new SubagentCompletionRepository().finishExecution({ task: task(), completion: completion() })
    ).rejects.toThrow('disk full')
    expect((await tasks.findByWorkspaceId('c1'))[0].status).toBe('running')
    expect((await tasks.findByWorkspaceId('c1'))[0].messages).toEqual([])
  })
})
