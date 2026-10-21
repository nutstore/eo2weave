import { describe, expect, it } from 'vitest'
import { groupMessagesIntoTurns } from '../group-messages'
import { createAssistantMessage, createUserMessage } from '@/agent/message-types'

describe('groupMessagesIntoTurns usage aggregation', () => {
  it('hides runtime updates without splitting assistant output and retains handoff cards', () => {
    const question = createUserMessage('question')
    const first = createAssistantMessage('first')
    const second = createAssistantMessage('second')
    const handoff = { ...createUserMessage('task'), delegationNote: { fromAgentId: 'a', task: 'task' } }
    const turns = groupMessagesIntoTurns([
      question, first, { ...createUserMessage('state'), kind: 'context_update' }, second, handoff,
    ])
    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant', 'user'])
    expect(turns[1]).toMatchObject({ messages: [first, second] })
    expect(turns[2]).toMatchObject({ message: handoff })
  })

  it('uses latest assistant usage for per-message fields and accumulates across the turn', () => {
    const user = createUserMessage('u1')
    const a1 = createAssistantMessage('a1')
    a1.usage = { promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cacheReadTokens: 400 }
    const a2 = createAssistantMessage('a2')
    a2.usage = { promptTokens: 200, completionTokens: 100, totalTokens: 300, cacheReadTokens: 50 }

    const turns = groupMessagesIntoTurns([user, a1, a2])
    const assistantTurn = turns.find((t) => t.type === 'assistant')
    expect(assistantTurn?.type).toBe('assistant')
    if (!assistantTurn || assistantTurn.type !== 'assistant') return

    // Per-message fields reflect the LATEST message only
    expect(assistantTurn.totalUsage).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      cacheReadTokens: 50,
      // Accumulated fields sum across all messages in the turn
      accumulatedPromptTokens: 1400,         // 1200 + 200 (non-cache input)
      accumulatedCacheTokens: 450,            // 400 + 50
      accumulatedCompletionTokens: 400,       // 300 + 100
    })
  })
})

