import { afterEach, describe, expect, it, vi } from 'vitest'
import { getApiProvider } from '@earendil-works/pi-ai'
import { fetchDeepSeekBalance } from '../deepseek-provider'
import { createDeviceSession, fetchGatewayModels, fetchRateLimits, pollDeviceToken } from '../llm-gateway-auth'
import { getOpenRouterPricing, refreshOpenRouterModelsNow } from '../openrouter-pricing'
import { CW_OPENAI_FETCH_API, ensurePiAICustomProvidersRegistered } from '@/agent/llm/pi-ai-custom-openai-fetch'

function connectBridge(body: string, contentType = 'application/json') {
  const browserFetch = vi.fn().mockRejectedValue(new Error('Browser CORS blocked'))
  vi.stubGlobal('fetch', browserFetch)
  const mcpNetworkFetch = vi.fn((_request: Record<string, unknown>) => ({
    cancel: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield { type: 'response_start', status: 200, headers: { 'content-type': contentType } }
      yield { type: 'bytes', data: btoa(body) }
    },
  }))
  ;(window as unknown as { __agentWeb: unknown }).__agentWeb = {
    ready: true,
    mcpNetworkCapabilities: { version: 2 },
    mcpNetworkFetch,
  }
  return { browserFetch, mcpNetworkFetch }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __agentWeb?: unknown }).__agentWeb
  localStorage.clear()
})

describe('provider HTTP requests through the extension', () => {
  it('queries DeepSeek balance with the account key', async () => {
    const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5' }] }
    const { browserFetch, mcpNetworkFetch } = connectBridge(JSON.stringify(payload))

    expect(await fetchDeepSeekBalance('balance-key', 'https://api.deepseek.com/v1')).toEqual(payload)
    expect(mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.deepseek.com/user/balance',
    }))
    expect(new Headers(mcpNetworkFetch.mock.calls[0][0].headers as HeadersInit).get('authorization')).toBe('Bearer balance-key')
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('refreshes OpenRouter pricing from an extension response', async () => {
    const { browserFetch, mcpNetworkFetch } = connectBridge(JSON.stringify({
      data: [{ id: 'bridge-test/new-model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
    }))

    expect(await refreshOpenRouterModelsNow()).toBe(true)
    expect(getOpenRouterPricing('bridge-test/new-model')).toEqual({ input: 1, output: 2 })
    expect(mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://openrouter.ai/api/v1/models' }))
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('uses the extension for gateway login, polling, models and quotas', async () => {
    const { browserFetch, mcpNetworkFetch } = connectBridge(JSON.stringify({ data: [{ id: 'gateway-model' }] }))

    await createDeviceSession('https://gw.example', 'test-client')
    await pollDeviceToken('https://gw.example', 'device-code', 'user-code')
    expect(await fetchGatewayModels('https://gw.example', 'gateway-token')).toEqual({
      models: [{ id: 'gateway-model', name: 'gateway-model' }], status: 'ready',
    })
    await fetchRateLimits('https://gw.example', 'gateway-token')

    expect(mcpNetworkFetch.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ url: 'https://gw.example/v1/auth/device/code', method: 'POST', body: JSON.stringify({ client_id: 'test-client' }) }),
      expect.objectContaining({ url: 'https://gw.example/v1/auth/device/token', method: 'POST', body: JSON.stringify({ device_code: 'device-code', user_code: 'user-code' }) }),
      expect.objectContaining({ url: 'https://gw.example/v1/models' }),
      expect.objectContaining({ url: 'https://gw.example/v1/rate-limits' }),
    ])
    for (const [request] of mcpNetworkFetch.mock.calls.slice(2)) {
      expect(new Headers(request.headers as HeadersInit).get('authorization')).toBe('Bearer gateway-token')
    }
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('streams a custom OpenAI chat response through the extension', async () => {
    const { browserFetch, mcpNetworkFetch } = connectBridge(
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      'text/event-stream',
    )
    ensurePiAICustomProvidersRegistered()
    const handler = getApiProvider(CW_OPENAI_FETCH_API)!
    const stream = handler.stream({
      id: 'local-model', api: CW_OPENAI_FETCH_API, provider: 'custom', name: 'Local Model',
      baseUrl: 'https://custom.example/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
    }, { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] }, { apiKey: 'chat-key' })

    const result = await stream.result()

    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://custom.example/v1/chat/completions', method: 'POST',
    }))
    expect(new Headers(mcpNetworkFetch.mock.calls[0][0].headers as HeadersInit).get('authorization')).toBe('Bearer chat-key')
    expect(browserFetch).not.toHaveBeenCalled()
  })
})
