import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

const convId = 'dismiss-test-conv'

describe('dismissConversationError (#370)', () => {
  beforeEach(() => {
    // Fresh runtime entry per test
    useConversationRuntimeStore.getState().resetConversationState(convId)
  })

  it('hides the banner while the same error string is dismissed', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, 'boom')
    expect(useConversationRuntimeStore.getState().runtimes.get(convId)?.dismissedError).toBeNull()

    store.dismissConversationError(convId, 'boom')
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    // The error itself is NOT cleared (the failed turn stays in the transcript);
    // only the dismissed marker is set so the banner hides.
    expect(rt?.error).toBe('boom')
    expect(rt?.dismissedError).toBe('boom')
  })

  it('stores the dismissed string trimmed, so whitespace cannot un-dismiss the banner', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, '  boom  ')
    store.dismissConversationError(convId, '  boom  ')
    expect(useConversationRuntimeStore.getState().runtimes.get(convId)?.dismissedError).toBe('boom')
  })

  it('dismisses a persisted-turn error that has no runtime error behind it', () => {
    const store = useConversationRuntimeStore.getState()
    const noEntryConvId = convId + '-no-entry'
    // After a reload the persisted-turn banner can render before anything else
    // creates the runtime entry, so the dismissal must create it.
    expect(useConversationRuntimeStore.getState().runtimes.has(noEntryConvId)).toBe(false)
    store.dismissConversationError(noEntryConvId, 'The model request failed.')
    const rt = useConversationRuntimeStore.getState().runtimes.get(noEntryConvId)
    expect(rt?.error).toBeNull()
    expect(rt?.dismissedError).toBe('The model request failed.')
  })

  it('shows a fresh banner when a different error arrives after a dismissal', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, 'first failure')
    store.dismissConversationError(convId, 'first failure')
    expect(useConversationRuntimeStore.getState().runtimes.get(convId)?.dismissedError).toBe('first failure')

    store.setConversationError(convId, 'second failure')
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    expect(rt?.error).toBe('second failure')
    expect(rt?.dismissedError).toBeNull()
  })

  it('clears the dismissed marker when the error is cleared', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, 'boom')
    store.dismissConversationError(convId, 'boom')
    store.setConversationError(convId, null)
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    expect(rt?.error).toBeNull()
    expect(rt?.dismissedError).toBeNull()
  })
})
