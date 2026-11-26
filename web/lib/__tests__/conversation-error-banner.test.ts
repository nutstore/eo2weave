import { describe, expect, it } from 'vitest'
import { resolveErrorBanner } from '@/lib/conversation-error-banner'

const none = { conversationError: null, persistedRetryError: null, dismissedError: null }

describe('resolveErrorBanner (#370)', () => {
  it('shows the runtime error when nothing is dismissed', () => {
    expect(resolveErrorBanner({ ...none, conversationError: 'boom' })).toBe('boom')
  })

  it('hides the runtime error while that exact string is dismissed', () => {
    expect(resolveErrorBanner({ ...none, conversationError: 'boom', dismissedError: 'boom' })).toBeNull()
  })

  it('shows a different runtime error after a dismissal', () => {
    expect(resolveErrorBanner({ ...none, conversationError: 'second failure', dismissedError: 'first failure' })).toBe(
      'second failure',
    )
  })

  it('falls back to the persisted turn error when the runtime error is gone', () => {
    expect(resolveErrorBanner({ ...none, persistedRetryError: 'The model request failed.' })).toBe(
      'The model request failed.',
    )
  })

  it('lets a dismissal hide the persisted turn error too', () => {
    expect(
      resolveErrorBanner({
        ...none,
        persistedRetryError: 'The model request failed.',
        dismissedError: 'The model request failed.',
      }),
    ).toBeNull()
  })

  it('ignores surrounding whitespace when comparing the dismissed string', () => {
    expect(resolveErrorBanner({ ...none, conversationError: '  boom  ', dismissedError: 'boom' })).toBeNull()
  })

  it('returns null when there is nothing to show', () => {
    expect(resolveErrorBanner(none)).toBeNull()
  })
})
