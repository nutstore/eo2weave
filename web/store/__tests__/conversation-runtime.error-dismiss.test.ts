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

    store.dismissConversationError(convId)
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    // The error itself is NOT cleared (the failed turn stays in the transcript);
    // only the dismissed marker is set so the banner hides.
    expect(rt?.error).toBe('boom')
    expect(rt?.dismissedError).toBe('boom')
  })

  it('shows a fresh banner when a different error arrives after a dismissal', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, 'first failure')
    store.dismissConversationError(convId)
    expect(useConversationRuntimeStore.getState().runtimes.get(convId)?.dismissedError).toBe('first failure')

    store.setConversationError(convId, 'second failure')
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    expect(rt?.error).toBe('second failure')
    expect(rt?.dismissedError).toBeNull()
  })

  it('clears the dismissed marker when the error is cleared', () => {
    const store = useConversationRuntimeStore.getState()
    store.setConversationError(convId, 'boom')
    store.dismissConversationError(convId)
    store.setConversationError(convId, null)
    const rt = useConversationRuntimeStore.getState().runtimes.get(convId)
    expect(rt?.error).toBeNull()
    expect(rt?.dismissedError).toBeNull()
  })
})
