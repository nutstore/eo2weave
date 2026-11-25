import type { Message } from '@/agent/message-types'

/**
 * Transcript mirror for queue edits/removals.
 *
 * An app-tool prompt is persisted AND appended to the transcript at enqueue
 * time (its `persistedMessage` owns that row). `conversation-persist` treats
 * the transcript as the source of truth, so a queue-only removal left the row
 * behind (a refresh resurrected a removed prompt) and a queue-only edit was
 * lost (the dequeue consumer ran the enqueue-time text).
 *
 * The conversation store owns `updateMessages` and installs this mirror at load
 * time. The slot lives in its own dependency-free module because the runtime
 * store cannot import the conversation store (the conversation store already
 * imports it) and must not grow an export every partial test mock has to copy.
 */
export interface QueuedMessageMirror {
  /** Drop the transcript record of a discarded queued prompt. */
  remove: (conversationId: string, messageId: string) => void
  /** Replace the transcript record of an edited queued prompt. */
  replace: (conversationId: string, message: Message) => void
}

let mirror: QueuedMessageMirror | null = null

/** Installed by the conversation store; null while it is not loaded. */
export function setQueuedMessageMirror(next: QueuedMessageMirror | null): void {
  mirror = next
}

/** The installed mirror, or null when the conversation store is not loaded. */
export function queuedMessageMirror(): QueuedMessageMirror | null {
  return mirror
}
