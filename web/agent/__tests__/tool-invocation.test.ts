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
      getToolDefinitionsForMode: () => [{ function: { name: 'read' } }], execute,
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
})
