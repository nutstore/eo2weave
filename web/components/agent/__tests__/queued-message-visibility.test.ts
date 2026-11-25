import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@/agent/message-types'
import {
  hideQueuedTranscriptMessages,
  pendingQueuedMessageIds,
  visibleTranscriptMessages,
} from '@/components/agent/queued-message-visibility'
import type { QueuedMessage } from '@/store/conversation-runtime.store'

describe('pendingQueuedMessageIds', () => {
  it('collects only the entries that own a persisted record', () => {
    const persisted = createUserMessage('app-tool prompt')
    const entries: QueuedMessage[] = [
      { text: 'app-tool prompt', enqueuedAt: 1, persistedMessage: persisted },
      { text: 'typed while busy', enqueuedAt: 2 },
    ]
    expect([...pendingQueuedMessageIds(entries)]).toEqual([persisted.id])
  })
})

describe('hideQueuedTranscriptMessages', () => {
  it('hides the bubble of a prompt that is still queued, keeping its card', () => {
    const persisted = createUserMessage('app-tool prompt')
    const earlier = createUserMessage('earlier turn')
    const queued: QueuedMessage[] = [
      { text: 'app-tool prompt', enqueuedAt: 1, persistedMessage: persisted },
      { text: 'typed while busy', enqueuedAt: 2 },
    ]

    expect(hideQueuedTranscriptMessages([earlier, persisted], queued)).toEqual([earlier])
  })

  it('shows the bubble again once the entry leaves the queue', () => {
    const persisted = createUserMessage('app-tool prompt')
    expect(hideQueuedTranscriptMessages([persisted], [])).toEqual([persisted])
  })

  it('returns the same array instance when the queue owns nothing in the transcript', () => {
    const messages = [createUserMessage('hello')]
    const queued: QueuedMessage[] = [{ text: 'typed while busy', enqueuedAt: 1 }]

    expect(hideQueuedTranscriptMessages(messages, queued)).toBe(messages)
  })
})

describe('visibleTranscriptMessages', () => {
  it('hides a queued prompt bubble for as long as the entry stays queued', () => {
    const persisted = createUserMessage('app-tool prompt')
    const queued: QueuedMessage[] = [{ text: 'app-tool prompt', enqueuedAt: 1, persistedMessage: persisted }]

    // No processing flag: the card renders whenever the queue is non-empty, so
    // the bubble must stay hidden at idle too (an idle queue would otherwise
    // offer a delete that only drops the transcript row, not the delivery).
    expect(visibleTranscriptMessages([persisted], queued)).toEqual([])
  })

  it('returns the same array instance when nothing is queued', () => {
    const messages = [createUserMessage('hello')]

    expect(visibleTranscriptMessages(messages, [])).toBe(messages)
  })

  it('restores the bubble once the entry leaves the queue', () => {
    const persisted = createUserMessage('app-tool prompt')

    expect(visibleTranscriptMessages([persisted], [])).toEqual([persisted])
  })
})
