import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Message as PiMessage } from '@earendil-works/pi-ai'
import type { Message } from '@/agent/message-types'
import { executePiCoreLoop, type ExecutePiCoreLoopInput } from '@/agent/loop/pi-core-runner'
import { foldContext } from '@/agent/context/journal'

const hooks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@/agent/loop/agent-loop-stream', () => ({ continueAgentLoop: (...args: unknown[]) => hooks.run(...args) }))
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
      id: 'large-assistant', role: 'assistant', content: 'Earlier answer '.repeat(500), timestamp: Date.now() + 10,
      usage: { promptTokens: 8900, completionTokens: 100, totalTokens: 9000 },
    }, { id: 'followup', role: 'user', content: 'Continue', timestamp: Date.now() + 11 }]
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
    expect(requests[0]).toHaveLength(3)
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

  it('rejects an oversized runtime snapshot before persisting or dispatching it', async () => {
    const dispatched = vi.fn()
    const onContextCommit = vi.fn(async () => {})
    const onMessagesUpdated = vi.fn()
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      await config.convertToLlm(context.messages)
      dispatched()
    })())
    await expect(executePiCoreLoop({
      ...options(),
      collectContext: async () => [{ sourceId: 'skill', entries: { manual: 'x'.repeat(40000) } }],
      callbacks: { onContextCommit, onMessagesUpdated },
    })).rejects.toThrow('cannot fit')
    expect(onContextCommit).not.toHaveBeenCalled()
    expect(onMessagesUpdated).not.toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
  })

  it('compresses older history to admit a newly enabled skill and commits the complete checkpoint once', async () => {
    const history: Message[] = [user, {
      id: 'older-work', role: 'assistant', content: 'old '.repeat(3500), timestamp: 2,
      usage: { promptTokens: 6000, completionTokens: 1000, totalTokens: 7000 },
    }, { id: 'followup', role: 'user', content: 'Use the newly enabled skill', timestamp: 3 }]
    const manual = 'manual '.repeat(1900)
    const summary = vi.fn(async () => ({ summary: 'Earlier task and verified work', mode: 'llm' as const }))
    const commits: Message[][] = []
    let persisted = false
    let sent: PiMessage[] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      sent = await config.convertToLlm(context.messages)
    })())
    const base = options(history)
    const result = await executePiCoreLoop({ ...base,
      contextManager: { getConfig: () => ({ systemPrompt: 'fixed', maxContextTokens: 10000, reserveTokens: 1000 }) } as ExecutePiCoreLoopInput['contextManager'],
      generateContextSummaryWithLLM: summary,
      collectContext: async () => [{ sourceId: 'skill', entries: { manual } }],
      callbacks: {
        onContextCommit: async messages => { commits.push(messages); persisted = true },
        onMessagesUpdated: () => { expect(persisted).toBe(true) },
      },
    })
    expect(summary).toHaveBeenCalledOnce()
    expect(commits).toHaveLength(1)
    expect(commits[0].some(message => message.kind === 'context_summary')).toBe(true)
    expect(commits[0].some(message => message.kind === 'context_update')).toBe(true)
    expect(foldContext(result.allMessages).get('skill')!.entries.manual).toBe(manual)
    expect(JSON.stringify(sent)).toContain('Earlier task and verified work')
    expect(JSON.stringify(sent)).toContain(manual)
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

  it('retains the fitting journal patch when proactive compression fails', async () => {
    const entries = { manual: 'original manual '.repeat(350) }
    let sent: PiMessage[] = []
    hooks.run.mockImplementation((context: { messages: AgentMessage[] }, config: Convert) => (async function* () {
      sent = await config.convertToLlm(context.messages)
    })())
    const first = await executePiCoreLoop({ ...options(), collectContext: async () => [{ sourceId: 'skill', entries }] })
    const olderWork = 'earlier work '.repeat(1000)
    const history: Message[] = [...first.allMessages, {
      id: 'work-before-failed-summary', role: 'assistant', content: olderWork, timestamp: Date.now(),
      usage: { promptTokens: 8900, completionTokens: 100, totalTokens: 9000 },
    }, { id: 'next-task', role: 'user', content: 'Continue', timestamp: Date.now() }]
    const summary = vi.fn(async () => { throw new Error('summary unavailable') })
    const collectContext = vi.fn(async () => [{ sourceId: 'skill', entries: { ...entries, added: 'new rule' } }])
    const result = await executePiCoreLoop({ ...options(history), generateContextSummaryWithLLM: summary, collectContext })
    expect(summary).toHaveBeenCalledTimes(2)
    expect(collectContext).toHaveBeenCalledOnce()
    expect(result.allMessages.some(message => message.kind === 'context_summary')).toBe(false)
    expect(result.allMessages.at(-1)!.contextCommit!.changes[0].snapshot).toBeUndefined()
    expect(foldContext(result.allMessages).get('skill')!.entries).toEqual({ ...entries, added: 'new rule' })
    expect(JSON.stringify(sent)).toContain(olderWork)
  })
})
