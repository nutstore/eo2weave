/**
 * Request identity for page actions.
 *
 * Every submission gets a UNIQUE request id, generated at the ORIGINAL
 * send site (the page-side bridge caller `runBoundPageAction` in
 * injected.content.ts) and stamped into the action payload before it
 * crosses the bridge. The background keys its retry dedupe on
 * `tabId:requestId`, so:
 *   - two INDEPENDENT submissions — even of byte-identical payloads —
 *     carry different ids and always run separately (a content-hash id
 *     would silently swallow the second one);
 *   - a RETRY of the same submission (the bridge caller's retry wrapper
 *     re-sends after a BRIDGE_TIMEOUT) threads the SAME id, so the
 *     background joins the first run's in-flight promise, or — if that
 *     run already SETTLED — returns the recorded outcome from a
 *     short-TTL settled cache instead of executing a second time.
 *
 * The id deliberately does NOT derive from the action's content: content
 * addressing both collides genuinely independent identical submissions
 * and required serializing (and mutating) caller-owned objects. Both
 * hazards are gone: the id is opaque, and the action object is never
 * touched (the stamp is applied on a shallow copy).
 */

/** The transport-only key carrying the request identity. */
export const PAGE_ACTION_REQUEST_ID_KEY = '__cwRequestId'

let submissionSeq = 0

/**
 * A fresh, unique request id for ONE submission. Two calls never return
 * the same id — independent submissions must never join each other's
 * dedupe entry, and no content hash (with its collision class) is
 * involved.
 */
export function createPageActionRequestId(): string {
  submissionSeq = (submissionSeq + 1) % 0xffffffff
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 12)
  return `__cw_${Date.now().toString(36)}_${submissionSeq.toString(36)}_${random}`
}

/** Upper bound for any single debugger-callback wait (matches cdp-evaluate). */
export const PAGE_ACTION_CAPTURE_CAP_MS = 15_000

/**
 * Budget for a debugger-callback wait (frame loader capture) that runs
 * while the handler HOLDS the tab lock: whichever is smaller of the
 * fixed callback cap and the caller's remaining deadline. A stalled
 * debugger callback must not keep the lock after the caller's deadline
 * has passed — the caller is gone and can never receive the result. A
 * returned 0 fails closed (the capture returns null → mismatch → the
 * CSP fallback is refused).
 */
export function boundedCaptureTimeoutMs(
  deadlineAt: number | undefined,
  now: number = Date.now(),
  capMs: number = PAGE_ACTION_CAPTURE_CAP_MS,
): number {
  if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return capMs
  return Math.max(0, Math.min(capMs, deadlineAt - now))
}

/**
 * Clamp the page-supplied absolute deadline into the background's
 * receipt-based budget. The stamp is advisory (a liveness hint the page
 * ships with the request), never a trust boundary:
 *   - absent / non-finite → receipt + maxWindowMs (the plain budget);
 *   - OLDER than receipt - maxWindowMs → the request was delayed past
 *     its own lifetime and its caller has already given up:
 *     `expiredInTransit` (the caller rejects it outright);
 *   - otherwise → min(supplied, receipt + maxWindowMs). THE CAP: an
 *     unauthenticated page value can only SHORTEN the background's
 *     receipt-based budget (make it give up earlier — its own action,
 *     its own budget), never extend it past receipt + maxWindowMs.
 */
export function clampPageActionDeadline(
  callerDeadlineAt: number | undefined,
  requestReceivedAt: number,
  maxWindowMs: number,
): { deadlineAt: number; expiredInTransit: boolean } {
  const receiptBudget = requestReceivedAt + maxWindowMs
  if (callerDeadlineAt === undefined || !Number.isFinite(callerDeadlineAt)) {
    return { deadlineAt: receiptBudget, expiredInTransit: false }
  }
  if (callerDeadlineAt <= requestReceivedAt - maxWindowMs) {
    return { deadlineAt: receiptBudget, expiredInTransit: true }
  }
  return { deadlineAt: Math.min(callerDeadlineAt, receiptBudget), expiredInTransit: false }
}
