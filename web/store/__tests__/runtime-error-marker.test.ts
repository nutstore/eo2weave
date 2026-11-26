import { describe, expect, it } from 'vitest'
import { markRuntimeError } from '@/store/runtime-error-marker'

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
