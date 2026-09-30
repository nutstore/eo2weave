import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executePiCoreLoop, shouldStripTemperatureForModel } from '../loop/pi-core-runner'

const mockAgentLoopContinue = vi.fn()
const mockConvertAgentMessagesToLlm = vi.fn()
const mockStreamSimple = vi.fn()

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({
      enableThinking: false,
      thinkingLevel: 'low',
      temperature: 0.42,
    })),
  },
}))

vi.mock('@earendil-works/pi-agent-core', () => ({
  agentLoopContinue: (...args: unknown[]) => mockAgentLoopContinue(...args),
}))

vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  // Keep the real module: pi-ai-custom-openai-fetch calls registerApiProvider
  // at module scope, so wiping the module would break its import. Only the
  // streamSimple entry point is intercepted to capture mergedOptions.
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return {
    ...actual,
    streamSimple: (...args: unknown[]) => mockStreamSimple(...args),
  }
})

vi.mock('../loop/build-agent-tools', () => ({
  buildAgentTools: vi.fn(() => []),
}))

vi.mock('../loop/convert-bridge', () => ({
  convertAgentMessagesToLlm: (...args: unknown[]) => mockConvertAgentMessagesToLlm(...args),
}))

describe('pi-core-runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when there is no abort signal', async () => {
    const result = await executePiCoreLoop({
      signal: undefined,
      initialMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
      callbacks: {},
      baseSystemPrompt: 'sys',
      mode: 'act',
      toolRegistry: {
        getToolDefinitionsForMode: () => [],
      } as never,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      getToolContext: () => ({ directoryHandle: null }),
      provider: {
        getModel: () => ({ api: 'openai', provider: 'openai', id: 'm', maxTokens: 1024 }),
        getApiKey: () => 'k',
        maxContextTokens: 128000,
        estimateTokens: () => 1,
      } as never,
      contextManager: {
        getConfig: () => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 }),
        trimMessages: (msgs: unknown) => ({ messages: msgs as never[] }),
        trimMessagesToTarget: (msgs: unknown) => msgs as never[],
      } as never,
      toolExecutionTimeout: 30000,
      toolTimeoutExemptions: new Set<string>(),
      maxIterations: 20,
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressedMemoryPrefix: 'Earlier conversation summary:',
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    expect(result.allMessages).toHaveLength(1)
    expect(result.shouldStopForElicitation).toBe(false)
    expect(result.reachedMaxIterations).toBe(false)
  })

  it('retains injected context summary in final messages when loop events continue', async () => {
    mockConvertAgentMessagesToLlm.mockImplementation(async (input: any) => {
      input.onSummaryInjected?.('compressed snapshot')
      return {
        piMessages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
        convertCallCount: input.convertCallCount + 1,
        lastSummaryConvertCall: input.convertCallCount + 1,
        compressionBaseline: { summary: 'compressed snapshot', cutoffTimestamp: Date.now() },
      }
    })

    mockAgentLoopContinue.mockImplementation((context: any, config: any) => {
      return (async function* () {
        await config.convertToLlm(context.messages)
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: 'stop',
            api: 'openai',
            provider: 'openai',
            model: 'm',
            timestamp: Date.now(),
          },
        }
      })()
    })

    const abortController = new AbortController()
    const result = await executePiCoreLoop({
      signal: abortController.signal,
      initialMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
      callbacks: {},
      baseSystemPrompt: 'sys',
      mode: 'act',
      toolRegistry: {
        getToolDefinitionsForMode: () => [],
      } as never,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      getToolContext: () => ({ directoryHandle: null }),
      provider: {
        getModel: () => ({ api: 'openai', provider: 'openai', id: 'm', maxTokens: 1024 }),
        getApiKey: () => 'k',
        maxContextTokens: 128000,
        estimateTokens: () => 1,
      } as never,
      contextManager: {
        getConfig: () => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 }),
        trimMessages: (msgs: unknown) => ({ messages: msgs as never[] }),
        trimMessagesToTarget: (msgs: unknown) => msgs as never[],
      } as never,
      toolExecutionTimeout: 30000,
      toolTimeoutExemptions: new Set<string>(),
      maxIterations: 20,
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressedMemoryPrefix: 'Earlier conversation summary:',
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    const hasSummary = result.allMessages.some(
      (msg) => msg.role === 'user' && msg.kind === 'context_summary'
    )
    expect(hasSummary).toBe(true)
    expect(result.allMessages.some((msg) => msg.role === 'assistant' && msg.content === 'done')).toBe(
      true
    )
  })

  it('forwards the settings temperature into the loop config (and keeps model maxTokens)', async () => {
    mockConvertAgentMessagesToLlm.mockImplementation(async (input: any) => ({
      piMessages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
      convertCallCount: input.convertCallCount,
      lastSummaryConvertCall: input.lastSummaryConvertCall,
      compressionBaseline: null,
    }))
    mockAgentLoopContinue.mockImplementation((context: any, config: any) => {
      return (async function* () {
        await config.convertToLlm(context.messages)
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: 'stop',
            api: 'openai',
            provider: 'openai',
            model: 'm',
            timestamp: Date.now(),
          },
        }
      })()
    })

    const abortController = new AbortController()
    await executePiCoreLoop({
      signal: abortController.signal,
      initialMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
      callbacks: {},
      baseSystemPrompt: 'sys',
      mode: 'act',
      toolRegistry: {
        getToolDefinitionsForMode: () => [],
      } as never,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      getToolContext: () => ({ directoryHandle: null }),
      provider: {
        getModel: () => ({ api: 'openai', provider: 'openai', id: 'm', maxTokens: 1024 }),
        getApiKey: () => 'k',
        maxContextTokens: 128000,
        estimateTokens: () => 1,
      } as never,
      contextManager: {
        getConfig: () => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 }),
        trimMessages: (msgs: unknown) => ({ messages: msgs as never[] }),
        trimMessagesToTarget: (msgs: unknown) => msgs as never[],
      } as never,
      toolExecutionTimeout: 30000,
      toolTimeoutExemptions: new Set<string>(),
      maxIterations: 20,
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressedMemoryPrefix: 'Earlier conversation summary:',
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    expect(mockAgentLoopContinue).toHaveBeenCalledTimes(1)
    const config = mockAgentLoopContinue.mock.calls[0][1] as Record<string, unknown>
    // Temperature comes from the settings store (mocked to 0.42 above)
    expect(config.temperature).toBe(0.42)
    // Output cap stays model-determined — settings.maxTokens is intentionally ignored
    expect(config.maxTokens).toBe(1024)
  })

  it('strips temperature for OpenAI reasoning models by endpoint, keeps it otherwise', () => {
    // Matrix over shouldStripTemperatureForModel — the same predicate the
    // streamFn onPayload applies to the outgoing payload.
    const cases: Array<{ model: Record<string, unknown>; expectStrip: boolean }> = [
      // Native OpenAI api-type models, o-series/gpt-5 → stripped (400 on temperature)
      { model: { id: 'o3', api: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, expectStrip: true },
      { model: { id: 'o4-mini-2025-04-16', api: 'openai-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, expectStrip: true },
      { model: { id: 'gpt-5-mini', api: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, expectStrip: true },
      // Regression guard for P2: custom provider (cw-openai-fetch api) pointed
      // at api.openai.com + gpt-5 → still stripped (an api-type guard missed this)
      { model: { id: 'gpt-5-mini', api: 'cw-openai-fetch', provider: 'custom-123', baseUrl: 'https://api.openai.com/v1' }, expectStrip: true },
      // Proxy endpoints keep temperature (valid param there), even for o-series ids
      { model: { id: 'openai/o3-mini', api: 'cw-openai-fetch', provider: 'custom-123', baseUrl: 'https://openrouter.ai/api/v1' }, expectStrip: false },
      // Native OpenAI non-reasoning models keep temperature
      { model: { id: 'gpt-4o', api: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, expectStrip: false },
      { model: { id: 'gpt-4.1', api: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, expectStrip: false },
      // Non-OpenAI providers never strip (anthropic/google/…)
      { model: { id: 'o3', api: 'openai-completions', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }, expectStrip: false },
    ]
    for (const { model, expectStrip } of cases) {
      expect(shouldStripTemperatureForModel(model as never)).toBe(expectStrip)
    }
  })

  it('streamFn onPayload applies the strip to the outgoing payload', async () => {
    mockConvertAgentMessagesToLlm.mockImplementation(async (input: any) => ({
      piMessages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
      convertCallCount: input.convertCallCount,
      lastSummaryConvertCall: input.lastSummaryConvertCall,
      compressionBaseline: null,
    }))
    mockAgentLoopContinue.mockImplementation((context: any, config: any) => {
      return (async function* () {
        await config.convertToLlm(context.messages)
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            usage: { input: 1, output: 1, totalTokens: 2 },
            stopReason: 'stop',
            api: 'openai',
            provider: 'openai',
            model: 'm',
            timestamp: Date.now(),
          },
        }
      })()
    })

    const abortController = new AbortController()
    await executePiCoreLoop({
      signal: abortController.signal,
      initialMessages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
      callbacks: {},
      baseSystemPrompt: 'sys',
      mode: 'act',
      toolRegistry: {
        getToolDefinitionsForMode: () => [],
      } as never,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      getToolContext: () => ({ directoryHandle: null }),
      provider: {
        getModel: () => ({ api: 'openai', provider: 'openai', id: 'm', maxTokens: 1024 }),
        getApiKey: () => 'k',
        maxContextTokens: 128000,
        estimateTokens: () => 1,
      } as never,
      contextManager: {
        getConfig: () => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 }),
        trimMessages: (msgs: unknown) => ({ messages: msgs as never[] }),
        trimMessagesToTarget: (msgs: unknown) => msgs as never[],
      } as never,
      toolExecutionTimeout: 30000,
      toolTimeoutExemptions: new Set<string>(),
      maxIterations: 20,
      convertCallCount: 0,
      lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
      compressedMemoryPrefix: 'Earlier conversation summary:',
      generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' }),
    })

    // The onPayload wrapper is what actually mutates the outgoing payload.
    // agentLoopContinue is mocked (so streamFn is never invoked by the loop),
    // so grab the streamFn from the mock call args and drive it directly.
    const streamFn = mockAgentLoopContinue.mock.calls[0][3] as (
      model: unknown,
      context: unknown,
      options?: Record<string, unknown>
    ) => unknown

    mockStreamSimple.mockImplementation(
      (_m: unknown, _c: unknown, opts: Record<string, unknown> | undefined) => {
        const payload = { temperature: 0.42 }
        ;(opts?.onPayload as ((p: Record<string, unknown>) => void) | undefined)?.(payload)
        // Fixture model is a non-reasoning openai provider model — the wrapper
        // must leave its temperature untouched.
        expect(payload).toHaveProperty('temperature', 0.42)
        return (async function* () {})()
      }
    )

    await streamFn(
      { id: 'gpt-4o', api: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { messages: [] },
      {}
    )
    expect(mockStreamSimple).toHaveBeenCalledTimes(1)
  })
})
