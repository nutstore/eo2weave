import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sidePanelMode: true,
  hostname: 'www.xiaohongshu.com',
  webTool: {
    name: 'like_feed',
    origin: 'https://www.xiaohongshu.com',
    fullName: 'https_www_xiaohongshu_com__like_feed',
    hostname: 'www.xiaohongshu.com',
    description: 'Like the current feed',
    inputSchema: { type: 'object' as const, properties: {} },
    apiMode: 'documentModelContext' as const,
    tabs: [
      { tabId: 27, title: 'Second note', url: 'https://www.xiaohongshu.com/explore/two', lastSeenAt: 2 },
    ],
  },
}))

vi.mock('@/agent/workspace-assistant-context', () => ({
  getSidePanelBindingId: () => null,
  getSidePanelHostname: () => mocks.hostname,
  isSidePanelMode: () => mocks.sidePanelMode,
}))
vi.mock('@/mcp/mcp-manager', () => ({
  getMCPManager: () => ({ getAllTools: () => new Map() }),
}))
vi.mock('@/webmcp/bridge-client', () => ({ getWebMCPBridge: () => null }))
vi.mock('@/webmcp/plugin-download', () => ({ consumeAndSavePluginDownload: vi.fn() }))
vi.mock('@/webmcp/store', () => ({
  useWebMCPStore: {
    getState: () => ({
      getEnabledTools: () => [mocks.webTool],
    }),
  },
}))

import {
  collectSidePanelPageTools,
  setSidePanelBoundTabId,
} from '../external-tool-bridge'

afterEach(() => setSidePanelBoundTabId(null))

describe('side-panel page tool targeting', () => {
  it('never falls back to same-host tools when the bound tab is unknown', () => {
    setSidePanelBoundTabId(null)
    expect(collectSidePanelPageTools()).toEqual([])

    setSidePanelBoundTabId(999)
    expect(collectSidePanelPageTools()).toEqual([])

    setSidePanelBoundTabId(27)
    expect(collectSidePanelPageTools()).toEqual([mocks.webTool])
  })
})
