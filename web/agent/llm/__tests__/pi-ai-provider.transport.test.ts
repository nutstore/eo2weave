import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiAIProvider } from '../pi-ai-provider'

const chatSse = [
  { id: 'chat-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
  { id: 'chat-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'

const responsesSse = [
  { type: 'response.created', response: { id: 'resp-test' } },
  { type: 'response.output_item.added', item: { type: 'message', id: 'msg-test', role: 'assistant', content: [] } },
  { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } },
  { type: 'response.output_text.delta', delta: '你好' },
  { type: 'response.completed', response: { id: 'resp-test', status: 'completed', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { __agentWeb?: unknown }).__agentWeb
})

describe('native SDK extension transport', () => {
  const cases = [
    { providerType: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', path: 'responses', sse: responsesSse },
    { providerType: 'groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', path: 'chat/completions', sse: chatSse },
  ].flatMap((config) => (['chat', 'chatStream'] as const).map((mode) => ({ ...config, mode })))
  it.each(cases)('uses the extension for $providerType $mode with the real SDK', async ({ mode, sse, ...config }) => {
    const direct = vi.fn()
    vi.stubGlobal('fetch', direct)
    const proxy = vi.fn((_request: Record<string, unknown>) => ({
      cancel: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield { type: 'response_start' as const, status: 200, headers: { 'content-type': 'text/event-stream' } }
        yield { type: 'bytes' as const, data: btoa(String.fromCharCode(...new TextEncoder().encode(sse))) }
      },
    }))
    ;(window as unknown as { __agentWeb: unknown }).__agentWeb = {
      ready: true, mcpNetworkCapabilities: { version: 2 }, mcpNetworkFetch: proxy,
    }
    const provider = new PiAIProvider({ ...config, apiKey: 'test-key' })
    const request = { messages: [{ role: 'user' as const, content: 'Hello' }] }
    if (mode === 'chat') {
      expect((await provider.chat(request)).choices[0].message.content).toBe('你好')
    } else {
      let text = ''
      for await (const chunk of provider.chatStream(request)) text += chunk.choices[0].delta.content ?? ''
      expect(text).toBe('你好')
    }
    expect(proxy).toHaveBeenCalledTimes(1)
    const payload = proxy.mock.calls[0][0]
    expect(payload.url).toBe(`${config.baseUrl}/${config.path}`)
    expect(new Headers(payload.headers as HeadersInit).get('authorization')).toBe('Bearer test-key')
    const body = JSON.parse(payload.body as string)
    expect(body.model).toBe(config.model)
    expect(body.stream).toBe(true)
    expect(JSON.stringify(body.input ?? body.messages)).toContain('Hello')
    expect(direct).not.toHaveBeenCalled()
  })
})
