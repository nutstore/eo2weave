import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../message-types'
import { compressHistory } from '../loop/compression-runner'

const history: Message[] = [
  { id: 'task', role: 'user', content: 'x'.repeat(1200) + ' FINAL_CONSTRAINT', timestamp: 1 },
  { id: 'work', role: 'assistant', content: 'older work '.repeat(1200), timestamp: 2 },
  { id: 'tail', role: 'assistant', content: 'recent work', timestamp: 3 },
]
describe('shared compression runner', () => {
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
