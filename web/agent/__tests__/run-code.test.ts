import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { executeQuickJs } from '@creatorweave/quickjs-runtime'
import { runCodeDefinition, runCodeExecutor } from '@/agent/tools/run-code.tool'
import { buildAgentTools, type BuildAgentToolsInput } from '@/agent/loop/build-agent-tools'
import type { ToolDefinition, ToolExecutor } from '@/agent/tools/tool-types'

let wasm: WebAssembly.Module
vi.mock('@/runtime/quickjs/client', () => ({ executeCode: (...args: Parameters<typeof import('@/runtime/quickjs/client').executeCode>) => executeQuickJs(wasm, ...args) }))
vi.mock('@/store/workspace-preferences.store', () => ({ getCurrentWorkspaceAgentMode: () => 'act' }))
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve('@creatorweave/quickjs-runtime/package.json'))
  wasm = await WebAssembly.compile(await readFile(runtimeRequire.resolve('quickjs-wasi/quickjs.wasm')))
})

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
    getToolContext: () => ({ directoryHandle: null }),
    provider: { getModel: () => ({ input: ['text', 'image'] }), maxContextTokens: 128000, estimateTokens: () => 1 },
    contextManager: { getConfig: () => ({}) }, toolExecutionTimeout: 5000, toolTimeoutExemptions: new Set(),
  } as unknown as BuildAgentToolsInput
  const tools = buildAgentTools(input)
  const run = (code: string) => tools.find(t => t.name === 'run_code')!.execute('parent', { purpose: 'Test code', code })
  return { run, tools, execute, before, input }
}

