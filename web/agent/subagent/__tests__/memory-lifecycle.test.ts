import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@/agent/message-types'
import type { StoredSubagentTask } from '@/sqlite/repositories/subagent.repository'
import type { SubagentCompletion } from '../async-types'
import { __resetSubagentRuntimeRegistryForTests, getOrCreateSubagentRuntime } from '../runtime'

const storage = vi.hoisted(() => {
  const tasks = new Map<string, StoredSubagentTask>()
  const completions = new Map<string, SubagentCompletion>()
  const taskRepo = {
    findByWorkspaceId: vi.fn(async () => [...tasks.values()].map((task) => structuredClone(task))),
    findMetadataByWorkspaceId: vi.fn(async () =>
      [...tasks.values()].map((task) => ({ ...structuredClone(task), messages: [] }))
    ),
    findByAgentId: vi.fn(async (_workspaceId: string, id: string) =>
      structuredClone(tasks.get(id) ?? null)
    ),
    saveBatch: vi.fn(async (_workspaceId: string, rows: StoredSubagentTask[]) => {
      for (const row of rows) tasks.set(row.agentId, structuredClone(row))
    }),
  }
  const completionRepo = {
    find: vi.fn(async (id: string) => structuredClone(completions.get(id) ?? null)),
    findMetadata: vi.fn(async (id: string) => {
      const row = completions.get(id)
      return row ? { ...structuredClone(row), messages: [] } : null
    }),
    finishExecution: vi.fn(
      async ({
        task,
        completion,
      }: {
        task: StoredSubagentTask
        completion: SubagentCompletion
      }) => {
        tasks.set(task.agentId, structuredClone(task))
        completions.set(completion.id, structuredClone(completion))
        return completion
      }
    ),
  }
  return { tasks, completions, taskRepo, completionRepo, run: vi.fn() }
})

vi.mock('@/sqlite', () => ({
  getSubagentRepository: () => storage.taskRepo,
  getSubagentCompletionRepository: () => storage.completionRepo,
}))
vi.mock('@/agent/agent-loop', () => ({
  AgentLoop: class {
    run(messages: Message[]) {
      return storage.run(messages)
    }
    cancel() {}
  },
}))

const payload = 'TOOL_RESULT_'.repeat(100_000)
const answer = (content = 'done'): Message => ({
  id: 'answer',
  role: 'assistant',
  content,
  timestamp: 2,
})

function seedTask(agentId: string): void {
  storage.tasks.set(agentId, {
    workspaceId: 'memory-test',
    agentId,
    description: 'saved task',
    status: 'completed',
    mode: 'act',
    subagent_type: 'worker',
    messages: [{ id: 'tool', role: 'tool', content: payload, timestamp: 1 }, answer()],
    queue: [],
    stopped: false,
    created_at: 1,
    updated_at: 2,
    last_activity_at: 2,
  })
}

function createRuntime() {
  return getOrCreateSubagentRuntime({
    workspaceId: 'memory-test',
    provider: {} as never,
    toolRegistry: {} as never,
    contextManager: { getConfig: () => ({ maxContextTokens: 1000 }) } as never,
    baseToolContext: { directoryHandle: null },
  })
}

// Retained references are the regression: public status alone cannot detect them.
function retainedTask(runtime: ReturnType<typeof createRuntime>, id: string) {
  return (
    runtime as unknown as {
      tasks: Map<
        string,
        { messages: Message[]; execution: { completion?: SubagentCompletion; deps?: unknown } }
      >
    }
  ).tasks.get(id)!
}

beforeEach(() => {
  __resetSubagentRuntimeRegistryForTests()
  storage.tasks.clear()
  storage.completions.clear()
  vi.clearAllMocks()
  storage.run
    .mockReset()
    .mockImplementation(async (messages: Message[]) => [
      ...messages,
      { id: 'tool', role: 'tool', content: payload, timestamp: 1 },
      answer(),
    ])
})

