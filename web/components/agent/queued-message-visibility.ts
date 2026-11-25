import type { QueuedMessage } from '@/store/conversation-runtime.store'

export interface VisibleQueuedEntry {
  /** Position in the pending queue (0-based) — card actions address the queue by this. */
  index: number
  message: QueuedMessage
}

/**
 * Queue entries to render as cards while the agent is processing.
 *
 * An app-tool prompt is appended to the transcript at enqueue time and carries
 * `persistedMessage`, so it is already on screen as a normal user bubble —
 * rendering its card too shows the same prompt twice. Entries without a
 * persisted record (UI-sent prompts) stay memory-only and keep their card.
 *
 * The queue index is preserved so the card's update/remove/move actions keep
 * addressing the real entry; only the rendered list is filtered.
 */
export function visibleQueuedEntries(
  queued: QueuedMessage[],
  transcriptIds: ReadonlySet<string>,
): VisibleQueuedEntry[] {
  const entries: VisibleQueuedEntry[] = []
  for (let index = 0; index < queued.length; index++) {
    const persistedId = queued[index].persistedMessage?.id
    if (persistedId && transcriptIds.has(persistedId)) continue
    entries.push({ index, message: queued[index] })
  }
  return entries
}
