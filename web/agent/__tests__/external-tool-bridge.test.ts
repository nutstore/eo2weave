import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshCatalog: vi.fn(),
  discoverCatalog: vi.fn(),
  expireDiscovery: vi.fn(),
  getMCPManager: vi.fn(),
  getWebMCPBridge: vi.fn(),
  getWebMCPState: vi.fn(),
}))

vi.mock('@/webmcp/manager', () => ({
  refreshWebMCPCatalog: mocks.refreshCatalog,
  discoverWebMCPCatalog: mocks.discoverCatalog,
  expireWebMCPDiscovery: mocks.expireDiscovery,
}))

vi.mock('@/mcp/mcp-manager', () => ({
  getMCPManager: mocks.getMCPManager,
}))

vi.mock('@/webmcp/bridge-client', () => ({
  getWebMCPBridge: mocks.getWebMCPBridge,
}))

vi.mock('@/webmcp/store', () => ({
  useWebMCPStore: { getState: mocks.getWebMCPState },
}))

// call_tool now routes through the policy engine (PR-2). These tests target
// error-wrapping behavior only, so authorization is stubbed to allow.
vi.mock('../policy-engine', () => ({
  authorize: vi.fn().mockResolvedValue({ decision: 'allow', via: 'auto' }),
}))

import { callToolExecutor, collectAllExternalTools } from '../external-tool-bridge'
import { useSettingsStore } from '@/store/settings.store'
import { authorize } from '../policy-engine'

const inputSchema = { type: 'object' as const, properties: {} }
const toolContext = { directoryHandle: null }

