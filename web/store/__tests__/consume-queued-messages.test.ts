import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation, createUserMessage, type Conversation, type Message } from '@/agent/message-types'
import { useConversationRuntimeStore } from '../conversation-runtime.store'
import { consumeQueuedMessages } from '../consume-queued-messages'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const conversationId = 'batch-consumer-test'

function setup(initialMessages: Message[] = []) {
  let conversation: Conversation = { ...createConversation('batch-consumer-test'), id: conversationId, status: 'idle', messages: initialMessages }
  const updateMessages = vi.fn((messages: Message[]) => {
    conversation = { ...conversation, messages }
  })
  const runAgent = vi.fn(async () => {})
  const consume = () => consumeQueuedMessages({
    conversationId,
    providerType: 'openai',
    modelName: 'test-model',
    maxTokens: 2048,
    getConversation: () => conversation,
    updateMessages,
    runAgent,
  })
  return { consume, updateMessages, runAgent, getMessages: () => conversation.messages }
}

describe('consumeQueuedMessages', () => {
  beforeEach(() => useConversationRuntimeStore.getState().clearQueue(conversationId))

  it('keeps separate user records but starts only one agent turn for a batch', async () => {
    const { consume, updateMessages, runAgent, getMessages } = setup()
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'first', enqueuedAt: 1 })
    runtime.enqueueMessage(conversationId, { text: 'second', enqueuedAt: 2 })
    await consume()
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    expect(getMessages().map((message) => message.content)).toEqual(['first', 'second'])
    expect(new Set(getMessages().map((message) => message.id)).size).toBe(2)
    expect(updateMessages).toHaveBeenCalledTimes(1)
    expect(runtime.getQueueDepth(conversationId)).toBe(0)
  })

  it('reuses persisted identity, applies edits and folds rerun triggers without blank messages', async () => {
    const persisted = createUserMessage('old text')
    const { consume, runAgent, getMessages, updateMessages } = setup([persisted])
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'edited text', enqueuedAt: 1, persistedMessage: persisted })
    runtime.enqueueMessage(conversationId, { text: '', enqueuedAt: 2, rerunOnly: true })
    runtime.enqueueMessage(conversationId, { text: 'another', enqueuedAt: 3 })
    await consume()
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    expect(getMessages().map((message) => message.content)).toEqual(['edited text', 'another'])
    expect(getMessages()[0].id).toBe(persisted.id)
    expect(getMessages()[0].timestamp).toBe(persisted.timestamp)
    expect(updateMessages).toHaveBeenCalledTimes(1)
  })

  it('does not consume an MCP continuation as a normal queued user message', () => {
    const { runAgent } = setup()
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'result', enqueuedAt: 1, mcpTaskId: 'task-1' })
    // The continuation import is mocked in the dedicated MCP task tests; this
    // case only verifies the batch selector's barrier without invoking it.
    expect(runtime.dequeueBatch(conversationId)).toBeNull()
    expect(runtime.getQueueDepth(conversationId)).toBe(1)
    expect(runAgent).not.toHaveBeenCalled()
  })
})
