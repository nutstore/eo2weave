import { describe, expect, it, vi } from 'vitest'
import { convertAgentMessagesToLlm, type ConvertAgentMessagesToLlmInput } from '../loop/convert-bridge'
import { internalToPiMessages } from '../loop/message-mappers'
import type { Message } from '../message-types'

const model = { api: 'openai-completions', provider: 'openai', id: 'test-model', input: ['text'], maxTokens: 4096 } as never
function input(overrides: Partial<ConvertAgentMessagesToLlmInput> = {}): ConvertAgentMessagesToLlmInput {
  return {
    agentMessages: [], model, provider: { maxContextTokens: 10000, estimateTokens: () => 1 } as never,
    maxContextTokens: 10000, reserveTokens: 1000, compressedMemoryPrefix: 'Memory:', convertCallCount: 0,
    lastSummaryConvertCall: -Infinity, compressionBaseline: null,
    generateContextSummaryWithLLM: async () => ({ summary: 'Checkpoint', mode: 'llm' }), ...overrides,
  }
}
function history(usage = 9000, chars = 12000): Message[] {
  return [
    { id: 'task', role: 'user', content: 'Critical task statement and exact constraints', timestamp: 1 },
    { id: 'old', role: 'assistant', content: 'x'.repeat(chars), timestamp: 2, usage: { promptTokens: usage - 100, completionTokens: 100, totalTokens: usage } },
    { id: 'tail', role: 'assistant', content: 'Latest result stays verbatim', timestamp: 3 },
  ]
}
const pi = (messages: Message[]) => internalToPiMessages(messages, model, 'Memory:')

