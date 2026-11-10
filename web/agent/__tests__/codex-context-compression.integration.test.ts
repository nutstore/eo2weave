import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiAIProvider } from '@/agent/llm/pi-ai-provider'
import { executePiCoreLoop, type ExecutePiCoreLoopInput } from '@/agent/loop/pi-core-runner'
import { generateContextSummaryWithLLM } from '@/agent/loop/context-summary'
import { registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

const tools = vi.hoisted(() => ({ current: [] as unknown[] }))
vi.mock('@/agent/loop/build-agent-tools', () => ({ buildAgentTools: () => tools.current }))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: { getState: () => ({ enableThinking: true, thinkingLevel: 'medium' }) },
}))

function response(text: string, tokens = 100, tool = false): Response {
  const item = tool
    ? { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'read', arguments: '{}' }
    : { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text }] }
  const events = [
    { type: 'response.output_item.added', item },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { status: 'completed', usage: {
      input_tokens: tokens - 10, output_tokens: 10,
      input_tokens_details: { cached_tokens: tokens - 20 }, total_tokens: tokens,
    } } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function setup(): ExecutePiCoreLoopInput {
  registerDynamicProvider('codex-oauth', {
    baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'codex-test', headers: {},
  }, {
    category: 'custom', displayName: 'Codex', models: [{
      id: 'codex-test', name: 'Codex test', contextWindow: 1000, capabilities: ['code', 'reasoning'],
    }],
  })
  const provider = new PiAIProvider({
    providerType: 'codex-oauth', model: 'codex-test',
    baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'test-key',
  })
  return {
    signal: new AbortController().signal,
    initialMessages: [{ id: 'u', role: 'user', content: 'Read the file and continue', timestamp: 1 }],
    baseSystemPrompt: 'Assistant', mode: 'act', toolRegistry: {} as never,
    getToolContext: () => ({ directoryHandle: null }), provider,
    contextManager: { getConfig: () => ({ systemPrompt: 'Assistant', maxContextTokens: 1000, reserveTokens: 100 }) } as never,
    toolExecutionTimeout: 1000, toolTimeoutExemptions: new Set(), maxIterations: 10,
    convertCallCount: 0, lastSummaryConvertCall: -Infinity, compressedMemoryPrefix: 'Memory:',
    generateContextSummaryWithLLM: (droppedContent, maxSummaryTokens) => generateContextSummaryWithLLM({
      provider, droppedContent, maxSummaryTokens, compressedMemoryPrefix: 'Memory:',
    }),
  }
}

describe('Codex context compression through the real Pi loop and Responses parser', () => {
  beforeEach(() => { tools.current = [] })
  afterEach(() => {
    unregisterDynamicProvider('codex-oauth')
    useConversationRuntimeStore.setState({ mountedConversations: new Map() })
    vi.unstubAllGlobals()
  })

  it('compresses between tool calls after the conversation view unmounts', async () => {
    const input = setup()
    const runtime = useConversationRuntimeStore.getState()
    runtime.mountConversation('background-chat')
    tools.current = [{ name: 'read', label: 'Read', description: 'Read', parameters: {
      type: 'object', properties: {},
    }, execute: async () => {
      runtime.unmountConversation('background-chat')
      runtime.mountConversation('other-chat')
      return { content: [{ type: 'text', text: 'File contents' }], details: {} }
    } }]
    let turn = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.instructions.startsWith('You are compressing')) return response('Read the file; continue the task.')
      return ++turn === 1 ? response('', 980, true) : response('Done')
    }))
    const onContextCompressionComplete = vi.fn()
    const result = await executePiCoreLoop({ ...input, callbacks: { onContextCompressionComplete } })
    expect(runtime.isConversationMounted('background-chat')).toBe(false)
    expect(runtime.isConversationMounted('other-chat')).toBe(true)
    expect(onContextCompressionComplete).toHaveBeenCalledOnce()
    expect(result.allMessages.some(message => message.kind === 'context_summary')).toBe(true)
    expect(result.allMessages.at(-1)?.content).toBe('Done')
  })

  it('compresses a resumed conversation whose context is mostly cached tokens', async () => {
    const input = setup()
    input.initialMessages.push({
      id: 'previous', role: 'assistant', content: 'Earlier answer', timestamp: 2,
      usage: { promptTokens: 10, completionTokens: 10, cacheReadTokens: 960, totalTokens: 0 },
    }, { id: 'continue', role: 'user', content: 'Continue', timestamp: 3 })
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      return response(body.instructions.startsWith('You are compressing') ? 'Earlier task summary' : 'Done')
    }))
    const result = await executePiCoreLoop(input)
    expect(result.allMessages.some(message => message.kind === 'context_summary')).toBe(true)
    expect(result.compressionBaseline?.summary).toBe('Earlier task summary')
  })

  it('checks the final response usage on the next request even when the conversation stays in the background', async () => {
    const input = setup()
    useConversationRuntimeStore.getState().mountConversation('other-chat')
    let turn = 0
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.instructions.startsWith('You are compressing')) return response('Earlier task summary')
      return response('Done', ++turn === 1 ? 980 : 100)
    }))
    const onContextCompressionComplete = vi.fn()
    const first = await executePiCoreLoop({ ...input, callbacks: { onContextCompressionComplete } })
    expect(first.allMessages.at(-1)?.usage?.totalTokens).toBe(980)
    expect(onContextCompressionComplete).not.toHaveBeenCalled()

    // A follow-up dispatched off-screen uses the same compression gate as a UI send.
    const second = await executePiCoreLoop({
      ...input, callbacks: { onContextCompressionComplete },
      initialMessages: [...first.allMessages, {
        id: 'followup', role: 'user', content: 'Continue', timestamp: Date.now(),
      }],
    })
    expect(onContextCompressionComplete).toHaveBeenCalledOnce()
    expect(second.compressionBaseline?.summary).toBe('Earlier task summary')
    expect(useConversationRuntimeStore.getState().isConversationMounted('other-chat')).toBe(true)
  })

  it('does not force disabled reasoning on Codex summary requests', async () => {
    const input = setup()
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      requests.push(body)
      return response('Earlier task summary')
    }))
    await input.generateContextSummaryWithLLM('Earlier conversation', 500)
    expect(requests).toHaveLength(1)
    expect(requests[0].reasoning).toBeUndefined()
  })

  it('surfaces a failed Codex summary request instead of reporting an empty success', async () => {
    const input = setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Summary request rejected', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })))
    await expect(input.generateContextSummaryWithLLM('Earlier conversation', 500))
      .rejects.toThrow('Summary request rejected')
  })

  it('keeps the transcript and still runs when both summary requests fail (#268)', async () => {
    const input = setup()
    input.initialMessages.push({
      id: 'previous', role: 'assistant', content: 'Earlier answer', timestamp: 2,
      usage: { promptTokens: 970, completionTokens: 10, totalTokens: 980 },
    }, { id: 'continue', role: 'user', content: 'Continue', timestamp: 3 })
    // Two failed summary attempts (initial + retry), then the turn itself.
    let calls = 0
    const bodies: string[] = []
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls += 1
      bodies.push(String(init?.body ?? ''))
      if (calls <= 2) {
        return new Response(JSON.stringify({
          error: { message: 'Summary request rejected', type: 'invalid_request_error' },
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return response('Done', 100)
    })
    vi.stubGlobal('fetch', fetch)
    const onContextCompressionComplete = vi.fn()

    const result = await executePiCoreLoop({ ...input, callbacks: { onContextCompressionComplete } })

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onContextCompressionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'skip', summary: null })
    )
    expect(result.allMessages.length).toBeGreaterThan(0)
    // History is preserved: the model still sees the earlier turn, not a marker.
    expect(bodies[2]).toContain('Earlier answer')
  })

  it('rejects an empty summary instead of continuing with an uncompressed context', async () => {
    const input = setup()
    vi.stubGlobal('fetch', vi.fn(async () => response('')))
    await expect(input.generateContextSummaryWithLLM('Earlier conversation', 500))
      .rejects.toThrow('empty context summary')
  })
})
