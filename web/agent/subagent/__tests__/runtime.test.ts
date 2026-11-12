import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubagentTaskStore } from '@/store/subagent-task.store'
import type { Message } from '@/agent/message-types'
import type {
  SubagentStepNotification,
  SubagentTaskNotification,
  SubagentRuntime,
} from '@/agent/tools/tool-types'
import { __resetSubagentRuntimeRegistryForTests, getOrCreateSubagentRuntime, disposeSubagentRuntime } from '@/agent/subagent/runtime'

const hoisted = vi.hoisted(() => {
  const repo = {
    findByWorkspaceId: vi.fn(async () => []),
    saveBatch: vi.fn(async () => {}),
    transitionStatus: vi.fn(async () => ({ applied: true })),
    getStatus: vi.fn(async () => null),
    finishExecution: vi.fn(async (_input: { task: unknown; completion: import('@/agent/subagent/async-types').SubagentCompletion }) => {}),
    suppressAgent: vi.fn(async () => {}),
    consume: vi.fn(async () => true),
    find: vi.fn(async () => null),
  }

  const loopConfigs: any[] = []
  let runImpl: (messages: Message[], config: any, callbacks?: any) => Promise<Message[]> = async (messages) => messages

  return {
    repo,
    loopConfigs,
    setRunImpl: (impl: (messages: Message[], config: any, callbacks?: any) => Promise<Message[]>) => {
      runImpl = impl
    },
    getRunImpl: () => runImpl,
  }
})

vi.mock('@/sqlite', () => ({
  getSubagentRepository: () => hoisted.repo,
  getSubagentCompletionRepository: () => hoisted.repo,
}))

vi.mock('@/agent/agent-loop', () => {
  class MockAgentLoop {
    private config: any

    constructor(config: any) {
      this.config = config
      hoisted.loopConfigs.push(config)
    }

    cancel(): void {
      // no-op in tests; run completion is controlled by deferred promises
    }

    async run(messages: Message[], callbacks?: any): Promise<Message[]> {
      return hoisted.getRunImpl()(messages, this.config, callbacks)
    }
  }

  return { AgentLoop: MockAgentLoop }
})

