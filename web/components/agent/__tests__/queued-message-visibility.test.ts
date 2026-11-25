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
  it('hides a queued prompt bubble only while the queue cards render', () => {
    const persisted = createUserMessage('app-tool prompt')
    const queued: QueuedMessage[] = [{ text: 'app-tool prompt', enqueuedAt: 1, persistedMessage: persisted }]

    expect(visibleTranscriptMessages([persisted], queued, true)).toEqual([])
    expect(visibleTranscriptMessages([persisted], queued, false)).toEqual([persisted])
  })

  it('returns the same array instance when no cards are on screen', () => {
    const messages = [createUserMessage('hello')]
    const queued: QueuedMessage[] = [{ text: 'hello', enqueuedAt: 1, persistedMessage: messages[0] }]

    expect(visibleTranscriptMessages(messages, queued, false)).toBe(messages)
  })
})
