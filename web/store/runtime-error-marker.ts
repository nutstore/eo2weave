import type { ConversationRuntime } from '@/store/conversation-runtime.store'

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

/**
 * Release a runtime entry's payload while keeping its dismissal marker (#370).
 *
 * The eviction path deletes idle runtime entries, but `dismissedError` lives on
 * the entry while the failed turn it hides stays in the transcript: deleting
 * the entry would revive a dismissed banner on the next open. Drop the
 * message-sized buffers instead and keep the (now tiny) entry.
 *
 * The error text goes too: the marker alone keeps the banner closed (the
 * persisted failed turn supplies the text again on the next open), and a
 * provider error can carry an unbounded response body. Same for the
 * iteration-limit flag, which belongs to the run that already ended.
 */
export function stripRuntimePayload(rt: ConversationRuntime): void {
  rt.error = null
  rt.iterationLimitReached = null
  rt.streamingContent = ''
  rt.streamingReasoning = ''
  rt.isContentStreaming = false
  rt.isReasoningStreaming = false
  rt.completedContent = null
  rt.completedReasoning = null
  rt.currentToolCall = null
  rt.activeToolCalls = []
  rt.streamingToolArgs = ''
  rt.streamingToolArgsByCallId = {}
  rt.draftAssistant = null
  rt.contextWindowUsage = null
  rt.collectedAssets = []
}