describe('external tool bridge error isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshCatalog.mockReset()
    mocks.getWebMCPBridge.mockReturnValue(null)
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [],
      getToolByCallName: () => undefined,
    })
  })

  it('preserves mixed media, resource blocks and structuredContent for code callers', async () => {
    const image = {type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}
    const resource = {type:'resource_link',uri:'https://example.com/report',name:'report'}
    const result = {content:[{type:'text',text:'caption'},image,resource],structuredContent:{count:2}}
    mocks.getMCPManager.mockReturnValue({getAllTools:()=>new Map([['server',[{name:'picture',inputSchema}]]]),executeTool:vi.fn().mockResolvedValue(result)})
    const response = JSON.parse(await callToolExecutor({full_tool_name:'server:picture'},toolContext))
    expect(response.data.content).toEqual(result.content)
    expect(response.data.structuredContent).toEqual({count:2})
    expect(response.contentParts).toEqual([...result.content.slice(0,2), {type:'text',text:'{"count":2}'}])
    expect(response.data.text).toBe('caption')
  })
  it('preserves pure images and wraps untrusted text without changing image bytes', async () => {
    const image = {type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}
    const executeTool = vi.fn().mockResolvedValueOnce({content:[image]}).mockResolvedValueOnce({content:[{type:'text',text:'external caption'},image]})
    mocks.getMCPManager.mockReturnValue({getAllTools:()=>new Map([['server',[{name:'picture',inputSchema,annotations:{untrustedContentHint:true}}]]]),executeTool})
    const pure = JSON.parse(await callToolExecutor({full_tool_name:'server:picture'},toolContext))
    expect(pure.data.content).toEqual([image])
    const mixed = JSON.parse(await callToolExecutor({full_tool_name:'server:picture'},toolContext))
    expect(mixed.data.content[0].text).toContain('<untrusted_external_content')
    expect(mixed.data.content[1]).toEqual(image)
  })
  it('keeps untrusted WebMCP JSON machine-readable and wraps only its Agent presentation', async () => {
    const value = {status:'completed',result:{ok:true,value:1,output:[{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}]}}
    const webTool = {name:'picture',origin:'https://example.com',fullName:'picture',hostname:'example.com',description:'',inputSchema,apiMode:'documentModelContext' as const,tabs:[{tabId:1,title:'Example',url:'https://example.com',lastSeenAt:1}],annotations:{untrustedContentHint:true}}
    mocks.getMCPManager.mockReturnValue({getAllTools:()=>new Map()})
    mocks.getWebMCPState.mockReturnValue({getEnabledTools:()=>[webTool],getToolByCallName:(name:string)=>name==='picture'?webTool:undefined})
    mocks.getWebMCPBridge.mockReturnValue({webMCPInvoke:vi.fn().mockResolvedValue({ok:true,origin:'https://example.com',result:value,hostname:'example.com',toolName:'picture',tabId:1})})
    const response = JSON.parse(await callToolExecutor({full_tool_name:'picture',tab_id:1},toolContext))
    expect(response.data.result).toEqual(value)
    expect(response.contentParts).toHaveLength(1)
    expect(response.contentParts[0].type).toBe('text')
    expect(response.contentParts[0].text).toContain('<untrusted_external_content')
  })
  it('requires an exact tab for WebMCP calls', async () => {
    const webTool = {
      name: 'picture',
      origin: 'https://example.com',
      fullName: 'picture',
      hostname: 'example.com',
      description: '',
      inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getToolByCallName: (name: string) => name === 'picture' ? webTool : undefined,
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'picture',
    }, toolContext))

    expect(response.error).toMatchObject({
      code: 'TAB_TARGET_REQUIRED',
      details: { availableTabIds: [1] },
    })
  })
  it('rejects a tab that no longer exposes the selected WebMCP tool', async () => {
    const webTool = {
      name: 'picture',
      origin: 'https://example.com',
      fullName: 'picture',
      hostname: 'example.com',
      description: '',
      inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getToolByCallName: (name: string) => name === 'picture' ? webTool : undefined,
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'picture',
      tab_id: 2,
    }, toolContext))

    expect(response.error).toMatchObject({
      code: 'TAB_TARGET_NOT_FOUND',
      details: { availableTabIds: [1] },
    })
  })
  it('wraps error text returned by an untrusted MCP tool', async () => {
    const tools = new Map([[
      'untrusted-server',
      [{
        name: 'failing_tool',
        inputSchema,
        annotations: { untrustedContentHint: true },
      }],
    ]])
    mocks.getMCPManager.mockReturnValue({
      getAllTools: () => tools,
      executeTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Remote MCP failure' }],
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'untrusted-server:failing_tool',
    }, toolContext))

    expect(response.error.message).toContain('<untrusted_external_content')
    expect(response.error.message).toContain('Remote MCP failure')
  })

  it('wraps error text returned by an untrusted WebMCP tool', async () => {
    const webTool = {
      name: 'failing_tool',
      origin: 'https://example.com',
      fullName: 'failing_tool',
      hostname: 'example.com',
      description: '',
      inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
      annotations: { untrustedContentHint: true },
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getToolByCallName: (name: string) => name === 'failing_tool' ? webTool : undefined,
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        origin: 'https://example.com',
        error: 'Remote WebMCP failure',
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        tabId: 1,
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'failing_tool',
      tab_id: 1,
    }, toolContext))

    expect(response.error.message).toContain('<untrusted_external_content')
    expect(response.error.message).toContain('Remote WebMCP failure')
  })

  it('leaves error text returned by an unmarked WebMCP tool unchanged', async () => {
    const webTool = {
      name: 'failing_tool',
      origin: 'https://example.com',
      fullName: 'failing_tool',
      hostname: 'example.com',
      description: '',
      inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getToolByCallName: (name: string) => name === 'failing_tool' ? webTool : undefined,
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        origin: 'https://example.com',
        error: 'Remote WebMCP failure',
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        tabId: 1,
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'failing_tool',
      tab_id: 1,
    }, toolContext))

    expect(response.error.message).toBe('Remote WebMCP failure')
  })

  it('preserves the WebMCP error fallback when an untrusted tool returns no error text', async () => {
    const webTool = {
      name: 'failing_tool',
      origin: 'https://example.com',
      fullName: 'failing_tool',
      hostname: 'example.com',
      description: '',
      inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
      annotations: { untrustedContentHint: true },
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getToolByCallName: (name: string) => name === 'failing_tool' ? webTool : undefined,
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        origin: 'https://example.com',
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        tabId: 1,
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'failing_tool',
      tab_id: 1,
    }, toolContext))

    expect(response.error.message).toBe('WebMCP tool invocation failed')
  })

  it('leaves error text returned by an unmarked MCP tool unchanged', async () => {
    const tools = new Map([[
      'trusted-server',
      [{ name: 'failing_tool', inputSchema }],
    ]])
    mocks.getMCPManager.mockReturnValue({
      getAllTools: () => tools,
      executeTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Remote MCP failure' }],
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'trusted-server:failing_tool',
    }, toolContext))

    expect(response.error.message).toBe('Remote MCP failure')
  })

  it('does not wrap an MCP error when its untrusted annotation is malformed', async () => {
    const tools = new Map([[
      'malformed-server',
      [{
        name: 'failing_tool',
        inputSchema,
        annotations: { untrustedContentHint: 'false' as unknown as boolean },
      }],
    ]])
    mocks.getMCPManager.mockReturnValue({
      getAllTools: () => tools,
      executeTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Remote MCP failure' }],
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'malformed-server:failing_tool',
    }, toolContext))

    expect(response.error.message).toBe('Remote MCP failure')
  })
})


