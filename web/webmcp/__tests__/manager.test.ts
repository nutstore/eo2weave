import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  tools: [] as Array<Record<string, unknown>>,
  bridgeAvailable: true,
  enabled: true,
}))

vi.mock('../bridge-client', () => ({
  getWebMCPBridge: () => mocks.bridgeAvailable ? { webMCPDiscover: mocks.discover } : null,
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
  useSettingsStore: {
    getState: () => ({
      enableWebMCP: mocks.enabled,
      setEnableWebMCP: (enabled: boolean) => { mocks.enabled = enabled },
    }),
  },
}))
vi.mock('@/agent/workspace-assistant-context', () => ({
  isSidePanelMode: () => false,
  getSidePanelBindingId: () => null,
}))

import { applyWebMCPGlobalToggle, discoverWebMCPCatalog, expireWebMCPDiscovery, refreshWebMCPCatalog } from '../manager'

describe('WebMCP catalog refresh', () => {
  beforeEach(() => {
    mocks.enabled = true
    mocks.bridgeAvailable = true
    mocks.discover.mockReset()
  })

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

  it('preserves the last catalog when the bridge is temporarily unavailable', async () => {
    const cached = { fullName: 'https_example_com__read', tabs: [{ tabId: 1 }] }
    mocks.tools = [cached]
    mocks.bridgeAvailable = false
    try {
      expect(await discoverWebMCPCatalog(true)).toEqual([cached])
      expect(mocks.tools).toEqual([cached])
    } finally {
      mocks.bridgeAvailable = true
    }
  })

  it('does not commit a discovery that completes after WebMCP is disabled', async () => {
    let finish!: (response: unknown) => void
    mocks.tools = []
    mocks.discover.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = discoverWebMCPCatalog(true)
    await vi.waitFor(() => expect(mocks.discover).toHaveBeenCalledOnce())

    await applyWebMCPGlobalToggle(false)
    finish({ ok: true, tools: [{
      origin: 'https://example.com', name: 'read', fullName: 'https_example_com__read',
      hostname: 'example.com', tabId: 1, discoveredAt: Date.now(),
    }], discoveredAt: Date.now() })
    await pending

    expect(mocks.tools).toEqual([])
  })

  it('starts a new discovery after expiring a stalled request and ignores its late result', async () => {
    let finishOld!: (response: unknown) => void
    mocks.tools = []
    mocks.discover
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
      .mockResolvedValueOnce({ ok: true, tools: [{
        origin: 'https://example.com', name: 'read', fullName: 'https_example_com__read',
        hostname: 'example.com', tabId: 1, groupKey: 'fresh', discoveredAt: Date.now(),
      }], discoveredAt: Date.now() })

    const stale = discoverWebMCPCatalog(true)
    await vi.waitFor(() => expect(mocks.discover).toHaveBeenCalledOnce())
    expireWebMCPDiscovery()
    await discoverWebMCPCatalog(true)
    finishOld({ ok: true, tools: [{
      origin: 'https://example.com', name: 'read', fullName: 'https_example_com__read',
      hostname: 'example.com', tabId: 1, groupKey: 'stale', discoveredAt: Date.now(),
    }], discoveredAt: Date.now() })
    await stale

    expect(mocks.discover).toHaveBeenCalledTimes(2)
    expect(mocks.tools[0].groupKey).toBe('fresh')
  })

  it('shares a forced discovery between concurrent catalog misses', async () => {
    let finish!: (response: unknown) => void
    mocks.tools = []
    mocks.discover.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = discoverWebMCPCatalog(true)
    const second = discoverWebMCPCatalog(true)
    expect(mocks.discover).toHaveBeenCalledOnce()
    finish({ ok: true, tools: [], discoveredAt: Date.now() })
    await Promise.all([first, second])
    expect(mocks.discover).toHaveBeenCalledOnce()
  })
})