describe('convert-bridge', () => {
  it('increments conversion count and maps messages', async () => {
    const result = await convertAgentMessagesToLlm(input({ agentMessages: [{ role: 'user', content: 'hello', timestamp: 1 }] }))
    expect(result.convertCallCount).toBe(1)
    expect(result.piMessages).toMatchObject([{ role: 'user', content: 'hello' }])
  })
  it('uses real reported tokens even when the local estimate is low', async () => {
    const generate = vi.fn(async () => ({ summary: 'Checkpoint', mode: 'llm' as const }))
    const onSummaryInjected = vi.fn()
    const result = await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), generateContextSummaryWithLLM: generate, onSummaryInjected }))
    expect(generate).toHaveBeenCalledOnce()
    expect(result.compressionBaseline).toMatchObject({ throughMessageId: 'old', preservedMessageIds: ['task'] })
    expect(result.piMessages).toHaveLength(3)
    expect(onSummaryInjected).toHaveBeenCalledWith('Checkpoint', 3, 'old', ['task'])
  })
  it('does not use a large heuristic estimate to open the compression gate', async () => {
    const generate = vi.fn()
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history(8000)), provider: { maxContextTokens: 10000, estimateTokens: () => 20000 } as never, generateContextSummaryWithLLM: generate }))
    expect(generate).not.toHaveBeenCalled()
  })
  it('does not force a checkpoint for tiny history even when fixed overhead triggered the cap', async () => {
    const generate = vi.fn()
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history(9000, 10)), generateContextSummaryWithLLM: generate }))
    expect(generate).not.toHaveBeenCalled()
  })
  it('retries the summary once and writes the checkpoint only after success', async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ summary: 'Retried checkpoint', mode: 'llm' })
    const result = await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), generateContextSummaryWithLLM: generate }))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.compressionBaseline?.summary).toBe('Retried checkpoint')
  })
  it('preserves every character of fitting history when both summary attempts fail', async () => {
    const generate = vi.fn(async () => { throw new Error('summary failed') })
    const complete = vi.fn()
    const source = history()
    const result = await convertAgentMessagesToLlm(input({ agentMessages: pi(source), generateContextSummaryWithLLM: generate, callbacks: { onContextCompressionComplete: complete } }))
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.compressionBaseline).toBeNull()
    expect(JSON.stringify(result.piMessages)).toContain('x'.repeat(12000))
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ mode: 'skip', summary: null }))
  })
  it('propagates summary failure if the complete original transcript cannot fit', async () => {
    const generate = vi.fn(async () => { throw new Error('summary failed') })
    await expect(convertAgentMessagesToLlm(input({ agentMessages: pi(history(9000, 40000)), generateContextSummaryWithLLM: generate }))).rejects.toThrow('summary failed')
  })
  it('cancellation prevents retry and checkpoint persistence', async () => {
    const controller = new AbortController()
    const onSummaryInjected = vi.fn()
    const generate = vi.fn(async () => { controller.abort(); return { summary: 'Checkpoint', mode: 'llm' as const } })
    await expect(convertAgentMessagesToLlm(input({ agentMessages: pi(history()), signal: controller.signal, generateContextSummaryWithLLM: generate, onSummaryInjected }))).rejects.toThrow()
    expect(generate).toHaveBeenCalledOnce()
    expect(onSummaryInjected).not.toHaveBeenCalled()
  })
  it('skips one conversion after a checkpoint and then reopens the gate', async () => {
    const generate = vi.fn(async () => ({ summary: 'Checkpoint', mode: 'llm' as const }))
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), convertCallCount: 3, lastSummaryConvertCall: 3, generateContextSummaryWithLLM: generate }))
    expect(generate).not.toHaveBeenCalled()
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), convertCallCount: 4, lastSummaryConvertCall: 3, generateContextSummaryWithLLM: generate }))
    expect(generate).toHaveBeenCalledOnce()
  })
  it('carries an earlier checkpoint into the next summary source', async () => {
    const generate = vi.fn(async (_content: string, _tokens: number, _messages?: Message[]) => ({ summary: 'SECOND_CHECKPOINT', mode: 'llm' as const }))
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), compressionBaseline: { summary: 'FIRST_CHECKPOINT', cutoffTimestamp: 0 }, generateContextSummaryWithLLM: generate }))
    expect(generate.mock.calls[0]).toEqual([expect.stringContaining('FIRST_CHECKPOINT'), expect.any(Number), expect.arrayContaining([expect.objectContaining({ kind: 'context_summary', content: 'FIRST_CHECKPOINT' })])])
  })
  it('honors an explicit absolute cap and its off switch', async () => {
    const generate = vi.fn(async () => ({ summary: 'Checkpoint', mode: 'llm' as const }))
    const common = { agentMessages: pi(history(6000)), compressionAbsoluteCap: 5000, generateContextSummaryWithLLM: generate }
    await convertAgentMessagesToLlm(input({ ...common, compressionAbsoluteCapEnabled: true }))
    expect(generate).toHaveBeenCalledOnce()
    await convertAgentMessagesToLlm(input({ ...common, compressionAbsoluteCapEnabled: false }))
    expect(generate).toHaveBeenCalledOnce()
  })
  it('allows ratio compaction with the absolute cap disabled for scheduled runs', async () => {
    const generate = vi.fn(async () => ({ summary: 'Checkpoint', mode: 'llm' as const }))
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), compressionEnabled: true, compressionAbsoluteCapEnabled: false, generateContextSummaryWithLLM: generate }))
    expect(generate).toHaveBeenCalledOnce()
  })
  it('honors a path that disables summarization', async () => {
    const generate = vi.fn()
    await convertAgentMessagesToLlm(input({ agentMessages: pi(history()), compressionEnabled: false, generateContextSummaryWithLLM: generate }))
    expect(generate).not.toHaveBeenCalled()
  })
  it.each([0, 1000])('recovers actual input overflow even when previous reported usage is %s', async (usage) => {
    const source = history(usage, 40000)
    if (!usage) source[1].usage = undefined
    const generate = vi.fn(async () => ({ summary: 'Recovered checkpoint', mode: 'llm' as const }))
    const result = await convertAgentMessagesToLlm(input({ agentMessages: pi(source), generateContextSummaryWithLLM: generate }))
    expect(generate).toHaveBeenCalledOnce()
    expect(result.compressionBaseline?.summary).toBe('Recovered checkpoint')
  })
  it('rejects an oversized new user message that cannot be compacted', async () => {
    const generate = vi.fn()
    await expect(convertAgentMessagesToLlm(input({ agentMessages: [{ role: 'user', content: 'x'.repeat(40000), timestamp: 1 }], generateContextSummaryWithLLM: generate }))).rejects.toThrow(/fit|capacity|context/i)
    expect(generate).not.toHaveBeenCalled()
  })
  it('rejects oversized fixed instructions even when the conversation is empty', async () => {
    await expect(convertAgentMessagesToLlm(input({ systemPrompt: 'x'.repeat(30000) }))).rejects.toThrow(/fit|capacity|context/i)
  })
  it('projects an appended persisted marker before estimating and mapping input', async () => {
    const source = history()
    source.push({ id: 'checkpoint', role: 'user', kind: 'context_summary', content: 'Previous checkpoint', timestamp: 4, compressionBoundary: { throughMessageId: 'old', cutoffTimestamp: 3, preservedMessageIds: ['task'] } })
    const result = await convertAgentMessagesToLlm(input({ agentMessages: pi(source), compressionEnabled: false }))
    expect(JSON.stringify(result.piMessages)).not.toContain('x'.repeat(100))
    expect(JSON.stringify(result.piMessages)).toContain('Critical task statement')
    expect(JSON.stringify(result.piMessages)).toContain('Latest result stays verbatim')
  })
})
