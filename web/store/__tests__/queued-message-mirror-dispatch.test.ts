import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@/agent/message-types'
import { useConversationRuntimeStore } from '../conversation-runtime.store'
import { setQueuedMessageMirror, type QueuedMessageMirror } from '../queued-message-mirror-slot'

const conversationId = 'queue-mirror-dispatch'

function fakeMirror(): QueuedMessageMirror {
  return { remove: vi.fn(), replace: vi.fn() }
}

describe('queued message transcript mirror dispatch', () => {
  let mirror: QueuedMessageMirror

  beforeEach(() => {
    mirror = fakeMirror()
    setQueuedMessageMirror(mirror)
    useConversationRuntimeStore.setState({ pendingMessageQueues: new Map() })
  })

  afterEach(() => {
    setQueuedMessageMirror(null)
    useConversationRuntimeStore.setState({ pendingMessageQueues: new Map() })
  })

  it('drops the transcript record of a discarded app-tool prompt', () => {
    const persisted = createUserMessage('queued prompt')
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'queued prompt', enqueuedAt: 1, persistedMessage: persisted })

    runtime.removeQueuedMessage(conversationId, 0)

    expect(mirror.remove).toHaveBeenCalledWith(conversationId, persisted.id)
    expect(runtime.getQueueDepth(conversationId)).toBe(0)
  })

  it('never mirrors an entry the queue alone owns', () => {
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'typed while busy', enqueuedAt: 1 })

    runtime.updateQueuedMessage(conversationId, 0, { text: 'edited' })
    runtime.removeQueuedMessage(conversationId, 0)

    expect(runtime.getQueueDepth(conversationId)).toBe(0)
    expect(mirror.remove).not.toHaveBeenCalled()
    expect(mirror.replace).not.toHaveBeenCalled()
  })

  it('mirrors an edit onto the persisted message identity', () => {
    const persisted = createUserMessage('enqueue-time text')
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'enqueue-time text', enqueuedAt: 1, persistedMessage: persisted })

    runtime.updateQueuedMessage(conversationId, 0, { text: 'edited text' })

    expect(runtime.getQueuedMessage(conversationId, 0)?.text).toBe('edited text')
    expect(mirror.replace).toHaveBeenCalledWith(conversationId, {
      ...persisted,
      content: 'edited text',
      assets: persisted.assets,
    })
  })

  it('does nothing for a stale queue index', () => {
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'kept', enqueuedAt: 1 })

    runtime.removeQueuedMessage(conversationId, 3)

    expect(runtime.getQueueDepth(conversationId)).toBe(1)
    expect(mirror.remove).not.toHaveBeenCalled()
  })
})