it('refreshes navigation tools and returns the exact creator continuation without invoking again', async () => {
  const main = { name: 'com.xiaohongshu.main.publish_content', fullName: 'main_publish',
    origin: 'https://www.xiaohongshu.com', hostname: 'www.xiaohongshu.com', description: '', inputSchema,
    tabs: [{ tabId: 7 }], apiMode: 'documentModelContext' }
  const creator = { ...main, fullName: 'creator_publish', origin: 'https://creator.xiaohongshu.com', hostname: 'creator.xiaohongshu.com' }
  mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
  mocks.getWebMCPState.mockReturnValue({ getEnabledTools: () => [main], getToolByCallName: () => main })
  mocks.refreshCatalog.mockResolvedValue([creator, { ...creator, fullName: 'other_tab', tabs: [{ tabId: 8 }] }])
  const invoke = vi.fn().mockResolvedValue({ ok: true, hostname: main.hostname, tabId: 7,
    result: { status: 'success', result: { status: 'navigated', data: { continuation: { origin: creator.origin } } } } })
  mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })
  const result = JSON.parse(await callToolExecutor({ full_tool_name: main.fullName, tab_id: 7, args: {} }, toolContext))
  expect(result.data.continuation_tool).toBe('creator_publish')
  expect(result.data.page_tools).toHaveLength(1)
  expect(result.data.page_tools[0]).toMatchObject({ full_tool_name: 'creator_publish', tab_id: 7, origin: creator.origin })
  expect(invoke).toHaveBeenCalledTimes(1)
})

