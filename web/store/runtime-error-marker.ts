import type { ConversationRuntime } from './conversation-runtime.store'

/**
 * Assign a runtime error and invalidate any dismissal (issue #370).
 *
 * Every failure that lands in `ConversationRuntime.error` must go through here.
 * The banner hides exactly the error string the user dismissed, so a NEW
 * failure has to show a fresh banner even when it repeats that same text —
 * pre-run dispatch failures and stale dismiss clicks included.
 */
export function markRuntimeError(
  rt: Pick<ConversationRuntime, 'error' | 'dismissedError'>,
  error: string | null,
): void {
  rt.error = error
  rt.dismissedError = null
}
