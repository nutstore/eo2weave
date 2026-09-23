/**
 * Tests for web/storage/vacuum.ts — pre-backup / manual VACUUM helper.
 *
 * Mock strategy: `@/sqlite` (getSQLiteDB) and `navigator.storage.getDirectory`
 * are faked so no real OPFS or worker is touched. The mock manager records
 * every executed statement so we can assert the checkpoint+VACUUM sequence
 * and the close/reopen dance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const execute = vi.fn<(sql: string) => Promise<void>>()
const executeWithTimeout = vi.fn<(sql: string, timeoutMs?: number) => Promise<void>>()
const queryFirst = vi.fn<(sql: string) => Promise<unknown>>()
const close = vi.fn<() => Promise<void>>()
const initialize = vi.fn<() => Promise<void>>()

vi.mock('@/sqlite', () => ({
  getSQLiteDB: () => ({
    execute,
    executeWithTimeout,
    queryFirst,
    close,
    initialize,
  }),
}))

// Fake OPFS root with a single controllable db file size.
let dbFileSize: number | null
const getFile = vi.fn(async () => ({ size: dbFileSize }))
const getFileHandle = vi.fn(async () => ({ getFile }))
const getDirectory = vi.fn(async () => ({ getFileHandle }))

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): strip per-test mockImplementation setup
  // (e.g. getFileHandle.mockRejectedValue in the absent-db test) so it cannot
  // leak into later tests — the documented vitest footgun.
  vi.resetAllMocks()
  execute.mockResolvedValue(undefined)
  executeWithTimeout.mockResolvedValue(undefined)
  // Default freelist probe: well above the 20% skip threshold so VACUUM runs.
  queryFirst.mockImplementation(async (sql: string) =>
    sql.includes('freelist') ? { c: 50 } : { c: 100 },
  )
  close.mockResolvedValue(undefined)
  initialize.mockResolvedValue(undefined)
  getFile.mockImplementation(async () => ({ size: dbFileSize ?? 0 }))
  getFileHandle.mockImplementation(async () => ({ getFile }))
  getDirectory.mockImplementation(async () => ({ getFileHandle }))
  dbFileSize = null
  ;(globalThis as { navigator: unknown }).navigator = {
    storage: { getDirectory },
  } as unknown as Navigator
})

describe('vacuumDatabase', () => {
  it('runs checkpoint + VACUUM and returns the reclaimed byte delta', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = 1000
    getFile.mockImplementation(async () => ({ size: dbFileSize! }))

    // Simulate VACUUM shrinking the file mid-run.
    executeWithTimeout.mockImplementation(async (sql: string) => {
      if (sql === 'VACUUM') dbFileSize = 400
    })

    const reclaimed = await vacuumDatabase()
    expect(reclaimed).toBe(600)
    expect(executeWithTimeout).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)', 60_000)
    expect(executeWithTimeout).toHaveBeenCalledWith('VACUUM', 5 * 60_000)
    // close → initialize → pragmas → close (worker released for the caller)
    expect(close).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('returns 0 without running VACUUM when the freelist is below the skip threshold', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = 1000
    // 10 free of 100 total pages (10% < 20%) — the rebuild is not worth it.
    queryFirst.mockImplementation(async (sql: string) =>
      sql.includes('freelist') ? { c: 10 } : { c: 100 },
    )

    const reclaimed = await vacuumDatabase()
    expect(reclaimed).toBe(0)
    expect(executeWithTimeout).not.toHaveBeenCalled()
    // Skip path still restores the released-worker contract.
    expect(close).toHaveBeenCalledTimes(2)
    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('runs VACUUM anyway when the freelist probe fails', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = 1000
    queryFirst.mockRejectedValue(new Error('worker busy'))

    const reclaimed = await vacuumDatabase()
    expect(executeWithTimeout).toHaveBeenCalledWith('VACUUM', 5 * 60_000)
    expect(reclaimed).toBe(0)
  })

  it('returns null and keeps the worker closed when VACUUM throws', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = 1000
    executeWithTimeout.mockRejectedValue(new Error('quota exceeded'))

    const reclaimed = await vacuumDatabase()
    expect(reclaimed).toBeNull()
    // The finally block must still release the worker for the backup path.
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('returns null when the db file is absent (fresh profile)', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = null
    getFileHandle.mockRejectedValue(new Error('NotFoundError'))

    const reclaimed = await vacuumDatabase()
    expect(reclaimed).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(executeWithTimeout).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('returns 0 when the file does not shrink', async () => {
    const { vacuumDatabase } = await import('../vacuum')
    dbFileSize = 1000

    const reclaimed = await vacuumDatabase()
    expect(reclaimed).toBe(0)
  })
})
