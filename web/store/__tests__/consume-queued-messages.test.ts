import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation, createUserMessage, type Conversation, type Message } from '@/agent/message-types'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { consumeQueuedMessages, messagesForAgentTurn } from '@/store/consume-queued-messages'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/mcp/continue-task', () => ({ continueQueuedMCPTask: vi.fn(async () => {}) }))

import { continueQueuedMCPTask } from '@/mcp/continue-task'

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
  beforeEach(() => {
    useConversationRuntimeStore.getState().clearQueue(conversationId)
    vi.clearAllMocks()
  })

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

  it('keeps pending persisted prompts out of the current batch agent input', async () => {
    const queued = Array.from({ length: 12 }, (_, index) => createUserMessage(`prompt ${index}`))
    const { consume, getMessages, runAgent } = setup(queued)
    const runtime = useConversationRuntimeStore.getState()
    for (const [index, message] of queued.entries()) {
      runtime.enqueueMessage(conversationId, {
        text: message.content ?? '', enqueuedAt: index, persistedMessage: message,
      })
    }
    await consume()
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    expect(runtime.getQueueDepth(conversationId)).toBe(2)
    expect(getMessages()).toHaveLength(12)
    expect(messagesForAgentTurn(conversationId, getMessages()).map((message) => message.id))
      .toEqual(queued.slice(0, 10).map((message) => message.id))
  })

  it('inserts a capped earlier batch before persisted messages waiting for the next turn', async () => {
    const queued = Array.from({ length: 12 }, (_, index) => createUserMessage(`prompt ${index}`))
    const { consume, getMessages, runAgent } = setup(queued.slice(10))
    const runtime = useConversationRuntimeStore.getState()
    for (const [index, message] of queued.entries()) {
      runtime.enqueueMessage(conversationId, {
        text: message.content ?? '', enqueuedAt: index,
        ...(index >= 10 ? { persistedMessage: message } : {}),
      })
    }
    await consume()
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    expect(getMessages().map((message) => message.content))
      .toEqual(queued.map((message) => message.content))
    expect(messagesForAgentTurn(conversationId, getMessages()).map((message) => message.content))
      .toEqual(queued.slice(0, 10).map((message) => message.content))
  })

  it('orders missing and persisted messages by their queue positions', async () => {
    const later = createUserMessage('later')
    const { consume, getMessages, runAgent } = setup([later])
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'earlier', enqueuedAt: 1 })
    runtime.enqueueMessage(conversationId, { text: 'later', enqueuedAt: 2, persistedMessage: later })
    await consume()
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    expect(getMessages().map((message) => message.content)).toEqual(['earlier', 'later'])
    expect(getMessages()[1].id).toBe(later.id)
  })

  it('delivers an MCP queue head without dispatching a normal agent turn', async () => {
    const { consume, runAgent, updateMessages } = setup()
    const runtime = useConversationRuntimeStore.getState()
    runtime.enqueueMessage(conversationId, { text: 'result', enqueuedAt: 1, mcpTaskId: 'task-1' })
    await consume()
    expect(continueQueuedMCPTask).toHaveBeenCalledTimes(1)
    expect(continueQueuedMCPTask).toHaveBeenCalledWith('task-1', 'result')
    expect(runtime.getQueueDepth(conversationId)).toBe(1)
    expect(updateMessages).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })
})
