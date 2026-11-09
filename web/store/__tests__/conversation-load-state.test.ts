import { beforeEach, describe, expect, it } from 'vitest'
import {
  bumpActiveSelectionGeneration,
  bumpTranscriptVersion,
  claimTranscriptRead,
  forgetTranscriptState,
  getActiveSelectionGeneration,
  getTranscriptVersion,
  getTranscriptVersionEntryForTests,
  isCurrentTranscriptRead,
  resetConversationRetryStateForTests,
} from '@/store/conversation-load'

// Pure unit tests for the module-level state the load pipeline owns. The
// store-level behaviour is covered by conversation.store.load-failure.*.test.ts;
// these pin the bookkeeping itself so the maps cannot silently change shape
// (issue #245: the pipeline is testable without driving a load).
describe('conversation-load transcript watermark', () => {
  beforeEach(() => {
    resetConversationRetryStateForTests()
  })

  it('starts with no entry for an unknown conversation', () => {
    expect(getTranscriptVersion('conv-a')).toBeUndefined()
    expect(getTranscriptVersionEntryForTests('conv-a')).toBeUndefined()
  })

  it('bumps per conversation without touching its neighbours', () => {
    bumpTranscriptVersion('conv-a')
    bumpTranscriptVersion('conv-a')
    bumpTranscriptVersion('conv-b')

    expect(getTranscriptVersion('conv-a')).toBe(2)
    expect(getTranscriptVersion('conv-b')).toBe(1)
    expect(getTranscriptVersion('conv-c')).toBeUndefined()
  })

  it('claims monotonically increasing read generations per conversation', () => {
    const first = claimTranscriptRead('conv-a')
    const second = claimTranscriptRead('conv-a')
    const other = claimTranscriptRead('conv-b')

    expect(second).toBe(first + 1)
    expect(other).toBe(first)
    expect(isCurrentTranscriptRead('conv-a', second)).toBe(true)
    expect(isCurrentTranscriptRead('conv-a', first)).toBe(false)
    expect(isCurrentTranscriptRead('conv-b', other)).toBe(true)
  })

  it('forgets both maps when the conversation is deleted', () => {
    bumpTranscriptVersion('conv-a')
    const generation = claimTranscriptRead('conv-a')
    bumpTranscriptVersion('conv-b')

    forgetTranscriptState('conv-a')

    expect(getTranscriptVersion('conv-a')).toBeUndefined()
    expect(isCurrentTranscriptRead('conv-a', generation)).toBe(false)
    // The neighbour survives: deleting one conversation must not reset others.
    expect(getTranscriptVersion('conv-b')).toBe(1)
  })

  it('reset clears every watermark and read generation', () => {
    bumpTranscriptVersion('conv-a')
    const generation = claimTranscriptRead('conv-a')

    resetConversationRetryStateForTests()

    expect(getTranscriptVersion('conv-a')).toBeUndefined()
    expect(isCurrentTranscriptRead('conv-a', generation)).toBe(false)
  })
})

describe('conversation-load active selection generation', () => {
  beforeEach(() => {
    resetConversationRetryStateForTests()
  })

  it('bump returns the new value and the getter reads the same counter', () => {
    const start = getActiveSelectionGeneration()
    const next = bumpActiveSelectionGeneration()

    expect(next).toBe(start + 1)
    expect(getActiveSelectionGeneration()).toBe(next)
    expect(bumpActiveSelectionGeneration()).toBe(next + 1)
  })
})
