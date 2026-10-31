import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ register: vi.fn(), entries: vi.fn(), silent: vi.fn(), expand: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/registry', () => ({
  registerTab: mocks.register, getRegistryEntries: mocks.entries,
  getFreshRegistryEntryForTab: mocks.entries,
  getRegistrySilentTabs: mocks.silent, entriesToDiscoveredTools: mocks.expand,
}))
import { discoverWebMCPToolsInCurrentWindow, installAdapterCatalog } from '../../../browser-extension/entrypoints/webmcp/discovery'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.entries.mockResolvedValue([])
  mocks.silent.mockResolvedValue([])
  mocks.expand.mockImplementation(entries => entries.flatMap((entry: any) => entry.tools.map((tool: any) => ({ ...tool, tabId: entry.tabId, origin: entry.origin }))))
})
afterEach(() => vi.unstubAllGlobals())
it('discovers destination adapter tools before page proxies register and retains the exact origin', async () => {
  const tab = { id: 7, windowId: 3, url: 'https://creator.xiaohongshu.com/publish/publish' }
  const query = vi.fn().mockResolvedValue([tab])
  vi.stubGlobal('chrome', { tabs: { query, get: vi.fn().mockResolvedValue(tab) } })
  installAdapterCatalog(async () => [{ name: 'com.xiaohongshu.main.publish_content', description: 'Publish', inputSchema: { type: 'object' } }])
  const response = await discoverWebMCPToolsInCurrentWindow(3)
  expect(query).toHaveBeenCalledWith({ windowId: 3 })
  expect(response.tools).toMatchObject([{ name: 'com.xiaohongshu.main.publish_content', tabId: 7, origin: 'https://creator.xiaohongshu.com' }])
  expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7, origin: 'https://creator.xiaohongshu.com' }))
})
it('does not advertise an adapter if the exact tab navigates while being discovered', async () => {
  vi.stubGlobal('chrome', { tabs: {
    query: vi.fn().mockResolvedValue([{ id: 7, url: 'https://www.xiaohongshu.com/explore' }]),
    get: vi.fn().mockResolvedValue({ id: 7, url: 'https://example.com/' }),
  } })
  installAdapterCatalog(async () => [{ name: 'com.xiaohongshu.main.open_home', description: '', inputSchema: { type: 'object' } }])
  expect((await discoverWebMCPToolsInCurrentWindow()).tools).toEqual([])
  expect(mocks.register).not.toHaveBeenCalled()
})
