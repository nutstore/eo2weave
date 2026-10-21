import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message as PiMessage } from '@earendil-works/pi-ai'
import type { Message } from '@/agent/message-types'
import { executePiCoreLoop, type ExecutePiCoreLoopInput } from '@/agent/loop/pi-core-runner'
import { foldContext } from '@/agent/context/journal'

const hooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@earendil-works/pi-agent-core', () => ({ agentLoopContinue: (...args: unknown[]) => hooks.run(...args) }))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: { getState: () => ({}) } }))

const model = { id: 'test', api: 'openai-completions', provider: 'test', maxTokens: 1024 }
const user: Message = { id: 'user', role: 'user', content: 'Hello', timestamp: 1 }
function options(history: Message[] = [user]): ExecutePiCoreLoopInput {
  return {
    initialMessages: history, signal: new AbortController().signal,
    baseSystemPrompt: 'fixed', mode: 'act', getToolContext: () => ({ directoryHandle: null }),
    toolRegistry: { getToolDefinitionsForMode: () => [] } as unknown as ExecutePiCoreLoopInput['toolRegistry'],
    provider: { getModel: () => model, getApiKey: () => 'key', estimateTokens: () => 10 } as unknown as ExecutePiCoreLoopInput['provider'],
    contextManager: { getConfig: () => ({ systemPrompt: 'fixed', maxContextTokens: 10000 }) } as unknown as ExecutePiCoreLoopInput['contextManager'],
    toolExecutionTimeout: 1000, toolTimeoutExemptions: new Set(), maxIterations: 10,
    convertCallCount: 0, lastSummaryConvertCall: -Infinity, compressedMemoryPrefix: 'Summary:',
    generateContextSummaryWithLLM: async () => ({ summary: 'Earlier task', mode: 'llm' }),
  }
}

type Convert = { convertToLlm: (messages: AgentMessage[]) => Promise<PiMessage[]> }

describe('context admission at model call boundaries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('preserves the entire previous request when a source changes mid-run, then survives resume', async () => {
    let state = { a: 'A' } as Record<string, string>
    const requests: PiMessage[][] = []
    const saved: Message[][] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      requests.push(structuredClone(await config.convertToLlm(context.messages)))
      state = { a: 'A', b: 'B' }
      requests.push(structuredClone(await config.convertToLlm(context.messages)))
      requests.push(structuredClone(await config.convertToLlm(context.messages)))
    })())
    const result = await executePiCoreLoop({
      ...options(), collectContext: async () => [{ sourceId: 'environment', entries: state }],
      callbacks: { onContextCommit: async messages => { saved.push(structuredClone(messages)) } },
    })
    expect(saved).toHaveLength(2)
    expect(requests[1].slice(0, requests[0].length)).toEqual(requests[0])
    expect(requests[2]).toEqual(requests[1])
    expect(foldContext(result.allMessages).get('environment')!.entries).toEqual(state)
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      requests.push(structuredClone(await config.convertToLlm(context.messages)))
    })())
    const onContextCommit = vi.fn(async () => {})
    await executePiCoreLoop({ ...options(JSON.parse(JSON.stringify(result.allMessages))),
      collectContext: async () => [{ sourceId: 'environment', entries: state }], callbacks: { onContextCommit } })
    expect(onContextCommit).not.toHaveBeenCalled()
    expect(requests[3]).toEqual(requests[2])
  })

  it('rebuilds context after automatic compression once and keeps subsequent requests identical', async () => {
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      await config.convertToLlm(context.messages)
    })())
    const first = await executePiCoreLoop({ ...options(), collectContext: async () => [{ sourceId: 'x', entries: { a: 'A' } }] })
    const history: Message[] = [...first.allMessages, {
      id: 'large-assistant', role: 'assistant', content: 'Earlier answer', timestamp: Date.now() + 10,
      usage: { promptTokens: 8900, completionTokens: 100, totalTokens: 9000 },
    }]
    const requests: PiMessage[][] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      requests.push(await config.convertToLlm(context.messages))
      requests.push(await config.convertToLlm(context.messages))
    })())
    const summary = vi.fn(async () => ({ summary: 'Earlier task', mode: 'llm' as const }))
    const result = await executePiCoreLoop({ ...options(history),
      generateContextSummaryWithLLM: summary,
      collectContext: async () => [{ sourceId: 'x', entries: { a: 'A', b: 'B' } }],
    })
    expect(summary).toHaveBeenCalledOnce()
    expect(requests[0]).toHaveLength(2)
    // Summary metadata can be rebuilt, but the complete model-visible prefix is unchanged.
    expect(requests[1]).toEqual(requests[0])
    expect(result.allMessages.at(-1)!.contextCommit!.changes[0].snapshot).toEqual({ a: 'A', b: 'B' })
  })

  it('never publishes or dispatches a context update when durable commit fails', async () => {
    const dispatched = vi.fn()
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      await config.convertToLlm(context.messages)
      dispatched()
    })())
    const onMessagesUpdated = vi.fn()
    await expect(executePiCoreLoop({ ...options(), collectContext: async () => [{ sourceId: 'x', entries: { a: 'A' } }],
      callbacks: { onContextCommit: async () => { throw new Error('disk full') }, onMessagesUpdated },
    })).rejects.toThrow('disk full')
    expect(dispatched).not.toHaveBeenCalled()
    expect(onMessagesUpdated).not.toHaveBeenCalled()
  })

  it('reintroduces a full baseline after a persisted summary without replaying old patches', async () => {
    let history: Message[] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      await config.convertToLlm(context.messages)
    })())
    const first = await executePiCoreLoop({ ...options(), collectContext: async () => [{ sourceId: 'x', entries: { a: 'A' } }] })
    history = [...first.allMessages, { id: 'summary', role: 'user', kind: 'context_summary', content: 'Earlier task', timestamp: Date.now() + 100 }]
    let sent: PiMessage[] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      sent = await config.convertToLlm(context.messages)
    })())
    const result = await executePiCoreLoop({ ...options(history), collectContext: async () => [] })
    expect(sent).toHaveLength(2)
    expect(result.allMessages.at(-1)!.contextCommit!.changes[0].snapshot).toEqual({ a: 'A' })
    expect(result.allMessages.at(-1)!.contextCommit!.epoch).not.toBe(first.allMessages.at(-1)!.contextCommit!.epoch)
  })
})
