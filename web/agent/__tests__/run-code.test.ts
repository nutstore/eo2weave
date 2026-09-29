import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { executeQuickJs } from '@/runtime/quickjs/runtime'
import { runCodeDefinition, runCodeExecutor } from '@/agent/tools/run-code.tool'
import { buildAgentTools, type BuildAgentToolsInput } from '@/agent/loop/build-agent-tools'
import type { ToolDefinition, ToolExecutor } from '@/agent/tools/tool-types'
import { projectTools } from '@/agent/tool-projection'

let wasm: WebAssembly.Module
vi.mock('@/runtime/quickjs/client', () => ({ executeCode: (...args: Parameters<typeof import('@/runtime/quickjs/client').executeCode>) => executeQuickJs(wasm, ...args) }))
vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => 'act' }))
beforeAll(async () => { wasm = await WebAssembly.compile(await readFile(createRequire(import.meta.url).resolve('quickjs-wasi/quickjs.wasm'))) })

function setup(executor: ToolExecutor, mode: 'act' | 'plan' = 'act') {
  const read: ToolDefinition = { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
  const write: ToolDefinition = { ...read, function: { ...read.function, name: 'write' } }
  const definitions = [read, write, runCodeDefinition]
  const before = vi.fn()
  const execute = vi.fn(async (name, args, ctx) => (name === 'run_code' ? runCodeExecutor : executor)(args, ctx))
  const input = {
    toolRegistry: { getToolDefinitionsForMode: () => definitions, execute }, mode,
    beforeToolCall: before,
    getAllMessages: () => [], getAbortSignal: () => undefined,
    getToolContext: () => ({ directoryHandle: null }), setToolContext: vi.fn(),
    provider: { maxContextTokens: 128000, estimateTokens: () => 1 },
    contextManager: { getConfig: () => ({}) }, toolExecutionTimeout: 5000, toolTimeoutExemptions: new Set(),
  } as unknown as BuildAgentToolsInput
  const tools = buildAgentTools(input)
  const run = (code: string) => tools.find(t => t.name === 'run_code')!.execute('parent', { purpose: 'Test code', code })
  return { run, tools, execute, before, input }
}

describe('run_code integration', () => {
  it('keeps all direct tools and excludes recursive code execution', () => {
    const { tools } = setup(async () => '{}')
    expect(tools.map(t => t.name)).toEqual(['read', 'write', 'run_code'])
    expect(projectTools([runCodeDefinition]).codeTools).toEqual([])
  })
  it('uses the same execution hooks, keeps intermediate results out of model context, and records UI traces', async () => {
    const { run, before, input } = setup(async () => JSON.stringify({ value: 5, secret: 'INTERMEDIATE_ONLY' }))
    const result = await run('const a = await tools.read({path:"a"}); console.log("done"); return a.value + 1')
    expect(JSON.stringify(result.content)).toContain('6')
    expect(JSON.stringify(result.content)).not.toContain('INTERMEDIATE_ONLY')
    expect(JSON.stringify(result.content)).toContain('done')
    expect((result.details as { displayContent: string }).displayContent).toContain('INTERMEDIATE_ONLY')
    expect(before.mock.calls.map(c => c[0].toolName)).toEqual(['run_code', 'read'])
    expect(input.setToolContext).not.toHaveBeenCalled()
  })
  it('defers images and explicit context even if the program subsequently fails', async () => {
    const { run } = setup(async (_args, ctx) => {
      ctx.deferContext!([{ type: 'text', text: 'child observation' }])
      return JSON.stringify({ ok: true, tool: 'read', version: 2, data: { path: 'a' }, contentParts: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] })
    })
    const result = await run('await tools.read({path:"a"}); throw new Error("after child")')
    expect(result.content).toContainEqual({ type: 'image', data: 'abc', mimeType: 'image/png' })
    expect(JSON.stringify(result.content)).toContain('child observation')
    expect(JSON.stringify(result.content)).toContain('after child')
  })
  it('enforces Plan policy and validates nested arguments before execution', async () => {
    const { run, execute } = setup(async () => '{}', 'plan')
    expect(JSON.stringify((await run('return await tools.write({path:"a"})')).content)).toContain('not available in plan mode')
    expect(JSON.stringify((await run('return await tools.read({})')).content)).toContain('Invalid arguments')
    expect(execute.mock.calls.every(c => c[0] === 'run_code')).toBe(true)
  })
  it('preserves context from pending calls when canceled', async () => {
    let started: () => void = () => {}
    const ready = new Promise<void>(resolve => { started = resolve })
    const controller = new AbortController()
    const { run, input } = setup(async (_args, ctx) => {
      ctx.deferContext!([{ type: 'text', text: 'observed before cancellation' }])
      started()
      await new Promise((_resolve, reject) => ctx.abortSignal!.addEventListener('abort', () => reject(new Error('canceled')), { once: true }))
      return '{}'
    })
    input.getAbortSignal = () => controller.signal
    const execution = run('await tools.read({path:"a"})')
    await ready
    controller.abort()
    const result = await execution
    expect(JSON.stringify(result.content)).toContain('observed before cancellation')
    expect(JSON.stringify(result.content)).toContain('JS_CANCELED')
  })
  it('orders parallel deferred context by call order and keeps tool error identity', async () => {
    const { run } = setup(async (args, ctx) => {
      await new Promise(resolve => setTimeout(resolve, args.path === 'a' ? 10 : 1))
      ctx.deferContext!([{ type: 'text', text: String(args.path) }])
      return JSON.stringify({ ok: false, version: 2, tool: 'read', error: { code: 'TEST_ERROR', message: 'failure', retryable: false } })
    })
    const result = await run('return await Promise.all(["a","b"].map(async path => { try { await tools.read({path}) } catch(e) { return e.toolName } }))')
    expect(JSON.stringify(result.content[0])).toContain('read')
    expect(result.content.slice(1)).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })
  it('requires purpose and rejects syntax before dispatching tools', async () => {
    const { tools, run, execute } = setup(async () => '{}')
    await expect(tools.find(t => t.name === 'run_code')!.execute('parent', { code: 'return 1' })).rejects.toThrow('Invalid arguments')
    expect(JSON.stringify((await run('const x = ;')).content)).toContain('JS_PREFLIGHT_FAILED')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
