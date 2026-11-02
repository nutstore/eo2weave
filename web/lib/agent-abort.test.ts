/**
 * Tests for agent abort-reason utilities and the reasoned abort chain:
 * - AgentLoop.cancel() attaches a semantic agent-cancelled reason to the signal
 * - isExpectedAgentAbort recognizes only our own prefixed AbortErrors
 * - the unhandledrejection filter suppresses only our own prefix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AGENT_ABORT_PREFIX,
  AgentAbortReasonName,
  createAgentAbortReason,
  isExpectedAgentAbort,
  installAgentAbortRejectionFilter,
  registerAgentAbortError,
} from '@/lib/agent-abort'
import { AgentLoop } from '@/agent/agent-loop'
import type { Message } from '@/agent/message-types'
import type { ToolContext } from '@/agent/tools/tool-types'

describe('createAgentAbortReason', () => {
  it('creates an AbortError DOMException with the agent-cancelled prefix', () => {
    const reason = createAgentAbortReason(AgentAbortReasonName.ByUser)
    expect(reason).toBeInstanceOf(DOMException)
    expect(reason.name).toBe('AbortError')
    expect(reason.message).toBe('agent-cancelled-by-user')
    expect(reason.message.startsWith(AGENT_ABORT_PREFIX)).toBe(true)
  })

  it('supports every semantic reason name, mapping it verbatim to the message', () => {
    for (const name of Object.values(AgentAbortReasonName)) {
      const reason = createAgentAbortReason(name)
      expect(reason.name).toBe('AbortError')
      expect(reason.message).toBe(name) // exact, not just prefixed
      expect(reason.message.startsWith(AGENT_ABORT_PREFIX)).toBe(true)
    }
  })
})

describe('isExpectedAgentAbort', () => {
  it('returns true for our own agent-cancelled reasons', () => {
    for (const name of Object.values(AgentAbortReasonName)) {
      expect(isExpectedAgentAbort(createAgentAbortReason(name))).toBe(true)
    }
  })

  it('returns false for AbortErrors without the agent-cancelled prefix', () => {
    expect(isExpectedAgentAbort(new DOMException('signal is aborted without reason', 'AbortError'))).toBe(false)
    expect(isExpectedAgentAbort(new DOMException('The operation was aborted. TimeoutError', 'AbortError'))).toBe(false)
    expect(isExpectedAgentAbort(new DOMException('agent-cancelled-by-user', 'TimeoutError'))).toBe(false)
    expect(isExpectedAgentAbort(new Error('agent-cancelled-by-user'))).toBe(false)
    expect(isExpectedAgentAbort('agent-cancelled-by-user')).toBe(false)
    expect(isExpectedAgentAbort(undefined)).toBe(false)
  })

  it('rejects a foreign AbortError that merely copies the agent-cancelled prefix', () => {
    // Ownership is decided by the module's WeakSet of minted reasons, not by
    // the message alone — a hostile/foreign subsystem minting the same prefix
    // must still surface.
    const foreign = new DOMException(`${AGENT_ABORT_PREFIX}: fake`, 'AbortError')
    expect(isExpectedAgentAbort(foreign)).toBe(false)
  })

  it('recognizes fallback AbortErrors registered via registerAgentAbortError', () => {
    const registered = registerAgentAbortError(new DOMException(AGENT_ABORT_PREFIX, 'AbortError'))
    expect(isExpectedAgentAbort(registered)).toBe(true)
  })
})

describe('AgentLoop reasoned aborts', () => {
  function createLoop(): AgentLoop {
    const provider = {
      name: 'mock',
      maxContextTokens: 128000,
      getModel: vi.fn(() => ({ id: 'mock-model', provider: 'mock', api: 'openai-completions' })),
      getApiKey: vi.fn(() => 'key'),
      estimateTokens: vi.fn(() => 1),
    } as any
    const toolRegistry = {
      getToolDefinitions: vi.fn(() => []),
      getToolDefinitionsForMode: vi.fn(() => []),
    } as any
    const contextManager = {
      setSystemPrompt: vi.fn(),
      getSystemPrompt: vi.fn(() => ''),
      trimToTokenWindow: vi.fn((m: Message[]) => m),
    } as any
    const toolContext = { sessionId: 'test-session' } as unknown as ToolContext
    return new AgentLoop({ provider, toolRegistry, contextManager, toolContext })
  }

  it('cancel() attaches a semantic agent-cancelled-by-user reason to the signal', () => {
    const loop = createLoop()
    // Reach into the loop's AbortController the same way run() creates it.
    const controller = new AbortController()
    ;(loop as unknown as { abortController: AbortController | null }).abortController = controller

    loop.cancel()

    expect(controller.signal.aborted).toBe(true)
    const reason = controller.signal.reason as DOMException
    expect(reason).toBeInstanceOf(DOMException)
    expect(reason.name).toBe('AbortError')
    expect(reason.message).toBe('agent-cancelled-by-user')
  })

  it('reason strings always carry the agent-cancelled prefix', () => {
    const loop = createLoop()
    const controller = new AbortController()
    ;(loop as unknown as { abortController: AbortController | null }).abortController = controller

    loop.cancel()
    expect((controller.signal.reason as DOMException).message.startsWith(AGENT_ABORT_PREFIX)).toBe(true)
  })
})

describe('installAgentAbortRejectionFilter', () => {
  // happy-dom doesn't propagate preventDefault() to `defaultPrevented` for
  // synthetic non-cancelable events, so track the call instead.
  let prevented = false

  function dispatchUnhandledRejection(reason: unknown): void {
    prevented = false
    const event = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(event, 'reason', { value: reason })
    Object.defineProperty(event, 'promise', { value: Promise.resolve() })
    const original = event.preventDefault.bind(event)
    event.preventDefault = () => { original(); prevented = true }
    window.dispatchEvent(event)
  }

  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    installAgentAbortRejectionFilter(window)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('suppresses (preventDefault) rejections carrying our agent-cancelled AbortError', () => {
    dispatchUnhandledRejection(createAgentAbortReason(AgentAbortReasonName.ByUser))
    expect(prevented).toBe(true)
  })

  it('suppresses all our semantic reasons', () => {
    for (const name of Object.values(AgentAbortReasonName)) {
      dispatchUnhandledRejection(createAgentAbortReason(name))
      expect(prevented).toBe(true)
    }
  })

  it('lets foreign AbortErrors surface (no preventDefault)', () => {
    dispatchUnhandledRejection(new DOMException('signal is aborted without reason', 'AbortError'))
    expect(prevented).toBe(false)
    dispatchUnhandledRejection(new DOMException('The operation was aborted.', 'AbortError'))
    expect(prevented).toBe(false)
  })

  it('lets non-abort errors surface', () => {
    dispatchUnhandledRejection(new Error('boom'))
    expect(prevented).toBe(false)
    dispatchUnhandledRejection(undefined)
    expect(prevented).toBe(false)
  })

  it('stops propagation for owned aborts but still delivers foreign errors to later listeners', () => {
    // Guards the stopImmediatePropagation() behavior the Next.js dev-overlay
    // suppression relies on: a regression that drops stopImmediatePropagation
    // lets owned aborts reach the overlay; one that stops propagation for
    // everything would silence genuine errors.
    let laterListenerSawEvent = false
    const laterListener = (): void => { laterListenerSawEvent = true }
    window.addEventListener('unhandledrejection', laterListener)
    try {
      dispatchUnhandledRejection(createAgentAbortReason(AgentAbortReasonName.ByUser))
      expect(laterListenerSawEvent).toBe(false)

      dispatchUnhandledRejection(new DOMException('signal is aborted without reason', 'AbortError'))
      expect(laterListenerSawEvent).toBe(true)
    } finally {
      window.removeEventListener('unhandledrejection', laterListener)
    }
  })

  it('installing twice for the same window does not register a second listener', () => {
    // Observe REGISTRATIONS, not deliveries: stopImmediatePropagation masks
    // any duplicate filter before it can run, so delivery- or
    // preventDefault-counting passes even with the dedup guard removed.
    // Wrapping addEventListener on a fresh stub target counts exactly what
    // the installer registers — a removed WeakSet guard registers 2.
    const stub = new EventTarget() as unknown as Window
    const registered: EventListener[] = []
    const originalAdd = stub.addEventListener.bind(stub)
    ;(stub as unknown as { addEventListener: Window['addEventListener'] }).addEventListener = ((
      type: string,
      listener: EventListener,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'unhandledrejection') registered.push(listener)
      return originalAdd(type, listener, options)
    }) as Window['addEventListener']

    installAgentAbortRejectionFilter(stub)
    installAgentAbortRejectionFilter(stub) // second install must be a no-op

    expect(registered.length).toBe(1)
  })
})
