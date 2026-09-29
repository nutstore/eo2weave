// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { executeQuickJs } from '../runtime'
import { preflight } from '../preflight'
import { DEFAULT_LIMITS, type RuntimeBindings } from '../types'

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
  it('reports user source locations and accepts async function syntax', () => {
    expect(preflight('await Promise.resolve();\nreturn 1')).toEqual([])
    expect(preflight('const x = ;')[0]).toMatchObject({ line: 1, column: 11 })
    expect(preflight('function f() { await x() }')).toHaveLength(1)
    expect(preflight('const x: number = 1')).toHaveLength(1)
    expect(preflight('return import("x")')).toHaveLength(1)
    expect(preflight('return "import(hi)"')).toEqual([])
  })
})
