import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubagentTaskStore, type SubagentTaskProjection } from '../subagent-task.store'
const fixture = vi.hoisted(() => ({
  suppressAgent: vi.fn(async () => {}),
  findCompletion: vi.fn(async () => ({ status: 'suppressed' })),
  workspace: { refreshPendingChanges: vi.fn(async () => ({ changes: [{ path: 'child.md' }] })) },
  getWorkspace: vi.fn(),
  visibleRefresh: vi.fn(async () => {}),
  context: { activeWorkspaceId: 'other', workspaces: [{ id: 'original', pendingCount: 0 }] },
}))
vi.mock('@/sqlite/repositories/subagent-completion.repository', () => ({ getSubagentCompletionRepository: () => ({ suppressAgent: fixture.suppressAgent, find: fixture.findCompletion }) }))
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
  expect(fixture.suppressAgent.mock.calls).toEqual([['original', 'waiting'], ['original', 'blocked']])
  expect(useSubagentTaskStore.getState().tasks.waiting.deliveryPhase).toBe('suppressed')
  expect(useSubagentTaskStore.getState().tasks.blocked.deliveryPhase).toBe('suppressed')
  expect(useSubagentTaskStore.getState().tasks.processing.deliveryPhase).toBe('processing')
  expect(useSubagentTaskStore.getState().tasks.handled.deliveryPhase).toBe('handled')
})