let assistantMessageId = 0
function createAssistantMessage(content: string): Message {
  return {
    id: `assistant-${Date.now()}-${assistantMessageId++}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    },
  }
}

function createStoredTask(input: {
  workspaceId: string
  agentId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  name?: string
  parentToolCallId?: string
  messages?: Message[]
  queue?: Array<{ message: string; enqueued_at: number }>
  timeout_ms?: number
}): Record<string, unknown> {
  const now = Date.now()
  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    name: input.name,
    description: 'persisted task',
    status: input.status,
    mode: 'act',
    subagent_type: 'general-purpose',
    parentToolCallId: input.parentToolCallId,
    timeout_ms: input.timeout_ms,
    messages: input.messages || [],
    queue: input.queue || [],
    usage: undefined,
    error: undefined,
    stopped: false,
    created_at: now - 5000,
    updated_at: now - 1000,
    last_activity_at: now - 1000,
  }
}

/** Type guard: filter union array to SubagentTaskNotification entries only. */
function taskNotifications(
  events: (SubagentTaskNotification | SubagentStepNotification)[]
): SubagentTaskNotification[] {
  return events.filter(
    (e): e is SubagentTaskNotification => e.event_type === 'task_notification'
  )
}

function createRuntime(
  workspaceId: string,
  notifications: (SubagentTaskNotification | SubagentStepNotification)[],
  onWorkspacePathsChanged?: (paths: readonly string[]) => void,
): SubagentRuntime {
  return getOrCreateSubagentRuntime({
    workspaceId,
    provider: {} as any,
    toolRegistry: {} as any,
    contextManager: {
      getConfig: () => ({
        maxContextTokens: 128000,
        reserveTokens: 4096,
        enableSummarization: false,
        maxMessageGroups: 20,
      }),
    } as any,
    baseToolContext: {
      directoryHandle: null,
      workspaceId,
      agentMode: 'act',
      onWorkspacePathsChanged,
    },
    onNotification: (event) => notifications.push(event),
  })
}

async function waitForStatus(runtime: SubagentRuntime, agentIdOrName: string, status: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const current = await runtime.getStatus({ agentId: agentIdOrName })
    if (current.status === status) return
    await Promise.resolve()
  }
  throw new Error(`status did not reach ${status}`)
}

/** Like waitForStatus, but advances fake timers so spawned tasks actually start. */
async function waitForStatusWithTimers(
  runtime: SubagentRuntime,
  agentIdOrName: string,
  status: string
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const current = await runtime.getStatus({ agentId: agentIdOrName })
    if (current.status === status) return
    await vi.advanceTimersByTimeAsync(1)
  }
  throw new Error(`status did not reach ${status}`)
}

describe('subagent runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    __resetSubagentRuntimeRegistryForTests()
    useSubagentTaskStore.setState({ tasks: {} })
    hoisted.loopConfigs.length = 0
    hoisted.repo.findByWorkspaceId.mockImplementation(async () => [])
    hoisted.repo.transitionStatus.mockImplementation(async () => ({ applied: true }))
    hoisted.repo.getStatus.mockImplementation(async () => null)
    hoisted.setRunImpl(async (messages) => [...messages, createAssistantMessage('ok')])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('accepts an async task durably before its deferred execution finishes', async () => {
    let finish!: (messages: Message[]) => void
    hoisted.setRunImpl(() => new Promise((resolve) => { finish = resolve }))
    const events: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime('async-accept', events)
    const receipt = await runtime.start({ description: 'async task', prompt: 'work' })
    expect(receipt).toMatchObject({ agentId: expect.any(String), description: 'async task' })
    expect(['pending', 'running']).toContain(receipt.status)
    expect(hoisted.repo.saveBatch).toHaveBeenCalled()
    await waitForStatusWithTimers(runtime, receipt.agentId, 'running')
    expect(events.filter((e) => e.event_type === 'task_notification' && e.status === 'completed')).toHaveLength(0)
    finish([createAssistantMessage('durable result')])
    await vi.advanceTimersByTimeAsync(1)
    expect(hoisted.repo.finishExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ messages: expect.arrayContaining([expect.objectContaining({ content: 'durable result' })]) }),
      completion: expect.objectContaining({ result: 'durable result', status: 'pending' }),
    }))
  })

  it('rejects async acceptance when initial persistence fails', async () => {
    const runtime = createRuntime('async-persist-fail', [])
    hoisted.repo.saveBatch.mockRejectedValueOnce(new Error('disk full'))
    await expect(runtime.start({ description: 'task', prompt: 'work' })).rejects.toThrow('disk full')
    expect((await runtime.list({})).total).toBe(0)
    expect(hoisted.loopConfigs).toHaveLength(0)
  })

  it('freezes active execution callbacks when runtime dependencies change', async () => {
    let finish!: (messages: Message[]) => void
    hoisted.setRunImpl(() => new Promise((resolve) => { finish = resolve }))
    const first = vi.fn()
    const second = vi.fn()
    const runtime = createRuntime('async-frozen', [], first)
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await waitForStatusWithTimers(runtime, receipt.agentId, 'running')
    createRuntime('async-frozen', [], second)
    hoisted.loopConfigs[0].toolContext.onWorkspacePathsChanged(['original.ts'])
    expect(first).toHaveBeenCalledWith(['original.ts'])
    expect(second).not.toHaveBeenCalled()
    finish([createAssistantMessage('done')])
    await vi.advanceTimersByTimeAsync(1)
    expect(hoisted.repo.finishExecution.mock.calls[0][0].completion.changedPaths).toEqual(['original.ts'])
  })

  it('wait times out without cancelling then atomically consumes its execution result', async () => {
    let finish!: (messages: Message[]) => void
    hoisted.setRunImpl(() => new Promise((resolve) => { finish = resolve }))
    const runtime = createRuntime('async-wait', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    const waiting = runtime.wait({ agentIds: [receipt.agentId], timeout_ms: 10, wait_for: 'all' })
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toMatchObject({ results: [], pending: [receipt.agentId], timed_out: true })
    finish([createAssistantMessage('wait result')])
    await vi.advanceTimersByTimeAsync(1)
    const result = await runtime.wait({ agentIds: [receipt.agentId], timeout_ms: 0 })
    expect(result.results).toEqual([expect.objectContaining({ agentId: receipt.agentId, result: 'wait result' })])
    expect(hoisted.repo.consume).toHaveBeenCalledWith(expect.any(String))
    expect(useSubagentTaskStore.getState().tasks[receipt.agentId].deliveryPhase).toBe('consumed')
  })

  it('retains the first completion and gives a queued follow-up its own execution identity', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-followup', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'first' })
    await waitForStatusWithTimers(runtime, receipt.agentId, 'running')
    await runtime.sendMessage({ to: receipt.agentId, message: 'second' })
    const waiting = runtime.wait({ agentIds: [receipt.agentId], timeout_ms: 1 })
    resolvers[0]([createAssistantMessage('first result')])
    await vi.advanceTimersByTimeAsync(1)
    expect((await waiting).pending).toEqual([receipt.agentId])
    expect(resolvers).toHaveLength(2)
    resolvers[1]([createAssistantMessage('second result')])
    await vi.advanceTimersByTimeAsync(1)
    const completions = hoisted.repo.finishExecution.mock.calls.map(([input]) => input.completion)
    expect(completions).toHaveLength(2)
    expect(completions[0].executionId).not.toBe(completions[1].executionId)
    expect(completions.map((c) => c.result)).toEqual(['first result', 'second result'])
  })

  it('suppresses a finished async completion when explicitly stopped', async () => {
    const runtime = createRuntime('async-stop-finished', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(1)
    await runtime.stop({ agentId: receipt.agentId })
    expect(hoisted.repo.suppressAgent).toHaveBeenCalledWith('async-stop-finished', receipt.agentId)
  })

  it('batch accepts valid members independently while enforcing the batch limit', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-batch', [])
    const result = await runtime.batchStart({ tasks: [
      { description: 'one', prompt: 'work' },
      { description: '', prompt: 'invalid' },
      { description: 'two', prompt: 'work' },
    ], max_concurrency: 1 })
    expect(result.accepted.map((r) => r.task_index)).toEqual([0, 2])
    expect(result.rejected.map((r) => r.task_index)).toEqual([1])
    await vi.advanceTimersByTimeAsync(1)
    expect(resolvers).toHaveLength(1)
    resolvers[0]([createAssistantMessage('one')])
    await vi.advanceTimersByTimeAsync(1)
    expect(resolvers).toHaveLength(2)
    resolvers[1]([createAssistantMessage('two')])
    await vi.advanceTimersByTimeAsync(1)
  })

  it('defaults a multi-target wait to any and leaves the other execution pending', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-wait-any', [])
    const one = await runtime.start({ description: 'one', prompt: 'work' })
    const two = await runtime.start({ description: 'two', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const waiting = runtime.wait({ agentIds: [one.agentId, two.agentId], timeout_ms: 100 })
    resolvers[0]([createAssistantMessage('first')])
    await vi.advanceTimersByTimeAsync(0)
    expect(await waiting).toMatchObject({ results: [{ agentId: one.agentId }], pending: [two.agentId], timed_out: false })
    resolvers[1]([createAssistantMessage('second')])
    await vi.advanceTimersByTimeAsync(0)
  })

  it('keeps the runtime cap of five across background batches and individual starts', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-global-cap', [])
    await runtime.batchStart({ tasks: Array.from({ length: 5 }, (_, i) => ({ description: String(i), prompt: 'work' })) })
    await runtime.start({ description: 'six', prompt: 'work' })
    await runtime.start({ description: 'seven', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(5)
    resolvers[0]([createAssistantMessage('one')])
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(6)
    resolvers[1]([createAssistantMessage('two')])
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvers).toHaveLength(7)
    resolvers.slice(2).forEach((finish) => finish([createAssistantMessage('done')]))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('captures queued provider/config/permissions before it waits for a slot', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-queued-freeze', [])
    await runtime.batchStart({ tasks: Array.from({ length: 6 }, (_, i) => ({ description: String(i), prompt: 'work' })) })
    await vi.advanceTimersByTimeAsync(0)
    const originalProvider = hoisted.loopConfigs[0].provider
    createRuntime('async-queued-freeze', [])
    resolvers[0]([createAssistantMessage('done')])
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.loopConfigs[5].provider).toBe(originalProvider)
    resolvers.slice(1).forEach((finish) => finish([createAssistantMessage('done')]))
    await vi.advanceTimersByTimeAsync(0)
  })

  it('saves the latest child trace before stop and ignores late streaming snapshots', async () => {
    let callbacks: any
    let finish!: (messages: Message[]) => void
    hoisted.setRunImpl((_messages, _config, currentCallbacks) => {
      callbacks = currentCallbacks
      return new Promise((resolve) => { finish = resolve })
    })
    const runtime = createRuntime('async-trace-stop', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const trace: Message[] = [createAssistantMessage('tool call trace'), { id: 'tool1', role: 'tool', content: 'tool output', timestamp: Date.now() }]
    callbacks.onMessagesUpdated(trace)
    expect(useSubagentTaskStore.getState().tasks[receipt.agentId].messages).toEqual(trace)
    await runtime.stop({ agentId: receipt.agentId, force: true })
    expect(hoisted.repo.finishExecution.mock.calls[0][0].completion.messages).toEqual(trace)
    callbacks.onMessagesUpdated([createAssistantMessage('late callback')])
    finish([createAssistantMessage('late result')])
    await vi.advanceTimersByTimeAsync(0)
    expect(useSubagentTaskStore.getState().tasks[receipt.agentId].messages).toEqual(trace)
  })

  it('publishes hydrated async interrupted tasks without restarting or auto notifying', async () => {
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([{
      ...createStoredTask({ workspaceId: 'async-hydrate', agentId: 'persisted', status: 'running' }),
      execution: { executionId: 'old-attempt', isAsync: true, conversationId: 'async-hydrate', suppressed: false, changedPaths: [] },
    }] as never)
    const runtime = createRuntime('async-hydrate', [])
    await runtime.list({})
    expect(useSubagentTaskStore.getState().tasks.persisted).toMatchObject({ status: 'failed', isAsync: true,
      executionId: 'old-attempt', error: { code: 'SESSION_INTERRUPTED' } })
    expect(hoisted.loopConfigs).toHaveLength(0)
    expect(hoisted.repo.finishExecution).not.toHaveBeenCalled()
  })

  it('uses a fresh origin and execution identity on resume and excludes prior usage', async () => {
    const runtime = createRuntime('async-resume-origin', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'first' })
    await vi.advanceTimersByTimeAsync(0)
    getOrCreateSubagentRuntime({ workspaceId: 'async-resume-origin', provider: {} as any, toolRegistry: {} as any,
      contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null, workspaceId: 'async-resume-origin' },
      continuation: { parentRunId: 'run2', providerType: 'test', modelName: 'model2', maxTokens: 1000, projectId: 'p2' } })
    await runtime.resume({ agentId: receipt.agentId, prompt: 'second' })
    await vi.advanceTimersByTimeAsync(0)
    const [first, second] = hoisted.repo.finishExecution.mock.calls.map(([input]) => input.completion)
    expect(first.executionId).not.toBe(second.executionId)
    expect(second.continuation).toMatchObject({ parentRunId: 'run2', modelName: 'model2', projectId: 'p2' })
    expect(first.usage?.total_tokens).toBe(30)
    expect(second.usage?.total_tokens).toBe(30)
    expect(second.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  })

  it('notifies ready only after terminal trace and usage are durable', async () => {
    let finishPersist!: () => void
    hoisted.repo.finishExecution.mockImplementationOnce(() => new Promise((resolve) => { finishPersist = resolve }))
    const ready = vi.fn()
    const runtime = createRuntime('async-ready-order', [])
    getOrCreateSubagentRuntime({ workspaceId: 'async-ready-order', provider: {} as any, toolRegistry: {} as any,
      contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null }, onCompletionReady: ready })
    await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).not.toHaveBeenCalled()
    const snapshot = hoisted.repo.finishExecution.mock.calls[0][0].completion
    expect(snapshot.messages.at(-1)?.content).toBe('ok')
    expect(snapshot.usage?.total_tokens).toBe(30)
    finishPersist()
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: snapshot.id }))
  })

  it('suppresses a ready notification when stop races terminal persistence', async () => {
    let finishPersist!: () => void
    hoisted.repo.finishExecution.mockImplementationOnce(() => new Promise((resolve) => { finishPersist = resolve }))
    const ready = vi.fn()
    const runtime = createRuntime('async-stop-race', [])
    getOrCreateSubagentRuntime({ workspaceId: 'async-stop-race', provider: {} as any, toolRegistry: {} as any,
      contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null }, onCompletionReady: ready })
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    await runtime.stop({ agentId: receipt.agentId, force: true })
    finishPersist()
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).not.toHaveBeenCalled()
  })

  it('waits on a hydrated completed execution using its durable completion', async () => {
    const stored = createStoredTask({ workspaceId: 'async-hydrated-wait', agentId: 'persisted', status: 'completed' })
    const execution = { executionId: 'e1', isAsync: true, conversationId: 'async-hydrated-wait', suppressed: false, changedPaths: [] }
    const completion = { id: 'persisted:e1', agentId: 'persisted', executionId: 'e1', status: 'pending', result: 'saved result' }
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([{ ...stored, execution }] as never)
    hoisted.repo.find.mockResolvedValueOnce(completion as never)
    const runtime = createRuntime('async-hydrated-wait', [])
    const result = await runtime.wait({ agentIds: ['persisted'], timeout_ms: 0 })
    expect(result.results).toEqual([expect.objectContaining({ result: 'saved result' })])
    expect(hoisted.repo.consume).toHaveBeenCalledWith('persisted:e1')
  })

  it('returns a hydrated interrupted outcome immediately without creating a wakeup', async () => {
    const execution = { executionId: 'e1', isAsync: true, conversationId: 'async-interrupted-wait', suppressed: false, changedPaths: [] }
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([{
      ...createStoredTask({ workspaceId: 'async-interrupted-wait', agentId: 'persisted', status: 'running' }), execution,
    }] as never)
    const runtime = createRuntime('async-interrupted-wait', [])
    const result = await runtime.wait({ agentIds: ['persisted'], timeout_ms: 0 })
    expect(result.results).toEqual([expect.objectContaining({ taskStatus: 'failed', error: { code: 'SESSION_INTERRUPTED', message: expect.any(String) } })])
    expect(result.pending).toEqual([])
    expect(hoisted.repo.finishExecution).not.toHaveBeenCalled()
  })

  it('never serializes provider secrets or callback dependencies in queued task persistence', async () => {
    hoisted.setRunImpl(() => new Promise(() => {}))
    const runtime = getOrCreateSubagentRuntime({ workspaceId: 'async-no-secrets', provider: { apiKey: 'secret-provider' } as any,
      toolRegistry: {} as any, contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null, workspaceId: 'async-no-secrets' },
      continuation: { parentRunId: 'r1', providerType: 'test', modelName: 'model', maxTokens: 1000, apiKey: 'secret-origin' } as any })
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await runtime.sendMessage({ to: receipt.agentId, message: 'next' })
    await vi.advanceTimersByTimeAsync(0)
    const serialized = JSON.stringify(hoisted.repo.saveBatch.mock.calls)
    expect(serialized).not.toContain('secret-provider')
    expect(serialized).not.toContain('secret-origin')
    expect(serialized).not.toContain('baseToolContext')
    await runtime.stop({ agentId: receipt.agentId, force: true })
  })

  it('persists a queued follow-up as unfinished when the previous attempt completes', async () => {
    const resolvers: Array<(messages: Message[]) => void> = []
    hoisted.setRunImpl(() => new Promise((resolve) => { resolvers.push(resolve) }))
    const runtime = createRuntime('async-followup-snapshot', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'first' })
    await vi.advanceTimersByTimeAsync(0)
    await runtime.sendMessage({ to: receipt.agentId, message: 'second' })
    resolvers[0]([createAssistantMessage('first result')])
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.repo.finishExecution.mock.calls[0][0].task).toMatchObject({ status: 'pending', queue: [{ message: 'second' }] })
    resolvers[1]([createAssistantMessage('second result')])
    await vi.advanceTimersByTimeAsync(0)
  })

  it('shows terminal persistence failure and never announces an undurable completion', async () => {
    const ready = vi.fn()
    hoisted.repo.finishExecution.mockRejectedValueOnce(new Error('disk unavailable'))
    const runtime = createRuntime('async-terminal-persist-failure', [])
    getOrCreateSubagentRuntime({ workspaceId: 'async-terminal-persist-failure', provider: {} as any, toolRegistry: {} as any,
      contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null }, onCompletionReady: ready })
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).not.toHaveBeenCalled()
    expect(useSubagentTaskStore.getState().tasks[receipt.agentId]).toMatchObject({ status: 'failed', error: { code: 'TERMINAL_PERSISTENCE_FAILED' } })
    const genericSnapshots = hoisted.repo.saveBatch.mock.calls.flatMap((call: any) => call[1])
    expect(genericSnapshots.some((task: any) => task.status === 'completed')).toBe(false)
  })

  it('returns stopped outcomes for queued execution identities', async () => {
    hoisted.setRunImpl(() => new Promise(() => {}))
    const runtime = createRuntime('async-stop-queued', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'first' })
    await runtime.sendMessage({ to: receipt.agentId, message: 'second' })
    await runtime.stop({ agentId: receipt.agentId, force: true })
    const result = await runtime.wait({ agentIds: [receipt.agentId], timeout_ms: 0 })
    expect(result.pending).toEqual([])
    expect(result.results).toEqual([expect.objectContaining({ taskStatus: 'killed', status: 'suppressed' })])
  })

  it('persists partial usage and trace on unexpected failure', async () => {
    hoisted.setRunImpl(async (_messages, _config, callbacks) => {
      callbacks.onMessagesUpdated([createAssistantMessage('partial result')])
      throw new Error('provider failed')
    })
    const runtime = createRuntime('async-failure-usage', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const completion = hoisted.repo.finishExecution.mock.calls[0][0].completion
    expect(completion).toMatchObject({ taskStatus: 'failed', error: { code: 'SUBAGENT_FAILED' }, usage: { total_tokens: 30 } })
    expect((await runtime.wait({ agentIds: [receipt.agentId], timeout_ms: 0 })).pending).toEqual([])
  })

  it('does not hold execution slots while the ready callback dispatches a parent run', async () => {
    const ready = vi.fn(() => new Promise<void>(() => {}))
    const runtime = createRuntime('async-callback-slots', [])
    getOrCreateSubagentRuntime({ workspaceId: 'async-callback-slots', provider: {} as any, toolRegistry: {} as any,
      contextManager: { getConfig: () => ({ maxContextTokens: 1000, reserveTokens: 100 }) } as any,
      baseToolContext: { directoryHandle: null }, onCompletionReady: ready })
    await runtime.batchStart({ tasks: Array.from({ length: 6 }, (_, i) => ({ description: String(i), prompt: 'work' })) })
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).toHaveBeenCalledTimes(6)
  })

  it('does not recreate deleted task rows from a disposed runtime after a late result', async () => {
    let finish!: (messages: Message[]) => void
    hoisted.setRunImpl(() => new Promise((resolve) => { finish = resolve }))
    const runtime = createRuntime('async-dispose', [])
    await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    disposeSubagentRuntime('async-dispose')
    hoisted.repo.saveBatch.mockClear()
    finish([createAssistantMessage('late result')])
    await vi.advanceTimersByTimeAsync(0)
    expect(hoisted.repo.saveBatch).not.toHaveBeenCalled()
    expect(hoisted.repo.finishExecution).not.toHaveBeenCalled()
  })

  it('keeps externally delivered phase during progress and publishes suppression on stop', async () => {
    const runtime = createRuntime('async-store-phase', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const executionId = useSubagentTaskStore.getState().tasks[receipt.agentId].executionId!
    useSubagentTaskStore.getState().setDeliveryPhase(receipt.agentId, executionId, 'delivered')
    await runtime.stop({ agentId: receipt.agentId })
    expect(useSubagentTaskStore.getState().tasks[receipt.agentId].deliveryPhase).toBe('suppressed')
  })

  it('disposes wait timers and abort listeners without stopping the child', async () => {
    hoisted.setRunImpl(() => new Promise(() => {}))
    const runtime = createRuntime('async-wait-abort', [])
    const receipt = await runtime.start({ description: 'task', prompt: 'work' })
    await vi.advanceTimersByTimeAsync(0)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const timerCount = vi.getTimerCount()
    const waiting = runtime.wait({ agentIds: [receipt.agentId], signal: controller.signal })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(await waiting).toMatchObject({ results: [], pending: [receipt.agentId], timed_out: false })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(timerCount)
    expect((await runtime.getStatus({ agentId: receipt.agentId })).status).toBe('running')
    await runtime.stop({ agentId: receipt.agentId, force: true })
  })

  it('spawn blocks until completion and returns result', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-blocking-${Date.now()}`, notifications)
    const result = await runtime.spawn({
      description: 'blocking test',
      prompt: 'run',
    })
    expect(result.status).toBe('completed')
    expect(result.content).toBe('ok')
    expect(result.agentId).toBeTruthy()
    expect(result.usage).toBeDefined()
    expect(taskNotifications(notifications).some((event) => event.status === 'completed')).toBe(true)
  })

  it('forces explorer subagents into plan mode', async () => {
    const runtime = createRuntime(`workspace-explorer-${Date.now()}`, [])

    await runtime.spawn({
      description: 'inspect code',
      prompt: 'find the relevant implementation',
      mode: 'act',
      subagent_type: 'explorer',
    })

    expect(hoisted.loopConfigs).toHaveLength(1)
    expect(hoisted.loopConfigs[0].mode).toBe('plan')
    expect(hoisted.loopConfigs[0].toolContext.agentMode).toBe('plan')
    expect(hoisted.loopConfigs[0].toolContext.isSubagent).toBe(true)
    expect(hoisted.loopConfigs[0].systemPrompt).toContain('Role: Explorer')
  })

  it('includes the owning tool-call ID in subagent notifications', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-parent-call-${Date.now()}`, notifications)

    await runtime.spawn({
      description: 'correlated task',
      prompt: 'run',
      parentToolCallId: 'spawn-call-a',
    })

    expect(notifications.find((event) => event.event_type === 'task_notification')).toMatchObject({
      agentId: expect.any(String),
      parentToolCallId: 'spawn-call-a',
    })
  })

  it('reserves a completed task name for status and resume lookup', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-name-reuse-${Date.now()}`, notifications)

    const first = await runtime.spawn({
      description: 'first run',
      prompt: 'do something',
      name: 'my-agent',
    })
    expect(first.status).toBe('completed')

    await expect(
      runtime.spawn({
        description: 'second run',
        prompt: 'do something else',
        name: 'my-agent',
      })
    ).rejects.toMatchObject({ code: 'NAME_CONFLICT' })
  })

  it('keeps completed task in memory after spawn for status lookup', async () => {
    const runtime = createRuntime(`workspace-cleanup-${Date.now()}`, [])
    const result = await runtime.spawn({
      description: 'cleanup test',
      prompt: 'run',
    })
    await expect(runtime.getStatus({ agentId: result.agentId })).resolves.toMatchObject({
      status: 'completed',
    })
  })

  it('rebuilds child loop context from current runtime deps when resuming in a later parent run', async () => {
    const workspaceId = `workspace-context-refresh-${Date.now()}`
    const firstRunPaths: string[] = []
    const secondRunPaths: string[] = []
    const runtime = createRuntime(workspaceId, [], (paths) => firstRunPaths.push(...paths))

    const spawned = await runtime.spawn({
      description: 'context refresh test',
      prompt: 'first pass',
    })
    const firstContext = hoisted.loopConfigs[0].toolContext

    const refreshedRuntime = createRuntime(workspaceId, [], (paths) => secondRunPaths.push(...paths))
    await refreshedRuntime.resume({ agentId: spawned.agentId, prompt: 'second pass' })
    await waitForStatus(refreshedRuntime, spawned.agentId, 'completed')

    // The completed task's live loop/context are released (memory hygiene);
    // resume builds a FRESH context from the current runtime deps, so stale
    // parent-run callbacks can never leak into the resumed child by design.
    expect(hoisted.loopConfigs).toHaveLength(2)
    const resumedContext = hoisted.loopConfigs[1].toolContext
    expect(resumedContext).not.toBe(firstContext)
    resumedContext.onWorkspacePathsChanged(['root/child-write.ts'])
    expect(firstRunPaths).toEqual([])
    expect(secondRunPaths).toEqual(['root/child-write.ts'])
  })

  it('spawn throws when subagent times out', async () => {
    let resolveRun = () => {}
    hoisted.setRunImpl(
      (messages) =>
        new Promise<Message[]>((resolve) => {
          resolveRun = () => resolve([...messages, createAssistantMessage('late')])
        })
    )

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-timeout-${Date.now()}`, notifications)

    // Start spawn without awaiting — it blocks until subagent completes
    const spawnPromise = runtime.spawn({
      description: 'timeout test',
      prompt: 'run',
      timeout_ms: 10,
    })

    // Advance timers to trigger the timeout
    await vi.advanceTimersByTimeAsync(20)

    // Resolve the run so processQueue can complete
    resolveRun()

    // spawn should throw because task timed out
    try {
      await spawnPromise
      expect.unreachable('should have thrown')
    } catch (e: any) {
      expect(e.code).toBe('SUBAGENT_TIMEOUT')
    }

    expect(
      taskNotifications(notifications).some(
        (event) => event.status === 'failed' && event.exit_reason === 'timeout'
      )
    ).toBe(true)
  })

  it('spawn throws when subagent fails', async () => {
    hoisted.setRunImpl(() => {
      throw new Error('something went wrong')
    })

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-fail-${Date.now()}`, notifications)

    try {
      await runtime.spawn({
        description: 'fail test',
        prompt: 'run',
      })
      expect.unreachable('should have thrown')
    } catch (e: any) {
      expect(e.message).toContain('failed')
    }

    expect(taskNotifications(notifications).some((event) => event.status === 'failed')).toBe(true)
  })

  it('rejects enqueue when queue is full', async () => {
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-queue-full-${Date.now()}`, notifications)

    // Start spawn without awaiting (it blocks until completion)
    runtime.spawn({
      description: 'queue full test',
      prompt: 'run',
      name: 'queue-test-agent',
    }).catch(() => {})

    await waitForStatus(runtime, 'queue-test-agent', 'running')

    for (let i = 0; i < 100; i += 1) {
      const result = await runtime.sendMessage({ to: 'queue-test-agent', message: `msg-${i}` })
      expect(result.success).toBe(true)
    }

    const overflow = await runtime.sendMessage({ to: 'queue-test-agent', message: 'overflow', timeout_ms: 0 })
    expect(overflow.success).toBe(false)
    expect(overflow.message).toBe('QUEUE_FULL')
  })

  it('waits for enqueue timeout before returning QUEUE_FULL', async () => {
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-enqueue-timeout-${Date.now()}`, notifications)

    runtime.spawn({
      description: 'enqueue timeout test',
      prompt: 'run',
      name: 'enqueue-test-agent',
    }).catch(() => {})

    await waitForStatus(runtime, 'enqueue-test-agent', 'running')

    for (let i = 0; i < 100; i += 1) {
      const result = await runtime.sendMessage({ to: 'enqueue-test-agent', message: `msg-${i}`, timeout_ms: 0 })
      expect(result.success).toBe(true)
    }

    let settled = false
    let queueResult: { success: boolean; message: string } = { success: true, message: '' }
    const pending = runtime
      .sendMessage({ to: 'enqueue-test-agent', message: 'overflow', timeout_ms: 30 })
      .then((value) => {
        settled = true
        queueResult = value
      })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(29)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toBe(true)
    expect(queueResult.success).toBe(false)
    expect(queueResult.message).toBe('QUEUE_FULL')
  })

  it('drops expired queued messages before enqueueing new ones', async () => {
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-queue-timeout-${Date.now()}`, notifications)

    runtime.spawn({
      description: 'queue timeout test',
      prompt: 'run',
      name: 'expire-test-agent',
    }).catch(() => {})

    await waitForStatus(runtime, 'expire-test-agent', 'running')

    const first = await runtime.sendMessage({ to: 'expire-test-agent', message: 'stale' })
    expect(first.success).toBe(true)

    await vi.advanceTimersByTimeAsync(300001)

    const second = await runtime.sendMessage({ to: 'expire-test-agent', message: 'fresh' })
    expect(second.success).toBe(true)

    const status = await runtime.getStatus({ agentId: 'expire-test-agent' })
    expect(status.queue_depth).toBe(1)
  })

  it('keeps killed status when stop wins race against late completion', async () => {
    let resolveRun = () => {}
    hoisted.setRunImpl(
      (messages) =>
        new Promise<Message[]>((resolve) => {
          resolveRun = () => resolve([...messages, createAssistantMessage('completed late')])
        })
    )

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-race-${Date.now()}`, notifications)

    // Start spawn without awaiting
    runtime.spawn({
      description: 'race test',
      prompt: 'run',
      name: 'race-test-agent',
    }).catch(() => {})

    await waitForStatus(runtime, 'race-test-agent', 'running')
    const status = await runtime.getStatus({ agentId: 'race-test-agent' })
    const agentId = status.agentId

    const stopping = runtime.stop({ agentId, timeout_ms: 100 })
    resolveRun()
    await stopping

    const finalStatus = await runtime.getStatus({ agentId })
    expect(finalStatus.status).toBe('killed')
    const taskNotifs = taskNotifications(notifications)
    expect(taskNotifs.some((event) => event.status === 'killed')).toBe(true)
    expect(taskNotifs.some((event) => event.status === 'completed')).toBe(false)
  })

  it('escalates soft stop to forced kill when cleanup timeout is reached', async () => {
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-stop-timeout-${Date.now()}`, notifications)

    runtime.spawn({
      description: 'stop timeout test',
      prompt: 'run',
      name: 'stop-test-agent',
    }).catch(() => {})

    await waitForStatus(runtime, 'stop-test-agent', 'running')
    const status = await runtime.getStatus({ agentId: 'stop-test-agent' })
    const agentId = status.agentId

    let stopped = false
    const stopping = runtime.stop({ agentId, timeout_ms: 40 }).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    await vi.advanceTimersByTimeAsync(40)
    await stopping

    const finalStatus = await runtime.getStatus({ agentId })
    expect(finalStatus.status).toBe('killed')
    expect(finalStatus.error?.code).toBe('STOPPED_FORCE_TIMEOUT')
  })

  it('sends running notification only when a tool call happens', async () => {
    hoisted.setRunImpl(async (messages) => [...messages, createAssistantMessage('no tools used')])

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-running-notify-${Date.now()}`, notifications)
    await runtime.spawn({
      description: 'no tool call',
      prompt: 'run',
    })

    expect(taskNotifications(notifications).some((event) => event.status === 'running')).toBe(false)
  })

  it('hydrates running task as failed with SESSION_INTERRUPTED and supports alias lookup', async () => {
    const workspaceId = `workspace-hydrate-running-${Date.now()}`
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([
      createStoredTask({
        workspaceId,
        agentId: 'subagent_persisted_1',
        status: 'running',
        name: 'persisted-alias',
        queue: [{ message: 'queued-before-restart', enqueued_at: Date.now() - 1000 }],
      }),
    ] as any)
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(workspaceId, notifications)
    const status = await runtime.getStatus({ agentId: 'persisted-alias' })
    expect(status.status).toBe('failed')
    expect(status.error?.code).toBe('SESSION_INTERRUPTED')

    const resumed = await runtime.sendMessage({ to: 'persisted-alias', message: 'resume work' })
    expect(resumed.success).toBe(true)
    expect(resumed.resumed).toBe(true)
  })

  it('hydrates pending task as failed and preserves transcript count for resume', async () => {
    const workspaceId = `workspace-hydrate-pending-${Date.now()}`
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([
      createStoredTask({
        workspaceId,
        agentId: 'subagent_persisted_2',
        status: 'pending',
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'first',
            timestamp: Date.now() - 3000,
          },
          {
            id: 'a1',
            role: 'assistant',
            content: 'answer',
            timestamp: Date.now() - 2000,
          },
        ],
      }),
    ] as any)

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(workspaceId, notifications)
    const status = await runtime.getStatus({ agentId: 'subagent_persisted_2' })
    expect(status.status).toBe('failed')
    expect(status.error?.code).toBe('SESSION_INTERRUPTED')

    const resumed = await runtime.resume({
      agentId: 'subagent_persisted_2',
      prompt: 'continue from checkpoint',
    })
    expect(resumed.status).toBe('resumed')
    expect(resumed.transcript_entries_recovered).toBe(2)
  })

  it('restores the owning tool-call ID for notifications after hydration', async () => {
    const workspaceId = `workspace-hydrate-parent-${Date.now()}`
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([
      createStoredTask({
        workspaceId,
        agentId: 'subagent_persisted_parent',
        status: 'failed',
        parentToolCallId: 'persisted-tool-call',
      }),
    ] as any)
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(workspaceId, notifications)

    await runtime.resume({ agentId: 'subagent_persisted_parent', prompt: 'continue' })
    await waitForStatus(runtime, 'subagent_persisted_parent', 'completed')
    await vi.advanceTimersByTimeAsync(0)

    expect(taskNotifications(notifications).at(-1)).toMatchObject({
      parentToolCallId: 'persisted-tool-call',
    })
  })

  it('queues a sixth spawn until one of five execution slots is released', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-concurrency-${Date.now()}`, notifications)

    const resolveRuns: Array<() => void> = []
    hoisted.setRunImpl(
      (messages) => new Promise<Message[]>((resolve) => {
        resolveRuns.push(() => resolve([...messages, createAssistantMessage('done')]))
      })
    )

    const spawnPromises: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) {
      spawnPromises.push(
        runtime.spawn({
          description: `task-${i}`,
          prompt: `run ${i}`,
          name: `task-${i}`,
        }).catch(() => {})
      )
      await waitForStatus(runtime, `task-${i}`, 'running')
    }

    spawnPromises.push(
      runtime.spawn({
        description: 'task-5',
        prompt: 'run 5',
        name: 'task-5',
      }).catch(() => {})
    )
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    expect(hoisted.loopConfigs).toHaveLength(5)
    expect((await runtime.getStatus({ agentId: 'task-5' })).status).toBe('pending')

    resolveRuns.shift()?.()
    await waitForStatus(runtime, 'task-5', 'running')
    expect(hoisted.loopConfigs).toHaveLength(6)

    while (resolveRuns.length > 0) resolveRuns.shift()?.()
    await Promise.all(spawnPromises)
  })

  it('shutdown marks all active tasks as failed with SESSION_INTERRUPTED', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-shutdown-${Date.now()}`, notifications)

    // Block runs
    hoisted.setRunImpl(
      () => new Promise<Message[]>(() => {})
    )

    // Start spawns without awaiting
    runtime.spawn({
      description: 'active-1',
      prompt: 'run',
      name: 'shutdown-1',
    }).catch(() => {})

    runtime.spawn({
      description: 'active-2',
      prompt: 'run',
      name: 'shutdown-2',
    }).catch(() => {})

    // Both should be running/pending
    const s1 = await runtime.getStatus({ agentId: 'shutdown-1' })
    const s2 = await runtime.getStatus({ agentId: 'shutdown-2' })
    expect(['pending', 'running']).toContain(s1.status)
    expect(['pending', 'running']).toContain(s2.status)

    // Shutdown
    runtime.shutdown()

    // Both should be failed
    const s1After = await runtime.getStatus({ agentId: 'shutdown-1' })
    const s2After = await runtime.getStatus({ agentId: 'shutdown-2' })
    expect(s1After.status).toBe('failed')
    expect(s1After.error?.code).toBe('SESSION_INTERRUPTED')
    expect(s2After.status).toBe('failed')
    expect(s2After.error?.code).toBe('SESSION_INTERRUPTED')
  })

  it('stopAll kills every active member and leaves terminal ones untouched', async () => {
    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-stop-all-${Date.now()}`, notifications)

    await runtime.spawn({ description: 'already done', prompt: 'run', name: 'stop-all-done' })

    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))
    runtime.spawn({ description: 'active-1', prompt: 'run', name: 'stop-all-1' }).catch(() => {})
    runtime.spawn({ description: 'active-2', prompt: 'run', name: 'stop-all-2' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await waitForStatusWithTimers(runtime, 'stop-all-1', 'running')
    await waitForStatusWithTimers(runtime, 'stop-all-2', 'running')
    expect(['pending', 'running']).toContain((await runtime.getStatus({ agentId: 'stop-all-1' })).status)
    expect(['pending', 'running']).toContain((await runtime.getStatus({ agentId: 'stop-all-2' })).status)

    const result = await runtime.stopAll({ force: true })

    expect(result.stopped).toHaveLength(2)
    expect(new Set(result.stopped).size).toBe(2)
    expect((await runtime.getStatus({ agentId: 'stop-all-1' })).status).toBe('killed')
    expect((await runtime.getStatus({ agentId: 'stop-all-2' })).status).toBe('killed')
    expect((await runtime.getStatus({ agentId: 'stop-all-done' })).status).toBe('completed')
    expect(taskNotifications(notifications).filter((event) => event.status === 'killed')).toHaveLength(2)
  })

  it('applies the default deadline when the caller passes no timeout_ms', async () => {
    let resolveRun = () => {}
    hoisted.setRunImpl(
      (messages) =>
        new Promise<Message[]>((resolve) => {
          resolveRun = () => resolve([...messages, createAssistantMessage('late')])
        })
    )

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-default-deadline-${Date.now()}`, notifications)

    const spawnPromise = runtime.spawn({ description: 'no deadline', prompt: 'run', name: 'default-deadline' })
    spawnPromise.catch(() => {})
    await waitForStatusWithTimers(runtime, 'default-deadline', 'running')

    // Just short of the ten-minute default the run is still alive.
    await vi.advanceTimersByTimeAsync(599000)
    expect((await runtime.getStatus({ agentId: 'default-deadline' })).status).toBe('running')

    await vi.advanceTimersByTimeAsync(2000)
    expect((await runtime.getStatus({ agentId: 'default-deadline' })).status).toBe('failed')

    resolveRun()
    await expect(spawnPromise).rejects.toMatchObject({ code: 'SUBAGENT_TIMEOUT' })
    expect(
      taskNotifications(notifications).some(
        (event) => event.status === 'failed' && event.exit_reason === 'timeout'
      )
    ).toBe(true)
  })

  it('keeps timeout_ms: 0 as an explicit no-deadline opt-out', async () => {
    hoisted.setRunImpl(() => new Promise<Message[]>(() => {}))

    const notifications: (SubagentTaskNotification | SubagentStepNotification)[] = []
    const runtime = createRuntime(`workspace-opt-out-deadline-${Date.now()}`, notifications)

    runtime
      .spawn({ description: 'no deadline', prompt: 'run', name: 'opt-out', timeout_ms: 0 })
      .catch(() => {})
    await waitForStatus(runtime, 'opt-out', 'running')

    await vi.advanceTimersByTimeAsync(3_600_000)
    expect((await runtime.getStatus({ agentId: 'opt-out' })).status).toBe('running')

    await runtime.stopAll({ force: true })
  })

  it('persists the execution deadline and restores it after hydration', async () => {
    const workspaceId = `workspace-deadline-persist-${Date.now()}`
    hoisted.repo.findByWorkspaceId.mockResolvedValueOnce([
      createStoredTask({
        workspaceId,
        agentId: 'subagent_restored_deadline',
        status: 'completed',
        timeout_ms: 900000,
      }),
    ] as any)

    const runtime = createRuntime(workspaceId, [])
    // Any lookup forces the lazy hydration from SQLite.
    await runtime.getStatus({ agentId: 'subagent_restored_deadline' })
    runtime.shutdown()

    for (let i = 0; i < 50 && hoisted.repo.saveBatch.mock.calls.length === 0; i += 1) {
      await Promise.resolve()
    }
    const call = hoisted.repo.saveBatch.mock.calls.at(-1) as unknown as
      | [string, Array<{ agentId: string; timeout_ms?: number }>]
      | undefined
    const saved = call?.[1] ?? []
    expect(saved.find((task) => task.agentId === 'subagent_restored_deadline')?.timeout_ms).toBe(900000)
  })
})
