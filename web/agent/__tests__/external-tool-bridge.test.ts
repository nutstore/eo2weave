import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshCatalog: vi.fn(),
  discoverCatalog: vi.fn(),
  expireDiscovery: vi.fn(),
  getMCPManager: vi.fn(),
  getWebMCPBridge: vi.fn(),
  getWebMCPState: vi.fn(),
  consumeAndSavePluginDownload: vi.fn(),
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

vi.mock('@/webmcp/plugin-download', () => ({
  consumeAndSavePluginDownload: mocks.consumeAndSavePluginDownload,
  // Real class identity: the bridge catches post-save aborts with
  // `instanceof SavedAssetAbortedError`, and the cancellation marker is
  // matched by VALUE (#139 review: pre-start abort becomes failure).
  WEBMCP_DOWNLOAD_ABORTED: '__WEBMCP_DOWNLOAD_ABORTED__',
  // The bridge consults this registry before deleting a saved asset: a path
  // still claimed by another in-flight download must not be deleted.
  isAssetPathClaimed: () => false,
  SavedAssetAbortedError: class SavedAssetAbortedError extends Error {
    readonly savedPath: string
    constructor(savedPath: string) {
      super(`Plugin download aborted after saving asset: ${savedPath}`)
      this.name = 'SavedAssetAbortedError'
      this.savedPath = savedPath
    }
  },
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
    mocks.consumeAndSavePluginDownload.mockReset()
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
      // Read-only: this test isolates error-passthrough behavior, not the
      // write-ambiguity path (which appends its own guidance).
      annotations: { readOnlyHint: true },
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
      // Read-only + untrusted: isolates the untrusted-wrapping behavior.
      annotations: { untrustedContentHint: true, readOnlyHint: true },
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
    mocks.consumeAndSavePluginDownload.mockReset()
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

  it('invokes legacy tools that may write on the preferred tab', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    const invoke = vi.fn().mockResolvedValue({ ok: true, tabId: 1, result: { created: true } })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0][0]).toMatchObject({ targetTabId: 1, preferredTabId: 1, groupKey: 'signature' })
    expect(result.data.result).toEqual({ created: true })
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

  it('reports a legacy write executed in a different tab without retrying it', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    const invoke = vi.fn().mockResolvedValue({ ok: true, tabId: 2, result: { created: true } })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(invoke).toHaveBeenCalledOnce()
    expect(result.error.code).toBe('TAB_TARGET_MISMATCH')
    expect(result.error.message).toContain('may have changed the page')
    expect(result.error.message).toContain('check both tabs before retrying')
    expect(result.error.retryable).toBe(false)
  })

  it('marks a failed write with unknown tab provenance non-retryable (#138 review: partial writes)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // ok=false and NO tabId: the tool may have partially mutated the page
    // before failing — the error must NOT be marked retryable, and the
    // message must tell the caller to verify the page first.
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({ ok: false, error: 'selector not found' }),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain("verify the target tab's state before retrying")
  })

  it('keeps a pre-execution routing error retryable even after a failed route-key refresh (#139 review: safe route errors)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // Route miss with NO tabId, and the route-key refresh fails to produce a
    // replacement — the tool provably never ran, so the error stays retryable.
    mocks.refreshCatalog.mockResolvedValue([])
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: 'No route cache entry for tool and group',
      }),
    })

    vi.useFakeTimers()
    try {
      const pending = callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext)
      await vi.advanceTimersByTimeAsync(3100)
      const result = JSON.parse(await pending)
      expect(result.error.code).toBe('INVALID_TOOL_NAME')
      expect(result.error.retryable).toBe(true)
      expect(result.error.message).not.toContain('verify the target tab')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a routing error reported WITH a tabId non-retryable (#139 review: dispatch-following failures)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // A routing-shaped error that carries a tabId cannot be trusted as
    // pre-execution — the failure may follow the dispatch to a live tab.
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'TOOL_TARGET_NOT_FOUND',
        error: 'target vanished',
        tabId: 1,
      }),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain("verify the target tab's state before retrying")
  })

  it('marks a rejected write invoke non-retryable with verification guidance (#139 review: writes can be retried after applying)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // The bridge rejects AFTER the dispatch may have applied on the page —
    // the caller must not blindly retry the write.
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockRejectedValue(new Error('extension message port closed')),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.code).toBe('WEBMCP_INVOKE_FAILED')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain('may have already been applied')
    expect(result.error.message).toContain("verify the target tab's state before retrying")
  })

  it('keeps a rejected READ invoke retryable (#139 review: repeating a read is safe)', async () => {
    const readTool = { ...legacyTool('signature'), annotations: { readOnlyHint: true } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => readTool)
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockRejectedValue(new Error('extension message port closed')),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: readTool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.retryable).toBe(true)
    expect(result.error.message).not.toContain('may have already been applied')
  })

  it('returns the cancellation envelope without dispatching when the run aborts before the invoke (#139 review: aborted writes still start)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // Never-settling invoke spy: proves the write was NEVER dispatched
    // (#139 review: pre-dispatch cancellation test still dispatches — the
    // old version aborted after several macrotask turns, i.e. during the
    // invoke, where the in-flight abort race alone produces the envelope
    // and the test passes even for a dispatched write).
    const invoke = vi.fn().mockImplementation(() => new Promise(() => {}))
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: invoke,
    })
    // Deterministic interleaving for the exact review gap ("after the
    // stale-approval check and before invokeWithAbort dispatches"): no await
    // sits between the guard and the dispatch, so a REAL AbortController
    // can never flip inside that window. A flipping signal makes the
    // boundary observable: the guard reads `aborted` === false (passes),
    // invokeWithAbort's pre-dispatch check reads it === true and must return
    // the envelope WITHOUT sending.
    let readCount = 0
    const flippingSignal = {
      get aborted() { return readCount++ >= 1 },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal

    const result = JSON.parse(
      await callToolExecutor(
        { full_tool_name: tool.fullName, tab_id: 1, args: { a: 'x' } },
        { ...toolContext, abortSignal: flippingSignal },
      ),
    )
    expect(result.error.code).toBe('CALL_CANCELLED')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain('do not assume it did not run')
    // The decisive assertion the review demanded: the write was NEVER
    // dispatched to the extension.
    expect(invoke).not.toHaveBeenCalled()
    // Sanity: the signal really was read live (guard first, then the
    // pre-dispatch check) rather than short-circuited elsewhere.
    expect(readCount).toBeGreaterThanOrEqual(2)
  })

  it('returns CALL_CANCELLED when the refreshed-route retry is aborted mid-flight (#139 review: retry abort loses cancellation result)', async () => {
    const stale = legacyTool('stale')
    const fresh = legacyTool('fresh')
    let current = stale
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => current)
    mocks.refreshCatalog.mockImplementation(async () => {
      current = fresh
      return [fresh]
    })
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    let settleRetry!: () => void
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: 'route miss',
      })
      .mockImplementationOnce(() => {
        started()
        return new Promise((resolve) => { settleRetry = () => resolve({ ok: true, tabId: 1, result: {} }) })
      })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })
    const controller = new AbortController()

    const pending = callToolExecutor(
      { full_tool_name: stale.fullName, tab_id: 1, args: { a: 'x' } },
      { ...toolContext, abortSignal: controller.signal },
    )
    await startedPromise
    controller.abort() // abort while the REFRESHED-route retry is in flight
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('PENDING'), 300))])
    settleRetry() // unhook the fake invoke so nothing leaks
    expect(raced).not.toBe('PENDING')
    const result = JSON.parse(raced as string)
    expect(result.error.code).toBe('CALL_CANCELLED')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain('may still be running')
  })

  it('marks a post-invocation plugin-download failure non-retryable for write tools (#139 review: download failures can replay writes)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // The page action SUCCEEDED and returned a download plan; the finalize
    // step then fails. Retrying would replay the completed page action.
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: true,
        tabId: 1,
        result: { done: true },
        pluginDownloadPlan: { transferId: 't1' },
      }),
      webMCPPluginDownloadStream: vi.fn(),
      webMCPPluginDownloadFinalize: vi.fn().mockResolvedValue({ ok: false, error: 'finalize exploded' }),
    })
    mocks.consumeAndSavePluginDownload.mockResolvedValue({
      savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.code).toBe('WEBMCP_PLUGIN_DOWNLOAD_FINALIZE_FAILED')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain('already ran')
    expect(result.error.message).toContain('verify its result on the target tab')
  })

  it('keeps a post-invocation plugin-download failure retryable for read-only tools (#139 review: repeating a read is safe)', async () => {
    const readTool = { ...legacyTool('signature'), annotations: { readOnlyHint: true } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => readTool)
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: true,
        tabId: 1,
        result: { done: true },
        pluginDownloadPlan: { transferId: 't1' },
      }),
      webMCPPluginDownloadStream: vi.fn(),
      webMCPPluginDownloadFinalize: vi.fn().mockResolvedValue({ ok: false, error: 'finalize exploded' }),
    })
    mocks.consumeAndSavePluginDownload.mockResolvedValue({
      savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: readTool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.retryable).toBe(true)
    expect(result.error.message).not.toContain('already ran')
  })

  it('a failed READ with unknown tab provenance stays retryable', async () => {
    const tool = legacyTool('signature') // no annotations -> default read behavior? readOnlyHint undefined counts as write; use explicit read
    const readTool = { ...tool, annotations: { readOnlyHint: true } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => readTool)
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: readTool.fullName, tab_id: 1 }, toolContext))
    expect(result.error.retryable).toBe(true)
  })

  it('resolves cancelled WebMCP calls immediately when the run aborts (#138 review: no cancellation path)', async () => {
    const tool = { ...legacyTool('signature'), annotations: { readOnlyHint: false } }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setLegacyState(() => tool)
    // The extension call never settles (no cancellation path in the
    // protocol) — the abort must still resolve the tool call.
    const controller = new AbortController()
    const abortableContext = { ...toolContext, abortSignal: controller.signal }

    // The auth gate rejects already-aborted calls up front; abort only
    // AFTER webMCPInvoke has actually started (explicit signal, not a
    // timing guess — #139 review flake).
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    let resolveInvoke!: () => void
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockImplementation(
        () => {
          started()
          return new Promise((resolve) => { resolveInvoke = () => resolve({ ok: true, tabId: 1, result: {} }) })
        },
      ),
    })
    const pending = callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, abortableContext)
    await startedPromise
    controller.abort()
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('PENDING'), 300))])
    resolveInvoke() // unhook the fake invoke so nothing leaks
    expect(raced).not.toBe('PENDING')
    const result = JSON.parse(raced as string)
    expect(result.error.code).toBe('CALL_CANCELLED')
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain('may still be running')
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

