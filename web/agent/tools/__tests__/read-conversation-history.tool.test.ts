import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readConversationHistoryExecutor } from '../read-conversation-history.tool'
import { isToolAllowedInDirectMode, isToolAllowedInMode } from '@/agent/agent-mode'

const { findByConversation } = vi.hoisted(() => ({ findByConversation: vi.fn() }))
vi.mock('@/sqlite/repositories/message.repository', () => ({
  getMessageRepository: () => ({ findByConversation }),
}))
const context = { directoryHandle: null, workspaceId: 'current-chat', directMode: true }
const read = async (args: Record<string, unknown> = {}) => JSON.parse(await readConversationHistoryExecutor(args, context))

describe('read_conversation_history', () => {
  beforeEach(() => { findByConversation.mockReset(); findByConversation.mockResolvedValue([]) })

  it('reads only the current conversation and preserves full tool metadata', async () => {
    findByConversation.mockResolvedValue([{ id: 'call', role: 'assistant', timestamp: 1, content: null,
      toolCalls: [{ id: 'tc', type: 'function', function: { name: 'create_conversation', arguments: '{"projectId":"proj-important"}' } }] },
      { id: 'result', role: 'tool', timestamp: 2, name: 'create_conversation', toolCallId: 'tc', content: '{"conversationId":"chat-created"}' }])
    const result = await read({ conversation_id: 'other-chat' })
    expect(findByConversation).toHaveBeenCalledWith('current-chat')
    expect(result.ok).toBe(true)
    const records = result.data.records.map((record: { text: string }) => JSON.parse(record.text))
    expect(records[0].toolCalls[0].function.arguments).toContain('proj-important')
    expect(records[1]).toMatchObject({ toolCallId: 'tc', content: '{"conversationId":"chat-created"}' })
  })

  it('can page through a long message without losing its trailing constraint', async () => {
    findByConversation.mockResolvedValue([{ id: 'long', role: 'user', timestamp: 1, content: 'x'.repeat(3500) + 'MUST_KEEP_SUFFIX' }])
    let cursor: string | undefined
    let reconstructed = ''
    do {
      const result = await read({ max_chars: 1000, cursor })
      reconstructed += result.data.records.map((record: { text: string }) => record.text).join('')
      cursor = result.data.nextCursor ?? undefined
    } while (cursor)
    expect(JSON.parse(reconstructed).content).toBe('x'.repeat(3500) + 'MUST_KEEP_SUFFIX')
  })

  it('locates an old source message by ID or keyword and excludes runtime catalogs', async () => {
    findByConversation.mockResolvedValue([
      { id: 'catalog', role: 'user', kind: 'context_update', content: 'secret target', timestamp: 1 },
      { id: 'u', role: 'user', content: 'target project', timestamp: 2, pageContext: { selectedText: 'original selected requirement' } },
      { id: 'a', role: 'assistant', content: 'done', timestamp: 3 },
    ])
    expect((await read({ query: 'target' })).data.records.map((record: { id: string }) => record.id)).toEqual(['u'])
    expect((await read({ message_id: 'a' })).data.records.map((record: { id: string }) => record.id)).toEqual(['a'])
    expect(JSON.parse((await read({ message_id: 'u' })).data.records[0].text).pageContext.selectedText).toBe('original selected requirement')
  })

  it('is available without file access in both direct and plan modes', () => {
    expect(isToolAllowedInDirectMode('read_conversation_history')).toBe(true)
    expect(isToolAllowedInMode('read_conversation_history', 'plan')).toBe(true)
  })

  it('rejects a missing conversation context without accessing storage', async () => {
    const result = JSON.parse(await readConversationHistoryExecutor({}, { directoryHandle: null }))
    expect(result.ok).toBe(false)
    expect(findByConversation).not.toHaveBeenCalled()
  })

  it('recovers child source messages from the runtime-bound transcript without reading the parent', async () => {
    const readHistory = vi.fn(async () => [{ id: 'child-result', role: 'tool' as const, toolCallId: 'child-call',
      name: 'read', content: 'exact child evidence', timestamp: 1 }])
    const result = JSON.parse(await readConversationHistoryExecutor({ message_id: 'child-result', conversation_id: 'other-chat' }, {
      ...context, isSubagent: true, conversationHistory: { id: 'child-agent', read: readHistory },
    }))
    expect(result.data.conversationId).toBe('child-agent')
    expect(JSON.parse(result.data.records[0].text)).toMatchObject({ id: 'child-result', content: 'exact child evidence' })
    expect(readHistory).toHaveBeenCalledOnce()
    expect(findByConversation).not.toHaveBeenCalled()
  })

  it('does not query the parent when a child lacks a bound transcript', async () => {
    const result = JSON.parse(await readConversationHistoryExecutor({}, { ...context, isSubagent: true }))
    expect(result.ok).toBe(false)
    expect(findByConversation).not.toHaveBeenCalled()
  })
})