describe('WebMCP legacy extension compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshCatalog.mockReset()
  })

  const legacySchema = { type: 'object' as const, properties: { a: { type: 'string' } } }

  const legacyTool = (groupKey: string) => ({
    name: 'picture',
    origin: 'https://example.com',
    fullName: 'example_com__picture',
    hostname: 'example.com',
    description: '',
    inputSchema: legacySchema,
    apiMode: 'documentModelContext' as const,
    annotations: { readOnlyHint: true },
    tabs: [{
      tabId: 1,
      title: 'Example',
      url: 'https://example.com',
      lastSeenAt: 1,
      groupKey,
    }],
  })

  const setLegacyState = (getTool: () => ReturnType<typeof legacyTool>) => {
    mocks.getWebMCPState.mockImplementation(() => ({
      getEnabledTools: () => [getTool()],
      getToolByCallName: () => getTool(),
      get discoveredTools() {
        const tool = getTool()
        return [{ ...tool, tabId: 1, annotations: tool.annotations }]
      },
    }))
  }

  it('sends route fields for both extension generations', async () => {
    const tool = legacyTool('example_com_signature')
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      hostname: 'example.com',
      tabId: 1,
      result: { ok: true },
    })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    await callToolExecutor(
      { full_tool_name: tool.fullName, tab_id: 1, args: { a: 'x' } },
      toolContext,
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toMatchObject({
      targetTabId: 1,
      preferredTabId: 1,
      origin: 'https://example.com',
      toolName: 'picture',
      fullToolName: 'example_com__picture',
      groupKey: 'example_com_signature',
      args: { a: 'x' },
    })
  })

  it('refreshes the route key and retries once when the route lookup misses', async () => {
    const stale = legacyTool('example_com_stale')
    const fresh = legacyTool('example_com_fresh')
    let current = stale
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => current)
    mocks.refreshCatalog.mockImplementation(async () => {
      current = fresh
      return [fresh]
    })
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: 'No route cache entry for tool and group — try re-discovering WebMCP tools',
        hostname: '',
        toolName: '',
      })
      .mockResolvedValueOnce({
        ok: true,
        hostname: 'example.com',
        tabId: 1,
        result: { ok: true },
      })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor(
      { full_tool_name: stale.fullName, tab_id: 1, args: { a: 'x' } },
      toolContext,
    ))

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[0][0]).toMatchObject({ groupKey: 'example_com_stale' })
    expect(invoke.mock.calls[1][0]).toMatchObject({
      groupKey: 'example_com_fresh',
      args: { a: 'x' },
    })
    expect(result.data.result).toEqual({ ok: true })
  })

  it('does not retry a route miss after the run is cancelled during discovery', async () => {
    const stale = legacyTool('stale')
    const fresh = legacyTool('fresh')
    let current = stale
    let finishRefresh!: () => void
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => current)
    mocks.refreshCatalog.mockImplementation(() => new Promise<void>((resolve) => {
      finishRefresh = () => { current = fresh; resolve() }
    }))
    const invoke = vi.fn().mockResolvedValue({ ok: false, errorCode: 'INVALID_TOOL_NAME', error: 'route miss' })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })
    const controller = new AbortController()

    const pending = callToolExecutor(
      { full_tool_name: stale.fullName, tab_id: 1, args: { a: 'x' } },
      { ...toolContext, abortSignal: controller.signal },
    )
    await vi.waitFor(() => expect(mocks.refreshCatalog).toHaveBeenCalledOnce())
    controller.abort()
    finishRefresh()
    const result = JSON.parse(await pending)

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.error.code).toBe('CALL_CANCELLED')
  })

  it('returns the original route error when discovery exceeds the retry deadline', async () => {
    const stale = legacyTool('stale')
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => stale)
    mocks.refreshCatalog.mockReturnValue(new Promise(() => {}))
    const invoke = vi.fn().mockResolvedValue({ ok: false, errorCode: 'INVALID_TOOL_NAME', error: 'route miss' })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    vi.useFakeTimers()
    try {
      const pending = callToolExecutor({ full_tool_name: stale.fullName, tab_id: 1 }, toolContext)
      await vi.advanceTimersByTimeAsync(3100)
      const result = JSON.parse(await pending)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(result.error.code).toBe('INVALID_TOOL_NAME')
      expect(mocks.expireDiscovery).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks legacy tools that may write because the old extension can select another tab', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    const invoke = vi.fn()
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(invoke).not.toHaveBeenCalled()
    expect(result.error.code).toBe('LEGACY_EXACT_TAB_UNSUPPORTED')
  })

  it('rejects a legacy read result returned from a different tab', async () => {
    const tool = legacyTool('signature')
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({ ok: true, tabId: 2, result: { value: 'other tab' } }),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.code).toBe('TAB_TARGET_MISMATCH')
  })

  it('uses the selected tab annotation instead of another tab representative', async () => {
    const tool = legacyTool('signature')
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [tool],
      getToolByCallName: () => tool,
      discoveredTools: [{ ...tool, tabId: 1, annotations: { readOnlyHint: false } }],
    })
    const invoke = vi.fn()
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(invoke).not.toHaveBeenCalled()
    expect(result.error.code).toBe('LEGACY_EXACT_TAB_UNSUPPORTED')
  })
})

