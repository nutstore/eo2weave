import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubagentTaskStore, type SubagentTaskProjection } from '../subagent-task.store'
const fixture = vi.hoisted(() => ({
  suppressAgent: vi.fn(async () => {}),
  findCompletion: vi.fn(async () => ({ status: 'suppressed' })),
  listProcessing: vi.fn(async () => []),
  workspace: { refreshPendingChanges: vi.fn(async () => ({ changes: [{ path: 'child.md' }] })) },
  getWorkspace: vi.fn(),
  visibleRefresh: vi.fn(async () => {}),
  context: { activeWorkspaceId: 'other', workspaces: [{ id: 'original', pendingCount: 0 }] },
}))
vi.mock('@/sqlite/repositories/subagent-completion.repository', () => ({ getSubagentCompletionRepository: () => ({ suppressAgent: fixture.suppressAgent, find: fixture.findCompletion, listProcessing: fixture.listProcessing }) }))
vi.mock('@/opfs', () => ({
  getWorkspaceManager: async () => ({ getWorkspace: fixture.getWorkspace }),
}))
vi.mock('@/store/conversation-agent-run', () => ({ isConversationDispatchBusy: () => false }))
vi.mock('@/store/conversation-context.store', () => ({
  useConversationContextStore: {
    getState: () => ({ ...fixture.context, refreshPendingChanges: fixture.visibleRefresh }),
    setState: (update: (state: typeof fixture.context) => Partial<typeof fixture.context>) =>
      Object.assign(fixture.context, update(fixture.context)),
  },
}))
import {
  recordAsyncSubagentPaths,
  isAsyncSubagentPath,
  retainPendingSubagentPaths,
  refreshAsyncSubagentWorkspace,
  hasReadySubagentReturns,
  stopPendingSubagentReturns,
} from '../subagent-continuation'
beforeEach(() => {
  vi.clearAllMocks()
  useSubagentTaskStore.setState({ tasks: {} })
  fixture.getWorkspace.mockResolvedValue(fixture.workspace)
  fixture.context.activeWorkspaceId = 'other'
})
describe('async child workspace ownership', () => {
  it('keeps child paths pending during overlap and releases attribution after manual review', async () => {
    recordAsyncSubagentPaths('original', ['child.md'])
    expect(isAsyncSubagentPath('original', 'child.md')).toBe(true)
    retainPendingSubagentPaths('original', new Set(['child.md']))
    expect(isAsyncSubagentPath('original', 'child.md')).toBe(true)
    retainPendingSubagentPaths('original', new Set())
    expect(isAsyncSubagentPath('original', 'child.md')).toBe(false)
    await vi.waitFor(() => expect(fixture.workspace.refreshPendingChanges).toHaveBeenCalled())
  })
  it('refreshes the original workspace while another conversation is open', async () => {
    await refreshAsyncSubagentWorkspace('original')
    expect(fixture.getWorkspace).toHaveBeenCalledWith('original')
    expect(fixture.workspace.refreshPendingChanges).toHaveBeenCalledTimes(1)
    expect(fixture.visibleRefresh).not.toHaveBeenCalled()
    expect(fixture.context.activeWorkspaceId).toBe('other')
  })
})

it('yields only for unacknowledged pending async returns in the owning conversation', () => {
  const base: SubagentTaskProjection = { agentId: 'ready', conversationId: 'original', description: 'Inspect', role: 'worker', status: 'completed', createdAt: 1, updatedAt: 2, lastActivity: 2, isAsync: true, executionId: 'attempt', deliveryPhase: 'pending', messages: [] }
  expect(hasReadySubagentReturns('original')).toBe(false)
  useSubagentTaskStore.getState().publish(base)
  expect(hasReadySubagentReturns('original')).toBe(true)
  expect(hasReadySubagentReturns('other')).toBe(false)
  for (const phase of ['processing', 'delivered', 'handled', 'suppressed'] as const) {
    useSubagentTaskStore.getState().publish({ ...base, deliveryPhase: phase })
    expect(hasReadySubagentReturns('original')).toBe(false)
  }
  useSubagentTaskStore.getState().publish({ ...base, acknowledged: true })
  expect(hasReadySubagentReturns('original')).toBe(false)
  useSubagentTaskStore.getState().publish({ ...base, isAsync: false })
  expect(hasReadySubagentReturns('original')).toBe(false)
})

