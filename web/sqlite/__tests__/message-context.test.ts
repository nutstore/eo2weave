import { describe, expect, it, vi } from 'vitest'
import { MessageRepository, type MessageRow } from '../repositories/message.repository'
import { reconcileContext } from '@/agent/context/journal'
import { createUserMessage, getMessageRecordType } from '@/agent/message-types'

const db = vi.hoisted(() => ({ execute: vi.fn(async () => {}), queryAll: vi.fn() }))
vi.mock('../sqlite-database', () => ({
  getSQLiteDB: () => db,
  parseJSON: (text: string) => JSON.parse(text),
}))

function rowFromLastInsert(): MessageRow {
  const call = db.execute.mock.calls.at(-1) as unknown as [string, unknown[]]
  const [id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at] = call[1]
  return { id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at } as MessageRow
}

describe('durable model context metadata', () => {
  it('preserves agent-input identity across reloads, including multimodal parts', async () => {
    const repository = new MessageRepository()
    const messages = [
      { ...createUserMessage('delegated task'), delegationNote: { fromAgentId: 'a', task: 'task', reason: 'specialist' } },
      createUserMessage('image', undefined, undefined, {
        readImageHandoff: { path: '/x.png', mimeType: 'image/png', ocrStatus: 'done' },
        contentParts: [{ type: 'text', text: 'image' }, { type: 'image', data: 'base64', mimeType: 'image/png' }],
      }),
    ]
    for (const message of messages) {
      await repository.insert('conversation', message, 0)
      db.queryAll.mockResolvedValueOnce([rowFromLastInsert()])
      const [restored] = await repository.findByConversation('conversation')
      expect(getMessageRecordType(restored)).toBe('agent_input')
      expect(restored).toMatchObject(message)
    }
  })

  it('round trips rendered patches and provenance without re-rendering', async () => {
    const repository = new MessageRepository()
    const snapshot = reconcileContext([], [{ sourceId: 'skills', entries: { a: 'Skill A' } }], 'envelope')!
    const patch = reconcileContext([snapshot], [{ sourceId: 'skills', entries: { a: 'Skill A', b: 'Skill B' } }], 'envelope')!
    await repository.insert('conversation', patch, 1)
    db.queryAll.mockResolvedValueOnce([rowFromLastInsert()])
    const [restored] = await repository.findByConversation('conversation')
    expect(restored.contextCommit).toEqual(patch.contextCommit)
    expect(restored.content).toBe(patch.content)
    expect(reconcileContext([snapshot, restored], [{ sourceId: 'skills', entries: { a: 'Skill A', b: 'Skill B' } }], 'envelope')).toBeUndefined()
  })

  it('preserves page capture delivery and exact compression boundary', async () => {
    const repository = new MessageRepository()
    const message = { ...createUserMessage('this', undefined, { url: 'https://example.com', selectedText: 'A' }),
      compressionBoundary: { throughMessageId: 'previous', cutoffTimestamp: 10 } }
    await repository.insert('conversation', message, 0)
    db.queryAll.mockResolvedValueOnce([rowFromLastInsert()])
    const [restored] = await repository.findByConversation('conversation')
    expect(restored.pageContext).toEqual(message.pageContext)
    expect(restored.pageContextDelivery).toBe('journal')
    expect(restored.compressionBoundary).toEqual(message.compressionBoundary)
  })
})
