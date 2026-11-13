import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PiAIProvider } from '../pi-ai-provider'
import { generateContextSummaryWithLLM } from '@/agent/loop/context-summary'

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }))
vi.mock('@earendil-works/pi-ai', async importOriginal => ({
  ...await importOriginal<typeof import('@earendil-works/pi-ai')>(), complete,
}))

describe('auxiliary requests cannot execute tools', () => {
  beforeEach(() => {
    complete.mockReset()
    complete.mockResolvedValue({ content: [{ type: 'text', text: 'Checkpoint' }], stopReason: 'stop',
      usage: { input: 1, output: 1, totalTokens: 2 } })
  })

  it('forwards none to native adapters and the custom OpenAI payload', async () => {
    const provider = new PiAIProvider({ providerType: 'openai', model: 'gpt-4o', apiKey: 'test', baseUrl: 'https://api.openai.com/v1' })
    await provider.chat({ messages: [{ role: 'user', content: 'Summarize' }], toolChoice: 'none',
      tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } } }] })
    const options = complete.mock.calls[0][2]
    expect(options.toolChoice).toBe('none')
    const payload: Record<string, unknown> = { tools: [{ type: 'function' }], tool_choice: 'auto' }
    options.onPayload(payload)
    expect(payload.tool_choice).toBe('none')
  })

  it('passes generated images as labeled user evidence through the actual summary adapter', async () => {
    const provider = new PiAIProvider({ providerType: 'openai', model: 'gpt-4o', apiKey: 'test', baseUrl: 'https://api.openai.com/v1' })
    await generateContextSummaryWithLLM({ provider, messages: [{ id: 'source-generated', role: 'assistant', content: null,
      images: [{ data: 'GENERATED_PIXELS', mimeType: 'image/png' }], timestamp: 1 }],
      droppedContent: '', maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })
    const evidence = complete.mock.calls[0][1].messages.find((message: { role: string; content: unknown }) =>
      message.role === 'user' && JSON.stringify(message.content).includes('GENERATED_PIXELS'))
    expect(evidence?.content).toContainEqual({ type: 'image', data: 'GENERATED_PIXELS', mimeType: 'image/png' })
    expect(JSON.stringify(evidence)).toContain('source-generated')
  })
})
