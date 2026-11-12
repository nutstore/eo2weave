import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({
  workspace: { refreshPendingChanges: vi.fn(async () => ({ changes: [{ path: 'child.md' }] })) },
  getWorkspace: vi.fn(),
  visibleRefresh: vi.fn(async () => {}),
  context: { activeWorkspaceId: 'other', workspaces: [{ id: 'original', pendingCount: 0 }] },
}))
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
} from '../subagent-continuation'
beforeEach(() => {
  vi.clearAllMocks()
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
