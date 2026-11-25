import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@/agent/message-types'
import { visibleQueuedEntries } from '../queued-message-visibility'
import type { QueuedMessage } from '@/store/conversation-runtime.store'

function queue(...entries: QueuedMessage[]): QueuedMessage[] {
  return entries
}

describe('visibleQueuedEntries', () => {
  it('hides a card whose persisted prompt is already a transcript bubble', () => {
    const persisted = createUserMessage('app-tool prompt')
    const entries = queue(
      { text: 'app-tool prompt', enqueuedAt: 1, persistedMessage: persisted },
      { text: 'typed while busy', enqueuedAt: 2 },
    )
    expect(visibleQueuedEntries(entries, new Set([persisted.id]))).toEqual([
      { index: 1, message: entries[1] },
    ])
  })

  it('keeps the queue index of the surviving entries (no renumbering)', () => {
    const first = createUserMessage('one')
    const third = createUserMessage('three')
    const entries = queue(
      { text: 'one', enqueuedAt: 1, persistedMessage: first },
      { text: 'two', enqueuedAt: 2 },
      { text: 'three', enqueuedAt: 3, persistedMessage: third },
    )
    expect(visibleQueuedEntries(entries, new Set([first.id, third.id]))).toEqual([
      { index: 1, message: entries[1] },
    ])
  })

  it('shows every entry when the transcript holds none of them', () => {
    const persisted = createUserMessage('pending')
    const entries = queue({ text: 'pending', enqueuedAt: 1, persistedMessage: persisted })
    expect(visibleQueuedEntries(entries, new Set())).toEqual([{ index: 0, message: entries[0] }])
  })
})
