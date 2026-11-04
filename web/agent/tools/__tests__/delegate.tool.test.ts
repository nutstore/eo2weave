import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { delegateToExecutor } from '../delegate.tool'

// Mock the agents store — the executor reads useAgentsStore.getState().agents
const agentsStateMock = vi.fn()

vi.mock('@/store/agents.store', () => ({
  useAgentsStore: {
    getState: () => agentsStateMock(),
  },
}))

// Mock the OPFS ProjectManager — runs bound to a project resolve their Agent
// catalog through it instead of the globally loaded store.
vi.mock('@/opfs', () => ({
  ProjectManager: {
    create: async () => ({
      getProject: async (projectId: string) =>
        projectId === 'run-project'
          ? {
              agentManager: {
                listAgents: async () => [
                  { id: 'default', name: 'Default' },
                  { id: 'run-only-agent', name: 'Run Only' },
                ],
              },
            }
          : null,
    }),
  },
}))

const BASE_CONTEXT: ToolContext = {
  directoryHandle: null,
  currentAgentId: 'pm',
}

const AGENTS = [
  { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
  { id: 'pm', name: 'Product Manager', createdAt: 0, lastAccessedAt: 0 },
  { id: 'backend-engineer', name: 'Backend Engineer', createdAt: 0, lastAccessedAt: 0 },
  { id: 'frontend-lead', name: 'Frontend Lead', createdAt: 0, lastAccessedAt: 0 },
]

function parseResult(raw: string): any {
  return JSON.parse(raw)
}

describe('delegate_to tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentsStateMock.mockReturnValue({ agents: AGENTS })
  })

  it('returns success and invokes onDelegation when target_agent_id exists', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      {
        target_agent_id: 'backend-engineer',
        task: 'Evaluate the technical feasibility of the auth refactor.',
        reason: 'Needs backend expertise.',
      },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.delegated_to).toBe('backend-engineer')
    expect(parsed.data.delegated_to_name).toBe('Backend Engineer')
    expect(parsed.data.task).toContain('auth refactor')
    expect(parsed.data.reason).toBe('Needs backend expertise.')
    expect(onDelegation).toHaveBeenCalledOnce()
    expect(onDelegation).toHaveBeenCalledWith({
      targetAgentId: 'backend-engineer',
      task: 'Evaluate the technical feasibility of the auth refactor.',
      reason: 'Needs backend expertise.',
    })
  })

  it('returns AGENT_NOT_FOUND when target_agent_id does not exist', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: 'nonexistent', task: 'do something' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('AGENT_NOT_FOUND')
    expect(parsed.error.details.available_agent_ids).toContain('backend-engineer')
    expect(onDelegation).not.toHaveBeenCalled()
  })

  it('rejects self-delegation to prevent infinite loops', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: 'pm', task: 'do my own work' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('SELF_DELEGATION')
    expect(onDelegation).not.toHaveBeenCalled()
  })

  it('returns DELEGATION_UNAVAILABLE when onDelegation is missing (subagent context)', async () => {
    // ctx has no onDelegation
    const ctx: ToolContext = { ...BASE_CONTEXT }

    const raw = await delegateToExecutor(
      { target_agent_id: 'backend-engineer', task: 'do something' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('DELEGATION_UNAVAILABLE')
  })

  it('returns INVALID_INPUT when target_agent_id is empty', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: '   ', task: 'do something' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('INVALID_INPUT')
    expect(onDelegation).not.toHaveBeenCalled()
  })

  it('returns INVALID_INPUT when task is empty', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: 'backend-engineer', task: '' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('INVALID_INPUT')
    expect(onDelegation).not.toHaveBeenCalled()
  })

  it('validates the target against the RUN project catalog when projectId is bound', async () => {
    // Background conversations run in their own project: the globally loaded
    // store holds the UI-open project's Agents, so validation must consult
    // the run project instead — otherwise targets the prompt advertised are
    // rejected.
    const onDelegation = vi.fn()
    const ctx: ToolContext = {
      ...BASE_CONTEXT,
      projectId: 'run-project',
      onDelegation,
    }

    const raw = await delegateToExecutor(
      { target_agent_id: 'run-only-agent', task: 'take over' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.delegated_to).toBe('run-only-agent')
    expect(parsed.data.delegated_to_name).toBe('Run Only')
    expect(onDelegation).toHaveBeenCalledOnce()
  })

  it('rejects a target that exists in the open project but not the run project', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = {
      ...BASE_CONTEXT,
      projectId: 'run-project',
      onDelegation,
    }

    const raw = await delegateToExecutor(
      { target_agent_id: 'backend-engineer', task: 'take over' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('AGENT_NOT_FOUND')
    expect(parsed.error.details.available_agent_ids).toEqual(['default', 'run-only-agent'])
    expect(onDelegation).not.toHaveBeenCalled()
  })

  it('falls back to the globally loaded store when the run has no projectId', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: 'backend-engineer', task: 'take over' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.delegated_to).toBe('backend-engineer')
  })

  it('trims task and reason, and omits reason when empty', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { ...BASE_CONTEXT, onDelegation }

    const raw = await delegateToExecutor(
      {
        target_agent_id: 'backend-engineer',
        task: '  review the migration plan  ',
        reason: '   ',
      },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.task).toBe('review the migration plan')
    expect(parsed.data).not.toHaveProperty('reason')
    expect(onDelegation).toHaveBeenCalledWith({
      targetAgentId: 'backend-engineer',
      task: 'review the migration plan',
      reason: undefined,
    })
  })

  it('works when currentAgentId is null (no self-delegation check possible)', async () => {
    const onDelegation = vi.fn()
    const ctx: ToolContext = { directoryHandle: null, onDelegation }

    const raw = await delegateToExecutor(
      { target_agent_id: 'default', task: 'take over' },
      ctx
    )
    const parsed = parseResult(raw)

    expect(parsed.ok).toBe(true)
    expect(onDelegation).toHaveBeenCalledOnce()
  })
})
