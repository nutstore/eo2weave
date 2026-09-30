import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { startWebMCPAdapterSync } from '../adapter-sync'

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(), readFile: vi.fn(), enabled: true,
}))
vi.mock('@/agent/tools/backends/webmcp-backend', () => ({ WebMcpBackend: class {
  listDir = mocks.listDir
  readFile = mocks.readFile
} }))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: { getState: () => ({ enableWebMCP: mocks.enabled }) } }))

let stop: () => void
const metadata = { origin: 'https://example.com', name: 'title', description: 'Title', inputSchema: { type: 'object' } }
const source = `export default [{description:'Read',inspect(){return {status:'ready'}},run(){return 'title'}}]`
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.enabled = true
  mocks.listDir.mockResolvedValue([{ name: 'example', kind: 'directory' }])
  mocks.readFile.mockImplementation(async (path: string) => ({ content: path.endsWith('.json') ? JSON.stringify(metadata) : source }))
})
afterEach(() => { stop(); vi.useRealTimers(); Reflect.deleteProperty(window, '__agentWeb') })

it('syncs changed snapshots, withdraws deletions, and stops polling on cleanup', async () => {
  const setAdapters = vi.fn(async () => ({ ok: true, error: '' }))
  Object.assign(window, { __agentWeb: { ready: true, webMCPSetAdapters: setAdapters } })
  stop = startWebMCPAdapterSync()
  await vi.advanceTimersByTimeAsync(0)
  expect(setAdapters).toHaveBeenCalledWith([{ ...metadata, source }])
  await vi.advanceTimersByTimeAsync(3000)
  expect(setAdapters).toHaveBeenCalledTimes(1)
  mocks.listDir.mockResolvedValue([])
  await vi.advanceTimersByTimeAsync(3000)
  expect(setAdapters).toHaveBeenLastCalledWith([])
  stop()
  await vi.advanceTimersByTimeAsync(9000)
  expect(setAdapters).toHaveBeenCalledTimes(2)
})

it('withdraws adapters when WebMCP is disabled', async () => {
  const setAdapters = vi.fn(async () => ({ ok: true, error: '' }))
  Object.assign(window, { __agentWeb: { ready: true, webMCPSetAdapters: setAdapters } })
  stop = startWebMCPAdapterSync()
  await vi.advanceTimersByTimeAsync(0)
  mocks.enabled = false
  await vi.advanceTimersByTimeAsync(3000)
  expect(setAdapters).toHaveBeenLastCalledWith([])
})

it('waits for the extension bridge to become available', async () => {
  stop = startWebMCPAdapterSync()
  await vi.advanceTimersByTimeAsync(0)
  const setAdapters = vi.fn(async () => ({ ok: true, error: '' }))
  Object.assign(window, { __agentWeb: { ready: true, webMCPSetAdapters: setAdapters } })
  await vi.advanceTimersByTimeAsync(3000)
  expect(setAdapters).toHaveBeenCalledTimes(1)
})
