import { describe, expect, it } from 'vitest'
import { deserializeMessageMetadata, serializeMessageMetadata } from '../message-meta'

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

  it('omits empty metadata', () => {
    expect(serializeMessageMetadata({})).toBeNull()
  })
})
