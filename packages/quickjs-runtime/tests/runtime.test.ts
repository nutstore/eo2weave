// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { executeQuickJs, preflight, DEFAULT_LIMITS, type RuntimeBindings } from '../src/index'

let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  wasm = await WebAssembly.compile(await readFile(require.resolve('quickjs-wasi/quickjs.wasm')))
})
const empty: RuntimeBindings = { globals: {}, functions: {} }
function run(code: string, bindings = empty, timeoutMs = 1000, signal = new AbortController().signal) {
  return executeQuickJs(wasm, { code, filename: 'test.js', setup: '', limits: { ...DEFAULT_LIMITS, timeoutMs } }, bindings, signal)
}

describe('generic QuickJS runtime', () => {
  it('does not expose host or application capabilities unless injected', async () => {
    expect(await run(`return [typeof document, typeof window, typeof location,
      typeof chrome, typeof fetch, typeof setTimeout, typeof tools]`)).toEqual({
      ok: true, value: Array(7).fill('undefined'),
    })
  })
  it('builds caller-owned namespaces from JSON values and async functions', async () => {
    const request = {
      code: 'return await service.double(config.value)', filename: 'injection.js',
      setup: 'globalThis.service = Object.freeze({ double: value => double(value) })',
      limits: DEFAULT_LIMITS,
    }
    const config = { value: 21 }
    expect(await executeQuickJs(wasm, request, {
      globals: { config }, functions: { double: async ([value]) => Number(value) * 2 },
    }, new AbortController().signal)).toEqual({ ok: true, value: 42 })
    expect(await run('config.value = 99; return config.value', {
      globals: { config }, functions: {},
    })).toEqual({ ok: true, value: 99 })
    expect(config.value).toBe(21)
  })
  it('rejects reserved binding names, collisions, and native objects', async () => {
    for (const bindings of [
      { globals: { __qjsHost: 1 }, functions: {} },
      { globals: { call: 1 }, functions: { call: async () => null } },
      { globals: {}, functions: { __qjsHost: async () => null } },
      { globals: { native: new Date() }, functions: {} } as unknown as RuntimeBindings,
    ]) expect(await run('return 1', bindings)).toMatchObject({ ok: false })
  })
  it('keeps concurrent VMs and their host bindings independent', async () => {
    const results = await Promise.all([1, 2].map(value => run(
      'globalThis.local = await identity(); return local',
      { globals: {}, functions: { identity: async () => value } },
    )))
    expect(results).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }])
  })
  it('preserves caller-owned JSON metadata on host failures', async () => {
    expect(await run('try { await call() } catch (e) { return [e.code, e.source, e.details] }', {
      globals: {}, functions: { call: async () => {
        throw Object.assign(new Error('denied'), { code: 'DENIED', source: 'custom', details: { reason: 'policy' } })
      } },
    })).toEqual({ ok: true, value: ['DENIED', 'custom', { reason: 'policy' }] })
  })
  it('returns cancellation before starting and cancels pending host work', async () => {
    const canceled = new AbortController()
    canceled.abort()
    expect(await run('return 1', empty, 1000, canceled.signal)).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
    const controller = new AbortController()
    let hostSignal: AbortSignal | undefined
    const bindings: RuntimeBindings = { globals: {}, functions: {
      wait: async (_args, signal) => {
        hostSignal = signal
        controller.abort()
        return new Promise(() => {})
      },
    } }
    expect(await run('await wait()', bindings, 1000, controller.signal)).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
    expect(hostSignal?.aborted).toBe(true)
  })
  it('cancels unawaited host calls when the guest returns', async () => {
    let hostSignal: AbortSignal | undefined
    expect(await run('void wait(); return 1', { globals: {}, functions: {
      wait: async (_args, signal) => {
        hostSignal = signal
        return new Promise(() => {})
      },
    } })).toEqual({ ok: true, value: 1 })
    expect(hostSignal?.aborted).toBe(true)
  })
  it('bounds simultaneous host calls and JSON transfers in both directions', async () => {
    const request = {
      code: 'return await Promise.all([wait(), wait()])', filename: 'limits.js', setup: '',
      limits: { ...DEFAULT_LIMITS, maxConcurrentCalls: 1, timeoutMs: 1000 },
    }
    expect(await executeQuickJs(wasm, request, { globals: {}, functions: {
      wait: async () => new Promise(() => {}),
    } }, new AbortController().signal)).toMatchObject({ ok: false, error: { message: 'Host call limit exceeded' } })
    const small = { ...request, limits: { ...DEFAULT_LIMITS, maxTransferBytes: 256 } }
    for (const [code, bindings] of [
      ['return value', { globals: { value: 'x'.repeat(512) }, functions: {} }],
      ['return "x".repeat(512)', empty],
      ['return await read()', { globals: {}, functions: { read: async () => 'x'.repeat(512) } }],
    ] as [string, RuntimeBindings][]) {
      expect(await executeQuickJs(wasm, { ...small, code }, bindings, new AbortController().signal)).toMatchObject({ ok: false })
    }
  })
  it('executes without tools and isolates globals between invocations', async () => {
    expect(await run('globalThis.leak = 7; return value + 1', { globals: { value: 3 }, functions: {} })).toEqual({ ok: true, value: 4 })
    expect(await run('return typeof leak')).toEqual({ ok: true, value: 'undefined' })
  })
  it('supports concurrent asynchronous host functions and structured failures', async () => {
    const bindings: RuntimeBindings = { globals: {}, functions: {
      double: async args => Number(args[0]) * 2,
      fail: async () => { throw Object.assign(new Error('denied'), { code: 'DENIED' }) },
    } }
    expect(await run('return await Promise.all([double(2), double(3)])', bindings)).toEqual({ ok: true, value: [4, 6] })
    expect(await run('try { await fail() } catch (e) { return e.code }', bindings)).toEqual({ ok: true, value: 'DENIED' })
  })
  it('interrupts infinite loops and never-settled promises', async () => {
    expect(await run('while (true) {}', empty, 20)).toMatchObject({ ok: false, error: { code: 'JS_TIMEOUT' } })
    expect(await run('await new Promise(() => {})', empty, 20)).toMatchObject({ ok: false, error: { code: 'JS_TIMEOUT' } })
  })
  it('rejects lossy return values and undefined host arguments', async () => {
    expect(await run('return { f: () => {} }')).toMatchObject({ ok: false })
    expect(await run('return new Map([[1,2]])')).toMatchObject({ ok: false })
    expect(await run('return new Date()')).toMatchObject({ ok: false })
    expect(await run('return await f(undefined)', { globals: {}, functions: { f: async () => null } })).toMatchObject({ ok: false })
    expect(await run('return')).toEqual({ ok: true, value: null })
  })
  it('cancels host work when execution ends', async () => {
    let hostSignal: AbortSignal | undefined
    await run('await f(); return 1', { globals: {}, functions: { f: async (_args, signal) => { hostSignal = signal; return null } } })
    expect(hostSignal?.aborted).toBe(true)
  })
  it('bounds guest allocation and host call count', async () => {
    const request = { code: 'const a = []; while (true) a.push(new Array(10000).fill(1))', filename: 'memory.js', setup: '', limits: { ...DEFAULT_LIMITS, memoryBytes: 2 * 1024 * 1024, timeoutMs: 500 } }
    expect(await executeQuickJs(wasm, request, empty, new AbortController().signal)).toMatchObject({ ok: false })
    expect(await executeQuickJs(wasm, { ...request, code: 'await f(); await f()', limits: { ...DEFAULT_LIMITS, maxHostCalls: 1 } }, { globals: {}, functions: { f: async () => null } }, new AbortController().signal)).toMatchObject({ ok: false })
  })
  it('charges guest CPU independently from async host waiting', async () => {
    const request = { code: 'await f(); return 1', filename: 'cpu.js', setup: '', limits: { ...DEFAULT_LIMITS, cpuTimeMs: 20, timeoutMs: 1000 } }
    const bindings = { globals: {}, functions: { f: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return null } } }
    expect(await executeQuickJs(wasm, request, bindings, new AbortController().signal)).toEqual({ ok: true, value: 1 })
    expect(await executeQuickJs(wasm, { ...request, code: 'while(true) {}' }, empty, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'JS_CPU_LIMIT' } })
  })
  it('reports user source locations and accepts async function syntax', () => {
    expect(preflight('await Promise.resolve();\nreturn 1')).toEqual([])
    expect(preflight('const x = ;')[0]).toMatchObject({ line: 1, column: 11 })
    expect(preflight('function f() { await x() }')).toHaveLength(1)
    expect(preflight('const x: number = 1')).toHaveLength(1)
    expect(preflight('return import("x")')).toHaveLength(1)
    expect(preflight('return "import(hi)"')).toEqual([])
  })
})

