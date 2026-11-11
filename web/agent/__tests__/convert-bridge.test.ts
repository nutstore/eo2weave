import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../loop/tool-execution', async () => {
  const actual = await vi.importActual<typeof import('../loop/tool-execution')>(
    '../loop/tool-execution'
  )
  return {
    ...actual,
    ensureLatestToolResultFitsContext: vi.fn(actual.ensureLatestToolResultFitsContext),
  }
})

import { convertAgentMessagesToLlm } from '../loop/convert-bridge'
import { ensureLatestToolResultFitsContext } from '../loop/tool-execution'

describe('convert-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('increments convert call count and returns mapped pi messages', async () => {
    const result = await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'user',
          content: 'hello',
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 128000,
        estimateTokens: vi.fn(() => 1),
      } as never,
      maxContextTokens: 128000,
      reserveTokens: 4096,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    expect(result.convertCallCount).toBe(1)
    expect(result.piMessages).toHaveLength(1)
    expect(result.piMessages[0]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('continues with emergency trim when latest-tool-fit check fails', async () => {
    vi.mocked(ensureLatestToolResultFitsContext).mockImplementation(() => {
      throw new Error('tool result cannot fit')
    })

    const result = await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'user',
          content: 'hello',
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 128000,
        estimateTokens: vi.fn(() => 1),
      } as never,
      maxContextTokens: 128000,
      reserveTokens: 4096,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    expect(result.convertCallCount).toBe(1)
    expect(result.piMessages.length).toBeGreaterThan(0)
  })

  it('starts compression when totalTokens exceeds trigger even when input/output metrics look small', async () => {
    // extractLastTurnUsedTokens prefers `totalTokens` over input + output +
    // cacheRead because that's what the API reports as the authoritative
    // "context already consumed" number.  If `totalTokens` is missing or
    // small but the API under-reported per-message metrics, the total
    // still wins — this guards the auth source of truth.
    const onContextCompressionStart = vi.fn()
    const generateContextSummaryWithLLM = vi.fn(async () => ({
      summary: 'short summary',
      mode: 'llm' as const,
    }))

    await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
          timestamp: Date.now(),
          usage: { input: 100, output: 20, totalTokens: 120000 },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 128000,
        estimateTokens: vi.fn(() => 1),
      } as never,
      maxContextTokens: 128000,
      reserveTokens: 4096,
      callbacks: { onContextCompressionStart },
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    expect(onContextCompressionStart).toHaveBeenCalled()
    expect(generateContextSummaryWithLLM).toHaveBeenCalled()
  })

  it('does not start compression when assistant usage is below 85 percent of model max tokens', async () => {
    const onContextCompressionStart = vi.fn()
    const generateContextSummaryWithLLM = vi.fn(async () => ({
      summary: 'short summary',
      mode: 'llm' as const,
    }))

    await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
          timestamp: Date.now(),
          usage: { input: 700, output: 120 },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 1000,
        estimateTokens: vi.fn(() => 1),
      } as never,
      maxContextTokens: 1000,
      reserveTokens: 100,
      callbacks: { onContextCompressionStart },
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    expect(onContextCompressionStart).not.toHaveBeenCalled()
    expect(generateContextSummaryWithLLM).not.toHaveBeenCalled()
  })

  it('does NOT start compression when usedRealTokens is below trigger even if preTrimTokens is high', async () => {
    // Regression guard: the previous design let the heuristic `preTrimTokens`
    // independently trigger compression.  Real usage from the API is more
    // accurate (counts cache hits, image tokens, etc.) so we now gate
    // compression exclusively on `usedRealTokens`.  A high heuristic must
    // NOT push us into compression if real usage is still under the trigger.
    const onContextCompressionStart = vi.fn()
    const generateContextSummaryWithLLM = vi.fn(async () => ({
      summary: 'short summary',
      mode: 'llm' as const,
    }))

    await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
          timestamp: Date.now(),
          usage: { input: 700, output: 120 },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'continue' }],
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 1000,
        estimateTokens: vi.fn(() => 900),
      } as never,
      maxContextTokens: 1000,
      reserveTokens: 100,
      callbacks: { onContextCompressionStart },
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    expect(onContextCompressionStart).not.toHaveBeenCalled()
    expect(generateContextSummaryWithLLM).not.toHaveBeenCalled()
  })

  it('starts compression when last assistant totalTokens exceeds threshold', async () => {
    const onContextCompressionStart = vi.fn()
    const generateContextSummaryWithLLM = vi.fn(async () => ({
      summary: 'short summary',
      mode: 'llm' as const,
    }))

    await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
          timestamp: Date.now(),
          usage: { input: 700, output: 120, cacheRead: 50, totalTokens: 900 },
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'continue' }],
          timestamp: Date.now(),
        },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: {
        maxContextTokens: 1000,
        estimateTokens: vi.fn(() => 100),
      } as never,
      maxContextTokens: 1000,
      reserveTokens: 100,
      callbacks: { onContextCompressionStart },
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    expect(onContextCompressionStart).toHaveBeenCalled()
    expect(generateContextSummaryWithLLM).toHaveBeenCalled()
  })

  it('retries the summarizer once before giving up (#268)', async () => {
    const generateContextSummaryWithLLM = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ summary: 'retried summary', mode: 'llm' as const })

    const result = await convertAgentMessagesToLlm({
      agentMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'previous answer' }],
          timestamp: 1000,
          usage: { input: 700, output: 120, cacheRead: 50, totalTokens: 900 },
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }], timestamp: 1001 },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: { maxContextTokens: 1000, estimateTokens: vi.fn(() => 100) } as never,
      maxContextTokens: 1000,
      reserveTokens: 100,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    expect(generateContextSummaryWithLLM).toHaveBeenCalledTimes(2)
    expect(result.compressionBaseline?.summary).toBe('retried summary')
  })

  it('keeps the transcript and shrinks oversized old messages when summarization fails twice (#268)', async () => {
    const onContextCompressionComplete = vi.fn()
    const generateContextSummaryWithLLM = vi.fn(async () => {
      throw new Error('The model returned an empty context summary. Please try again.')
    })
    const longAnswer = 'x'.repeat(5000)
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'critical requirement: keep the task' }], timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'text', text: longAnswer }], timestamp: 1001 },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 1002,
        usage: { input: 700, output: 120, cacheRead: 50, totalTokens: 900 } },
      ...Array.from({ length: 7 }, (_, i) => ({
        role: 'user', content: [{ type: 'text', text: `turn ${i}` }], timestamp: 1003 + i,
      })),
    ] as never[]

    const result = await convertAgentMessagesToLlm({
      agentMessages: history,
      model: { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      provider: { maxContextTokens: 1000, estimateTokens: vi.fn(() => 100) } as never,
      maxContextTokens: 1000,
      reserveTokens: 100,
      callbacks: { onContextCompressionComplete },
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      generateContextSummaryWithLLM,
    })

    // The turn runs, no compression baseline is written (history is not replaced),
    // the task statement survives and the bulky tool output was shrunk instead.
    expect(generateContextSummaryWithLLM).toHaveBeenCalledTimes(2)
    expect(result.compressionBaseline).toBeNull()
    const serialized = JSON.stringify(result.piMessages)
    expect(serialized).toContain('critical requirement')
    expect(serialized).toContain('truncated')
    expect(serialized).not.toContain('x'.repeat(4500))
    expect(onContextCompressionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'skip', summary: null })
    )
  })

  it('does not summarise twice on consecutive converts', async () => {
    const summarize = vi.fn(async () => ({ summary: 'SUMMARY_2', mode: 'llm' as const }))
    const result = await convertAgentMessagesToLlm({
      agentMessages: [
        { role: 'user', content: 'earlier question', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], timestamp: 2, usage: { totalTokens: 250_000 } },
        { role: 'user', content: 'follow up', timestamp: 3 },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'big-model' } as never,
      provider: { maxContextTokens: 1_000_000, estimateTokens: vi.fn(() => 1) } as never,
      maxContextTokens: 1_000_000,
      reserveTokens: 32_000,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 3,
      // Counters are the *next* call number: a summary written by call #3 is
      // recorded as lastSummaryConvertCall = 3, and call #4 must wait.
      lastSummaryConvertCall: 3,
      compressionBaseline: { summary: 'SUMMARY_1', cutoffTimestamp: 1 },
      compressionAbsoluteCapEnabled: true,
      compressionAbsoluteCap: 200_000,
      generateContextSummaryWithLLM: summarize,
    } as never)

    expect(summarize).not.toHaveBeenCalled()
    expect(result.compressionBaseline?.summary).toBe('SUMMARY_1')
  })

  it('feeds the previous summary into the next summarisation', async () => {
    const summarize = vi.fn(async (_content: string, _maxTokens: number) => ({
      summary: 'SUMMARY_2',
      mode: 'llm' as const,
    }))
    await convertAgentMessagesToLlm({
      agentMessages: [
        { role: 'assistant', content: [{ type: 'text', text: 'later answer' }], timestamp: 5, usage: { totalTokens: 250_000 } },
        { role: 'user', content: 'newest question', timestamp: 6 },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'big-model' } as never,
      provider: { maxContextTokens: 1_000_000, estimateTokens: vi.fn(() => 1) } as never,
      maxContextTokens: 1_000_000,
      reserveTokens: 32_000,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 10,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: { summary: 'SUMMARY_ONE', cutoffTimestamp: 1 },
      compressionAbsoluteCapEnabled: true,
      compressionAbsoluteCap: 200_000,
      generateContextSummaryWithLLM: summarize,
    } as never)

    expect(summarize).toHaveBeenCalledTimes(1)
    const fed = summarize.mock.calls[0][0]
    expect(fed).toContain('SUMMARY_ONE')
    expect(fed).toContain('newest question')
  })

  it('never summarises on a path that disables it', async () => {
    const summarize = vi.fn(async () => ({ summary: 'nope', mode: 'llm' as const }))
    await convertAgentMessagesToLlm({
      agentMessages: [
        { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2, usage: { totalTokens: 900_000 } },
      ] as never[],
      model: { api: 'openai', provider: 'openai', id: 'big-model' } as never,
      provider: { maxContextTokens: 1_000_000, estimateTokens: vi.fn(() => 1) } as never,
      maxContextTokens: 1_000_000,
      reserveTokens: 32_000,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 1,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      compressionEnabled: false,
      generateContextSummaryWithLLM: summarize,
    } as never)

    expect(summarize).not.toHaveBeenCalled()
  })
  it('triggers on the absolute cap, not the window ratio', async () => {
    // 250K tokens on a 1M window: far below the 85% ratio trigger (850K), above
    // the 200K cap. Only a gate wired to the cap may summarise here.
    const messages = [
      { role: 'user', content: 'long task', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2, usage: { totalTokens: 250_000 } },
      { role: 'user', content: 'next', timestamp: 3 },
    ]
    const summarize = vi.fn(async () => ({ summary: 'CAPPED', mode: 'llm' as const }))

    const capped = await convertAgentMessagesToLlm({
      agentMessages: messages as never[],
      model: { api: 'openai', provider: 'openai', id: 'big-model' } as never,
      provider: { maxContextTokens: 1_000_000, estimateTokens: vi.fn(() => 1) } as never,
      maxContextTokens: 1_000_000,
      reserveTokens: 32_000,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 2,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      compressionAbsoluteCapEnabled: true,
      compressionAbsoluteCap: 200_000,
      generateContextSummaryWithLLM: summarize,
    } as never)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(capped.compressionBaseline?.summary).toBe('CAPPED')

    // Same usage with the cap disabled stays on the ratio gate: no summarising.
    const ratioOnly = await convertAgentMessagesToLlm({
      agentMessages: messages as never[],
      model: { api: 'openai', provider: 'openai', id: 'big-model' } as never,
      provider: { maxContextTokens: 1_000_000, estimateTokens: vi.fn(() => 1) } as never,
      maxContextTokens: 1_000_000,
      reserveTokens: 32_000,
      callbacks: {},
      compressedMemoryPrefix: 'Earlier conversation summary:',
      convertCallCount: 2,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressionBaseline: null,
      compressionAbsoluteCapEnabled: false,
      compressionAbsoluteCap: 200_000,
      generateContextSummaryWithLLM: summarize,
    } as never)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(ratioOnly.compressionBaseline).toBeNull()
  })
})
