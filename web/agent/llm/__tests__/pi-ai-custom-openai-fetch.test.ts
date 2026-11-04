import { describe, expect, it } from 'vitest'
import {
  applyMaxThinkingOverride,
  buildChatCompletionsPayload,
  CW_OPENAI_FETCH_API,
  stripDeveloperRoleForDynamicProviders,
} from '../pi-ai-custom-openai-fetch'

describe('buildChatCompletionsPayload', () => {
  it('should request usage in streaming mode', () => {
    const model = {
      id: 'MiniMax-M2.7',
      api: CW_OPENAI_FETCH_API,
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      name: 'MiniMax M2.7',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      temperature: 0.2,
      maxTokens: 1024,
    } as never) as Record<string, unknown>

    expect(payload.stream).toBe(true)
    expect(payload.stream_options).toEqual({ include_usage: true })
    expect(payload.temperature).toBe(0.2)
    expect(payload.max_tokens).toBe(1024)
    expect(Array.isArray(payload.messages)).toBe(true)
  })

  it('should clamp minimax temperature to provider-supported range', () => {
    const model = {
      id: 'MiniMax-M2.7',
      api: CW_OPENAI_FETCH_API,
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      name: 'MiniMax M2.7',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      systemPrompt: 'You are helpful',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    } as never

    const low = buildChatCompletionsPayload(model, context, {
      temperature: 0,
    } as never) as Record<string, unknown>
    expect(low.temperature).toBe(0.01)

    const high = buildChatCompletionsPayload(model, context, {
      temperature: 1.5,
    } as never) as Record<string, unknown>
    expect(high.temperature).toBe(1)
  })

  it('should send effort:none when reasoning is absent on OpenRouter', () => {
    const model = {
      id: 'my-model',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-abc',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'My Model',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      systemPrompt: undefined,
      messages: [{ role: 'user', content: 'hello' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context) as Record<string, unknown>

    expect(payload.reasoning).toEqual({ effort: 'none' })
  })

  it('should not inject any thinking params when model.reasoning is false', () => {
    const model = {
      id: 'my-model',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-abc',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'My Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      systemPrompt: undefined,
      messages: [{ role: 'user', content: 'hello' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context) as Record<string, unknown>

    expect(payload.reasoning).toBeUndefined()
    expect(payload.reasoning_effort).toBeUndefined()
    expect(payload.thinking).toBeUndefined()
    expect(payload.enable_thinking).toBeUndefined()
  })

  it('should inject OpenRouter reasoning format for openrouter.ai baseUrl', () => {
    const model = {
      id: 'anthropic/claude-sonnet-4',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-or',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'Claude via OpenRouter',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'think!' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'high',
    } as never) as Record<string, unknown>

    expect(payload.reasoning).toEqual({ effort: 'high' })
    expect(payload.reasoning_effort).toBeUndefined()
  })

  it('should inject OpenRouter reasoning format for jianguoyun baseUrl', () => {
    const model = {
      id: 'anthropic/claude-sonnet-4',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-jgy',
      baseUrl: 'https://ai-assistant.jianguoyun.net.cn/api/v1',
      name: 'Claude via Jianguoyun',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'think!' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'medium',
    } as never) as Record<string, unknown>

    expect(payload.reasoning).toEqual({ effort: 'medium' })
    expect(payload.reasoning_effort).toBeUndefined()
  })

  it('should inject DeepSeek thinking format for deepseek.com baseUrl', () => {
    const model = {
      id: 'deepseek-r1',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-ds',
      baseUrl: 'https://api.deepseek.com/v1',
      name: 'DeepSeek R1',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'think!' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'medium',
    } as never) as Record<string, unknown>

    expect(payload.thinking).toEqual({ type: 'enabled' })
    expect(payload.reasoning_effort).toBe('medium')
  })

  it('should inject reasoning_effort as default for unknown baseUrl', () => {
    const model = {
      id: 'some-model',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-xyz',
      baseUrl: 'https://my-llm.example.com/v1',
      name: 'My LLM',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'think!' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'low',
    } as never) as Record<string, unknown>

    expect(payload.reasoning_effort).toBe('low')
    expect(payload.reasoning).toBeUndefined()
  })

  it('should use thinkingLevelMap when available', () => {
    const model = {
      id: 'kimi-k2',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-or',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'Kimi K2',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'think!' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'high',
    } as never) as Record<string, unknown>

    expect(payload.reasoning).toEqual({ effort: 'high' })
  })

  it('should ignore reasoning param when model.reasoning is false', () => {
    const model = {
      id: 'no-thinking-model',
      api: CW_OPENAI_FETCH_API,
      provider: 'custom-or',
      baseUrl: 'https://openrouter.ai/api/v1',
      name: 'No Thinking',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as never

    const context = {
      messages: [{ role: 'user', content: 'hello' }],
    } as never

    const payload = buildChatCompletionsPayload(model, context, {
      reasoning: 'high',
    } as never) as Record<string, unknown>

    expect(payload.reasoning).toBeUndefined()
    expect(payload.reasoning_effort).toBeUndefined()
  })
})

