import { describe, expect, it, vi } from 'vitest'
import { generateContextSummaryWithLLM } from '../loop/context-summary'
import type { ChatCompletionRequest } from '../llm/llm-provider'
import type { Message } from '../message-types'
import { internalToPiMessages, materializeProviderHistory, piToInternalMessage } from '../loop/message-mappers'

const response = (finish_reason = 'stop', content = 'checkpoint') => ({ choices: [{ message: { content }, finish_reason }] })
const source: Message[] = [
  { id: 'user-id', role: 'user', content: 'x'.repeat(1800) + ' FINAL_CONSTRAINT', timestamp: 1 },
  { id: 'call-id', role: 'assistant', content: null, toolCalls: [{ id: 'tool-id', type: 'function', function: { name: 'read', arguments: '{"path":"specific-path","id":"argument-id"}' } }], timestamp: 2 },
  { id: 'result-id', role: 'tool', name: 'read', toolCallId: 'tool-id', content: 'all results', timestamp: 3 },
]
describe('typed context summarizer', () => {
  it.each(['aborted', 'error'] as const)('uses normal provider ownership and pairing for a canonical %s turn', async (kind) => {
    const model = { api: 'openai-completions', provider: 'openai', id: 'test', input: ['text', 'image'] } as never
    const rawArguments = '{ "path" : "precise/path.txt", "id": "argument-id" }'
    const canonical: Message[] = [
      { id: 'task', role: 'user', content: 'Continue from the screenshot', timestamp: 1,
        assets: [{ name: 'reference.png', mimeType: 'image/png', size: 10, ocrBase64: 'UPLOADED_PIXELS' }] as never,
        pageContext: { title: 'Source page', selectedText: 'EXACT_SELECTED_REQUIREMENT' } },
      { id: 'failed', role: 'assistant', kind, content: 'partial work', timestamp: 2,
        toolCalls: [{ id: 'failed-read', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { id: 'failed-result', role: 'tool', toolCallId: 'failed-read', name: 'read', content: '{"status":"interrupted"}', timestamp: 3 },
      { id: 'valid', role: 'assistant', content: 'Read evidence', timestamp: 4,
        toolCalls: [{ id: 'valid-read', type: 'function', function: { name: 'read', arguments: rawArguments } }] },
      { id: 'evidence-result', role: 'tool', toolCallId: 'valid-read', name: 'read', content: 'Verified file evidence', timestamp: 5 },
      { id: 'generated', role: 'assistant', content: null, timestamp: 6, images: [{ mimeType: 'image/png', data: 'GENERATED_PIXELS' }] },
    ]
    const original = structuredClone(canonical)
    const normal = internalToPiMessages(canonical, model, 'Memory:')
    const expectedSources = normal.map(piToInternalMessage)
    const materialized = materializeProviderHistory(canonical, model, 'Memory:')
    const chat = vi.fn(async (_request: ChatCompletionRequest) => response())
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 50000, getModel: () => model } as never,
      droppedContent: '', messages: canonical, maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })
    const request = chat.mock.calls[0][0]

    expect(materialized.map(message => message.id)).toEqual(expectedSources.map(message => message!.id))
    expect(materialized.find(message => message.id === 'valid')?.toolCalls?.[0].function.arguments).toBe(rawArguments)
    const replay = request.messages.slice(1, -1)
    expect(replay.filter(message => message.role === 'tool').map(message => message.tool_call_id)).toEqual(
      normal.filter(message => message.role === 'toolResult').map(message => message.toolCallId)
    )
    const callIndex = replay.findIndex(message => message.tool_calls?.some(call => call.id === 'valid-read'))
    expect(replay[callIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'valid-read', content: 'Verified file evidence' })
    expect(replay[callIndex].tool_calls?.[0].function.arguments).toBe(rawArguments)
    expect(JSON.stringify(replay)).not.toContain('failed-read')
    expect(JSON.stringify(request.messages)).toContain('UPLOADED_PIXELS')
    expect(JSON.stringify(request.messages)).toContain('GENERATED_PIXELS')
    expect(JSON.stringify(request.messages)).toContain('EXACT_SELECTED_REQUIREMENT')
    expect(request.messages.at(-1)?.content).toContain('evidence-result')
    expect(canonical).toEqual(original)
  })

  it('replays uploaded and generated image pixels and captured page context', async () => {
    const chat = vi.fn(async (_request: ChatCompletionRequest) => response())
    const images: Message[] = [
      { id: 'uploaded', role: 'user', content: 'Match the screenshot', timestamp: 1,
        assets: [{ name: 'reference.png', mimeType: 'image/png', size: 10, ocrBase64: 'UPLOADED_PIXELS' }] as never,
        pageContextDelivery: 'journal', pageContext: { title: 'Source page', selectedText: 'EXACT_SELECTED_REQUIREMENT' } },
      { id: 'generated', role: 'assistant', content: null, timestamp: 2,
        images: [{ mimeType: 'image/png', data: 'GENERATED_PIXELS' }] },
    ]
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 50000,
      getModel: () => ({ input: ['text', 'image'] }) } as never,
      droppedContent: '', messages: images, maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })
    const request = chat.mock.calls[0][0]
    expect(JSON.stringify(request.messages)).toContain('UPLOADED_PIXELS')
    expect(JSON.stringify(request.messages)).toContain('GENERATED_PIXELS')
    expect(JSON.stringify(request.messages)).toContain('EXACT_SELECTED_REQUIREMENT')
  })

  it('refuses to replace image evidence with text-only chunks when the full replay cannot fit', async () => {
    const chat = vi.fn(async (_request: ChatCompletionRequest) => response())
    await expect(generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 10000,
      getModel: () => ({ input: ['text', 'image'] }) } as never,
      droppedContent: '', messages: [{ id: 'image', role: 'user', timestamp: 1, content: 'x'.repeat(40000),
        contentParts: [{ type: 'text', text: 'x'.repeat(40000) }, { type: 'image', data: 'VISUAL_CONSTRAINT', mimeType: 'image/png' }] }],
      maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })).rejects.toThrow(/image/i)
    expect(chat).not.toHaveBeenCalled()
  })

  it('replays original roles and tool payloads plus current instructions with tools disabled', async () => {
    const chat = vi.fn(async (_request: ChatCompletionRequest) => response())
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 10000 } as never, droppedContent: '', messages: source, maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:', systemPrompt: 'current rules', tools: [{ type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } } }] } as never)
    const request = chat.mock.calls[0]![0] as unknown as ChatCompletionRequest
    expect(request.messages[0]).toEqual({ role: 'system', content: 'current rules' })
    expect(request.messages.at(-1)?.content).toContain('user-id')
    expect(request.messages.at(-1)?.content).toContain('result-id')
    expect(request.messages.at(-1)?.content).toContain('read_conversation_history')
    expect(request.messages.at(-1)?.content).toContain('structured checkpoint')
    expect(request.messages).toContainEqual(expect.objectContaining({ role: 'user', content: expect.stringContaining('FINAL_CONSTRAINT') }))
    expect(request.messages).toContainEqual(expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'tool-id', function: expect.objectContaining({ arguments: expect.stringContaining('argument-id') }) })] }))
    expect(request.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'tool-id', content: 'all results' }))
    expect(request.toolChoice).toBe('none')
    expect(request.messages.at(-1)?.content).toContain('Summarize the following dropped conversation context')
  })
  it('honors the model output limit when choosing the auxiliary completion budget', async () => {
    const chat = vi.fn(async (_request: ChatCompletionRequest) => response())
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 10000, getModel: () => ({ maxTokens: 128 }) } as never, droppedContent: 'history', maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })
    expect(chat.mock.calls[0][0].maxTokens).toBe(128)
  })
  it('rejects incomplete output rather than storing it as a checkpoint', async () => {
    await expect(generateContextSummaryWithLLM({ provider: { chat: async () => response('length'), maxContextTokens: 10000 } as never, droppedContent: 'history', maxSummaryTokens: 1000, compressedMemoryPrefix: 'Memory:' })).rejects.toThrow(/incomplete|length/i)
  })
  it('counts large tool schema data fields and preserves complete tool argument data when chunking', async () => {
    const requests: ChatCompletionRequest[] = []
    const chat = vi.fn(async (request: ChatCompletionRequest) => { requests.push(request); return response('stop', 'dense checkpoint') })
    const messages = source.map(message => message.id === 'call-id' ? { ...message, toolCalls: [{ ...message.toolCalls![0], function: { name: 'read', arguments: JSON.stringify({ data: 'DATA_START ' + 'ab '.repeat(12000) + ' DATA_END' }) } }] } : message)
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 5000 } as never, droppedContent: '', messages, maxSummaryTokens: 400, compressedMemoryPrefix: 'Memory:' })
    expect(requests.length).toBeGreaterThan(1)
    expect(JSON.stringify(requests)).toContain('DATA_START')
    expect(JSON.stringify(requests)).toContain('DATA_END')
    const blocked = vi.fn(async (_request: ChatCompletionRequest) => response())
    await expect(generateContextSummaryWithLLM({ provider: { chat: blocked, maxContextTokens: 5000 } as never, droppedContent: 'history', tools: [{ name: 'read', parameters: { type: 'object', properties: { data: { description: 'x'.repeat(30000) } } } }] as never, maxSummaryTokens: 400, compressedMemoryPrefix: 'Memory:' })).rejects.toThrow(/fit/)
    expect(blocked).not.toHaveBeenCalled()
  })
  it('summarizes every span of oversized input through bounded requests', async () => {
    const requests: ChatCompletionRequest[] = []
    const chat = vi.fn(async (request: ChatCompletionRequest) => { requests.push(request); return response('stop', 'dense checkpoint') })
    const content = 'START ' + 'ab '.repeat(12000) + ' END_SUFFIX'
    await generateContextSummaryWithLLM({ provider: { chat, maxContextTokens: 5000 } as never, droppedContent: content, maxSummaryTokens: 400, compressedMemoryPrefix: 'Memory:' })
    expect(requests.length).toBeGreaterThan(1)
    expect(JSON.stringify(requests)).toContain('START')
    expect(JSON.stringify(requests)).toContain('END_SUFFIX')
    for (const request of requests) {
      expect(JSON.stringify(request).length / 3 + (request.maxTokens ?? 0)).toBeLessThan(5000)
    }
  })
})