describe('run_code integration', () => {
  it('keeps all direct tools and excludes recursive code execution', async () => {
    const { tools, run } = setup(async () => '{}')
    expect(tools.map(t => t.name)).toEqual(['read', 'write', 'run_code'])
    expect(JSON.stringify((await run('if (tools.run_code) return "exposed"; return await invokeTool("run_code", { purpose: "x", code: "1" })')).content)).toContain('Tool unavailable')
  })
  it('uses the same execution hooks, keeps intermediate results out of model context, and records UI traces', async () => {
    const { run, before } = setup(async () => JSON.stringify({ value: 5, secret: 'INTERMEDIATE_ONLY' }))
    const result = await run('const a = await tools.read({path:"a"}); console.log("done"); return a.value + 1')
    expect(JSON.stringify(result.content)).toContain('6')
    expect(JSON.stringify(result.content)).not.toContain('INTERMEDIATE_ONLY')
    expect(JSON.stringify(result.content)).toContain('done')
    expect((result.details as { displayContent: string }).displayContent).toContain('INTERMEDIATE_ONLY')
    expect(before.mock.calls.map(c => c[0].toolName)).toEqual(['run_code', 'read'])
  })
  it('applies afterToolCall to the model-facing run_code result', async () => {
    const { run, input } = setup(async () => '{}')
    input.afterToolCall = vi.fn(async (ctx) => (ctx.toolName === 'run_code' ? { content: 'PATCHED' } : undefined))
    const result = await run('return 1')
    expect(result.content).toEqual([{ type: 'text', text: 'PATCHED' }])
    expect(JSON.stringify(vi.mocked(input.afterToolCall!).mock.calls.at(-1)![0])).not.toContain('"calls"')
  })
  it('emits selected images and text even when the program subsequently fails', async () => {
    const { run } = setup(async () => JSON.stringify({ ok: true, tool: 'read', version: 2,
      data: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      contentParts: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }))
    const hidden = await run('await tools.read({path:"a"}); return 1')
    expect(hidden.content).toHaveLength(1)
    const result = await run('const a = await tools.read({path:"a"}); text("child observation"); image(a); throw new Error("after child")')
    expect(result.content.slice(1)).toEqual([
      { type: 'text', text: 'child observation' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(JSON.stringify(result.content[0])).toContain('after child')
    expect(JSON.stringify(result.content[0])).not.toContain('iVBORw0KGgo=')
  })
  it('enforces Plan policy and validates nested arguments before execution', async () => {
    const { run, execute } = setup(async () => '{}', 'plan')
    expect(JSON.stringify((await run('return await tools.write({path:"a"})')).content)).toContain('not available in plan mode')
    expect(JSON.stringify((await run('return await tools.read({})')).content)).toContain('Invalid arguments')
    expect(execute.mock.calls.every(c => c[0] === 'run_code')).toBe(true)
  })
  it('preserves explicit output when canceled', async () => {
    let started: () => void = () => {}
    const ready = new Promise<void>(resolve => { started = resolve })
    const controller = new AbortController()
    const { run, input } = setup(async (_args, ctx) => {
      started()
      await new Promise((_resolve, reject) => ctx.abortSignal!.addEventListener('abort', () => reject(new Error('canceled')), { once: true }))
      return '{}'
    })
    input.getAbortSignal = () => controller.signal
    const execution = run('text("observed before cancellation"); await tools.read({path:"a"})')
    await ready
    controller.abort()
    const result = await execution
    expect(JSON.stringify(result.content)).toContain('observed before cancellation')
    expect(JSON.stringify(result.content)).toContain('JS_CANCELED')
  })
  it('lets code choose ordering after parallel calls and preserves error identity', async () => {
    const { run } = setup(async (args) => {
      await new Promise(resolve => setTimeout(resolve, args.path === 'a' ? 10 : 1))
      return JSON.stringify({ ok: false, version: 2, tool: 'read', error: { code: 'TEST_ERROR', message: 'failure', retryable: false } })
    })
    const result = await run('const values = await Promise.all(["a","b"].map(async path => { try { await tools.read({path}) } catch(e) { return {path, toolName:e.toolName, code:e.code} } })); for (const v of values) text(v.path); return values')
    expect(JSON.stringify(result.content[0])).toContain('TEST_ERROR')
    expect(result.content.slice(1)).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
  })
  it('only forwards declared child output explicitly', async () => {
    const { run } = setup(async () => JSON.stringify({ok:true, version:2, tool:'read', data:{ok:true,value:3,output:[{type:'text',text:'child output'}]}}))
    expect(JSON.stringify((await run('await tools.read({path:"a"}); return 2')).content)).not.toContain('child output')
    const result = await run('const child = await tools.read({path:"a"}); output.forward(child.output); return child.value')
    expect(result.content.slice(1)).toEqual([{type:'text',text:'child output'}])
  })
  it('logs synchronously without consuming the asynchronous host call quota', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('for(let i=0;i<500;i++) console.log(i); return 500')
    expect(result.content).toHaveLength(501)
  })
  it('rejects remote image data and detects the actual MIME type', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('image({type:"image",data:"iVBORw0KGgo=",mimeType:"text/html"}); image("https://example.com/image.png")')
    expect(result.content[1]).toEqual({type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'})
    expect(JSON.stringify(result.content[0])).toContain('inline image bytes')
  })
  it('reports output limits with partial output intact', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('for(let i=0;i<1001;i++) text("x"); return 1')
    expect(result.content).toHaveLength(1001)
    expect(JSON.stringify(result.content[0])).toContain('JS_OUTPUT_LIMIT')
  })
  it('leaves OCR to an explicit call for a text-only model', async () => {
    const { run, input } = setup(async () => '{}')
    input.provider = { ...input.provider, getModel: () => ({input:['text']}) } as never
    const result = await run('image("iVBORw0KGgo="); return null')
    expect(result.content.every(p => p.type === 'text')).toBe(true)
    expect(JSON.stringify(result.content)).toContain('does not accept images')
  })
  it('exposes complete MCP media results to code without forwarding intermediate output', async () => {
    const { run } = setup(async () => JSON.stringify({ok:true,version:2,tool:'call_tool',data:{content:[{type:'text',text:'caption'},{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}],structuredContent:{count:2}},contentParts:[{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}]}))
    const result = await run('const r = await tools.read({path:"a"}); image(r.content.find(p=>p.type==="image")); return r.structuredContent')
    expect(JSON.parse((result.content[0] as {text:string}).text).data.value).toEqual({count:2})
    expect(result.content.slice(1)).toEqual([{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}])
    expect(JSON.stringify(result.content)).not.toContain('caption')
  })
  it('bounds cumulative UTF-8 output bytes without losing prior observations', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('text("before limit"); text("汉".repeat(2100000)); return 1')
    expect(result.content.slice(1)).toEqual([{type:'text',text:'before limit'}])
    expect(JSON.stringify(result.content[0])).toContain('JS_OUTPUT_LIMIT')
  })
  it('keeps output when the combined result exceeds the JSON transfer limit', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('text("before limit"); return "x".repeat(8 * 1024 * 1024 - 16)')
    expect(JSON.stringify(result.content[0])).toContain('JS_RESULT_LIMIT')
    expect(result.content.slice(1)).toEqual([{type:'text',text:'before limit'}])
  })
  it('normalizes lower-level output events to the published output schema', async () => {
    const { run } = setup(async () => '{}')
    const result = await run('emitEvent({type:"text",text:"visible",extra:"not output"}); return 1')
    expect(result.content.slice(1)).toEqual([{type:'text',text:'visible'}])
    expect(JSON.stringify((result.details as {displayContent:string}).displayContent)).not.toContain('not output')
  })
  it('persists direct read_image bytes for preview while keeping them out of model text', async () => {
    const { input } = setup(async () => '{}')
    input.toolRegistry.getToolDefinitionsForMode = () => [{type:'function',function:{name:'read_image',description:'image',parameters:{type:'object',properties:{}}}}]
    input.toolRegistry.execute = async()=>JSON.stringify({ok:true,tool:'read_image',version:2,data:{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png',path:'chart.png'}})
    const result = await buildAgentTools(input)[0].execute('image',{})
    expect(JSON.stringify(result.content[0])).not.toContain('iVBORw0KGgo=')
    expect((result.details as {displayContent:string}).displayContent).toContain('iVBORw0KGgo=')
    expect(result.content[1].type).toBe('image')
  })
  it('requires purpose and rejects syntax before dispatching tools', async () => {
    const { tools, run, execute } = setup(async () => '{}')
    await expect(tools.find(t => t.name === 'run_code')!.execute('parent', { code: 'return 1' })).rejects.toThrow('Invalid arguments')
    expect(JSON.stringify((await run('const x = ;')).content)).toContain('JS_PREFLIGHT_FAILED')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
