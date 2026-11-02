import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectRepository } from '../project.repository'

// Round-6 finding: `deleteProjectIncludingHostRebind` used to take a
// CALLER-SNAPSHOTTED list of workspace IDs and rebind each row by id, with a
// CALLER-COMPUTED successor id. Both snapshots predate the transaction:
//   • a workspace created between the snapshot and the transaction kept the
//     dying project's id (the UPDATE only touched captured rows);
//   • a concurrent deletion (another tab) could invalidate the successor id.
// The repository now selects the successor INSIDE the transaction (fresh
// read, ignoring a successor id that no longer exists) and rebinds with one
// keyed UPDATE `WHERE project_id = ?`, which covers every workspace hosted by
// the deleted project at commit time, captured or not.

interface TxCall {
  sql: unknown
  params?: unknown[]
}

const txExecute = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => undefined))
const txQueryFirst = vi.hoisted(() => vi.fn(async (_sql: string, _params?: unknown[]) => null as unknown))
const transaction = vi.hoisted(() => vi.fn(async (callback: (tx: unknown) => Promise<void>) => {
  await callback({
    execute: txExecute,
    queryFirst: txQueryFirst,
  })
}))

vi.mock('../../sqlite-database', () => ({
  getSQLiteDB: () => ({ transaction }),
  generateId: (prefix: string) => `${prefix}-test`,
}))
vi.mock('@/security/secret-key-scope', () => ({
  getProjectSecretStoragePrefix: (projectId: string) => `proj:${projectId}:`,
}))

const rebindCall = (): TxCall | undefined =>
  txExecute.mock.calls
    .map(([sql, params]) => ({ sql, params }) as TxCall)
    .find((call) => String(call.sql).includes('UPDATE workspaces'))

describe('ProjectRepository.deleteProjectIncludingHostRebind — in-transaction rebind', () => {
  beforeEach(() => {
    txExecute.mockClear()
    txQueryFirst.mockClear()
    transaction.mockClear()
    txQueryFirst.mockResolvedValue(null)
  })

  it('rebinds by project key inside the transaction (not by a caller-supplied id list)', async () => {
    const repo = new ProjectRepository()

    await repo.deleteProjectIncludingHostRebind('p-a', 'p-b', ['host-1'])

    // Single keyed UPDATE — the affected set is every row hosting p-a at
    // commit time, so post-snapshot workspaces are covered too.
    const rebind = rebindCall()
    expect(rebind).toBeDefined()
    expect(rebind!.sql).toBe('UPDATE workspaces SET project_id = ? WHERE project_id = ?')
    expect(rebind!.params).toEqual(['p-b', 'p-a'])
    // Per-row workspace UPDATEs are gone (the projects DELETE legitimately
    // still keys by id).
    expect(txExecute.mock.calls.some(([sql]) =>
      String(sql).includes('UPDATE workspaces') && String(sql).includes('WHERE id = ?')
    )).toBe(false)
  })

  it('re-reads the successor INSIDE the transaction when the caller passes none', async () => {
    txQueryFirst.mockResolvedValueOnce({ id: 'p-live', status: 'active' })
    const repo = new ProjectRepository()

    await repo.deleteProjectIncludingHostRebind('p-dead', '')

    expect(txQueryFirst).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id != ?'),
      ['p-dead'],
    )
    expect(rebindCall()!.params).toEqual(['p-live', 'p-dead'])
  })

  it('rebinds to empty string when no survivor exists inside the transaction (last-project case)', async () => {
    txQueryFirst.mockResolvedValueOnce(null)
    const repo = new ProjectRepository()

    await repo.deleteProjectIncludingHostRebind('p-only', '')

    expect(rebindCall()!.params).toEqual(['', 'p-only'])
  })

  it('an empty successor triggers the in-transaction live read even with hosted workspaces', async () => {
    // Last-project-shaped call from the store: successor '' → the successor
    // query runs INSIDE the transaction, so a project created or deleted
    // between the store's snapshot and this transaction cannot skew the
    // choice; empty result rebinds hosts to '' (no project).
    txQueryFirst.mockResolvedValueOnce(null)
    const repo = new ProjectRepository()

    await repo.deleteProjectIncludingHostRebind('p-a', '')

    expect(txQueryFirst).toHaveBeenCalledWith(
      expect.stringContaining("status != 'archived'"),
      ['p-a'],
    )
    expect(rebindCall()!.params).toEqual(['', 'p-a'])
  })

  it('project deletion and secret cleanup still commit in the same transaction', async () => {
    const repo = new ProjectRepository()
    await repo.deleteProjectIncludingHostRebind('p-a', 'p-b')

    expect(transaction).toHaveBeenCalledTimes(1)
    const sqls = txExecute.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.includes('DELETE FROM api_keys'))).toBe(true)
    expect(sqls.some((sql) => sql.includes('DELETE FROM projects WHERE id = ?'))).toBe(true)
  })
})