it('suppresses only unhandled terminal background returns in the original conversation', async () => {
  const base: SubagentTaskProjection = { agentId: 'waiting', conversationId: 'original', description: 'Inspect', role: 'worker', status: 'completed', createdAt: 1, updatedAt: 2, lastActivity: 2, isAsync: true, executionId: 'attempt', deliveryPhase: 'pending', messages: [] }
  const tasks: SubagentTaskProjection[] = [base,
    { ...base, agentId: 'blocked', deliveryPhase: 'blocked' },
    { ...base, agentId: 'handled', deliveryPhase: 'handled' },
    { ...base, agentId: 'processing', deliveryPhase: 'processing' },
    { ...base, agentId: 'acknowledged', acknowledged: true },
    { ...base, agentId: 'active', status: 'running' },
    { ...base, agentId: 'sync', isAsync: false },
    { ...base, agentId: 'other', conversationId: 'other' },
  ]
  tasks.forEach(task => useSubagentTaskStore.getState().publish(task))
  await stopPendingSubagentReturns('original')
  expect(fixture.suppressAgent.mock.calls).toEqual([['original', 'waiting', 'attempt'], ['original', 'blocked', 'attempt']])
  expect(useSubagentTaskStore.getState().tasks.waiting.deliveryPhase).toBe('suppressed')
  expect(useSubagentTaskStore.getState().tasks.blocked.deliveryPhase).toBe('suppressed')
  expect(useSubagentTaskStore.getState().tasks.processing.deliveryPhase).toBe('processing')
  expect(useSubagentTaskStore.getState().tasks.handled.deliveryPhase).toBe('handled')
})

it('suppresses just the selected execution and ignores a stale task selection', async () => {
  const base: SubagentTaskProjection = { agentId: 'selected', conversationId: 'original', description: 'Inspect', role: 'worker', status: 'completed', createdAt: 1, updatedAt: 2, lastActivity: 2, isAsync: true, executionId: 'attempt', deliveryPhase: 'pending', messages: [] }
  useSubagentTaskStore.getState().publish(base)
  useSubagentTaskStore.getState().publish({ ...base, agentId: 'other' })
  await stopPendingSubagentReturns('original', { agentId: 'selected', executionId: 'old-attempt' })
  expect(fixture.suppressAgent).not.toHaveBeenCalled()
  await stopPendingSubagentReturns('original', { agentId: 'selected', executionId: 'attempt' })
  expect(fixture.suppressAgent.mock.calls).toEqual([['original', 'selected', 'attempt']])
  expect(useSubagentTaskStore.getState().tasks.selected.deliveryPhase).toBe('suppressed')
  expect(useSubagentTaskStore.getState().tasks.other.deliveryPhase).toBe('pending')
})

describe('hydration keeps transcripts out of memory', () => {
  it('publishes metadata only, so a past transcript is not retained at startup', async () => {
    // Regression guard: hydration used to publish the full `messages` array of
    // every task of every conversation, which a long session never released.
    const { recoverSubagentContinuations } = await import('../subagent-continuation')
    const { getSubagentRepository } = await import('@/sqlite/repositories/subagent.repository')
    const repository = await getSubagentRepository()
    vi.spyOn(repository, 'findMetadataByWorkspaceId').mockResolvedValue([{
      agentId: 'historic',
      workspaceId: 'conv-hydrate',
      name: 'historic',
      description: 'Past work',
      status: 'completed',
      subagent_type: 'explorer',
      messages: [{ id: 'm1', role: 'assistant', content: 'a very large past transcript', timestamp: 1 }],
      created_at: 1,
      updated_at: 2,
      last_activity_at: 2,
    } as never])

    await recoverSubagentContinuations(['conv-hydrate'])

    const projection = useSubagentTaskStore.getState().tasks.historic
    expect(projection).toBeDefined()
    expect(projection.description).toBe('Past work')
    expect(projection.messages).toEqual([])
  })
})
