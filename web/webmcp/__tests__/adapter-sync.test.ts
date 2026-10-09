import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startWebMCPAdapterSync } from '../adapter-sync'
import { manifest, source, pkg } from './fixtures'

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(), readFile: vi.fn(), enabled: true, workspace: 'workspace-a',
  publish: vi.fn(), close: vi.fn(), connect: vi.fn(),
  listeners: [] as Array<(state: { activeWorkspaceId: string; activeProjectId: string; enableWebMCP: boolean }) => void>,
}))
vi.mock('@/agent/tools/backends/webmcp-backend', () => ({ WebMcpBackend: class {
  listDir = mocks.listDir
  readFile = mocks.readFile
} }))
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
  mocks.connect.mockReturnValue({ publish: mocks.publish, stop: mocks.close })
  mocks.publish.mockResolvedValue(undefined)
  mocks.listDir.mockResolvedValue([{ name: manifest.id, kind: 'directory' }])
  mocks.readFile.mockImplementation(async (path: string) => ({ content: path.endsWith('.json') ? JSON.stringify(manifest) : source }))
  Object.assign(window, { __agentWeb: { ready: true, supportsAdapterWorkflows: true } })
})
afterEach(() => { stop(); vi.useRealTimers(); Reflect.deleteProperty(window, '__agentWeb') })
const notify = () => mocks.listeners.forEach(fn => fn({ activeWorkspaceId: mocks.workspace, activeProjectId: 'project', enableWebMCP: mocks.enabled }))

it('publishes changed packages and withdraws deletions', async () => {
  stop = startWebMCPAdapterSync()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.publish).toHaveBeenCalledWith([pkg])
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.publish).toHaveBeenCalledTimes(1)
  mocks.listDir.mockResolvedValue([])
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.publish).toHaveBeenLastCalledWith([])
  stop()
  await vi.advanceTimersByTimeAsync(9000)
  expect(mocks.publish).toHaveBeenCalledTimes(2)
})
it('disconnects immediately on disable and workspace switches', async () => {
  stop = startWebMCPAdapterSync()
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
it('does not publish a stale catalog if workspace changes during its read', async () => {
  let release!: (value: unknown[]) => void
  mocks.listDir.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  stop = startWebMCPAdapterSync()
  mocks.workspace = 'workspace-b'
  notify()
  release([])
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.publish).not.toHaveBeenCalled()
})
it('waits for a compatible extension', async () => {
  Reflect.deleteProperty(window, '__agentWeb')
  stop = startWebMCPAdapterSync()
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.connect).not.toHaveBeenCalled()
  Object.assign(window, { __agentWeb: { ready: true, supportsAdapterWorkflows: true } })
  await vi.advanceTimersByTimeAsync(3000)
  expect(mocks.publish).toHaveBeenCalledTimes(1)
})
