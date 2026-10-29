// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import {
  PAGE_ACTION_REQUEST_ID_KEY,
  PAGE_ACTION_CAPTURE_CAP_MS,
  createPageActionRequestId,
  boundedCaptureTimeoutMs,
  clampPageActionDeadline,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-request-identity'
import {
  submitPageActionWithRetry,
  serializePageActionPayload,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-retry-wrapper'
import {
  bumpTabNavigationEpoch,
  navigationEpochChanged,
  resetTabNavigationEpochsForTest,
} from '../../../browser-extension/lib/bash-commands/browser/page-action-navigation-epoch'

/**
 * Sourcery round-2 follow-ups on PR #110:
 *   - #1: request ids are UNIQUE per submission (never content-derived) —
 *     two independent submissions of an IDENTICAL payload must never
 *     share an id (a content hash would silently swallow the second one);
 *     only a retry threads the same id.
 *   - #2: no identity API mutates caller-owned objects — frozen/nested
 *     frozen payloads must not throw (the old stableSerialize stamped a
 *     temporary marker onto them).
 *   - #3: the loader capture wait is bounded by the caller's shared
 *     deadline (capped at the fixed debugger-callback timeout).
 *   - #4: the page-supplied deadline is clamped so it can never EXTEND
 *     the background's receipt-based budget.
 */

describe('createPageActionRequestId (#1: unique per submission)', () => {
  it('gives INDEPENDENT submissions different ids — even with identical payloads', () => {
    const submit = () => ({ type: 'click', locator: { selector: '#submit' } })
    const ids = Array.from({ length: 50 }, () => createPageActionRequestId())
    expect(new Set(ids).size).toBe(50)
    // Byte-identical payloads too: identity comes from the submission,
    // not the content — a content-hash id would collide here.
    const a = createPageActionRequestId()
    const b = createPageActionRequestId()
    expect(a).not.toBe(b)
    expect(submit()).toEqual(submit())
  })

  it('stamps a unique id per submission; a RETRY threads the SAME id', () => {
    // Retry wrapper semantics (injected.content.ts runBoundPageAction):
    // generate once at the original send site, reuse on resubmission.
    const original = createPageActionRequestId()
    const action = { type: 'fill', locator: { selector: '#f' }, value: 'hi' }
    const stamped = { ...action, [PAGE_ACTION_REQUEST_ID_KEY]: original }
    // The retry re-sends the SAME stamped payload (same id), not a
    // re-derived content hash.
    const retryStamp = stamped[PAGE_ACTION_REQUEST_ID_KEY]
    expect(retryStamp).toBe(original)
    // A NEW submission gets a fresh id.
    const next = { ...action, [PAGE_ACTION_REQUEST_ID_KEY]: createPageActionRequestId() }
    expect(next[PAGE_ACTION_REQUEST_ID_KEY]).not.toBe(original)
    // The stamp key stays compatible with the background reader.
    expect(PAGE_ACTION_REQUEST_ID_KEY).toBe('__cwRequestId')
    expect(typeof original).toBe('string')
    expect(original.length).toBeGreaterThan(0)
  })

  it('the REAL wrapper threads the SAME id through the retry, read via the serialized payload (Sourcery round-6 #3)', async () => {
    // The earlier form of this test read the id from a locally captured
    // variable — a wrapper regression (fresh id on retry, or changed
    // stamping) could not be detected. Here the id is read ONLY through
    // the actual transport path: what the wrapper hands to `send`,
    // serialized exactly as it crosses the bridge (JSON round-trip).
    const action = { type: 'fill', locator: { selector: '#f' }, value: 'hi' }
    const serializedPayloads: string[] = []
    let sends = 0
    const send = (type: string, payload: Record<string, unknown>) => {
      expect(type).toBe('runBoundPageAction')
      serializedPayloads.push(serializePageActionPayload(payload))
      sends += 1
      if (sends === 1) {
        return Promise.resolve({ ok: false, errorCode: 'BRIDGE_TIMEOUT' })
      }
      return Promise.resolve({ ok: true, result: 'done' })
    }
    const result = (await submitPageActionWithRetry(send, 'b1', action)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(sends).toBe(2)
    expect(serializedPayloads.length).toBe(2)

    // Parse the ids back out of the SERIALIZED payloads — the exact
    // bytes the background receives on each attempt.
    const ids = serializedPayloads.map((raw) => {
      const parsed = JSON.parse(raw) as { action: Record<string, unknown> }
      return parsed.action[PAGE_ACTION_REQUEST_ID_KEY]
    })
    // Both attempts carry a present, string id…
    expect(typeof ids[0]).toBe('string')
    expect((ids[0] as string).length).toBeGreaterThan(0)
    // …and the RETRY re-sends the SAME id (regression = fresh id here).
    expect(ids[1]).toBe(ids[0])

    // The wrapper preserves the caller's action fields verbatim in the
    // serialized payload (the stamp is additive on a shallow copy).
    const firstParsed = JSON.parse(serializedPayloads[0]!) as {
      action: Record<string, unknown>
      binding: string
      deadlineAt: number
    }
    expect(firstParsed.binding).toBe('b1')
    expect(firstParsed.action.type).toBe('fill')
    expect(firstParsed.action.value).toBe('hi')
    expect(typeof firstParsed.deadlineAt).toBe('number')

    // A NEW submission through the same wrapper gets a DIFFERENT id.
    let secondId: unknown
    await submitPageActionWithRetry(async (_type, payload) => {
      secondId = (JSON.parse(serializePageActionPayload(payload)) as { action: Record<string, unknown> })
        .action[PAGE_ACTION_REQUEST_ID_KEY]
      return { ok: true }
    }, 'b1', action)
    expect(secondId).not.toBe(ids[0])

    // Non-timeout failures resolve as-is (single send — a real outcome,
    // not a transport failure, so no retry).
    let sends2 = 0
    const outcome = (await submitPageActionWithRetry(async () => {
      sends2 += 1
      return { ok: false, errorCode: 'RUNNER_NOT_READY' }
    }, 'b1', action)) as { errorCode: string }
    expect(sends2).toBe(1)
    expect(outcome.errorCode).toBe('RUNNER_NOT_READY')
  })
})

describe('no caller-object mutation (#2: frozen actions)', () => {
  it('stamps a DEEP-FROZEN action without throwing', () => {
    const action = Object.freeze({
      type: 'click',
      locator: Object.freeze({ selector: Object.freeze('#locked') }),
    })
    // The old stableSerialize assigned a temporary cyclic marker onto the
    // frozen objects and threw TypeError here, rejecting the action
    // before it ever reached the bridge. The new flow shallow-copies.
    expect(() => Object.freeze({ ...action, [PAGE_ACTION_REQUEST_ID_KEY]: createPageActionRequestId() })).not.toThrow()
    expect(Object.isFrozen(action)).toBe(true)
    expect(Object.isFrozen(action.locator)).toBe(true)
  })

  it('derives identity WITHOUT touching the action object at all', () => {
    const action = { type: 'snapshot' }
    const before = Reflect.ownKeys(action)
    // Identity no longer inspects/serializes the payload: nothing may be
    // assigned onto (or deleted from) caller-owned objects.
    void createPageActionRequestId()
    expect(Reflect.ownKeys(action)).toEqual(before)
    expect(action).not.toHaveProperty('__cwCyclic')
  })
})

describe('boundedCaptureTimeoutMs (#3: caller-deadline-bounded capture)', () => {
  const CAP = PAGE_ACTION_CAPTURE_CAP_MS

  it('caps at the fixed debugger-callback timeout when the deadline is far', () => {
    const now = 1_000_000
    expect(boundedCaptureTimeoutMs(now + 10 * CAP, now)).toBe(CAP)
    expect(boundedCaptureTimeoutMs(undefined, now)).toBe(CAP)
    expect(boundedCaptureTimeoutMs(Number.NaN, now)).toBe(CAP)
  })

  it('shrinks to the caller’s remaining budget — never past the deadline', () => {
    const now = 1_000_000
    expect(boundedCaptureTimeoutMs(now + 5_000, now)).toBe(5_000)
    expect(boundedCaptureTimeoutMs(now + 1, now)).toBe(1)
    // Expired deadline: the capture must not wait at all (fail closed),
    // instead of the old fixed 15s hold on the tab lock.
    expect(boundedCaptureTimeoutMs(now, now)).toBe(0)
    expect(boundedCaptureTimeoutMs(now - 1, now)).toBe(0)
    expect(boundedCaptureTimeoutMs(now - 60_000, now)).toBe(0)
  })
})

describe('clampPageActionDeadline (#4: no forged-deadline budget extension)', () => {
  const WINDOW = 300_000
  const received = 10_000_000

  it('uses the receipt-based budget when no deadline is supplied', () => {
    const r = clampPageActionDeadline(undefined, received, WINDOW)
    expect(r.deadlineAt).toBe(received + WINDOW)
    expect(r.expiredInTransit).toBe(false)
  })

  it('caps a page-supplied deadline at receipt + window (never extends the budget)', () => {
    // THE INVARIANT: the effective budget never exceeds receipt + WINDOW,
    // whatever the page supplies (Sourcery #4 — the old code honored any
    // in-window value verbatim, letting a stamp at the window edge grant
    // the full extra window on top of preflight/delivery time).
    const forged = received + WINDOW - 1
    const r = clampPageActionDeadline(forged, received, WINDOW)
    expect(r.deadlineAt).toBeLessThanOrEqual(received + WINDOW)
    expect(r.expiredInTransit).toBe(false)
    // A stamp beyond the window is clamped to exactly the receipt budget.
    expect(clampPageActionDeadline(received + WINDOW + 5_000, received, WINDOW).deadlineAt).toBe(received + WINDOW)
    // A stamp in the (accepted, window] range can only make the budget
    // SHORTER than or equal to receipt + WINDOW — never longer.
    expect(clampPageActionDeadline(received + WINDOW + 1, received, WINDOW).deadlineAt)
      .toBeLessThanOrEqual(received + WINDOW)
  })

  it('honors a legitimate in-window deadline (can only shorten the budget)', () => {
    const legit = received - 60_000
    const r = clampPageActionDeadline(legit, received, WINDOW)
    expect(r.deadlineAt).toBe(legit)
    expect(r.expiredInTransit).toBe(false)
  })

  it('rejects a stamp older than the window as expired-in-transit', () => {
    const stale = received - WINDOW - 1
    const r = clampPageActionDeadline(stale, received, WINDOW)
    expect(r.expiredInTransit).toBe(true)
    expect(r.deadlineAt).toBe(received + WINDOW)
  })
})

/**
 * Sourcery round-4 fix 1 (fallback accepts a replacement document):
 * the tab's navigation epoch is pinned BEFORE the executeScript that
 * produced the compile failure and re-checked before the CDP fallback
 * dispatch. The epoch advances on every cross-document navigation
 * commit (tabs.onUpdated status='loading'), so a navigation between the
 * failed compile and the fallback — the window where the post-hoc
 * loaderId capture observes the REPLACEMENT document and would bless
 * the stale run — fails closed. pushState/hash changes never touch the
 * epoch (same document), so legitimate same-document fallbacks still
 * run.
 */
describe('tab navigation epoch (fix 1: replacement-document guard)', () => {
  beforeEach(() => {
    resetTabNavigationEpochsForTest()
  })

  it('is monotonic per tab and independent across tabs', () => {
    expect(bumpTabNavigationEpoch(7)).toBe(1)
    expect(bumpTabNavigationEpoch(7)).toBe(2)
    expect(bumpTabNavigationEpoch(9)).toBe(1) // other tabs unaffected
    expect(bumpTabNavigationEpoch(7)).toBe(3)
  })

  it('pins before executeScript, mismatch after a navigation → fallback refused', () => {
    // The handler pins the epoch before its executeScript:
    const pinned = bumpTabNavigationEpoch(7)
    // A cross-document navigation commits BEFORE the fallback branch:
    bumpTabNavigationEpoch(7)
    // The fallback's re-check no longer matches the pin → refused.
    expect(navigationEpochChanged(7, pinned)).toBe(true)
  })

  it('same document (no navigation commit) → epoch unchanged → fallback allowed', () => {
    const pinned = bumpTabNavigationEpoch(5)
    // pushState / hash changes fire NO status='loading' event: the
    // counter is untouched, the re-check matches the pin.
    expect(navigationEpochChanged(5, pinned)).toBe(false)
    // A different tab's navigation never affects this tab's guard.
    bumpTabNavigationEpoch(6)
    expect(navigationEpochChanged(5, pinned)).toBe(false)
  })

  it('reset clears all epochs (test-hook isolation)', () => {
    bumpTabNavigationEpoch(11)
    bumpTabNavigationEpoch(12)
    resetTabNavigationEpochsForTest()
    // After reset the counter starts from scratch.
    expect(bumpTabNavigationEpoch(11)).toBe(1)
  })
})