describe('subagent transcript memory lifecycle', () => {
  it('hydrates task metadata without reading or retaining all saved transcripts', async () => {
    seedTask('saved-1')
    seedTask('saved-2')
    const runtime = createRuntime()
    expect((await runtime.list({})).total).toBe(2)
    expect(storage.taskRepo.findMetadataByWorkspaceId).toHaveBeenCalledOnce()
    expect(storage.taskRepo.findByWorkspaceId).not.toHaveBeenCalled()
    expect(storage.taskRepo.findByAgentId).not.toHaveBeenCalled()
    expect(retainedTask(runtime, 'saved-1').messages).toHaveLength(0)
    expect(retainedTask(runtime, 'saved-2').messages).toHaveLength(0)
  })

  it('hydrates async delivery state without loading its archived completion snapshot', async () => {
    seedTask('saved')
    const task = storage.tasks.get('saved')!
    task.execution = {
      executionId: 'attempt',
      isAsync: true,
      conversationId: 'memory-test',
      suppressed: false,
      changedPaths: [],
    }
    storage.completions.set('saved:attempt', {
      id: 'saved:attempt',
      agentId: 'saved',
      executionId: 'attempt',
      conversationId: 'memory-test',
      notificationMessageId: 'notification',
      status: 'pending',
      taskStatus: 'completed',
      description: 'saved task',
      result: 'done',
      messages: task.messages,
      changedPaths: [],
      createdAt: 1,
      updatedAt: 2,
    })
    const runtime = createRuntime()
    await runtime.list({})
    expect(storage.completionRepo.findMetadata).toHaveBeenCalledWith('saved:attempt')
    expect(storage.completionRepo.find).not.toHaveBeenCalled()
    expect(retainedTask(runtime, 'saved').execution.completion?.messages).toHaveLength(0)
    expect((await runtime.getTrace({ agentId: 'saved' })).total).toBe(2)
    expect(retainedTask(runtime, 'saved').messages).toHaveLength(0)
  })

  it('releases a synchronous transcript after saving, and reloads it for trace and resume', async () => {
    const runtime = createRuntime()
    const result = await runtime.spawn({ description: 'work', prompt: 'first pass' })
    expect(result.content).toBe('done')
    expect(retainedTask(runtime, result.agentId).messages).toHaveLength(0)
    expect(retainedTask(runtime, result.agentId).execution.completion?.messages).toHaveLength(0)
    expect(retainedTask(runtime, result.agentId).execution.deps).toBeUndefined()
    const trace = await runtime.getTrace({ agentId: result.agentId })
    expect(trace.total).toBe(3)
    expect(trace.messages[1]).toMatchObject({ role: 'tool', content_truncated: true })
    expect(retainedTask(runtime, result.agentId).messages).toHaveLength(0)
    const finished = storage.tasks.get(result.agentId)!.messages
    let finish!: () => void
    storage.run.mockImplementationOnce(async (messages: Message[]) => {
      expect(messages.slice(0, -1)).toEqual(finished)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return [...messages, { ...answer('continued'), id: 'answer-2' }]
    })
    const resumed = await runtime.resume({ agentId: result.agentId, prompt: 'continue' })
    expect(resumed.transcript_entries_recovered).toBe(3)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish()
    await vi.waitFor(async () =>
      expect((await runtime.getStatus({ agentId: result.agentId })).status).toBe('completed')
    )
    await vi.waitFor(() => expect(retainedTask(runtime, result.agentId).messages).toHaveLength(0))
    expect(storage.tasks.get(result.agentId)!.messages).toEqual(expect.arrayContaining(finished))
  })

  it('keeps a durable async completion without retaining its copied transcript', async () => {
    const runtime = createRuntime()
    const receipt = await runtime.start({ description: 'background work', prompt: 'run' })
    await vi.waitFor(() => expect(storage.completions.size).toBe(1))
    await vi.waitFor(() => expect(retainedTask(runtime, receipt.agentId).messages).toHaveLength(0))
    const execution = retainedTask(runtime, receipt.agentId).execution
    expect(execution.completion?.messages).toHaveLength(0)
    expect(execution.deps).toBeUndefined()
    expect(storage.completions.values().next().value?.messages).toHaveLength(3)
    const trace = await runtime.getTrace({ agentId: receipt.agentId })
    expect(trace.total).toBe(3)
    expect(storage.completionRepo.find).toHaveBeenCalledWith(execution.completion!.id)
    expect(execution.completion?.messages).toHaveLength(0)
  })

  it('does not overwrite an unloaded transcript when another task is persisted', async () => {
    seedTask('saved')
    const runtime = createRuntime()
    await runtime.list({})
    const original = structuredClone(storage.tasks.get('saved')!.messages)
    await runtime.spawn({ description: 'another task', prompt: 'run' })
    await Promise.resolve()
    expect(storage.tasks.get('saved')!.messages).toEqual(original)
    expect(
      storage.taskRepo.saveBatch.mock.calls
        .flatMap(([, rows]) => rows)
        .filter((row) => row.agentId === 'saved')
    ).toHaveLength(0)
  })

  it('retains the only transcript when terminal persistence fails', async () => {
    storage.completionRepo.finishExecution.mockRejectedValueOnce(new Error('database unavailable'))
    const runtime = createRuntime()
    const receipt = await runtime.start({ description: 'background work', prompt: 'run' })
    await vi.waitFor(async () =>
      expect((await runtime.getStatus({ agentId: receipt.agentId })).status).toBe('failed')
    )
    expect(retainedTask(runtime, receipt.agentId).messages.length).toBeGreaterThan(0)
    expect(
      retainedTask(runtime, receipt.agentId).execution.completion?.messages.length
    ).toBeGreaterThan(0)
    expect(storage.completions.size).toBe(0)
  })
})
