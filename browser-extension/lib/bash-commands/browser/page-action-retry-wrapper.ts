/**
 * Bridge-caller retry wrapper for page actions (page side).
 *
 * This is the ACTUAL retry semantics of `runBoundPageAction` in
 * injected.content.ts, extracted so tests can exercise the real wrapper
 * (not a re-derived copy): a BRIDGE_TIMEOUT resubmits the SAME stamped
 * payload — the request id stamped at the original send site is reused,
 * so the background joins the in-flight run or replays its recorded
 * settled outcome. Anything other than a timeout resolves as-is
 * (structured ok:false results are real outcomes, not transport
 * failures).
 *
 * THE RETRY CARRIES A FRESH DEADLINE but the SAME request id: the
 * background's dedupe is keyed on the id, never on the deadline.
 */

import {
  PAGE_ACTION_REQUEST_ID_KEY,
  createPageActionRequestId,
} from './page-action-request-identity'

/** One bridge send — the injected.content.ts sendToBridge signature. */
export type BridgeSend = (
  type: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
) => Promise<unknown>

export const PAGE_ACTION_BRIDGE_TIMEOUT_MS = 300_000

/**
 * Stamp a fresh unique request id onto a shallow copy of the action and
 * submit through `send` with the caller's timeout; on BRIDGE_TIMEOUT
 * resubmit the SAME stamped payload once (same id, fresh deadline
 * budget). `now`/`setTimeoutMs` are injectable for deterministic tests.
 */
export async function submitPageActionWithRetry(
  send: BridgeSend,
  binding: string,
  action: Record<string, unknown>,
  timeoutMs: number = PAGE_ACTION_BRIDGE_TIMEOUT_MS,
): Promise<unknown> {
  const requestId = createPageActionRequestId()
  const stampedAction =
    action && typeof action === 'object'
      ? { ...action, [PAGE_ACTION_REQUEST_ID_KEY]: requestId }
      : action
  // Fresh ABSOLUTE deadline epoch per attempt: the background clamps the
  // value into its receipt-based budget (it can only shorten, never
  // extend).
  const first = await send(
    'runBoundPageAction',
    { binding, action: stampedAction, deadlineAt: Date.now() + timeoutMs },
    timeoutMs,
  )
  if ((first as { errorCode?: string } | null)?.errorCode !== 'BRIDGE_TIMEOUT') return first
  return send(
    'runBoundPageAction',
    { binding, action: stampedAction, deadlineAt: Date.now() + timeoutMs },
    timeoutMs,
  )
}

/**
 * Serialize the stamped payload exactly as it crosses the bridge
 * (window.postMessage → structured clone ≈ JSON round-trip) so tests can
 * read the request id through the REAL transport path rather than from a
 * locally captured variable.
 */
export function serializePageActionPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}
