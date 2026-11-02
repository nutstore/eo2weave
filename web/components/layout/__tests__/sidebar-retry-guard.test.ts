/**
 * Attempt-token guard for the sidebar retry button (PR #149 round-6 review,
 * "Retry re-enables prematurely").
 *
 * The inline retry handler clears its in-flight flag in a `finally` — when
 * attempt #1 exceeds the 15s timeout and attempt #2 starts, #1's settle
 * re-enables the button while #2 is still pending, allowing overlapping
 * retries. The guard extracts exactly that rule: only the LATEST attempt
 * token may clear the flag.
 */
import { describe, expect, it } from 'vitest'
import { createAttemptTokenSource } from '@/components/layout/sidebar-retry-guard'

describe('createAttemptTokenSource', () => {
  it('only lets the latest attempt clear the in-flight flag', () => {
    const source = createAttemptTokenSource()

    // Retry #1 starts, then times out; retry #2 starts while #1 settles.
    const attempt1 = source.next()
    const attempt2 = source.next()

    expect(attempt1).not.toBe(attempt2)
    // Attempt #1's late settle must NOT clear the flag — #2 is in flight.
    expect(source.isCurrent(attempt1)).toBe(false)
    // Attempt #2's settle DOES clear it.
    expect(source.isCurrent(attempt2)).toBe(true)
  })

  it('treats the current attempt as current and stale tokens after supersede', () => {
    const source = createAttemptTokenSource()
    const attempt1 = source.next()
    expect(source.isCurrent(attempt1)).toBe(true)

    // A newer attempt supersedes #1.
    source.next()
    expect(source.isCurrent(attempt1)).toBe(false)
  })
})
