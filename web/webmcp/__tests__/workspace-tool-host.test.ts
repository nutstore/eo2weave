import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceToolHost } from '../workspace-tool-host'
const mocks = vi.hoisted(() => ({ workspaceId: 'workspace-a', projectId: 'project-a', invoke: vi.fn(), directory: vi.fn(), mode: 'act' as 'act' | 'plan' }))
vi.mock('@/store/agents.store', () => ({ useAgentsStore: { getState: () => ({ activeAgentId: 'default' }) } }))
vi.mock('@/agent/tool-registry', () => ({ getToolRegistry: () => ({ getToolDefinitionsForMode: () => ['read', 'run_code', ...(mocks.mode === 'act' ? ['write'] : [])].map(name => ({ function: { name } })) }) }))
vi.mock('@/agent/tool-invocation', () => ({ invokeTool: mocks.invoke }))
vi.mock('@/agent/tools/tool-utils', () => ({ resolveWorkspaceDirectoryHandle: mocks.directory }))
vi.mock('@/store/workspace.store', () => ({ useWorkspaceStore: { getState: () => ({ activeWorkspaceId: mocks.workspaceId, isLoading: false }) } }))
vi.mock('@/store/project.store', () => ({ useProjectStore: { getState: () => ({ activeProjectId: mocks.projectId }) } }))
vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => mocks.mode }))
vi.mock('@/agent/workspace-assistant-context', () => ({ getSidePanelBindingId: () => 'binding' }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspaceId = 'workspace-a'
  mocks.projectId = 'project-a'
  mocks.mode = 'act'
  mocks.directory.mockResolvedValue(null)
  mocks.invoke.mockResolvedValue({ value: { count: 2 }, isError: false })
})
it('uses the shared invocation pipeline with a fixed workspace and per-execution read state', async () => {
  const host = createWorkspaceToolHost()!
  const signal = new AbortController().signal
  expect(host.names()).toEqual(['read', 'run_code', 'write'])
  expect(await host.invoke('read', {}, 'call-1', signal, 'run-1')).toEqual({ count: 2 })
  await host.invoke('write', {}, 'call-2', signal, 'run-1')
  await host.invoke('read', {}, 'call-3', signal, 'run-2')
  const first = mocks.invoke.mock.calls[0]
  expect(first[0]).toMatchObject({ beforeToolCall: expect.any(Function), mode: 'act' })
  expect(first[1].context).toMatchObject({ workspaceId: 'workspace-a', projectId: 'project-a', abortSignal: signal })
  expect(mocks.invoke.mock.calls[1][1].context.readFileState).toBe(first[1].context.readFileState)
  expect(mocks.invoke.mock.calls[2][1].context.readFileState).not.toBe(first[1].context.readFileState)
  host.end!('run-1')
  await host.invoke('read', {}, 'call-4', signal, 'run-1')
  expect(mocks.invoke.mock.calls[3][1].context.readFileState).not.toBe(first[1].context.readFileState)
  await host.invoke('run_code', {}, 'call-run-code', signal, 'run-code-execution')
  expect(mocks.invoke.mock.calls[4][1].toolName).toBe('run_code')
})
it('rechecks mode and rejects a workspace change while resolving directory context', async () => {
  const host = createWorkspaceToolHost()!
  const signal = new AbortController().signal
  mocks.mode = 'plan'
  expect(host.names()).toEqual(['read', 'run_code'])
  await expect(host.invoke('write', {}, 'call', signal, 'run')).rejects.toThrow('unavailable')
  mocks.directory.mockImplementationOnce(async () => { mocks.workspaceId = 'workspace-b'; return null })
  await expect(host.invoke('read', {}, 'call', signal, 'run')).rejects.toThrow('Workspace changed')
  expect(mocks.invoke).not.toHaveBeenCalled()
})
it('preserves tool failures as rejected calls with code and toolName', async () => {
  const host = createWorkspaceToolHost()!
  mocks.invoke.mockResolvedValue({ isError: true, presentation: { content: 'denied', details: { parsed: { version: 2, ok: false, tool: 'write', error: { code: 'DENIED', message: 'denied' } } } } })
  await expect(host.invoke('write', {}, 'call', new AbortController().signal, 'run')).rejects.toMatchObject({ code: 'DENIED', toolName: 'write' })
})