describe('WebMCP catalog lookup recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshCatalog.mockReset()
    mocks.discoverCatalog.mockReset()
  })

  it('refreshes once when a previously discovered tab tool is temporarily absent', async () => {
    const tool = {
      name: 'list_conversations', origin: 'https://example.com',
      fullName: 'https_example_com__list_conversations', hostname: 'example.com',
      description: '', inputSchema, apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
    }
    let available = false
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockImplementation(() => ({
      getEnabledTools: () => available ? [tool] : [],
      getToolByCallName: () => available ? tool : undefined,
    }))
    mocks.discoverCatalog.mockImplementation(async () => { available = true; return [tool] })
    const invoke = vi.fn().mockResolvedValue({ ok: true, tabId: 1, result: { count: 2 } })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({
      full_tool_name: tool.fullName,
      tab_id: 1,
      args: {},
    }, toolContext))

    expect(mocks.discoverCatalog).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
    expect(result.data.result).toEqual({ count: 2 })
  })

  it('rechecks the selected tab after a transient instance miss', async () => {
    const tool = {
      name: 'read', origin: 'https://example.com', fullName: 'https_example_com__read',
      hostname: 'example.com', description: '', inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 2, title: 'Other', url: 'https://example.com', lastSeenAt: 1 }],
    }
    let restored = false
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockImplementation(() => ({
      getEnabledTools: () => [{ ...tool, tabs: restored ? [...tool.tabs, { ...tool.tabs[0], tabId: 1 }] : tool.tabs }],
      getToolByCallName: () => ({ ...tool, tabs: restored ? [...tool.tabs, { ...tool.tabs[0], tabId: 1 }] : tool.tabs }),
    }))
    mocks.discoverCatalog.mockImplementation(async () => { restored = true; return [] })
    const invoke = vi.fn().mockResolvedValue({ ok: true, tabId: 1, result: { value: 1 } })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(mocks.discoverCatalog).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
  })

  it('does not expose cached WebMCP tools while globally disabled', () => {
    const previous = useSettingsStore.getState().enableWebMCP
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [{ fullName: 'https_example_com__read', tabs: [{ tabId: 1 }] }],
    })
    try {
      useSettingsStore.setState({ enableWebMCP: false })
      expect(collectAllExternalTools()).toEqual([])
    } finally {
      useSettingsStore.setState({ enableWebMCP: previous })
    }
  })

  it('does not invoke a tool if WebMCP is disabled during authorization', async () => {
    const tool = {
      name: 'read', origin: 'https://example.com', fullName: 'https_example_com__read',
      hostname: 'example.com', description: '', inputSchema,
      apiMode: 'documentModelContext' as const,
      tabs: [{ tabId: 1, title: 'Example', url: 'https://example.com', lastSeenAt: 1 }],
    }
    const previous = useSettingsStore.getState().enableWebMCP
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({ getEnabledTools: () => [tool], getToolByCallName: () => tool })
    const invoke = vi.fn()
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })
    let approve!: (value: { decision: 'allow'; via: 'auto' }) => void
    vi.mocked(authorize).mockImplementationOnce(() => new Promise((resolve) => { approve = resolve }))

    try {
      useSettingsStore.setState({ enableWebMCP: true })
      const pending = callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext)
      await vi.waitFor(() => expect(approve).toBeTypeOf('function'))
      useSettingsStore.setState({ enableWebMCP: false })
      approve({ decision: 'allow', via: 'auto' })
      const result = JSON.parse(await pending)
      expect(invoke).not.toHaveBeenCalled()
      expect(result.error.code).toBe('WEBMCP_DISABLED')
    } finally {
      useSettingsStore.setState({ enableWebMCP: previous })
    }
  })
})
