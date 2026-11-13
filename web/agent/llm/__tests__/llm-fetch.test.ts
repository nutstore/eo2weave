import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLlmFetch, installLlmBridgeFetch } from '../llm-fetch'
import { registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
import type { MCPNetworkBridge } from '@/mcp/extension-fetch'

function replyBridge(text = '你好', status = 200) {
  const bytes = new TextEncoder().encode(text)
  const cancel = vi.fn()
  const bridge = {
    ready: true,
    mcpNetworkCapabilities: { version: 2 },
    mcpNetworkFetch: vi.fn((_request: Record<string, unknown>) => ({
      cancel,
      async *[Symbol.asyncIterator]() {
        yield { type: 'response_start' as const, status, headers: { 'content-type': 'text/plain' } }
        // Split inside a multibyte character to exercise byte preservation.
        for (const part of [bytes.slice(0, 1), bytes.slice(1)]) {
          yield { type: 'bytes' as const, data: btoa(String.fromCharCode(...part)) }
        }
      },
    })),
  }
  return { bridge, cancel }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __agentWeb?: unknown }).__agentWeb
  unregisterDynamicProvider('custom-transport-test')
  unregisterDynamicProvider('codex-oauth')
})

describe('extension-first LLM fetch', () => {
  it.each([
    undefined,
    { ready: false, mcpNetworkCapabilities: { version: 2 }, mcpNetworkFetch: vi.fn() },
    { ready: true, mcpProxyFetch: vi.fn() },
    { ready: true, mcpNetworkCapabilities: { version: 2 } },
  ])('uses browser fetch when a capable connected bridge is absent (%j)', async (bridge) => {
    const response = new Response('direct')
    const direct = vi.fn(async () => response)
    const fetch = createLlmFetch(direct, () => bridge as MCPNetworkBridge | undefined)
    expect(await fetch('https://api.example.com/models')).toBe(response)
    expect(direct).toHaveBeenCalledTimes(1)
  })

  it('proxies a models GET with its headers and preserves response bytes', async () => {
    const { bridge } = replyBridge()
    const direct = vi.fn()
    const fetch = createLlmFetch(direct, () => bridge)
    const response = await fetch('https://api.example.com/models', { headers: { Authorization: 'Bearer test-key' } })

    expect(await response.text()).toBe('你好')
    expect(bridge.mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example.com/models', method: 'GET', body: null,
    }))
    const payload = bridge.mcpNetworkFetch.mock.calls[0][0]
    expect(new Headers(payload.headers as HeadersInit).get('authorization')).toBe('Bearer test-key')
    expect(direct).not.toHaveBeenCalled()
  })

  it('proxies Request bodies and HTTP errors without resending directly', async () => {
    const { bridge } = replyBridge('rate limited', 429)
    const direct = vi.fn()
    const fetch = createLlmFetch(direct, () => bridge)
    const response = await fetch(new Request('https://api.example.com/chat/completions', {
      method: 'POST', body: '{"stream":true}', headers: { Authorization: 'Bearer test-key' },
    }))

    expect(response.status).toBe(429)
    expect(await response.text()).toBe('rate limited')
    expect(bridge.mcpNetworkFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', body: '{"stream":true}' }))
    expect(direct).not.toHaveBeenCalled()
  })

  it('propagates bridge failures without a browser retry', async () => {
    const { bridge, cancel } = replyBridge()
    bridge.mcpNetworkFetch.mockImplementation(() => ({
      cancel,
      async *[Symbol.asyncIterator]() { throw new Error('Bridge disconnected') },
    }))
    const direct = vi.fn()
    await expect(createLlmFetch(direct, () => bridge)('https://api.example.com/models')).rejects.toThrow('Bridge disconnected')
    expect(direct).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['before headers', 'during streaming'])('cancels the extension request %s', async (phase) => {
    const cancel = vi.fn()
    const next = vi.fn()
    if (phase === 'during streaming') next.mockResolvedValueOnce({ done: false, value: { type: 'response_start', status: 200 } })
    next.mockImplementation(() => new Promise(() => {}))
    const bridge: MCPNetworkBridge = {
      ready: true, mcpNetworkCapabilities: { version: 2 },
      mcpNetworkFetch: () => ({ cancel, [Symbol.asyncIterator]: () => ({ next }) }),
    }
    const controller = new AbortController()
    const direct = vi.fn()
    const pending = createLlmFetch(direct, () => bridge)('https://api.example.com/chat/completions', { signal: controller.signal })
    const result = phase === 'during streaming' ? (await pending).text() : pending
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(direct).not.toHaveBeenCalled()
  })
})

describe('SDK fetch routing', () => {
  function install() {
    const { bridge } = replyBridge()
    ;(window as unknown as { __agentWeb: unknown }).__agentWeb = bridge
    const direct = vi.fn(async () => new Response('direct'))
    vi.stubGlobal('fetch', direct)
    installLlmBridgeFetch()
    return { bridge, direct }
  }

  it.each([
    'https://api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/responses',
    'https://api.anthropic.com/v1/messages',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
  ])('installs once and proxies registered generation endpoints: %s', async (url) => {
    const { bridge, direct } = install()
    const installed = globalThis.fetch
    installLlmBridgeFetch()
    expect(globalThis.fetch).toBe(installed)
    await (await fetch(url, { method: 'POST', body: '{}' })).text()
    expect(bridge.mcpNetworkFetch).toHaveBeenCalledTimes(1)
    expect(direct).not.toHaveBeenCalled()
  })

  it.each([
    'https://api.openai.com.evil.example/v1/chat/completions',
    'https://api.openai.com/v10/chat/completions',
    'https://api.openai.com/v1/assets/app.js',
  ])('leaves unrelated requests unchanged: %s', async (url) => {
    const { bridge, direct } = install()
    await fetch(url, { method: 'POST', body: '{}' })
    expect(direct).toHaveBeenCalledTimes(1)
    expect(bridge.mcpNetworkFetch).not.toHaveBeenCalled()
  })

  it('recognizes providers registered after installation', async () => {
    const { bridge, direct } = install()
    registerDynamicProvider('custom-transport-test', { baseURL: 'https://custom.example/api', modelName: 'test' }, {
      category: 'custom', displayName: 'Test', models: [],
    })
    await (await fetch('https://custom.example/api/responses', { method: 'POST', body: '{}' })).text()
    expect(bridge.mcpNetworkFetch).toHaveBeenCalledTimes(1)
    expect(direct).not.toHaveBeenCalled()
  })

  it('routes a resolved SDK endpoint override and keeps browser mode non-recursive', async () => {
    const { bridge, direct } = install()
    installLlmBridgeFetch('https://override.example/custom/v1')
    await (await fetch('https://override.example/custom/v1/messages', { method: 'POST', body: '{}' })).text()
    expect(bridge.mcpNetworkFetch).toHaveBeenCalledTimes(1)
    bridge.ready = false
    expect(await (await fetch('https://override.example/custom/v1/messages', { method: 'POST', body: '{}' })).text()).toBe('direct')
    expect(direct).toHaveBeenCalledTimes(1)
  })

  it('leaves Codex requests to the existing dedicated transport', async () => {
    const { bridge, direct } = install()
    registerDynamicProvider('codex-oauth', { baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'test' }, {
      category: 'custom', displayName: 'Codex', models: [],
    })
    await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', body: '{}' })
    expect(direct).toHaveBeenCalledTimes(1)
    expect(bridge.mcpNetworkFetch).not.toHaveBeenCalled()
  })
})
