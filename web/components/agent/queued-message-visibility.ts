import type { Message } from '@/agent/message-types'
import type { QueuedMessage } from '@/store/conversation-runtime.store'

/**
 * Ids of the transcript messages that a pending queue entry already owns.
 *
 * An app-tool prompt is appended to the transcript at enqueue time (its row
 * has to be part of the persist snapshot), so the same prompt would render
 * twice while it waits: once as a normal user bubble and once as a queue card.
 */
export function pendingQueuedMessageIds(queued: QueuedMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of queued) {
    const id = entry.persistedMessage?.id
    if (id) ids.add(id)
  }
  return ids
}

/**
 * Hide the transcript bubbles of prompts that are still waiting in the queue.
 *
 * The queue CARD is the surface that stays: it carries the queue-specific
 * edit/remove/move actions, while the bubble's own edit/delete actions are
 * disabled while a run is processing — hiding the card instead would leave a
 * pending prompt with no usable controls. Entries without a persisted record
 * (UI sends) are memory-only and never appear in the transcript.
 *
 * Returns the input array unchanged when nothing is queued, so the memoized
 * turn list keeps its identity during normal renders.
 */
export function hideQueuedTranscriptMessages(
  messages: Message[],
  queued: QueuedMessage[],
): Message[] {
  if (queued.length === 0) return messages
  const pending = pendingQueuedMessageIds(queued)
  if (pending.size === 0) return messages
  return messages.filter((message) => !pending.has(message.id))
}
