/**
 * Attempt-token guard for retry buttons (PR #149 round-6 review,
 * "Retry re-enables prematurely").
 *
 * A retry handler that clears its in-flight flag in a `finally` has a race:
 * when attempt #1 exceeds its timeout and attempt #2 starts, attempt #1's
 * `finally` fires while #2 is still pending and re-enables the button —
 * allowing overlapping retries.
 *
 * The fix is a monotonically increasing attempt token: each start claims a
 * NEW token, and a settle may only clear the in-flight flag if it belongs to
 * the LATEST attempt.
 */

/**
 * Creates a counter that hands out a fresh attempt token per call and knows
 * which token is current.
 */
export function createAttemptTokenSource(): {
  next: () => number
  isCurrent: (attempt: number) => boolean
} {
  let generation = 0
  return {
    next: () => ++generation,
    isCurrent: (attempt: number) => attempt === generation,
  }
}
