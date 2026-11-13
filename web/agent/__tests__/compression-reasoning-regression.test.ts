import { describe, expect, it, vi } from 'vitest'
import { buildChatCompletionsPayload, CW_OPENAI_FETCH_API } from '../llm/pi-ai-custom-openai-fetch'
import { convertAgentMessagesToLlm, resolveCompressionInputBudget } from '../loop/convert-bridge'
import { estimateCompressionTokens } from '../loop/compression-history'
import { internalToPiMessages, piToInternalMessage } from '../loop/message-mappers'
import type { Message } from '../message-types'

describe('reasoning-heavy compression admission', () => {
  it('compresses at the real-usage gate and dispatches a fitting complete final reasoning/tool exchange', async () => {
    const model = { api: CW_OPENAI_FETCH_API, provider: 'custom-reasoning', id: 'test', name: 'Test',
      baseUrl: 'https://example.test/v1', contextWindow: 10000, maxTokens: 2000, reasoning: true,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never
    const reasoning = 'reason '.repeat(1500)
    const task: Message = { id: 'task', role: 'user', content: 'Read six files and continue', timestamp: 1 }
    const rounds = Array.from({ length: 6 }, (_, index): Message[] => [
      { id: `call-${index}`, role: 'assistant', content: null, reasoning, timestamp: index * 2 + 2,
        toolCalls: [{ id: `read-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `${index}.txt` }) } }],
        ...(index === 5 ? { usage: { promptTokens: 8000, completionTokens: 1500, totalTokens: 9500 } } : {}) },
      { id: `result-${index}`, role: 'tool', toolCallId: `read-${index}`, name: 'read', content: `File ${index} contents`, timestamp: index * 2 + 3 },
    ]).flat()
    const canonical = [task, ...rounds]
    const snapshot = structuredClone(canonical)
    const original = internalToPiMessages(canonical, model, 'Memory:')
    const generate = vi.fn(async (_content: string, _tokens: number, _messages?: Message[]) => ({ summary: 'Read files 0–4; the final read is retained.', mode: 'llm' as const }))
    const result = await convertAgentMessagesToLlm({ agentMessages: original, model,
      provider: { maxContextTokens: 10000, estimateTokens: () => 652 } as never,
      maxContextTokens: 10000, reserveTokens: 2000, convertCallCount: 0, lastSummaryConvertCall: -Infinity,
      compressionBaseline: null, compressedMemoryPrefix: 'Memory:', generateContextSummaryWithLLM: generate })

    expect(generate).toHaveBeenCalledOnce()
    expect(result.compressionBaseline).toMatchObject({ throughMessageId: 'result-4', preservedMessageIds: ['task'] })
    const retained = result.piMessages.map(piToInternalMessage).filter((message): message is Message => message !== null)
    expect(retained.slice(1)).toEqual([task, ...rounds.slice(-2)])
    expect(estimateCompressionTokens(retained)).toBeLessThanOrEqual(resolveCompressionInputBudget(10000, 2000))
    const payload = buildChatCompletionsPayload(model, { messages: result.piMessages }) as { messages: Array<{
      role: string; reasoning_content?: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string
    }> }
    const before = buildChatCompletionsPayload(model, { messages: original })
    expect(JSON.stringify(before).length / 3).toBeGreaterThan(8000)
    expect(JSON.stringify(payload).length / 3 + 2000).toBeLessThan(10000)
    expect(payload.messages.filter(message => message.reasoning_content).map(message => message.reasoning_content)).toEqual([reasoning])
    const callIndex = payload.messages.findIndex(message => message.tool_calls?.some(call => call.id === 'read-5'))
    expect(payload.messages[callIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'read-5' })
    expect(generate.mock.calls[0][0]).not.toContain(reasoning)
    expect(canonical).toEqual(snapshot)
  })
})
