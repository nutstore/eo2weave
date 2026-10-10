import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMCPManager: vi.fn(),
  getWebMCPBridge: vi.fn(),
  getWebMCPState: vi.fn(),
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

import { callToolExecutor } from '../external-tool-bridge'

const inputSchema = { type: 'object' as const, properties: {} }
const toolContext = { directoryHandle: null }

describe('external tool bridge error isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getWebMCPBridge.mockReturnValue(null)
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [],
      getPreferredTabIdForTool: () => undefined,
      recordToolInvocation: vi.fn(),
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
    const webTool = {name:'picture',fullName:'picture',groupKey:'example_com',hostname:'example.com',description:'',inputSchema,toolsetSignature:'signature',apiMode:'documentModelContext' as const,representativeTabId:1,annotations:{untrustedContentHint:true}}
    mocks.getMCPManager.mockReturnValue({getAllTools:()=>new Map()})
    mocks.getWebMCPState.mockReturnValue({getEnabledTools:()=>[webTool],getPreferredTabIdForTool:()=>1,recordToolInvocation:vi.fn()})
    mocks.getWebMCPBridge.mockReturnValue({webMCPInvoke:vi.fn().mockResolvedValue({ok:true,result:value,hostname:'example.com',toolName:'picture'})})
    const response = JSON.parse(await callToolExecutor({full_tool_name:'example_com_picture'},toolContext))
    expect(response.data.result).toEqual(value)
    expect(response.contentParts).toHaveLength(1)
    expect(response.contentParts[0].type).toBe('text')
    expect(response.contentParts[0].text).toContain('<untrusted_external_content')
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
      fullName: 'failing_tool',
      groupKey: 'example_com',
      hostname: 'example.com',
      description: '',
      inputSchema,
      toolsetSignature: 'signature',
      apiMode: 'documentModelContext' as const,
      representativeTabId: 1,
      annotations: { untrustedContentHint: true },
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getPreferredTabIdForTool: () => 1,
      recordToolInvocation: vi.fn(),
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        error: 'Remote WebMCP failure',
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        fullToolName: 'failing_tool',
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'example_com_failing_tool',
    }, toolContext))

    expect(response.error.message).toContain('<untrusted_external_content')
    expect(response.error.message).toContain('Remote WebMCP failure')
  })

  it('leaves error text returned by an unmarked WebMCP tool unchanged', async () => {
    const webTool = {
      name: 'failing_tool',
      fullName: 'failing_tool',
      groupKey: 'example_com',
      hostname: 'example.com',
      description: '',
      inputSchema,
      toolsetSignature: 'signature',
      apiMode: 'documentModelContext' as const,
      representativeTabId: 1,
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getPreferredTabIdForTool: () => 1,
      recordToolInvocation: vi.fn(),
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        error: 'Remote WebMCP failure',
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        fullToolName: 'failing_tool',
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'example_com_failing_tool',
    }, toolContext))

    expect(response.error.message).toBe('Remote WebMCP failure')
  })

  it('preserves the WebMCP error fallback when an untrusted tool returns no error text', async () => {
    const webTool = {
      name: 'failing_tool',
      fullName: 'failing_tool',
      groupKey: 'example_com',
      hostname: 'example.com',
      description: '',
      inputSchema,
      toolsetSignature: 'signature',
      apiMode: 'documentModelContext' as const,
      representativeTabId: 1,
      annotations: { untrustedContentHint: true },
    }
    mocks.getMCPManager.mockReturnValue({ getAllTools: () => new Map() })
    mocks.getWebMCPState.mockReturnValue({
      getEnabledTools: () => [webTool],
      getPreferredTabIdForTool: () => 1,
      recordToolInvocation: vi.fn(),
    })
    mocks.getWebMCPBridge.mockReturnValue({
      webMCPInvoke: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'REMOTE_FAILURE',
        hostname: 'example.com',
        toolName: 'failing_tool',
        fullToolName: 'failing_tool',
      }),
    })

    const response = JSON.parse(await callToolExecutor({
      full_tool_name: 'example_com_failing_tool',
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