describe('WebMCP #139 round-3 regression coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshCatalog.mockReset()
    mocks.consumeAndSavePluginDownload.mockReset()
  })

  const round3Schema = { type: 'object' as const, properties: { a: { type: 'string' } } }

  const round3Tool = (groupKey: string, annotations?: Record<string, unknown>) => ({
    name: 'picture',
    origin: 'https://example.com',
    fullName: 'example_com__picture',
    hostname: 'example.com',
    description: '',
    inputSchema: round3Schema,
    apiMode: 'documentModelContext' as const,
    ...(annotations ? { annotations } : {}),
    tabs: [{
      tabId: 1,
      title: 'Example',
      url: 'https://example.com',
      lastSeenAt: 1,
      groupKey,
    }],
  })

  const setRound3State = (getTool: () => ReturnType<typeof round3Tool>) => {
    mocks.getWebMCPState.mockImplementation(() => ({
      getEnabledTools: () => [getTool()],
      getToolByCallName: () => getTool(),
      get discoveredTools() {
        const tool = getTool()
        return [{ ...tool, tabId: 1, annotations: tool.annotations }]
      },
    }))
  }

  it('does not auto-retry a routing error that carries a tabId (#139 review: route refresh can repeat writes)', async () => {
    // A routing-shaped error WITH a tabId may have followed a completed
    // dispatch — resending the same arguments could repeat a write.
    const tool = round3Tool('stale', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    mocks.refreshCatalog.mockResolvedValue([])
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      errorCode: 'INVALID_TOOL_NAME',
      error: 'route vanished',
      tabId: 1,
    })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(await callToolExecutor({ full_tool_name: tool.fullName, tab_id: 1 }, toolContext))
    expect(invoke).toHaveBeenCalledOnce() // no refreshed-route retry dispatched
    expect(mocks.refreshCatalog).not.toHaveBeenCalled()
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain("verify the target tab's state before retrying")
  })

  it('marks a routing error from the DISPATCHED refreshed-route retry ambiguous for writes (#139 review: dispatched writes look safe to retry)', async () => {
    // First dispatch: pre-execution route miss (no tabId). After the route
    // refresh, the RETRY is dispatched and comes back with another routing
    // error without a tabId — the call already went out once, so a write
    // must keep the ambiguous (non-retryable) classification.
    let current = round3Tool('stale', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => current)
    mocks.refreshCatalog.mockImplementation(async () => {
      current = round3Tool('fresh', { readOnlyHint: false })
      return [current]
    })
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: 'route miss',
      })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'INVALID_TOOL_NAME',
        error: 'route miss on refreshed key',
      })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })

    const result = JSON.parse(
      await callToolExecutor({ full_tool_name: 'example_com__picture', tab_id: 1 }, toolContext),
    )
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(result.error.retryable).toBe(false)
    expect(result.error.message).toContain("verify the target tab's state before retrying")
  })

  it('returns the cancellation envelope when the abort fires during the route-key refresh (#139 review: slow route refresh loses cancellation)', async () => {
    // The refresh never settles: the abort race must end the call with the
    // envelope instead of waiting on the catalog.
    const stale = round3Tool('stale')
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => stale)
    mocks.refreshCatalog.mockImplementation(() => new Promise(() => {}))
    const invoke = vi.fn().mockResolvedValue({ ok: false, errorCode: 'INVALID_TOOL_NAME', error: 'route miss' })
    mocks.getWebMCPBridge.mockReturnValue({ webMCPInvoke: invoke })
    const controller = new AbortController()

    const pending = callToolExecutor(
      { full_tool_name: stale.fullName, tab_id: 1, args: { a: 'x' } },
      { ...toolContext, abortSignal: controller.signal },
    )
    await vi.waitFor(() => expect(mocks.refreshCatalog).toHaveBeenCalledOnce())
    controller.abort()
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r('PENDING'), 300))])
    expect(raced).not.toBe('PENDING')
    const result = JSON.parse(raced as string)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(result.error.code).toBe('CALL_CANCELLED')
  })

  it('rolls back the saved asset and returns CALL_CANCELLED when the abort fires after the save (#139 review: failed finalize hides a saved file)', async () => {
    const tool = round3Tool('signature', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    // Stub the assets backend at the MODULE boundary: importing the real
    // module pulls in the OPFS workspace manager, which needs a live
    // FileSystemDirectoryHandle the test env cannot provide.
    const deleteFile = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@/agent/tools/backends/assets-backend', () => ({
      AssetsBackend: class {
        deleteFile = deleteFile
      },
    }))
    try {
      // deleteSavedAssetQuietly imports the backend lazily — clear the
      // module registry so the doMock above takes effect on that import.
      vi.resetModules()
      const { callToolExecutor: freshExecutor } = await import('../external-tool-bridge')
      // The fresh module instance re-imports the hoisted test doubles; the
      // factory vi.mocks at the top of the file still apply, so rebind the
      // state/bridge mocks on the SHARED mock fns (already done below).
      mocks.getWebMCPBridge.mockReturnValue({
        webMCPInvoke: vi.fn().mockResolvedValue({
          ok: true,
          tabId: 1,
          result: { done: true },
          pluginDownloadPlan: { transferId: 't1' },
        }),
        webMCPPluginDownloadStream: vi.fn(),
        webMCPPluginDownloadFinalize: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      mocks.consumeAndSavePluginDownload.mockResolvedValue({
        savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
      })
      const controller = new AbortController()

      const pending = freshExecutor(
        { full_tool_name: tool.fullName, tab_id: 1 },
        { ...toolContext, workspaceId: 'ws-1', abortSignal: controller.signal },
      )
      await vi.waitFor(() => expect(mocks.consumeAndSavePluginDownload).toHaveBeenCalledOnce())
      controller.abort()
      const result = JSON.parse(await pending)
      expect(deleteFile).toHaveBeenCalledWith('x.bin')
      expect(result.error.code).toBe('CALL_CANCELLED')
    } finally {
      vi.doUnmock('@/agent/tools/backends/assets-backend')
      vi.resetModules()
    }
  })

  it('surfaces the saved path in the cancellation envelope when the rollback FAILS after an abort (#139 review: cancelled downloads leave orphans / failed rollback hides saved asset)', async () => {
    const tool = round3Tool('signature', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    const deleteFile = vi.fn().mockRejectedValue(new Error('disk boom'))
    vi.doMock('@/agent/tools/backends/assets-backend', () => ({
      AssetsBackend: class {
        deleteFile = deleteFile
      },
    }))
    try {
      vi.resetModules()
      const { callToolExecutor: freshExecutor } = await import('../external-tool-bridge')
      mocks.getWebMCPBridge.mockReturnValue({
        webMCPInvoke: vi.fn().mockResolvedValue({
          ok: true,
          tabId: 1,
          result: { done: true },
          pluginDownloadPlan: { transferId: 't1' },
        }),
        webMCPPluginDownloadStream: vi.fn(),
        webMCPPluginDownloadFinalize: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      mocks.consumeAndSavePluginDownload.mockResolvedValue({
        savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
      })
      const controller = new AbortController()

      const pending = freshExecutor(
        { full_tool_name: tool.fullName, tab_id: 1 },
        { ...toolContext, workspaceId: 'ws-1', abortSignal: controller.signal },
      )
      await vi.waitFor(() => expect(mocks.consumeAndSavePluginDownload).toHaveBeenCalledOnce())
      controller.abort()
      const result = JSON.parse(await pending)
      // Still a cancellation envelope, but the orphan's path must be in the
      // message and the details so the caller can clean it up.
      expect(result.error.code).toBe('CALL_CANCELLED')
      expect(result.error.message).toContain('vfs://assets/x.bin')
      expect(result.error.details?.savedAssetPath).toBe('vfs://assets/x.bin')
    } finally {
      vi.doUnmock('@/agent/tools/backends/assets-backend')
      vi.resetModules()
    }
  })

  it('does NOT dispatch finalize for an already-aborted run and rolls the asset back (#139 review: cancelled runs still finalize transfers)', async () => {
    const tool = round3Tool('signature', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    const deleteFile = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@/agent/tools/backends/assets-backend', () => ({
      AssetsBackend: class {
        deleteFile = deleteFile
      },
    }))
    try {
      vi.resetModules()
      const { callToolExecutor: freshExecutor } = await import('../external-tool-bridge')
      const finalize = vi.fn().mockResolvedValue({ ok: true, transferId: 't1' })
      mocks.getWebMCPBridge.mockReturnValue({
        webMCPInvoke: vi.fn().mockResolvedValue({
          ok: true,
          tabId: 1,
          result: { done: true },
          pluginDownloadPlan: { transferId: 't1' },
        }),
        webMCPPluginDownloadStream: vi.fn(),
        webMCPPluginDownloadFinalize: finalize,
      })
      mocks.consumeAndSavePluginDownload.mockImplementation(async () => {
        // The abort lands between the save and finalize — exactly the gap
        // where the old code dispatched finalize anyway.
        controller.abort()
        return {
          savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
        }
      })
      const controller = new AbortController()

      const result = JSON.parse(
        await freshExecutor(
          { full_tool_name: tool.fullName, tab_id: 1 },
          { ...toolContext, workspaceId: 'ws-1', abortSignal: controller.signal },
        ),
      )
      // The extension must never learn the transfer completed: the file the
      // rollback deletes must not stay referenced by a finalized transfer.
      expect(finalize).not.toHaveBeenCalled()
      expect(deleteFile).toHaveBeenCalledWith('x.bin')
      expect(result.error.code).toBe('CALL_CANCELLED')
    } finally {
      vi.doUnmock('@/agent/tools/backends/assets-backend')
      vi.resetModules()
    }
  })

  it('maps the pre-start download-abort marker to CALL_CANCELLED instead of WEBMCP_PLUGIN_DOWNLOAD_FAILED (#139 review: pre-start abort becomes failure)', async () => {
    const tool = round3Tool('signature', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: true,
        tabId: 1,
        result: { done: true },
        pluginDownloadPlan: { transferId: 't1' },
      }),
    })
    // The real consumeAndSavePluginDownload throws Error(WEBMCP_DOWNLOAD_ABORTED)
    // when the signal aborted before the transfer started. The abort must
    // land AFTER the stale-approval guard, so the download path is really
    // reached: the guard reads the signal once, the download path reads it
    // again — a flipping signal makes the ordering deterministic.
    mocks.consumeAndSavePluginDownload.mockRejectedValue(
      new Error('__WEBMCP_DOWNLOAD_ABORTED__'),
    )
    let readCount = 0
    const flippingSignal = {
      get aborted() { return readCount++ >= 1 },
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal

    const result = JSON.parse(
      await callToolExecutor(
        { full_tool_name: tool.fullName, tab_id: 1 },
        { ...toolContext, workspaceId: 'ws-1', abortSignal: flippingSignal },
      ),
    )
    expect(result.error.code).toBe('CALL_CANCELLED')
    expect(result.error.retryable).toBe(false)
  })

  it('surfaces the orphaned path in the FINALIZE-failure error when the rollback fails (#139 review: failed finalize hides a saved file)', async () => {
    const tool = round3Tool('signature', { readOnlyHint: false })
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    setRound3State(() => tool)
    const deleteFile = vi.fn().mockRejectedValue(new Error('disk boom'))
    vi.doMock('@/agent/tools/backends/assets-backend', () => ({
      AssetsBackend: class {
        deleteFile = deleteFile
      },
    }))
    try {
      vi.resetModules()
      const { callToolExecutor: freshExecutor } = await import('../external-tool-bridge')
      mocks.getWebMCPBridge.mockReturnValue({
        webMCPInvoke: vi.fn().mockResolvedValue({
          ok: true,
          tabId: 1,
          result: { done: true },
          pluginDownloadPlan: { transferId: 't1' },
        }),
        webMCPPluginDownloadStream: vi.fn(),
        webMCPPluginDownloadFinalize: vi.fn().mockResolvedValue({
          ok: false, error: 'extension finalize blew up',
        }),
      })
      mocks.consumeAndSavePluginDownload.mockResolvedValue({
        savedPath: 'x.bin', fileName: 'x.bin', mimeType: 'application/octet-stream', size: 1, patchedResult: {},
      })

      const result = JSON.parse(
        await freshExecutor(
          { full_tool_name: tool.fullName, tab_id: 1 },
          { ...toolContext, workspaceId: 'ws-1' },
        ),
      )
      expect(result.error.code).toBe('WEBMCP_PLUGIN_DOWNLOAD_FINALIZE_FAILED')
      expect(result.error.details?.savedAssetPath).toBe('vfs://assets/x.bin')
      expect(result.error.message).toContain('could not be rolled back')
    } finally {
      vi.doUnmock('@/agent/tools/backends/assets-backend')
      vi.resetModules()
    }
  })
})