describe('convertContextMessages assistant image turns', () => {
  const buildModel = () =>
    ({
      id: 'MiniMax-M2.7',
      api: CW_OPENAI_FETCH_API,
      provider: 'minimax',
      baseUrl: 'https://api.minimax.io/v1',
      name: 'MiniMax M2.7',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }) as never

  it('keeps an image-only assistant turn in the serialized request', () => {
    // OpenAI chat-completions assistant messages cannot carry image parts, so
    // the image block serializes to nothing: content:null + no tool_calls.
    // The message must still be emitted with a text placeholder — dropping it
    // entirely erases the turn from provider history and breaks tool-call
    // ordering for later turns.
    const context = {
      systemPrompt: undefined,
      messages: [
        { role: 'user', content: 'draw a cat' },
        {
          role: 'assistant',
          content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
        },
        { role: 'user', content: 'now draw a dog' },
      ],
      tools: [],
    } as never

    const payload = buildChatCompletionsPayload(buildModel(), context) as Record<string, unknown>
    const messages = payload.messages as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(3) // user, assistant, user (no system prompt)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.content).toBe('[generated an image]')
    expect(JSON.stringify(payload)).not.toContain('aW1hZ2U=')
  })

  it('preserves assistant turns that carry text alongside images', () => {
    const context = {
      systemPrompt: undefined,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'here is your cat' },
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          ],
        },
      ],
      tools: [],
    } as never

    const payload = buildChatCompletionsPayload(buildModel(), context) as Record<string, unknown>
    const messages = payload.messages as Array<{ role: string; content: string | null }>
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('here is your cat')
  })
})

describe('applyMaxThinkingOverride', () => {
  it('should set reasoning.effort=max for openrouter baseUrl', () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: 'high' },
    }
    applyMaxThinkingOverride(payload, 'https://openrouter.ai/api/v1')
    expect(payload.reasoning).toEqual({ effort: 'max' })
  })

  it('should create reasoning object when openrouter payload lacks it', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://openrouter.ai/api/v1')
    expect(payload.reasoning).toEqual({ effort: 'max' })
  })

  it('should set reasoning_effort=max for openai/auto baseUrl', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://api.openai.com/v1')
    expect(payload.reasoning_effort).toBe('max')
  })

  it('should update nested reasoning.effort for responses-API style payload', () => {
    const payload: Record<string, unknown> = {
      reasoning: { effort: 'high', summary: 'auto' },
    }
    applyMaxThinkingOverride(payload, 'https://api.openai.com/v1')
    expect(payload.reasoning).toEqual({ effort: 'max', summary: 'auto' })
    expect(payload.reasoning_effort).toBe('max')
  })

  it('should set reasoning_effort=max for tencent-tokenhub baseUrl', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://ai.jianguoyun.com')
    expect(payload.reasoning_effort).toBe('max')
  })

  it('should use thinkingLevelMap mapping when provided', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://api.openai.com/v1', {
      max: 'maximum',
    })
    expect(payload.reasoning_effort).toBe('maximum')
  })

  it('should enable thinking for deepseek format', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://api.deepseek.com')
    expect(payload.thinking).toEqual({ type: 'enabled' })
    expect(payload.reasoning_effort).toBe('max')
  })

  it('should enable reasoning for together format', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://api.together.ai')
    expect(payload.reasoning).toEqual({ enabled: true })
    expect(payload.reasoning_effort).toBe('max')
  })

  it('should enable thinking for qwen format', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://dashscope.aliyuncs.com')
    expect(payload.enable_thinking).toBe(true)
  })

  it('should set reasoning_split for minimax format', () => {
    const payload: Record<string, unknown> = {}
    applyMaxThinkingOverride(payload, 'https://api.minimax.io/v1')
    expect(payload.reasoning_split).toBe(true)
  })
})

describe('stripDeveloperRoleForDynamicProviders', () => {
  it('rewrites developer → system in the Responses input array for custom-* providers', () => {
    // A custom provider configured with apiMode:'responses' goes through
    // pi-ai's built-in openai-responses handler, which hardcodes
    // role:"developer" for reasoning models and ignores compat.
    const payload: Record<string, unknown> = {
      model: 'my-model',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    }
    stripDeveloperRoleForDynamicProviders(payload, 'custom-1758123456789-abc123')

    const input = payload.input as Array<{ role: string }>
    expect(input[0].role).toBe('system')
    expect(input[1].role).toBe('user')
  })

  it('rewrites developer → system in chat-completions messages too', () => {
    const payload: Record<string, unknown> = {
      messages: [
        { role: 'developer', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ],
    }
    stripDeveloperRoleForDynamicProviders(payload, 'llm-gateway')

    const messages = payload.messages as Array<{ role: string }>
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('is a no-op for built-in providers (openai keeps developer role)', () => {
    const payload: Record<string, unknown> = {
      input: [{ role: 'developer', content: [{ type: 'input_text', text: 'sys' }] }],
    }
    stripDeveloperRoleForDynamicProviders(payload, 'openai')
    expect((payload.input as Array<{ role: string }>)[0].role).toBe('developer')
  })

  it('exempts codex-oauth — the ChatGPT endpoint natively uses developer role', () => {
    const payload: Record<string, unknown> = {
      input: [{ role: 'developer', content: [{ type: 'input_text', text: 'sys' }] }],
    }
    stripDeveloperRoleForDynamicProviders(payload, 'codex-oauth')
    expect((payload.input as Array<{ role: string }>)[0].role).toBe('developer')
  })

  it('leaves payloads without developer roles untouched', () => {
    const payload: Record<string, unknown> = {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      input: [{ role: 'system', content: [{ type: 'input_text', text: 'sys' }] }],
    }
    stripDeveloperRoleForDynamicProviders(payload, 'llm-gateway')
    expect(payload).toEqual({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      input: [{ role: 'system', content: [{ type: 'input_text', text: 'sys' }] }],
    })
  })
})
