import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { executePiCoreLoop } from '@/agent/loop/pi-core-runner'

const stream = vi.hoisted(() => vi.fn())
const tools = vi.hoisted(() => ({ current: [] as unknown[] }))
vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  streamSimple: stream,
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: { getState: () => ({ enableThinking: false }) },
}))
vi.mock('../loop/build-agent-tools', () => ({ buildAgentTools: () => tools.current }))

function response(content: unknown[], stopReason = 'stop') {
  const message = {
    role: 'assistant',
    content,
    stopReason,
    ...(stopReason === 'error' ? { errorMessage: 'provider failed' } : {}),
    api: 'openai-completions',
    provider: 'openai',
    model: 'm',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', message }
    },
    result: async () => message,
  }
}

function input(signal: AbortSignal, maxIterations = 20) {
  return {
    signal,
    initialMessages: [{ id: 'u', role: 'user' as const, content: 'hello', timestamp: 1 }],
    callbacks: {},
    baseSystemPrompt: 'sys',
    mode: 'act' as const,
    toolRegistry: {} as never,
    getToolContext: () => ({ directoryHandle: null }),
    provider: {
      getModel: () => ({ api: 'openai-completions', provider: 'openai', id: 'm', maxTokens: 1024 }),
      getApiKey: () => 'k',
      maxContextTokens: 128000,
      estimateTokens: () => 1,
    } as never,
    contextManager: {
      getConfig: () => ({ systemPrompt: 'sys', maxContextTokens: 128000, reserveTokens: 4096 }),
    } as never,
    toolExecutionTimeout: 30000,
    toolTimeoutExemptions: new Set<string>(),
    maxIterations,
    convertCallCount: 0,
    lastSummaryConvertCall: Number.NEGATIVE_INFINITY,
    compressedMemoryPrefix: 'Earlier:',
    generateContextSummaryWithLLM: async () => ({ summary: null, mode: 'skip' as const }),
  }
}

describe('empty turn recovery through pi-agent-core', () => {
  beforeEach(() => {
    stream.mockReset()
    tools.current = []
  })

  it('retries once with a nudge and does not persist the synthetic user message', async () => {
    let retryMessages: unknown[] = []
    stream
      .mockReturnValueOnce(response([{ type: 'thinking', thinking: 'hmm' }], 'length'))
      .mockImplementationOnce((_model, context) => {
        retryMessages = [...context.messages]
        return response([{ type: 'text', text: 'done' }])
      })
    const result = await executePiCoreLoop(input(new AbortController().signal, 1))
    expect(stream).toHaveBeenCalledTimes(2)
    expect(retryMessages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('previous response was empty'),
    })
    expect(result.allMessages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(result.allMessages.at(-1)?.content).toBe('done')
  })

  it('reports failure after two empty responses', async () => {
    stream.mockReturnValue(response([], 'length'))
    await expect(executePiCoreLoop(input(new AbortController().signal))).rejects.toThrow(
      'empty response after retrying'
    )
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('does not retry a visible response', async () => {
    stream.mockReturnValue(response([{ type: 'text', text: 'partial' }], 'length'))
    await executePiCoreLoop(input(new AbortController().signal))
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('keeps tool results in the retry context without executing the tool again', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'result' }],
      details: {},
    }))
    tools.current = [
      {
        name: 'read',
        label: 'read',
        description: 'read',
        parameters: { type: 'object', properties: {} },
        execute,
      },
    ]
    let retryMessages: AgentMessage[] = []
    stream
      .mockReturnValueOnce(
        response([{ type: 'toolCall', id: 't', name: 'read', arguments: {} }], 'toolUse')
      )
      .mockReturnValueOnce(response([], 'length'))
      .mockImplementationOnce((_model, context) => {
        retryMessages = [...context.messages]
        return response([{ type: 'text', text: 'done' }])
      })
    const result = await executePiCoreLoop(input(new AbortController().signal))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(
      retryMessages.some((message) => message.role === 'toolResult' && message.toolCallId === 't')
    ).toBe(true)
    expect(result.allMessages.at(-1)?.content).toBe('done')
  })

  it('does not retry an aborted response', async () => {
    stream.mockReturnValue(response([], 'aborted'))
    const result = await executePiCoreLoop(input(new AbortController().signal))
    expect(result.allMessages.at(-1)).toMatchObject({ kind: 'aborted', stopReason: 'aborted' })
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('persists provider error state before propagating the failure', async () => {
    stream.mockReturnValue(response([], 'error'))
    const onMessagesUpdated = vi.fn()
    await expect(
      executePiCoreLoop({
        ...input(new AbortController().signal),
        callbacks: { onMessagesUpdated },
      })
    ).rejects.toThrow('provider failed')
    expect(onMessagesUpdated).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ kind: 'error', stopReason: 'error' })])
    )
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('retries a later empty turn after a successful tool call', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'result' }],
      details: {},
    }))
    tools.current = [
      {
        name: 'read',
        label: 'read',
        description: 'read',
        parameters: { type: 'object', properties: {} },
        execute,
      },
    ]
    stream
      .mockReturnValueOnce(response([], 'length'))
      .mockReturnValueOnce(
        response([{ type: 'toolCall', id: 't', name: 'read', arguments: {} }], 'toolUse')
      )
      .mockReturnValueOnce(response([], 'length'))
      .mockReturnValueOnce(response([{ type: 'text', text: 'done' }]))
    const result = await executePiCoreLoop(input(new AbortController().signal))
    expect(result.allMessages.at(-1)?.content).toBe('done')
    expect(stream).toHaveBeenCalledTimes(4)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
