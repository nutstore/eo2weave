import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabaseManager } from '@/sqlite/sqlite-database'

/**
 * Regression tests for Sourcery round-13 findings on PR #133:
 *
 * 1. "Worker startup failure wedges retries" — a Worker constructor that
 *    THROWS (creation blocked / resources unavailable) must reset the
 *    `initializing` gate instead of leaving every later call spinning in
 *    the `while (this.initializing)` wait forever.
 * 2. "Diagnostics report stale failure" — when a retry fails with a
 *    DIFFERENT error than the initial attempt, the thrown error must be
 *    the final one, not the original.
 */

describe('SQLiteDatabaseManager init failure gates (PR #133 Sourcery)', () => {
  const OriginalWorker = globalThis.Worker
  const originalCrossOriginIsolated = (globalThis as any).crossOriginIsolated
  const managerCtor = SQLiteDatabaseManager as any
  const globals = globalThis as any

  beforeEach(() => {
    vi.resetAllMocks()
    managerCtor.instance = null
    globals.crossOriginIsolated = true
  })

  afterEach(async () => {
    await SQLiteDatabaseManager.getInstance()
      .close()
      .catch(() => undefined)
    managerCtor.instance = null
    globals.Worker = OriginalWorker
    globals.crossOriginIsolated = originalCrossOriginIsolated
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resets the initializing gate when the Worker constructor throws (no wedge)', async () => {
    class ExplodingWorker {
      constructor() {
        throw new RangeError('worker creation blocked')
      }
    }
    globals.Worker = ExplodingWorker as any

    const db = SQLiteDatabaseManager.getInstance()
    await expect(db.initialize()).rejects.toThrow('worker creation blocked')

    // The gate must NOT be stuck: a later call must re-attempt (not spin
    // forever in the `initializing` wait). Give it a healthy worker now.
    globals.Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(request: any) {
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: 'init', id: request.id, success: true, mode: 'opfs' },
          } as MessageEvent)
        })
      }
      terminate() {}
    } as any

    const retryPromise = db.initialize()
    // Attach a racing timeout so a wedged (spinning) gate fails the test
    // instead of hanging it.
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('initialize() wedged in initializing gate')), 2000)
    )
    await expect(Promise.race([retryPromise, timeout])).resolves.toBeUndefined()
    expect((db as any).initialized).toBe(true)
  })

  it('throws the FINAL retry error, not the stale initial one', async () => {
    vi.useFakeTimers()

    // Fake worker whose init reply FAILS with a per-attempt message: the
    // first attempt reports one error, later retries a different one.
    const initErrors = ['initial attempt: opfs unavailable', 'retry attempt: quota exhausted']
    let constructed = 0

    class FailingInitWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      constructor(_url: URL, _options?: WorkerOptions) {
        constructed += 1
      }
      postMessage(request: any) {
        const attemptIndex = Math.min(constructed - 1, initErrors.length - 1)
        const message = initErrors[attemptIndex]
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: 'init', id: request.id, success: false, error: message },
          } as MessageEvent)
        })
      }
      terminate() {}
    }
    globals.Worker = FailingInitWorker as any

    const db = SQLiteDatabaseManager.getInstance()
    const attempt = db.initialize()
    // Flush the backoff timers (500ms/1s/2s inside MAX_INIT_RETRIES=3).
    vi.runAllTimersAsync()

    await expect(attempt).rejects.toThrow('retry attempt: quota exhausted')
    expect(constructed).toBeGreaterThanOrEqual(2)
  })
})
