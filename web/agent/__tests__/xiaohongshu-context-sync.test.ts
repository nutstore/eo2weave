import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), setTab: vi.fn(), tools: vi.fn(), group: vi.fn() }))
vi.mock('@/webmcp/store', () => ({ useWebMCPStore: { getState: () => ({ getAllTools: mocks.tools, getGroupByKey: mocks.group }) } }))
vi.mock('@/webmcp/manager', () => ({ discoverWebMCPCatalog: vi.fn() }))
vi.mock('../external-tool-bridge', () => ({ setSidePanelBoundTabId: mocks.setTab }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/?source=side_panel&binding=test-binding&origin=https%3A%2F%2Fwww.xiaohongshu.com')
  vi.stubGlobal('__agentWeb', { fetchBoundPageContext: mocks.fetch })
  mocks.tools.mockReturnValue([])
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
  sessionStorage.clear()
})

describe('main synchronization and bound page tool context', () => {
  it('keeps main live-hostname behavior when the active page changes sites', async () => {
    mocks.fetch.mockResolvedValue({ url: 'https://docs.example.com/note', tabId: 7 })
    const context = await import('../workspace-assistant-context')
    const snapshot = await context.capturePageContext()
    expect(snapshot).toMatchObject({ hostname: 'docs.example.com', url: 'https://docs.example.com/note' })
    expect(context.getSidePanelHostname()).toBe('www.xiaohongshu.com')
    expect(mocks.setTab).toHaveBeenCalledWith(7)
  })

  it('includes tools when the followed tab belongs to a group but is not its representative', async () => {
    mocks.fetch.mockResolvedValue({ url: 'https://creator.xiaohongshu.com/publish/publish', tabId: 7 })
    const tool = { hostname: 'creator.xiaohongshu.com', name: 'xhs_publish_content', fullName: 'xhs__xhs_publish_content', description: 'Prepare', groupKey: 'creator', representativeTabId: 2 }
    mocks.tools.mockReturnValue([tool, { ...tool, name: 'unrelated', fullName: 'other', groupKey: 'another' }])
    mocks.group.mockImplementation((key: string) => ({ tabs: key === 'creator' ? [{ tabId: 2 }, { tabId: 7 }] : [{ tabId: 9 }] }))
    const context = await import('../workspace-assistant-context')
    expect(await context.capturePageContext()).toMatchObject({
      hostname: 'creator.xiaohongshu.com', webmcpTools: [{ name: tool.name, fullName: tool.fullName, description: tool.description }],
    })
    expect(mocks.setTab).toHaveBeenCalledWith(7)
  })

  it('does not label an invalid live URL with the previous binding hostname', async () => {
    mocks.fetch.mockResolvedValue({ url: 'not-a-url', tabId: 7 })
    const context = await import('../workspace-assistant-context')
    expect(await context.capturePageContext()).toMatchObject({ hostname: null, webmcpTools: [] })
  })
})
