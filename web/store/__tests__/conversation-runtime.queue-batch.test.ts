import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_QUEUE_BATCH_CHARS,
  MAX_QUEUE_BATCH_SIZE,
  type QueuedMessage,
  useConversationRuntimeStore,
} from '@/store/conversation-runtime.store'

const convId = 'batch-conversation'
const message = (text: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
  text,
  enqueuedAt: 1,
  ...patch,
})

function enqueue(...items: QueuedMessage[]) {
  const store = useConversationRuntimeStore.getState()
  for (const item of items) store.enqueueMessage(convId, item)
}

describe('conversation runtime dequeueBatch', () => {
  beforeEach(() => {
    useConversationRuntimeStore.getState().clearQueue(convId)
  })

  it('returns null for empty queues and MCP heads without removing entries', () => {
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toBeNull()
    const mcp = message('mcp', { mcpTaskId: 'task' })
    const next = message('next')
    enqueue(mcp, next)
    expect(store.dequeueBatch(convId)).toBeNull()
    expect(store.getQueueDepth(convId)).toBe(2)
    expect(store.dequeueMessage(convId)).toEqual(mcp)
    expect(store.dequeueBatch(convId)).toEqual({ messages: [next], rerunOnly: false, consumed: 1 })
  })

  it('groups equivalent agent overrides and background flags, preserving all message fields', () => {
    const first = message('one', { assets: [], agentOverrideId: null })
    const second = message('two', { agentOverrideId: undefined, background: false, ownerToken: 'owner' })
    const otherAgent = message('three', { agentOverrideId: 'agent' })
    enqueue(first, second, otherAgent)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [first, second], rerunOnly: false, consumed: 2 })
    expect(store.getQueuedMessage(convId, 0)).toEqual(otherAgent)
    expect(store.dequeueBatch(convId)).toEqual({ messages: [otherAgent], rerunOnly: false, consumed: 1 })
    expect(store.getQueueDepth(convId)).toBe(0)
  })

  it('stops at background or MCP boundaries without skipping later entries', () => {
    const foreground = message('foreground', { agentOverrideId: 'agent' })
    const background = message('background', { agentOverrideId: 'agent', background: true })
    const mcp = message('mcp', { mcpTaskId: 'task' })
    const tail = message('tail', { agentOverrideId: 'agent', background: true })
    enqueue(foreground, background, mcp, tail)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [foreground], rerunOnly: false, consumed: 1 })
    expect(store.dequeueBatch(convId)).toEqual({ messages: [background], rerunOnly: false, consumed: 1 })
    expect(store.dequeueBatch(convId)).toBeNull()
    expect(store.getQueuedMessage(convId, 0)).toEqual(mcp)
    expect(store.getQueuedMessage(convId, 1)).toEqual(tail)
  })

  it('folds only matching rerun triggers, including a trigger-only batch', () => {
    const trigger = message('', { rerunOnly: true, agentOverrideId: 'agent' })
    const actual = message('actual', { agentOverrideId: 'agent' })
    const folded = message('', { rerunOnly: true, agentOverrideId: 'agent' })
    const different = message('', { rerunOnly: true, agentOverrideId: 'agent', background: true })
    enqueue(trigger, actual, folded, different)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [actual], rerunOnly: true, consumed: 3 })
    expect(store.dequeueBatch(convId)).toEqual({ messages: [], rerunOnly: true, consumed: 1 })
  })

  it('counts triggers against the ten-entry limit and leaves the rest queued', () => {
    const triggers = Array.from({ length: MAX_QUEUE_BATCH_SIZE - 1 }, () => message('', { rerunOnly: true }))
    const last = message('last')
    const remainder = message('remainder')
    enqueue(...triggers, last, remainder)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [last], rerunOnly: true, consumed: MAX_QUEUE_BATCH_SIZE })
    expect(store.getQueuedMessage(convId, 0)).toEqual(remainder)
    expect(store.dequeueBatch(convId)).toEqual({ messages: [remainder], rerunOnly: false, consumed: 1 })
  })

  it('stops at the character limit, including exact-boundary messages and queued triggers', () => {
    const first = message('a'.repeat(MAX_QUEUE_BATCH_CHARS - 1))
    const exact = message('b')
    const trigger = message('', { rerunOnly: true })
    const overflow = message('c')
    enqueue(first, exact, trigger, overflow)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [first, exact], rerunOnly: true, consumed: 3 })
    expect(store.getQueuedMessage(convId, 0)).toEqual(overflow)
  })

  it('takes the first message even when oversized, but keeps subsequent messages', () => {
    const oversized = message('x'.repeat(MAX_QUEUE_BATCH_CHARS + 1))
    const next = message('next')
    enqueue(oversized, next)
    const store = useConversationRuntimeStore.getState()
    expect(store.dequeueBatch(convId)).toEqual({ messages: [oversized], rerunOnly: false, consumed: 1 })
    expect(store.getQueuedMessage(convId, 0)).toEqual(next)
  })
})
