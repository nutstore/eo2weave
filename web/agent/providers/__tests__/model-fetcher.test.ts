import { afterEach, describe, expect, it, vi } from 'vitest'
import { canFetchModels, fetchModelsForProvider } from '../model-fetcher'
import { registerDynamicProvider, unregisterDynamicProvider } from '../types'

const CODEX_PROVIDER = 'codex-oauth'

afterEach(() => {
  unregisterDynamicProvider(CODEX_PROVIDER)
  vi.unstubAllGlobals()
})

describe('fetchModelsForProvider', () => {
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
