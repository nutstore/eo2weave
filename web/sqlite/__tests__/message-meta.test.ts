import { describe, expect, it } from 'vitest'
import { deserializeMessageMetadata, serializeMessageMetadata } from '@/sqlite/message-meta'

describe('message metadata serialization', () => {
  it('round trips provider failure details and completion state', () => {
    const message = {
      kind: 'error',
      stopReason: 'error',
      errorMessage: 'provider diagnostic',
    } as const
    const metaJson = serializeMessageMetadata(message)

    expect(metaJson).not.toBeNull()
    expect(deserializeMessageMetadata(metaJson)).toEqual(message)
  })

  it('round trips aborted turns so recovery keeps the retry affordance', () => {
    const message = {
      kind: 'aborted',
      stopReason: 'aborted',
    } as const
    const metaJson = serializeMessageMetadata(message)

    expect(metaJson).not.toBeNull()
    expect(deserializeMessageMetadata(metaJson)).toEqual(message)
  })

  it('round trips application completion provenance without classifying it as human input', async () => {
    const { getMessageRecordType, isHumanUserMessage } = await import('@/agent/message-types')
    const meta = deserializeMessageMetadata(serializeMessageMetadata({ subagentCompletion: { eventIds: ['child:attempt'] } }))
    const message = { id: 'notice', role: 'user' as const, content: 'Child done', timestamp: 1, ...meta }
    expect(message.subagentCompletion?.eventIds).toEqual(['child:attempt'])
    expect(getMessageRecordType(message)).toBe('agent_input')
    expect(isHumanUserMessage(message)).toBe(false)
  })

  it('omits empty metadata' , () => {
    expect(serializeMessageMetadata({})).toBeNull()
  })
})
