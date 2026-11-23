import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentLoopConfig } from '@/agent/agent-loop'
import type { Message } from '@/agent/message-types'
import type { StoredSubagentTask } from '@/sqlite/repositories/subagent.repository'
import type { SubagentCompletion } from '../async-types'
import { __resetSubagentRuntimeRegistryForTests, getOrCreateSubagentRuntime } from '@/agent/subagent/runtime'
import { recordTeamTaskOutcome } from '@/agent/team/team-board'

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
    suppressAgent: vi.fn(async () => {}),
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
  return { tasks, completions, taskRepo, completionRepo, run: vi.fn(), configs: [] as AgentLoopConfig[], actorClasses: ['write'] as string[], actorReadonly: false }
})

vi.mock('@/sqlite', () => ({
  getSubagentRepository: () => storage.taskRepo,
  getSubagentCompletionRepository: () => storage.completionRepo,
}))
vi.mock('@/agent/agent-loop', () => ({
  AgentLoop: class {
    constructor(private config: AgentLoopConfig) {
      storage.configs.push(config)
    }
    run(messages: Message[]) {
      return storage.run(messages, this.config)
    }
    cancel() {}
  },
}))

vi.mock('@/opfs', () => ({
  ProjectManager: {
    create: async () => ({
      getProject: async () => ({
        agentManager: {
          getAgent: async () => ({ meta: { capabilities: { classes: storage.actorClasses, readonly: storage.actorReadonly } } }),
        },
      }),
    }),
  },
}))
vi.mock('@/agent/team/team-board', () => ({
  assignTeamTask: async () => ({ result: { brief: 'assigned task', runGoal: 'goal' } }),
  appendTeamLedger: async () => {},
  recordTeamTaskOutcome: vi.fn(async () => {}),
  listTeamSlotFiles: async () => [],
  buildTeamTaskSection: ({ runKey }: { runKey: string }) => `Pinned board: ${runKey}`,
}))
let answerId = 0
const answer = (): Message => ({
  id: `answer-${++answerId}`, role: 'assistant', content: 'done', timestamp: 2,
})

function createRuntime(teamRunKey = 'original-board') {
  return getOrCreateSubagentRuntime({
    workspaceId: 'boundaries-test',
    provider: {} as never,
    toolRegistry: {} as never,
    contextManager: { getConfig: () => ({ maxContextTokens: 1000 }) } as never,
    baseToolContext: { directoryHandle: null, projectId: 'project', teamRunKey },
  })
}

beforeEach(() => {
  __resetSubagentRuntimeRegistryForTests()
  storage.configs.length = 0
  storage.tasks.clear()
  storage.completions.clear()
  storage.actorClasses = ['write']
  storage.actorReadonly = false
  vi.clearAllMocks()
  storage.run.mockReset().mockImplementation(async (messages: Message[]) => [...messages, answer()])
})

describe('subagent execution boundaries', () => {
  it.each([{ classes: ['read'] as Array<'read'> }, { classes: [] }])('preserves effective classes $classes through repeated reloads and resumes', async ({ classes: capabilityClasses }) => {
    storage.run.mockImplementation(async (messages: Message[], config: AgentLoopConfig) => {
      expect(config.beforeToolCall!({ toolName: 'write', toolCallId: 'write', args: {} })).toMatchObject({
        block: true, reason: expect.stringContaining('capability boundary'),
      })
      const read = config.beforeToolCall!({ toolName: 'read', toolCallId: 'read', args: {} })
      if (capabilityClasses.length === 0) expect(read).toMatchObject({ block: true })
      else expect(read).toBeUndefined()
      return [...messages, answer()]
    })
    const runtime = createRuntime()
    const result = await runtime.spawn({
      description: 'restricted worker', prompt: 'inspect', subagent_type: 'worker',
      capabilities: { classes: capabilityClasses },
    })
    expect(storage.configs[0].toolContext.capabilityClasses).toEqual(capabilityClasses)
    for (let attempt = 1; attempt <= 2; attempt++) {
      __resetSubagentRuntimeRegistryForTests()
      const reloaded = createRuntime()
      await reloaded.resume({ agentId: result.agentId, prompt: 'continue' })
      await vi.waitFor(() => expect(storage.configs).toHaveLength(attempt + 1))
      const config = storage.configs[attempt]
      expect(config.toolContext.capabilityClasses).toEqual(capabilityClasses)
      expect(config.mode).toBe('act')
      await vi.waitFor(async () =>
        expect((await reloaded.getStatus({ agentId: result.agentId })).status).toBe('completed')
      )
    }
  })

  it.each([
    { actorClasses: ['write'], actorReadonly: false, capabilities: { readonly: true } },
    { actorClasses: ['read', 'write'], actorReadonly: false, capabilities: { readonly: true, classes: [] } },
    { actorClasses: ['write'], actorReadonly: true, capabilities: undefined },
  ])('intersects readonly and explicit class boundaries: %j', async ({ actorClasses, actorReadonly, capabilities }) => {
    storage.actorClasses = actorClasses
    storage.actorReadonly = actorReadonly
    storage.run.mockImplementationOnce(async (messages: Message[], config: AgentLoopConfig) => {
      expect(config.beforeToolCall!({ toolName: 'read', toolCallId: 'read', args: {} })).toMatchObject({
        block: true, reason: expect.stringContaining('capability boundary'),
      })
      return [...messages, answer()]
    })
    const runtime = createRuntime()
    const result = await runtime.spawn({
      description: 'actor', prompt: 'inspect', as: 'writer', capabilities,
    })
    const config = storage.configs[0]
    expect(config.toolContext.capabilityClasses).toEqual([])
    expect(result.status).toBe('completed')
  })

  it('keeps read access when an actor declares readonly with an empty class list', async () => {
    // An empty array in meta.json declares nothing; it must not strip `read`.
    storage.actorClasses = []
    storage.actorReadonly = true
    const runtime = createRuntime()
    const result = await runtime.spawn({ description: 'actor', prompt: 'inspect', as: 'writer' })
    expect(storage.configs[0].toolContext.capabilityClasses).toEqual(['read'])
    expect(result.status).toBe('completed')
  })

  it('keeps the assigned board in prompts and tools when resumed by a later parent run', async () => {
    const runtime = createRuntime('original-board')
    const result = await runtime.spawn({ description: 'member', prompt: 'inspect', task_id: 't1' })
    createRuntime('next-board')
    await runtime.resume({ agentId: result.agentId, prompt: 'continue on your original board' })
    await vi.waitFor(() => expect(storage.configs).toHaveLength(2))
    expect(storage.configs[1].systemPrompt).toContain('Pinned board: original-board')
    expect(storage.configs[1].toolContext.teamRunKey).toBe('original-board')
  })

  it('records a stopped team member as blocked instead of leaving its task running', async () => {
    const runtime = createRuntime()
    let finish!: () => void
    storage.run.mockImplementation(
      async (messages: Message[]) =>
        new Promise<Message[]>((resolve) => {
          finish = () => resolve([...messages, answer()])
        })
    )
    const spawned = await runtime.start({ description: 'member', prompt: 'work', task_id: 't-stop' })
    await vi.waitFor(() => expect(storage.run).toHaveBeenCalled())

    await runtime.stop({ agentId: spawned.agentId, force: true })

    // Stopping is terminal like failing; the board has to hear about it.
    expect(vi.mocked(recordTeamTaskOutcome)).toHaveBeenCalledWith(
      expect.objectContaining({ teamRunKey: 'original-board' }),
      expect.objectContaining({ taskId: 't-stop', status: 'blocked' })
    )
    finish()
  })
})
