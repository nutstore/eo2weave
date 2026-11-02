/**
 * Regression test for the Sourcery "earlier run cancels newer run" finding:
 * run() captures its own controller locally so a finished run's teardown
 * neither aborts a newer run's signal nor nulls the newer controller.
 */
import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '@/agent/agent-loop'
import type { Message } from '@/agent/message-types'
import type { ToolContext } from '@/agent/tools/tool-types'
import type { ChatMessage } from '@/agent/llm/llm-provider'
import { PiAIProvider } from '@/agent/llm/pi-ai-provider'
import { AgentAbortReasonName } from '@/lib/agent-abort'

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: vi.fn(() => ({
    getEnhancedSystemPrompt: vi.fn((prompt: string) => prompt),
  })),
}))

vi.mock('@/agent/intelligence-coordinator', () => ({
  getIntelligenceCoordinator: vi.fn(() => ({
    enhanceSystemPrompt: vi.fn((prompt: string) => Promise.resolve({ systemPrompt: prompt })),
  })),
}))

vi.mock('@/mcp', () => ({
  getMCPManager: vi.fn(() => ({
    initialize: vi.fn(() => Promise.resolve()),
  })),
}))

vi.mock('@/agent/prefetch', () => ({
  triggerPrefetch: vi.fn(() => Promise.resolve()),
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  agentLoopContinue: vi.fn(),
}))

// Minimal Pi-loop stub: the FIRST run hangs on a deferred gate (stays in
// flight), the SECOND run hangs on its own gate so it is still in flight when
// run #1's teardown executes, and later runs finish immediately.
const firstRunGate: { resolve: () => void; promise: Promise<void> } = (() => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { resolve, promise }
})()
const secondRunGate: { resolve: () => void; promise: Promise<void> } = (() => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { resolve, promise }
})()
let runCount = 0

const mockAgentLoopContinue = vi.mocked(
  (await import('@earendil-works/pi-agent-core')).agentLoopContinue,
) as any
mockAgentLoopContinue.mockImplementation(() => {
  runCount += 1
  const gate = runCount === 1 ? firstRunGate.promise : runCount === 2 ? secondRunGate.promise : Promise.resolve()
  return (async function* () {
    await gate
    yield {
      type: 'message_start',
      message: { role: 'assistant', content: [], usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() },
    }
    yield {
      type: 'message_end',
      message: { role: 'assistant', content: [], usage: { input: 1, output: 1, totalTokens: 2 }, timestamp: Date.now() },
    }
  })()
})

function createMockProvider(): PiAIProvider {
  const provider = Object.create(PiAIProvider.prototype) as any
  provider.name = 'mock'
  provider.maxContextTokens = 128000
  provider.getModel = vi.fn(() => ({
    api: 'openai-completions',
    provider: 'mock-provider',
    id: 'mock-model',
    maxTokens: 4096,
  }))
  provider.getApiKey = vi.fn(() => 'test-key')
  provider.chat = vi.fn()
  provider.chatStream = vi.fn()
  provider.estimateTokens = vi.fn(() => 1)
  return provider
}

function createUserMessage(content: string): Message {
  return { id: `msg-${content}`, timestamp: Date.now(), role: 'user', content }
}

describe('AgentLoop.run teardown isolation', () => {
  it('a finished first run does not abort or orphan a newer concurrent run', async () => {
    const loop = new AgentLoop({
      provider: createMockProvider(),
      toolRegistry: {
        getToolDefinitions: vi.fn(() => []),
        getToolDefinitionsForMode: vi.fn(() => []),
      } as any,
      contextManager: {
        trimMessages: vi.fn((msgs: ChatMessage[]) => ({ messages: msgs, wasTruncated: false, droppedGroups: 0 })),
        setSystemPrompt: vi.fn(),
        getConfig: vi.fn(() => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 })),
      } as any,
      toolContext: { directoryHandle: null } as ToolContext,
      skipEnhancements: true,
    })

    const internals = loop as unknown as { abortController: AbortController | null }

    // First run goes in-flight; second run replaces abortController before the
    // first finishes (agents can race via flow engine + WebMCP background runs).
    const first = loop.run([createUserMessage('first')])
    const second = loop.run([createUserMessage('second')])

    const secondController = internals.abortController
    expect(secondController).not.toBeNull()
    expect(secondController!.signal.aborted).toBe(false)

    // Let the first run's teardown execute while the second is still in flight.
    firstRunGate.resolve()
    await first

    // The newer run's controller must NOT have been aborted by the first run's
    // lifecycle teardown, and must NOT have been nulled out.
    expect(internals.abortController).toBe(secondController)
    expect(secondController!.signal.aborted).toBe(false)

    // The second run still completes normally afterwards.
    secondRunGate.resolve()
    await second
    expect(internals.abortController).toBeNull()
  })

  it('teardown still aborts the controller when the run is the latest one', async () => {
    const loop = new AgentLoop({
      provider: createMockProvider(),
      toolRegistry: {
        getToolDefinitions: vi.fn(() => []),
        getToolDefinitionsForMode: vi.fn(() => []),
      } as any,
      contextManager: {
        trimMessages: vi.fn((msgs: ChatMessage[]) => ({ messages: msgs, wasTruncated: false, droppedGroups: 0 })),
        setSystemPrompt: vi.fn(),
        getConfig: vi.fn(() => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 })),
      } as any,
      toolContext: { directoryHandle: null } as ToolContext,
      skipEnhancements: true,
    })

    const internals = loop as unknown as { abortController: AbortController | null }
    const run = loop.run([createUserMessage('solo')])
    const controller = internals.abortController!
    await run
    // Normal path: the run's own controller was aborted for queue cleanup and cleared.
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBeInstanceOf(DOMException)
    expect((controller.signal.reason as DOMException).name).toBe('AbortError')
    expect((controller.signal.reason as DOMException).message).toBe(AgentAbortReasonName.LifecycleTeardown)
    expect(internals.abortController).toBeNull()
  })
})
