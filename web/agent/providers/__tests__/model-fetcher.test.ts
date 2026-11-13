import { afterEach, describe, expect, it, vi } from 'vitest'
import { canFetchModels, fetchModelsForProvider } from '../model-fetcher'
import { getModelsForProvider, registerDynamicProvider, unregisterDynamicProvider } from '../types'

const CODEX_PROVIDER = 'codex-oauth'

afterEach(() => {
  unregisterDynamicProvider(CODEX_PROVIDER)
  vi.unstubAllGlobals()
  delete (window as unknown as { __agentWeb?: unknown }).__agentWeb
})

describe('fetchModelsForProvider', () => {
  it('discovers models through the connected extension without a browser request', async () => {
    const browserFetch = vi.fn().mockRejectedValue(new Error('Browser CORS blocked'))
    vi.stubGlobal('fetch', browserFetch)
    const mcpNetworkFetch = vi.fn((_request: Record<string, unknown>) => ({
      cancel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'response_start', status: 200, headers: { 'content-type': 'application/json' } }
        yield {
          type: 'bytes',
          data: btoa(JSON.stringify({ data: [{ id: 'glm-5.3-flash', context_window: 131072 }] })),
        }
      },
    }))
    ;(window as unknown as { __agentWeb: unknown }).__agentWeb = {
      ready: true,
      mcpNetworkCapabilities: { version: 2 },
      mcpNetworkFetch,
    }

    const result = await fetchModelsForProvider('volcengine-coding', { apiKey: 'test-key' })

    expect(result.source).toBe('dynamic')
    expect(result.models).toEqual([expect.objectContaining({ id: 'glm-5.3-flash', contextWindow: 131072 })])
    expect(mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://ark.cn-beijing.volces.com/api/coding/v3/models',
      method: 'GET',
    }))
    const request = mcpNetworkFetch.mock.calls[0][0]
    expect(new Headers(request.headers as HeadersInit).get('authorization')).toBe('Bearer test-key')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('reports an extension discovery failure with static models without retrying in the browser', async () => {
    const browserFetch = vi.fn().mockRejectedValue(new Error('Browser CORS blocked'))
    vi.stubGlobal('fetch', browserFetch)
    const mcpNetworkFetch = vi.fn(() => ({
      cancel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        throw new Error('Extension disconnected')
      },
    }))
    ;(window as unknown as { __agentWeb: unknown }).__agentWeb = {
      ready: true,
      mcpNetworkCapabilities: { version: 2 },
      mcpNetworkFetch,
    }

    const result = await fetchModelsForProvider('volcengine-coding', { apiKey: 'test-key' })

    expect(result.source).toBe('static')
    expect(result.error).toBe('Extension disconnected')
    expect(result.models.some((model) => model.id === 'ark-code-latest')).toBe(true)
    expect(mcpNetworkFetch).toHaveBeenCalledTimes(1)
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('fetches Volcengine Coding models from the OpenAI-compatible Coding endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.3-flash', context_window: 131072 }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsForProvider('volcengine-coding', { apiKey: 'test-key' })

    expect(canFetchModels('volcengine-coding')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ark.cn-beijing.volces.com/api/coding/v3/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    )
    expect(result.source).toBe('dynamic')
    expect(result.models).toEqual([expect.objectContaining({ id: 'glm-5.3-flash', contextWindow: 131072 })])
    expect(result.error).toBeUndefined()
  })

  it('keeps a usable Volcengine Coding fallback and reports discovery failures', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsForProvider('volcengine-coding', { apiKey: 'test-key' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.source).toBe('static')
    expect(result.error).toBe('HTTP 404: Not Found')
    expect(result.models.map((model) => model.id)).toEqual(expect.arrayContaining([
      'ark-code-latest', 'doubao-seed-2.1-lite', 'glm-5.3-flash',
    ]))
  })

  it('offers the built-in Volcengine Coding catalog before a key is saved', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModelsForProvider('volcengine-coding')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.models).toEqual(getModelsForProvider('volcengine-coding'))
    expect(result.models.some((model) => model.id === 'ark-code-latest')).toBe(true)
    expect(result.error).toBe('No API key provided')
  })

  it('uses extension-provided models for Codex OAuth without requesting /models', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    registerDynamicProvider(
      CODEX_PROVIDER,
      {
        baseURL: 'https://chatgpt.com/backend-api/codex',
        modelName: 'gpt-5.6-terra',
        apiMode: 'responses',
      },
      {
        category: 'custom',
        displayName: 'Codex (Browser OAuth)',
        models: [{
          id: 'gpt-5.6-terra',
          name: 'GPT-5.6 Terra',
          contextWindow: 258000,
          capabilities: ['code', 'reasoning', 'vision'],
        }],
      },
    )

    const result = await fetchModelsForProvider(CODEX_PROVIDER, {
      apiKey: 'virtual-key',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    })

    expect(result.source).toBe('static')
    expect(result.models.map((model) => model.id)).toEqual(['gpt-5.6-terra'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(canFetchModels(CODEX_PROVIDER)).toBe(false)
  })

  it('parses DeepSeek-style rich metadata (name, context_window, input_modalities)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [
          {
            id: 'deepseek-flash',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek-V4.1-Flash',
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
          },
          {
            id: 'deepseek-v4-pro',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek-V4-Pro',
            context_window: 1048576,
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
        ],
      }),
    })))

    const result = await fetchModelsForProvider('deepseek', { apiKey: 'test-key' })

    expect(result.source).toBe('dynamic')
    const flash = result.models.find((m) => m.id === 'deepseek-flash')
    expect(flash).toBeDefined()
    // API name wins over formatModelName heuristic
    expect(flash!.name).toBe('DeepSeek-V4.1-Flash')
    // API context_window wins over guess table
    expect(flash!.contextWindow).toBe(1048576)
    // image input modality maps to the vision capability tag
    expect(flash!.inputModalities).toEqual(['text', 'image'])
    expect(flash!.capabilities).toContain('vision')
    expect(flash!.metadataFromApi).toBe(true)

    const pro = result.models.find((m) => m.id === 'deepseek-v4-pro')
    expect(pro!.capabilities).not.toContain('vision')
    expect(pro!.contextWindow).toBe(1048576)
  })

  it('still parses OpenRouter-style responses (top_provider.context_length + pricing)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'anthropic/claude-haiku-5.5',
          context_length: 1000000,
          top_provider: { context_length: 1000000 },
          pricing: { prompt: '0.0000001', completion: '0.0000005' },
        }],
      }),
    })))

    const result = await fetchModelsForProvider('openrouter', { apiKey: 'test-key' })
    const m = result.models[0]
    expect(m.contextWindow).toBe(1000000)
    expect(m.pricing?.prompt).toBe('0.0000001')
  })
})
