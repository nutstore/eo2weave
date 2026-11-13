import { describe, expect, it } from 'vitest'
import { isViewingConversation } from '../conversation-view'

describe('isViewingConversation', () => {
  it('is true when the active conversation matches and the tab is visible', () => {
    expect(isViewingConversation('conv-1', 'conv-1', 'visible')).toBe(true)
  })

  it('is false for a different conversation', () => {
    expect(isViewingConversation('conv-2', 'conv-1', 'visible')).toBe(false)
  })

  it('is false when the tab is hidden', () => {
    expect(isViewingConversation('conv-1', 'conv-1', 'hidden')).toBe(false)
  })

  it('is false when no conversation is active', () => {
    expect(isViewingConversation(null, 'conv-1', 'visible')).toBe(false)
    expect(isViewingConversation(undefined, 'conv-1', 'visible')).toBe(false)
  })
})
