import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  tools: [] as Array<Record<string, unknown>>,
}))

vi.mock('../bridge-client', () => ({
  getWebMCPBridge: () => ({ webMCPDiscover: mocks.discover }),
}))
vi.mock('../store', () => ({
  useWebMCPStore: {
    getState: () => ({
      getAllTools: () => mocks.tools,
      getEnabledTools: () => mocks.tools,
      setDiscoveredTools: (tools: Array<Record<string, unknown>>) => {
        mocks.tools = tools.map((tool) => ({
          ...tool,
          tabs: [{ tabId: tool.tabId, groupKey: tool.groupKey }],
        }))
      },
      setAuthorizationMirror: vi.fn(),
      clearCatalog: () => { mocks.tools = [] },
    }),
  },
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: { getState: () => ({ enableWebMCP: true }) },
}))
vi.mock('@/agent/workspace-assistant-context', () => ({
  isSidePanelMode: () => false,
  getSidePanelBindingId: () => null,
}))

import { discoverWebMCPCatalog, refreshWebMCPCatalog } from '../manager'

describe('WebMCP catalog refresh', () => {
  it('starts a new discovery after an older in-flight request finishes', async () => {
    const makeTool = (groupKey: string) => ({
      origin: 'https://example.com', name: 'read', fullName: 'example_com__read',
      hostname: 'example.com', description: '', inputSchema: { type: 'object' },
      tabId: 1, apiMode: 'documentModelContext', groupKey, discoveredAt: Date.now(),
    })
    let finishOld!: (value: unknown) => void
    let finishFresh!: (value: unknown) => void
    mocks.discover.mockReset()
    mocks.tools = []
    mocks.discover
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishFresh = resolve }))

    const older = discoverWebMCPCatalog()
    await vi.waitFor(() => expect(mocks.discover).toHaveBeenCalledTimes(1))
    const refreshed = refreshWebMCPCatalog()
    finishOld({ ok: true, tools: [makeTool('stale')], discoveredAt: Date.now() })
    await older
    await vi.waitFor(() => expect(mocks.discover).toHaveBeenCalledTimes(2))
    finishFresh({ ok: true, tools: [makeTool('fresh')], discoveredAt: Date.now() })

    expect((await refreshed)[0].tabs[0].groupKey).toBe('fresh')
  })
})
