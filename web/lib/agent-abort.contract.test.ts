import { describe, it, expect } from 'vitest'
import {
  AGENT_ABORT_PREFIX,
  createAgentAbortReason,
  isExpectedAgentAbort,
  registerAgentAbortError,
} from '@/lib/agent-abort'

describe('agent-abort reason ownership contract', () => {
  it('prefixed DOMExceptions minted by the module are recognized as expected aborts', () => {
    const reason = createAgentAbortReason('agent-cancelled-by-user')
    expect(isExpectedAgentAbort(reason)).toBe(true)
  })

  it('a foreign AbortError copying the prefix is NOT recognized (WeakSet ownership check)', () => {
    // A hostile/foreign library could mint `new DOMException(AGENT_ABORT_PREFIX + '...', 'AbortError')`.
    // The prefix alone is NOT the contract — isExpectedAgentAbort only trusts
    // errors minted by createAgentAbortReason or registered via
    // registerAgentAbortError, so foreign copies still surface.
    const hostile = new DOMException(`${AGENT_ABORT_PREFIX}: fake`, 'AbortError')
    expect(isExpectedAgentAbort(hostile)).toBe(false)
  })

  it('fallback AbortErrors registered by our own bridges ARE recognized', () => {
    const registered = registerAgentAbortError(new DOMException(AGENT_ABORT_PREFIX, 'AbortError'))
    expect(isExpectedAgentAbort(registered)).toBe(true)
  })

  it('unprefixed aborts and plain errors surface', () => {
    expect(isExpectedAgentAbort(new DOMException('Request aborted', 'AbortError'))).toBe(false)
    expect(isExpectedAgentAbort(new Error('boom'))).toBe(false)
  })
})
