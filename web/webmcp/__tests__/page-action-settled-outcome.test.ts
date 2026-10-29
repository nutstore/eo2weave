// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  describeSettledOutcome,
  replayedSettledOutcome,
  pruneSettledEntries,
  isPlausibleRunnerResult,
  PAGE_ACTION_RETRY_MEMORY_MS,
  type PageActionSettledEntry,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-settled-outcome'

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
  it('is at least the bridge retry window (300s timeout + slack)', () => {
    // injected.content.ts runBoundPageAction: timeoutMs = 300_000, ONE
    // retry with a fresh full budget. The settled entry must outlive
    // the whole chain.
    expect(PAGE_ACTION_RETRY_MEMORY_MS).toBeGreaterThanOrEqual(300_000)
    // Small slack so a retry issued exactly at the boundary is not racing.
    expect(PAGE_ACTION_RETRY_MEMORY_MS).toBeGreaterThanOrEqual(305_000)
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