it('streams invocation-local JSON synchronously before failure without consuming host calls', async () => {
  const events: unknown[] = []
  const result = await executeQuickJs(wasm, {
    code:'emitEvent({value:1}); emitEvent({value:2}); throw new Error("failed")',filename:'events.js',setup:'',limits:{...DEFAULT_LIMITS,maxHostCalls:1},
  },{globals:{},functions:{},onEvent:value=>events.push(value)},new AbortController().signal)
  expect(result).toMatchObject({ok:false,error:{message:'failed'}})
  expect(events).toEqual([{value:1},{value:2}])
})
it('keeps event sinks isolated and rejects lossy events or sink errors', async () => {
  const streams: unknown[][] = [[],[]]
  await Promise.all(streams.map((events,index)=>run(`emitEvent(${index}); return null`,{globals:{},functions:{},onEvent:value=>events.push(value)})))
  expect(streams).toEqual([[0],[1]])
  for(const code of ['emitEvent(undefined)','emitEvent({value:Infinity})','emitEvent(new Date())'])
    expect(await run(code,{globals:{},functions:{},onEvent:()=>{throw new Error('must not run')}})).toMatchObject({ok:false,error:{message:expect.stringContaining('JSON')}})
  expect(await run('emitEvent(1)',{globals:{},functions:{},onEvent:()=>{throw Object.assign(new Error('full'),{code:'OUTPUT_LIMIT'})}}))
    .toMatchObject({ok:false,error:{code:'OUTPUT_LIMIT'}})
  expect(await run('return 1',{globals:{emitEvent:1},functions:{},onEvent:()=>{}})).toMatchObject({ok:false})
  expect(await run('return typeof emitEvent')).toEqual({ok:true,value:'undefined'})
})
