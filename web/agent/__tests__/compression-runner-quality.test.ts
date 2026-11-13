import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../message-types'
import { compressHistory } from '../loop/compression-runner'
import { estimateCompressionTokens, serializeCompressionHistory } from '../loop/compression-history'
import { internalToPiMessages } from '../loop/message-mappers'

const history: Message[] = [
  { id: 'task', role: 'user', content: 'x'.repeat(1200) + ' FINAL_CONSTRAINT', timestamp: 1 },
  { id: 'work', role: 'assistant', content: 'older work '.repeat(1200), timestamp: 2 },
  { id: 'tail', role: 'assistant', content: 'recent work', timestamp: 3 },
]
describe('shared compression runner', () => {
  it('compresses reasoning-heavy tool rounds while preserving the complete retained thinking block', async () => {
    const reasoning = 'reason '.repeat(1500)
    const task: Message = { id: 'task', role: 'user', content: 'Read all six files', timestamp: 1 }
    const rounds = Array.from({ length: 6 }, (_, index): Message[] => [
      { id: `call-${index}`, role: 'assistant', content: null, reasoning, timestamp: index * 2 + 2,
        toolCalls: [{ id: `read-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `${index}.txt` }) } }] },
      { id: `result-${index}`, role: 'tool', toolCallId: `read-${index}`, name: 'read', content: 'file contents', timestamp: index * 2 + 3 },
    ]).flat()
    const messages = [task, ...rounds]
    const generate = vi.fn(async (_content: string, _tokens: number, _messages?: Message[]) => ({ summary: 'Five files read; read the final file and continue.', mode: 'llm' as const }))
    const result = await compressHistory({ messages, effectiveCapacityTokens: 8000, generateContextSummaryWithLLM: generate })

    expect(result).not.toBeNull()
    expect(generate).toHaveBeenCalledOnce()
    expect(result!.messages.slice(1)).toEqual([task, ...rounds.slice(-2)])
    expect(estimateCompressionTokens(result!.messages)).toBeLessThan(8000)
    const replay = internalToPiMessages(result!.messages, { api: 'openai-completions', provider: 'openai', id: 'test', input: ['text'] } as never, 'Memory:')
    const thinking = replay.flatMap(message => message.role === 'assistant' ? message.content.filter(part => part.type === 'thinking') : [])
    expect(thinking).toEqual([{ type: 'thinking', thinking: reasoning }])
    expect(serializeCompressionHistory(messages)).not.toContain(reasoning)
    expect(generate.mock.calls[0][0]).not.toContain(reasoning)
    expect(rounds.filter(message => message.role === 'assistant').every(message => message.reasoning === reasoning)).toBe(true)
  })

  it('passes full typed source and preserves the user anchor and recent tail', async () => {
    const generate = vi.fn(async (_content: string, _tokens: number, _messages?: Message[]) => ({ summary: 'Goal and progress', mode: 'llm' as const }))
    const result = await compressHistory({ messages: history, effectiveCapacityTokens: 3000, generateContextSummaryWithLLM: generate })
    expect(generate.mock.calls[0]).toEqual([expect.stringContaining('FINAL_CONSTRAINT'), expect.any(Number), [history[0], history[1]]])
    expect(result?.messages.slice(1)).toEqual([history[0], history[2]])
    expect(result?.baseline).toMatchObject({ throughMessageId: 'work', preservedMessageIds: ['task'] })
  })
  it('balances callbacks and never writes a checkpoint after cancellation', async () => {
    const controller = new AbortController()
    const start = vi.fn()
    const complete = vi.fn()
    const generate = vi.fn(async () => {
      controller.abort()
      return { summary: 'summary', mode: 'llm' as const }
    })
    await expect(compressHistory({ messages: history, effectiveCapacityTokens: 3000, signal: controller.signal, callbacks: { onContextCompressionStart: start, onContextCompressionComplete: complete }, generateContextSummaryWithLLM: generate })).rejects.toThrow()
    expect(generate).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ mode: 'skip', summary: null }))
  })
  it('rejects a checkpoint when retained content alone exceeds the available input capacity', async () => {
    const generate = vi.fn(async () => ({ summary: 'small checkpoint', mode: 'llm' as const }))
    await expect(compressHistory({ messages: [...history.slice(0, 2), { ...history[2], content: 'recent '.repeat(3000) }], effectiveCapacityTokens: 3000, generateContextSummaryWithLLM: generate })).rejects.toThrow(/fit/)
  })
  it('rejects summaries that expand the selected history and retries only once', async () => {
    const generate = vi.fn(async () => ({ summary: 'huge '.repeat(10000), mode: 'llm' as const }))
    await expect(compressHistory({ messages: history, effectiveCapacityTokens: 3000, generateContextSummaryWithLLM: generate })).rejects.toThrow(/shrink/)
    expect(generate).toHaveBeenCalledTimes(2)
  })
})
