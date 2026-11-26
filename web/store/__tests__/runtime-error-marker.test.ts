import { describe, expect, it } from 'vitest'
import { createEmptyRuntime } from '@/store/conversation-runtime.store'
import { markRuntimeError, stripRuntimePayload } from '@/store/runtime-error-marker'

describe('markRuntimeError (#370)', () => {
  it('assigns the error and invalidates a dismissal', () => {
    const rt = { error: 'old failure', dismissedError: 'old failure' }
    markRuntimeError(rt, 'old failure')
    expect(rt.error).toBe('old failure')
    expect(rt.dismissedError).toBeNull()
  })

  it('clearing the error also clears the dismissal marker', () => {
    const rt = { error: 'boom', dismissedError: 'boom' }
    markRuntimeError(rt, null)
    expect(rt.error).toBeNull()
    expect(rt.dismissedError).toBeNull()
  })
})

describe('stripRuntimePayload (#370)', () => {
  it('keeps the dismissal marker while releasing the entry payload', () => {
    const rt = createEmptyRuntime()
    rt.status = 'idle'
    rt.error = 'the model request failed'
    rt.dismissedError = 'the model request failed'
    rt.iterationLimitReached = 25
    rt.streamingContent = 'partial answer'
    rt.completedContent = 'a whole assistant turn'
    rt.completedReasoning = 'long reasoning'
    rt.activeToolCalls = [{ id: 'call-1', name: 'read_file', arguments: {} } as never]
    rt.contextWindowUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as never
    rt.collectedAssets = [{ id: 'asset-1' } as never]

    stripRuntimePayload(rt)

    // The marker survives — it is what keeps the evicted conversation's banner closed.
    expect(rt.dismissedError).toBe('the model request failed')
    // The error text itself is released: the persisted turn supplies it again.
    expect(rt.error).toBeNull()
    // The finished run's iteration-limit warning must not resurface on reopen.
    expect(rt.iterationLimitReached).toBeNull()
    expect(rt.status).toBe('idle')
    // Payload is gone, which is the point of eviction.
    expect(rt.streamingContent).toBe('')
    expect(rt.completedContent).toBeNull()
    expect(rt.completedReasoning).toBeNull()
    expect(rt.activeToolCalls).toEqual([])
    expect(rt.contextWindowUsage).toBeNull()
    expect(rt.collectedAssets).toEqual([])
    expect(rt.draftAssistant).toBeNull()
  })
})
