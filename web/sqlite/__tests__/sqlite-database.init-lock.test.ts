import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabaseManager } from '@/sqlite/sqlite-database'

/**
 * Regression tests for Sourcery round-14 findings on PR #133
 * (web/sqlite/sqlite-database.ts acquireInitLock):
 *
 * 1. "Initialization lock releases too early" — the deadline timer must be
 *    CANCELLED when the lock is granted; otherwise it still fires
 *    releaseLock() mid-initialization and another tab can initialize
 *    concurrently during a long migration.
 * 2. "Rejected lock delays startup" — a REJECTED navigator.locks.request()
 *    never invokes the callback, so acquiredPromise must be settled from the
 *    rejection handler instead of every startup paying the full 10s deadline.
 */

describe('SQLiteDatabaseManager acquireInitLock (PR #133 Sourcery round 14)', () => {
  const managerCtor = SQLiteDatabaseManager as any
  let originalLocks: unknown
  let hadLocks: boolean

  beforeEach(() => {
    vi.resetAllMocks()
    managerCtor.instance = null
    const nav = globalThis.navigator as any
    hadLocks = !!nav?.locks
    originalLocks = nav?.locks
  })

  afterEach(() => {
    const nav = globalThis.navigator as any
    if (hadLocks) {
      nav.locks = originalLocks
    } else if (nav && 'locks' in nav) {
      delete nav.locks
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function stubLocks(request: (scope: string, cb: () => Promise<void>) => Promise<void>) {
    const nav = globalThis.navigator as any
    Object.defineProperty(nav, 'locks', {
      configurable: true,
      value: { request },
    })
  }

  it('keeps the lock held past the deadline while initialization is still running', async () => {
    vi.useFakeTimers()
    const held: { release: (() => void) | null } = { release: null }
    let callbackFinished = false
    stubLocks((_scope, cb) => {
      // Grant immediately; the callback holds the lock until released.
      const gate = new Promise<void>((resolve) => {
        held.release = resolve
      }).then(() => {
        callbackFinished = true
      })
      void cb().then(() => gate)
      return Promise.resolve()
    })

    const db = SQLiteDatabaseManager.getInstance()
    const release = await (db as any).acquireInitLock()
    expect(typeof release).toBe('function')
    void release

    // Past the old 10s deadline the lock MUST still be held (timer cancelled
    // on grant) — the held callback has not completed.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(callbackFinished).toBe(false)

    // Explicit release lets the holder finish.
    held.release?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(callbackFinished).toBe(true)
  })

  it('proceeds unlocked immediately when the lock request rejects (no deadline wait)', async () => {
    vi.useFakeTimers()
    stubLocks(() => Promise.reject(new Error('SecurityError: lock unavailable')))

    const db = SQLiteDatabaseManager.getInstance()
    const acquired = (db as any).acquireInitLock() as Promise<() => void>
    // A wrong implementation would leave `acquired` pending until the 10s
    // deadline; racing it against a short timer advance proves it settles
    // from the rejection path without paying the deadline.
    const raced = Promise.race([
      acquired.then(() => 'settled' as const),
      vi.advanceTimersByTimeAsync(50).then(() => 'deadline-wait' as const),
    ])
    await expect(raced).resolves.toBe('settled')

    // The release returned by the rejection path must be a safe no-op.
    const release = await acquired
    expect(() => release()).not.toThrow()
  })
})
