import { describe, expect, it } from 'vitest'
import type { Message } from '../message-types'
import {
  applyCompressionBaseline,
  getCompressionCutoffTimestamp,
  restoreCompressionBaseline,
} from '../loop/context-compression'

describe('context-compression helpers', () => {
  it('getCompressionCutoffTimestamp returns just after latest message timestamp', () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'first', timestamp: 10 },
      { id: '2', role: 'assistant', content: 'ok', timestamp: 11 },
      { id: '3', role: 'user', content: 'latest', timestamp: 42 },
      { id: '4', role: 'tool', content: 'result', toolCallId: 'tc1', name: 'read', timestamp: 43 },
    ]
    expect(getCompressionCutoffTimestamp(messages)).toBe(44)
  })

  it('restores explicit checkpoint metadata instead of its display timestamp', () => {
    const baseline = restoreCompressionBaseline([{ id: 'summary', role: 'user', kind: 'context_summary',
      content: 'Checkpoint', timestamp: 999,
      compressionBoundary: { throughMessageId: 'covered', cutoffTimestamp: 12, preservedMessageIds: ['human-task'] } }])
    expect(baseline).toEqual({ summary: 'Checkpoint', throughMessageId: 'covered', cutoffTimestamp: 12, preservedMessageIds: ['human-task'] })
  })

  it('uses the committed boundary rather than timestamps when messages share a millisecond', () => {
    const messages: Message[] = [
      { id: 'old', role: 'user', content: 'old', timestamp: 10 },
      { id: 'new', role: 'user', content: 'new', timestamp: 10 },
    ]
    const result = applyCompressionBaseline(messages, { summary: 'S', cutoffTimestamp: 11, throughMessageId: 'old' }, 'Earlier:')
    expect(result.map(message => message.content)).toEqual(['S', 'new'])
  })

  it('applyCompressionBaseline prepends summary and can return summary-only context', () => {
    const messages: Message[] = [
      { id: '1', role: 'user', content: 'old', timestamp: 10 },
      { id: '2', role: 'assistant', content: 'new', timestamp: 20 },
    ]
    const compressed = applyCompressionBaseline(messages, { summary: 'S', cutoffTimestamp: 21 }, 'Earlier:')

    expect(compressed).toHaveLength(1)
    expect(compressed[0]).toMatchObject({
      role: 'user',
      kind: 'context_summary',
      content: 'S',
      timestamp: 20,
    })
  })
})
