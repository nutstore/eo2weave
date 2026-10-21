// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { executeAdapterWorkflow } from '../../../browser-extension/entrypoints/webmcp/adapter-runtime'
let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const runtimeRequire = createRequire(require.resolve('@creatorweave/quickjs-runtime/package.json'))
  wasm = await WebAssembly.compile(await readFile(runtimeRequire.resolve('quickjs-wasi/quickjs.wasm')))
})
const workflow = (tree: string, result = 'return state.value', outputSchema = "{type: 'number'}") => `export default {
  inputSchema: { type: 'object' }, outputSchema: ${outputSchema},
  tree: ${tree}, result({input, state, target}) { ${result} }
}`
const run = (body: string) => workflow(`{type: 'action', async run({input, state, target}) { ${body}; return 'success' }}`)
const execute = (
  source: string,
  runBrowser = vi.fn(async () => 5 as any),
  controller = new AbortController(),
) => executeAdapterWorkflow(
  wasm,
  source,
  {},
  runBrowser,
  controller.signal,
  { tabId: 1, url: 'https://example.com' },
)

describe('SW behavior tree with guest callbacks', () => {
  it('exposes browser while keeping native APIs and the BT executor out of the VM', async () => {
    const runBrowser = vi.fn(async () => 5)
    const result = await execute(run("if ([typeof window, typeof document, typeof fetch, typeof XMLHttpRequest, typeof chrome, typeof process, typeof require, typeof setTimeout, typeof AbortSignal, typeof createExecution, typeof tools, typeof invokeTool, typeof packageRoot, typeof invoke, typeof command, typeof invokeBrowser, typeof writeLog].some(v => v !== 'undefined')) throw new Error('host leaked'); state.value = (await browser.eval('() => 5', {tab: target.tabId})) + 1"), runBrowser)
    expect(result).toEqual({ ok: true, value: { status: 'success', result: 6 } })
    expect(runBrowser).toHaveBeenCalledWith(expect.objectContaining({ command: 'eval', positionals: ['() => 5'], options: { tab: '1' } }), expect.any(AbortSignal))
  })
  it('shares guest business state without serializing it between nodes', async () => {
    const source = workflow(`{type: 'sequence', children: [
      {type:'action', run({state}) { state.values = new Map([['x', 4]]); state.read = () => state.values.get('x'); return 'success' }},
      {type:'action', run({state}) { state.value = state.read() + 1; return 'success' }}
    ]}`)
    expect(await execute(source)).toEqual({ok:true, value:{status:'success', result:5}})
  })
  it('selects fallback paths, waits, and never repeats a completed side effect', async () => {
    const invoke = vi.fn(async () => 5)
    const source = workflow(`{type:'sequence', children:[
      {type:'selector', children:[
        {type:'condition', inspect() { return false }},
        {type:'sequence', children:[
          {type:'action', async run({state,target}) { state.value = await browser.eval('() => 5', {tab: target.tabId}); state.polls = 0; return 'success' }},
          {type:'wait', intervalMs: 1, inspect({state}) { return ++state.polls >= 3 }}
        ]}
      ]},
      {type:'action', run({state}) { state.value += state.polls; return 'success' }}
    ]}`)
    expect(await execute(source, invoke)).toEqual({ok:true, value:{status:'success', result:8}})
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('returns root failure without evaluating result or later actions', async () => {
    const invoke = vi.fn(async () => 5)
    const source = workflow(`{type:'sequence', children:[
      {type:'condition', inspect() { return false }},
      {type:'action', async run({target}) { await browser.eval('() => 5', {tab: target.tabId}); return 'success' }}
    ]}`, "throw new Error('must not run')")
    expect(await execute(source, invoke)).toEqual({ok:true, value:{status:'failure'}})
    expect(invoke).not.toHaveBeenCalled()
  })
  it('handles running actions and wait timeouts as BT statuses', async () => {
    const source = workflow(`{type:'selector', children:[
      {type:'wait', timeoutMs:0, inspect() { return false }},
      {type:'action', run({state}) { state.value = (state.value || 0) + 1; return state.value < 2 ? 'running' : 'success' }}
    ]}`)
    expect(await execute(source)).toEqual({ok:true,value:{status:'success',result:2}})
  })
  it('validates workflow input before any guest callback', async () => {
    const invoke = vi.fn(async () => 5)
    expect(await executeAdapterWorkflow(wasm, run("state.value = await browser.eval('() => 5', {tab: target.tabId})"), 42, invoke, new AbortController().signal))
      .toMatchObject({ok:false,error:{message:expect.stringContaining('Workflow input')}})
    expect(invoke).not.toHaveBeenCalled()
  })
  it('validates final output and rejects unavailable tools', async () => {
    expect(await execute(run("state.value = 'bad'"))).toMatchObject({ok:false,error:{message:expect.stringContaining('Workflow output')}})
    expect(await execute(run("state.value = await browser.exec('missing')"))).toMatchObject({ok:false,error:{message:expect.stringContaining('Unknown browser command')}})
  })
  it('does not mistake exceptions or malformed statuses for branch failure', async () => {
    for (const body of ["throw new Error('broken')", "return 'ready'", 'return undefined']) {
      const source = workflow(`{type:'selector',children:[
        {type:'action',run(){ ${body} }},
        {type:'action',async run({target}){await browser.eval('() => 5',{tab:target.tabId});return 'success'}}
      ]}`)
      const invoke = vi.fn(async () => 5)
      expect(await execute(source, invoke)).toMatchObject({ok:false})
      expect(invoke).not.toHaveBeenCalled()
    }
    expect(await execute(workflow("{type:'condition',inspect(){return {status:'ready'}}}"))).toMatchObject({ok:false})
  })
  it('cancels in-flight guest tools and interrupts CPU loops', async () => {
    const controller = new AbortController()
    const invoke = vi.fn(async () => { controller.abort(); return 5 })
    expect(await execute(run("state.value = await browser.eval('() => 5', {tab: target.tabId})"), invoke, controller)).toMatchObject({ok:false,error:{code:'JS_CANCELED'}})
    expect(await execute(run('while (true) {}'))).toMatchObject({ok:false,error:{code:'JS_CPU_LIMIT'}})
  })
  it('cancels between ticks and closes the session', async () => {
    const controller = new AbortController()
    const promise = execute(workflow("{type:'wait',async inspect({target}){ await browser.eval('() => 5',{tab:target.tabId}); return false }}"), vi.fn(async () => {
      setTimeout(() => controller.abort(), 5)
      return 5
    }), controller)
    expect(await promise).toMatchObject({ok:false,error:{code:'JS_CANCELED'}})
  })
  it('normalizes undefined final output to null', async () => {
    expect(await execute(workflow("{type:'sequence',children:[]}", 'return undefined', '{type:"null"}')))
      .toEqual({ok:true,value:{status:'success',result:null}})
  })
  it('works under host CSP without Function compilation', async () => {
    const original = globalThis.Function
    globalThis.Function = (() => { throw new Error('unsafe-eval forbidden') }) as unknown as FunctionConstructor
    try {
      expect(await execute(run('state.value = 8'))).toEqual({ok:true,value:{status:'success',result:8}})
    } finally { globalThis.Function = original }
  })
  it('preserves target/input and isolates simultaneous invocations', async () => {
    const source = run('state.value = input.value + target.tabId')
    const results = await Promise.all([1, 2].map(value => executeAdapterWorkflow(wasm, source, {value}, vi.fn(), new AbortController().signal, {tabId:10,url:'https://example.com'})))
    expect(results.map(result => result.ok && result.value)).toEqual([{status:'success',result:11},{status:'success',result:12}])
  })
  it('forwards explicit tab activation to browser.click', async () => {
    const invoke = vi.fn(async () => ({ clicked: true }))
    const source = run("await browser.click('#save', undefined, {tab: target.tabId, activate: true}); state.value = 1")
    expect(await execute(source, invoke)).toEqual({ok:true,value:{status:'success',result:1}})
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      command: 'click', positionals: ['#save'], options: {tab: '1', activate: true},
    }), expect.any(AbortSignal))
  })
  it('allows a reentrant WebMCP call through browser.webmcp', async () => {
    const invoke = vi.fn(async () => ({tabId: 1, url: 'https://example.com', hostname: 'example.com', groupKey: 'group', tools: []}))
    const source = run("const result = await browser.webmcp.list({tab: target.tabId}); state.value = result.tools.length")
    const result = await executeAdapterWorkflow(wasm, source, {}, invoke, new AbortController().signal, {tabId:1,url:'https://example.com'})
    expect(result).toEqual({ok:true,value:{status:'success',result:0}})
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      command: 'webmcp', positionals: ['list'], options: {tab: '1'},
    }), expect.any(AbortSignal))
  })
})
