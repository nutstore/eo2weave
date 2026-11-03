import { describe, expect, it, vi } from 'vitest'
import { invokeTool } from '@/services/tool-invocation'
import type { ToolInvocationInput } from '@/services/tool-invocation'
import type { ToolContext } from '@/agent/tools/tool-types'

vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => 'act' }))

function input(execute: (name: string, args: unknown, context: ToolContext) => Promise<string>) {
  return {
    mode: 'act', toolExecutionTimeout: 1000, toolTimeoutExemptions: new Set(),
    getAbortSignal: () => undefined,
    toolRegistry: {
      getToolDefinitionsForMode: () => [
        { function: { name: 'read' } },
        { function: { name: 'call_tool', parameters: { type: 'object', properties: {} } } },
      ], execute,
    },
  } as unknown as ToolInvocationInput
}

describe('shared tool invocation', () => {
  it('keeps full structured data and per-call contexts isolated', async () => {
    const contexts: ToolContext[] = []
    const config = input(async (_name, _args, context) => {
      contexts.push(context)
      await Promise.resolve()
      return JSON.stringify({ ok: true, version: 2, tool: 'read', data: { text: 'x'.repeat(100000) } })
    })
    const context = { directoryHandle: null }
    const results = await Promise.all(['a', 'b'].map(toolCallId => invokeTool(config, {
      toolName: 'read', toolCallId, args: {}, context,
    })))
    expect(contexts[0]).not.toBe(contexts[1])
    expect(context).toEqual({ directoryHandle: null })
    expect(contexts.map(c=>c.currentToolCallId)).toEqual(['a','b'])
    expect(contexts.every(c=>!Object.hasOwn(c,'deferContext'))).toBe(true)
    expect(results[0].value).toEqual({ text: 'x'.repeat(100000) })
  })

  it('reports ordinary tool failures without fabricating context output', async () => {
    const config = input(async () => { throw new Error('failed') })
    await expect(invokeTool(config, {toolName:'read',toolCallId:'a',args:{},context:{directoryHandle:null}})).rejects.toThrow('failed')
  })
  it('rechecks caller capabilities for nested invocation', async () => {
    let names = ['run_code','read']
    const execute = vi.fn(async (name, _args, context: ToolContext) => {
      if(name === 'run_code') {
        expect(context.codeTools!.names).toEqual(['read'])
        names = ['run_code']
        await context.codeTools!.invoke({toolName:'read',toolCallId:'nested',args:{},signal:new AbortController().signal})
      }
      return '{}'
    })
    const config = input(execute)
    config.toolRegistry.getToolDefinitionsForMode = () => ['read','run_code','ask_user_question'].map(name=>({type:'function',function:{name,description:'',parameters:{type:'object',properties:{}}}}))
    config.allowedToolNames = () => names
    await expect(invokeTool(config, {toolName:'run_code',toolCallId:'a',args:{},context:{directoryHandle:null}})).rejects.toThrow('Tool unavailable: read')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('skips the envelope grace wait for MCP-backed call_tool (#148 round 8: MCP cancellations were delayed)', async () => {
    // An MCP full name (serverId:toolName) loses the abort race — it must
    // surface the abort error immediately, not wait out a 2s envelope grace
    // window for an envelope MCP calls never produce.
    const controller = new AbortController()
    const config = input(() =>
      new Promise<string>(() => {
        setTimeout(() => controller.abort(), 20)
      }),
    )
    config.getAbortSignal = () => controller.signal
    const started = Date.now()
    await expect(invokeTool(config, {
      toolName: 'call_tool',
      toolCallId: 'mcp1',
      args: { full_tool_name: 'my-server:slow_tool' },
      context: { directoryHandle: null },
    })).rejects.toThrow(/was aborted/)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('keeps the envelope grace wait for WebMCP call_tool', async () => {
    const controller = new AbortController()
    const cancelledEnvelope = JSON.stringify({
      ok: false,
      version: 2,
      tool: 'call_tool',
      error: { code: 'CALL_CANCELLED', message: 'cancelled', retryable: false },
    })
    const config = input(async () => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 20))
      return cancelledEnvelope
    })
    config.getAbortSignal = () => controller.signal

    // WebMCP full name (https_ host prefix + __ separator): the envelope wins.
    const webmcp = await invokeTool(config, {
      toolName: 'call_tool',
      toolCallId: 'wm1',
      args: { full_tool_name: 'https_example_com__write_doc' },
      context: { directoryHandle: null },
    })
    expect(JSON.parse(webmcp.raw).error.code).toBe('CALL_CANCELLED')
  })
})
