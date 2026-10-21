import { describe, expect, it } from 'vitest'
import {
  getMessageRecordType, isConversationUserMessage, isHumanUserMessage, type Message,
} from '@/agent/message-types'
import { selectConversationExportMessages, selectConversationTranscript } from '@/agent/message-projections'

const record = (id: string, fields: Partial<Message> = {}): Message => ({
  id, role: 'user', content: id, timestamp: 1, ...fields,
})

const history = [
  record('system', { role: 'system' }),
  record('question', { contentParts: [{ type: 'text', text: 'question' }, { type: 'image', data: 'base64', mimeType: 'image/png' }] }),
  record('context', { kind: 'context_update' }),
  record('delegation', { delegationNote: { fromAgentId: 'a', task: 'task' } }),
  record('image', { readImageHandoff: { path: '/image.png', mimeType: 'image/png', ocrStatus: 'done' } }),
  record('tool', { role: 'tool', toolCallId: 'call' }),
  record('answer', { role: 'assistant' }),
  record('changes', { role: 'assistant', kind: 'run_changes', runChanges: { snapshotId: 'snapshot' } }),
  record('summary', { kind: 'context_summary' }),
]

describe('application message identity and projections', () => {
  it('distinguishes record identity from transport role, including legacy records', () => {
    expect(history.map(getMessageRecordType)).toEqual([
      'system', 'user_input', 'context_update', 'agent_input', 'agent_input',
      'tool_result', 'assistant_output', 'run_changes', 'context_summary',
    ])
    expect(history.filter(isHumanUserMessage).map(m => m.id)).toEqual(['question'])
    expect(history.filter(isConversationUserMessage).map(m => m.id)).toEqual(['question', 'delegation', 'image'])
  })

  it('selects dialogue without mutating audit history or flattening multimodal parts', () => {
    const original = JSON.stringify(history)
    const transcript = selectConversationTranscript(history)
    expect(transcript.map(m => m.id)).toEqual(['question', 'answer'])
    expect(transcript[0]).toBe(history[1])
    expect(transcript[0].contentParts).toHaveLength(2)
    expect(JSON.stringify(history)).toBe(original)
  })

  it('keeps execution records in readable exports but never includes runtime patches', () => {
    expect(selectConversationExportMessages(history).map(m => m.id)).toEqual([
      'question', 'delegation', 'image', 'tool', 'answer', 'changes', 'summary',
    ])
    expect(selectConversationExportMessages(history, {
      includeSystemMessages: true, includeToolCalls: false,
    }).map(m => m.id)).toEqual(['system', 'question', 'delegation', 'image', 'answer', 'changes', 'summary'])
  })
})
