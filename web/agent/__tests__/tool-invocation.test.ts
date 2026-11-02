import { describe, expect, it, vi } from 'vitest'
import { invokeTool } from '@/services/tool-invocation'
import type { ToolInvocationInput } from '@/services/tool-invocation'
import type { ToolContext } from '@/agent/tools/tool-types'

vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => 'act' }))

// call_tool defaults to a prompt-level policy, which exempts it from the
// tool timeout — the timeout-notification contract below needs the timeout
// ACTIVE, so force the auto level for this module (#139 review round 4).
vi.mock('@/agent/policy-engine', () => ({ getToolPolicy: () => ({ level: 'auto' as const }) }))

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

  it('surfaces a WebMCP CALL_CANCELLED envelope for a call_tool that loses the abort race (#139 review: cancellation warning gets lost)', async () => {
    // call_tool with a full_tool_name (WebMCP-backed): when the run aborts
    // and the tool settles with the structured envelope moments later, the
    // envelope must REPLACE the generic abort rejection.
    const envelope = JSON.stringify({
      ok: false, version: 2, tool: 'call_tool',
      error: { code: 'CALL_CANCELLED', message: 'cancelled', retryable: false },
    })
    const controller = new AbortController()
    const config = input(async () => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 20))
      return envelope
    })
    config.getAbortSignal = () => controller.signal
    config.toolRegistry.getToolDefinitionsForMode = () => [
      { type: 'function', function: { name: 'call_tool', description: '', parameters: { type: 'object', properties: {} } } },
    ]
    const outcome = await invokeTool(config, {
      toolName: 'call_tool', toolCallId: 'a',
      args: { full_tool_name: 'https_example_com__picture' },
      context: { directoryHandle: null },
    })
    expect(JSON.parse(outcome.raw).error.code).toBe('CALL_CANCELLED')
  })

  it('does not wait the race-loss grace period for a non-WebMCP tool on abort (#139 review: Stop waits for unrelated tools)', async () => {
    // A plain tool that stays pending after abort must reject IMMEDIATELY —
    // it can never produce a CALL_CANCELLED envelope, so the caller must
    // not pay the 2s grace wait.
    const config = input(() => new Promise<string>(() => {}))
    const controller = new AbortController()
    config.getAbortSignal = () => controller.signal
    // Start the call and abort only AFTER execute() is inside the race:
    // aborting up-front makes execute()'s throwIfAborted throw synchronously
    // before the internal racers attach, leaving the abort promise
    // rejected-but-unobserved (unhandled rejection noise).
    let releaseExecute!: () => void
    const executeEntered = new Promise<void>((resolve) => { releaseExecute = resolve })
    const config2 = { ...config, toolRegistry: { ...config.toolRegistry, execute: async (): Promise<string> => { releaseExecute(); await new Promise<string>(() => {}); return '' } } }
    const pending = invokeTool(config2, { toolName: 'read', toolCallId: 'a', args: {}, context: { directoryHandle: null } })
    await executeEntered
    // Consume the rejection IN PARALLEL with the race: invokeTool's rejection
    // is observed here, so the internal abort promise can't surface as an
    // unhandled rejection after the test ends.
    const rejectionGuard = pending.then(() => 'RESOLVED', (e) => `REJECTED:${(e as Error).message}`)
    controller.abort()
    const raced = await Promise.race([
      rejectionGuard,
      new Promise((r) => setTimeout(() => r('PENDING'), 300)),
    ])
    expect(raced).not.toBe('PENDING')
    expect(raced).toContain('REJECTED')
    expect(await rejectionGuard).toContain('REJECTED')
  })

  it('notifies onToolTimeout when a WebMCP call_tool settles with the cancellation envelope after the timeout (#139 review: timeout callback is skipped)', async () => {
    const envelope = JSON.stringify({
      ok: false, version: 2, tool: 'call_tool',
      error: { code: 'CALL_CANCELLED', message: 'cancelled', retryable: false },
    })
    const onToolTimeout = vi.fn()
    const config = input(async () => {
      await new Promise((r) => setTimeout(r, 120))
      return envelope
    })
    config.getAbortSignal = () => undefined
    config.callbacks = { onToolTimeout }
    config.toolExecutionTimeout = 50
    config.toolRegistry.getToolDefinitionsForMode = () => [
      { type: 'function', function: { name: 'call_tool', description: '', parameters: { type: 'object', properties: {} } } },
    ]
    const outcome = await invokeTool(config, {
      toolName: 'call_tool', toolCallId: 'a',
      args: { full_tool_name: 'https_example_com__picture' },
      context: { directoryHandle: null },
    })
    expect(JSON.parse(outcome.raw).error.code).toBe('CALL_CANCELLED')
    expect(onToolTimeout).toHaveBeenCalledTimes(1)
  })

  it('does not wait the race-loss grace period for an MCP-backed call_tool (#139 review round 6: MCP calls wait unnecessarily)', async () => {
    // An MCP-backed call_tool ALSO carries a string full_tool_name — but
    // its name uses the `serverId:tool` separator, never the WebMCP
    // origin-derived `__` marker. The grace period (2s) must not be spent
    // waiting for a WebMCP-only cancellation envelope.
    const config = input(() => new Promise<string>(() => {}))
    const controller = new AbortController()
    config.getAbortSignal = () => controller.signal
    config.toolRegistry.getToolDefinitionsForMode = () => [
      { type: 'function', function: { name: 'call_tool', description: '', parameters: { type: 'object', properties: {} } } },
    ]
    let releaseExecute!: () => void
    const executeEntered = new Promise<void>((resolve) => { releaseExecute = resolve })
    const config2 = { ...config, toolRegistry: { ...config.toolRegistry, execute: async (): Promise<string> => { releaseExecute(); await new Promise<string>(() => {}); return '' } } }
    const pending = invokeTool(config2, {
      toolName: 'call_tool', toolCallId: 'a',
      args: { full_tool_name: 'filesystem:read_file' },
      context: { directoryHandle: null },
    })
    await executeEntered
    const rejectionGuard = pending.then(() => 'RESOLVED', (e) => `REJECTED:${(e as Error).message}`)
    controller.abort()
    const raced = await Promise.race([
      rejectionGuard,
      new Promise((r) => setTimeout(() => r('PENDING'), 300)),
    ])
    expect(raced).not.toBe('PENDING')
    expect(raced).toContain('REJECTED')
    expect(await rejectionGuard).toContain('REJECTED')
  })
})
