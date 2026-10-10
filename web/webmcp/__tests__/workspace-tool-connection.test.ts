import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startWorkspaceToolHost } from '../workspace-tool-connection'

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(), readFile: vi.fn(), enabled: true, workspace: 'workspace-a',
  attach: vi.fn(), close: vi.fn(), connect: vi.fn(),
  listeners: [] as Array<(state: { activeWorkspaceId: string; activeProjectId: string; enableWebMCP: boolean }) => void>,
}))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: {
  getState: () => ({ enableWebMCP: mocks.enabled }),
  subscribe: (fn: typeof mocks.listeners[number]) => { mocks.listeners.push(fn); return () => {} },
} }))
vi.mock('@/store/workspace.store', () => ({ useWorkspaceStore: {
  getState: () => ({ activeWorkspaceId: mocks.workspace }),
  subscribe: (fn: typeof mocks.listeners[number]) => { mocks.listeners.push(fn); return () => {} },
} }))
vi.mock('@/store/project.store', () => ({ useProjectStore: {
  getState: () => ({ activeProjectId: 'project' }), subscribe: () => () => {},
} }))
vi.mock('../workspace-tool-host', () => ({ createWorkspaceToolHost: () => ({ workspaceId: mocks.workspace, binding: null, names: () => ['read'] }) }))
vi.mock('../adapter-host', () => ({ connectAdapterHost: mocks.connect }))
let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.enabled = true
  mocks.workspace = 'workspace-a'
  mocks.listeners.length = 0
  mocks.connect.mockReturnValue({ attach: mocks.attach, stop: mocks.close })
  mocks.attach.mockResolvedValue(undefined)
  Object.assign(window, { __agentWeb: { ready: true, supportsAdapterWorkflows: true } })
})
afterEach(() => { stop(); vi.useRealTimers(); Reflect.deleteProperty(window, '__agentWeb') })
const notify = () => mocks.listeners.forEach(fn => fn({ activeWorkspaceId: mocks.workspace, activeProjectId: 'project', enableWebMCP: mocks.enabled }))

it('attaches only workspace tools without reading or publishing adapter files', async () => {
  stop = startWorkspaceToolHost()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.attach).toHaveBeenCalledWith()
  expect(mocks.listDir).not.toHaveBeenCalled()
  expect(mocks.readFile).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.attach).toHaveBeenCalledTimes(1)
})
it('disconnects immediately on disable and workspace switches', async () => {
  stop = startWorkspaceToolHost()
  await vi.advanceTimersByTimeAsync(0)
  mocks.workspace = 'workspace-b'
  notify()
  expect(mocks.close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.connect).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'workspace-b' }), expect.any(Function))
  mocks.enabled = false
  notify()
  expect(mocks.close).toHaveBeenCalledTimes(2)
})
it('waits for a compatible extension', async () => {
  Reflect.deleteProperty(window, '__agentWeb')
  stop = startWorkspaceToolHost()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.connect).not.toHaveBeenCalled()
  Object.assign(window, { __agentWeb: { ready: true, supportsAdapterWorkflows: true } })
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.attach).toHaveBeenCalledTimes(1)
})
