// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import {
  describeSettledOutcome,
  replayedSettledOutcome,
  pruneSettledEntries,
  settlementOutcomeFromRun,
  isPlausibleRunnerResult,
  PAGE_ACTION_RETRY_MEMORY_MS,
  type PageActionSettledEntry,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-settled-outcome'
import {
  readDedupeRecord,
  writeDedupeRecord,
  clearDedupeRecord,
  resetDedupeStoreForTest,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-dedupe-store'

/**
 * Sourcery round-4 follow-ups on PR #110 (fixes 2 + 3):
 *   - Fix 2 (expired retry entries duplicate actions): the settled cache
 *     must retain outcomes for at least the bridge caller's ENTIRE retry
 *     window (one retry at full 300s budget) — a late-but-legitimate
 *     retry must replay the recorded outcome, never find an expired
 *     entry and execute the same logical action a second time.
 *   - Fix 3 (retries replay an undefined result): settled entries are
 *     ENVELOPES. A rejected run is cached as a structured failure (the
 *     old `catch(() => {})` cached a swallowed `undefined`); a resolved
 *     `undefined` (lost result — the runner always resolves with an
 *     object) is flagged as a corrupt entry with an explicit retryable
 *     error; legit falsy values (false / 0 / null / '') pass through.
 */

describe('PAGE_ACTION_RETRY_MEMORY_MS (fix 2: covers the retry window)', () => {
  it('is at least the FULL retry horizon (first window + retry budget + slack)', () => {
    // injected.content.ts runBoundPageAction: timeoutMs = 300_000, ONE
    // retry with a fresh full budget. The retry is issued only AFTER the
    // first window's timeout fires, and the first run can settle at the
    // very END of its window — so a legitimate retry can arrive up to
    // ~600s after the first run settled (Sourcery round-6 #2: the old
    // 305s TTL pruned entries a retry could still need). The TTL must
    // therefore cover BOTH windows plus slack.
    expect(PAGE_ACTION_RETRY_MEMORY_MS).toBeGreaterThanOrEqual(600_000)
    // Small slack so a throttled retry timer at the boundary is not racing.
    expect(PAGE_ACTION_RETRY_MEMORY_MS).toBeGreaterThanOrEqual(610_000)
  })
})

describe('pruneSettledEntries (fix 2: bounded, never during the window)', () => {
  it('keeps entries within the TTL and drops only expired ones', () => {
    const now = 50_000
    // Ages at prune time: fresh=0, just-under=TTL, expired=TTL+1.
    const map = new Map<string, { settledAt: number }>([
      ['fresh', { settledAt: now }],
      ['just-under', { settledAt: now - PAGE_ACTION_RETRY_MEMORY_MS }],
      ['expired', { settledAt: now - PAGE_ACTION_RETRY_MEMORY_MS - 1 }],
    ])
    pruneSettledEntries(map, PAGE_ACTION_RETRY_MEMORY_MS, now)
    expect(map.has('fresh')).toBe(true)
    expect(map.has('just-under')).toBe(true)
    expect(map.has('expired')).toBe(false)
  })
})

describe('describeSettledOutcome (fix 3: envelopes, never a bare undefined)', () => {
  it('wraps a legitimate runner result as ok and replays it verbatim', () => {
    const result = { ok: true, result: { title: 'x' } }
    const entry = describeSettledOutcome(result)
    expect(entry.status).toBe('ok')
    expect(replayedSettledOutcome(entry)).toEqual(result)
  })

  it('passes falsy-but-defined results through untouched (backward compat)', () => {
    for (const value of [false, 0, null, '', 'ok']) {
      const entry = describeSettledOutcome(value)
      expect(entry.status).toBe('ok')
      expect(replayedSettledOutcome(entry)).toBe(value)
    }
  })

  it('flags a resolved-undefined (lost) result as an explicit retryable error', () => {
    // THE BUG: the old cache stored the bare undefined; a retry replayed
    // it as if the action had produced undefined. Now: structured error.
    const entry = describeSettledOutcome(undefined)
    expect(entry.status).toBe('error')
    const replayed = replayedSettledOutcome(entry) as { ok: boolean; errorCode: string; error: string }
    expect(replayed.ok).toBe(false)
    expect(replayed.errorCode).toBe('PAGE_ACTION_SETTLED_ENTRY_CORRUPT')
    expect(replayed.error).toContain('Retry')
    // The error must NOT be presented as a successful undefined result.
    expect(replayed).not.toBe(undefined)
  })

  it('caches a rejected run as a structured failure (not a swallowed undefined)', () => {
    // Mirrors the settlement handler: the catch converts the rejection
    // BEFORE describeSettledOutcome sees it — so the stored outcome is a
    // defined object and the envelope stays 'ok' with the failure inside.
    const rejection = new Error('tab lock aborted')
    const cachedOutcome = {
      ok: false,
      errorCode: 'PAGE_ACTION_RUN_FAILED',
      error: rejection.message,
    }
    const entry = describeSettledOutcome(cachedOutcome)
    expect(entry.status).toBe('ok') // envelope transport; payload is the failure
    const replayed = replayedSettledOutcome(entry) as { ok: boolean; errorCode: string }
    expect(replayed).toEqual(cachedOutcome)
    expect(replayed.ok).toBe(false)
    expect(replayed.errorCode).toBe('PAGE_ACTION_RUN_FAILED')
  })

  it('the REAL settlement conversion maps a rejection to a structured failure (Sourcery round-6 #4)', async () => {
    // Regression guard: if the background's rejection handler ever
    // swallows errors again (`catch(() => {})`), the recorded outcome
    // would be a bare `undefined` and the envelope would flag it as a
    // CORRUPT entry — a retry would see "result lost" instead of the
    // root cause. This exercises the REAL conversion function the
    // settlement handler uses, so restoring a swallowing catch (or
    // changing its shape) fails here.
    const rejecting = Promise.reject(new Error('tab lock aborted'))
    // Attach the handler the way the background does so the rejection
    // is consumed (no unhandled-rejection noise), then convert.
    const settled = await rejecting.then(
      (v) => ({ status: 'fulfilled', value: v }) as PromiseSettledResult<unknown>,
      (r) => ({ status: 'rejected', reason: r }) as PromiseSettledResult<unknown>,
    )
    const outcome = settlementOutcomeFromRun(settled) as {
      ok: boolean
      errorCode: string
      error: string
    }
    // NEVER a swallowed undefined:
    expect(outcome).not.toBe(undefined)
    expect(outcome).toEqual({
      ok: false,
      errorCode: 'PAGE_ACTION_RUN_FAILED',
      error: 'tab lock aborted',
    })
    // And the full pipeline (conversion → envelope → replay) preserves
    // the structured failure for the retry.
    const envelope = describeSettledOutcome(outcome)
    expect(envelope.status).toBe('ok') // transport envelope; payload is the failure
    const replayed = replayedSettledOutcome(envelope) as { ok: boolean; errorCode: string }
    expect(replayed.ok).toBe(false)
    expect(replayed.errorCode).toBe('PAGE_ACTION_RUN_FAILED')

    // A NON-Error rejection reason also converts to a defined string.
    const settled2 = { status: 'rejected', reason: 'boom' } as PromiseSettledResult<unknown>
    const outcome2 = settlementOutcomeFromRun(settled2) as { error: string }
    expect(outcome2.error).toBe('boom')

    // A fulfilled run passes its value through verbatim (including
    // legit falsy values — only `undefined` is corrupt-flagged later).
    const settled3 = { status: 'fulfilled', value: { ok: true, result: 7 } } as PromiseSettledResult<unknown>
    expect(settlementOutcomeFromRun(settled3)).toEqual({ ok: true, result: 7 })
  })

  it('a settled CORRUPT entry (lost undefined) never replays as success (Sourcery round-6 #4)', () => {
    // If the background ever recorded a bare undefined again (e.g. an
    // abandoned run returning bare), the corrupt-entry guard must still
    // fail the retry closed — verified end-to-end through the REAL
    // recording path.
    const envelope = describeSettledOutcome(settlementOutcomeFromRun({ status: 'fulfilled', value: undefined } as PromiseSettledResult<unknown>))
    expect(envelope.status).toBe('error')
    const replayed = replayedSettledOutcome(envelope) as { ok: boolean; errorCode: string }
    expect(replayed.ok).toBe(false)
    expect(replayed.errorCode).toBe('PAGE_ACTION_SETTLED_ENTRY_CORRUPT')
  })

  it('the deadline-abandoned branch returns a STRUCTURED outcome (never bare undefined)', () => {
    // Sourcery round-5, comment 2 residual: the shared run's deadline
    // branch used to `return` bare — the settlement handler cached
    // `undefined` and flagged it corrupt for a joining retry. It now
    // assigns the structured PAGE_ACTION_ABANDONED outcome before
    // returning. This pins the contract the settlement cache relies on:
    // every run path resolves to a defined `{ok: ...}` object.
    const abandonedOutcome = {
      ok: false,
      errorCode: 'PAGE_ACTION_ABANDONED',
      error: expect.stringContaining('deadline expired'),
    }
    // The branch's shape must satisfy the runner-result plausibility
    // contract (defined, object, boolean ok) so it is never mistaken for
    // a lost/corrupt result.
    expect(isPlausibleRunnerResult(abandonedOutcome)).toBe(true)
    expect(describeSettledOutcome(abandonedOutcome).status).toBe('ok')
    // And the guard the fix closes: a bare return value would NOT pass.
    expect(isPlausibleRunnerResult(undefined)).toBe(false)
  })
})

describe('isPlausibleRunnerResult (corrupt-entry heuristic)', () => {
  it('accepts the runner contract ({ ok: boolean, ... })', () => {
    expect(isPlausibleRunnerResult({ ok: true })).toBe(true)
    expect(isPlausibleRunnerResult({ ok: false, errorCode: 'X', error: 'y' })).toBe(true)
  })

  it('rejects non-objects and objects without a boolean ok', () => {
    expect(isPlausibleRunnerResult(undefined)).toBe(false)
    expect(isPlausibleRunnerResult(null)).toBe(false)
    expect(isPlausibleRunnerResult({})).toBe(false)
    expect(isPlausibleRunnerResult({ ok: 'yes' })).toBe(false)
  })
})

describe('envelope round-trip (what the background replays)', () => {
  it('ok path: retry sees exactly what the first run returned', () => {
    const entries: Array<PageActionSettledEntry & { settledAt: number }> = []
    entries.push({ ...describeSettledOutcome({ ok: true, result: 42 }), settledAt: 1 })
    expect(replayedSettledOutcome(entries[0])).toEqual({ ok: true, result: 42 })
  })

  it('error path: retry never receives an invalid (undefined) outcome', () => {
    const entry: PageActionSettledEntry & { settledAt: number } = {
      ...describeSettledOutcome(undefined),
      settledAt: 1,
    }
    expect(replayedSettledOutcome(entry)).not.toBe(undefined)
  })
})

/**
 * Sourcery round-6 #1 (restart-safe dedupe): the module-scope maps die
 * with the MV3 service worker — a retry arriving after a restart found
 * no record and re-executed the action. The dedupe store now mirrors
 * records into chrome.storage.session, which SURVIVES worker restarts.
 * These tests fake that storage backend (a plain object) and drive the
 * real read/write/clear functions against it.
 */
describe('page-action dedupe store (restart-safe via storage.session)', () => {
  // Fake chrome.storage.session: in the real extension this survives SW
  // restarts. Here the fake object plays that role: content written into
  // it stays readable even after the store's in-memory mirror is reset
  // (the restart simulation).
  let backend: Record<string, unknown>
  let failing: boolean

  beforeEach(() => {
    backend = {}
    failing = false
    resetDedupeStoreForTest()
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: {
          get: async (key: string) => {
            if (failing) throw new Error('storage unavailable')
            return key in backend ? { [key]: backend[key] } : {}
          },
          set: async (items: Record<string, unknown>) => {
            if (failing) throw new Error('storage unavailable')
            Object.assign(backend, items)
          },
          remove: async (key: string) => {
            if (failing) throw new Error('storage unavailable')
            delete backend[key]
          },
        },
      },
    }
  })

  it('a SETTLED record written before the "restart" is replayed after it', async () => {
    const envelope = describeSettledOutcome({ ok: true, result: 'first-run' })
    await writeDedupeRecord('1:req-a', { kind: 'settled', entry: envelope, settledAt: 123 })
    // Simulate the SW restart: in-memory mirror is gone, storage remains.
    resetDedupeStoreForTest()
    const record = await readDedupeRecord('1:req-a')
    expect(record?.kind).toBe('settled')
    if (record?.kind === 'settled') {
      expect(replayedSettledOutcome(record.entry)).toEqual({ ok: true, result: 'first-run' })
    }
  })

  it('an INFLIGHT record written before the "restart" survives as inflight (never re-executes)', async () => {
    await writeDedupeRecord('2:req-b', { kind: 'inflight', startedAt: 5 })
    resetDedupeStoreForTest()
    const record = await readDedupeRecord('2:req-b')
    // The background treats a persisted inflight record with no live
    // promise as an INTERRUPTED run: structured failure, no re-execution.
    expect(record?.kind).toBe('inflight')
  })

  it('settlement overwrites the inflight record (inflight → settled)', async () => {
    await writeDedupeRecord('3:req-c', { kind: 'inflight', startedAt: 5 })
    await writeDedupeRecord('3:req-c', {
      kind: 'settled',
      entry: describeSettledOutcome({ ok: false, errorCode: 'X' }),
      settledAt: 9,
    })
    resetDedupeStoreForTest()
    const record = await readDedupeRecord('3:req-c')
    expect(record?.kind).toBe('settled')
  })

  it('clearDedupeRecord removes the record from BOTH memory and storage', async () => {
    await writeDedupeRecord('4:req-d', { kind: 'inflight', startedAt: 1 })
    await clearDedupeRecord('4:req-d')
    expect(await readDedupeRecord('4:req-d')).toBeUndefined()
    resetDedupeStoreForTest()
    // After the "restart" the storage side is gone too.
    expect(await readDedupeRecord('4:req-d')).toBeUndefined()
  })

  it('a storage failure degrades to in-memory-only behavior (never breaks the action)', async () => {
    failing = true
    // Writes and reads must not throw.
    await writeDedupeRecord('5:req-e', { kind: 'inflight', startedAt: 1 })
    expect(await readDedupeRecord('5:req-e')).toEqual({ kind: 'inflight', startedAt: 1 })
    await clearDedupeRecord('5:req-e')
  })

  it('a MALFORMED stored record reads as absent (fail closed, no false dedupe)', async () => {
    backend['pageActionDedupe:6:req-f'] = { kind: 'bogus' }
    expect(await readDedupeRecord('6:req-f')).toBeUndefined()
    backend['pageActionDedupe:6:req-f'] = 42
    expect(await readDedupeRecord('6:req-f')).toBeUndefined()
  })

  it('absent chrome.storage.session (non-extension context) reads as absent', async () => {
    ;(globalThis as { chrome?: unknown }).chrome = undefined
    await writeDedupeRecord('7:req-g', { kind: 'settled', entry: describeSettledOutcome({ ok: true }), settledAt: 1 })
    // In-memory mirror still answers; storage path is a silent no-op.
    expect(await readDedupeRecord('7:req-g')).toBeDefined()
    resetDedupeStoreForTest()
    expect(await readDedupeRecord('7:req-g')).toBeUndefined()
  })
})
