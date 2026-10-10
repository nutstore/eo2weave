import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { withQuickJsSession, DEFAULT_LIMITS, type QuickJsSession } from '../src/index'
let wasm: WebAssembly.Module
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  wasm = await WebAssembly.compile(await readFile(require.resolve('quickjs-wasi/quickjs.wasm')))
})
const request = { filename: 'session.js', setup: '', limits: { ...DEFAULT_LIMITS, timeoutMs: 1000 } }
const empty = { globals: {}, functions: {} }
const signal = () => new AbortController().signal

describe('scoped QuickJS sessions', () => {
  it('keeps closures and non-JSON state across async calls', async () => {
    const result = await withQuickJsSession(wasm, request, {globals:{},functions:{double:async ([n]) => Number(n)*2}}, signal(), async session => {
      await session.evaluate(`const values = new Map(); globalThis.add = async (key, n) => { values.set(key, await double(n)); return values.size }; globalThis.read = key => values.get(key)`)
      expect(await session.call('add', ['x', 3])).toBe(1)
      return session.call('read', ['x'])
    })
    expect(result).toEqual({ok:true,value:6})
  })
  it('closes escaped references and cancels pending host work on scope exit', async () => {
    let escaped!: QuickJsSession
    let hostSignal!: AbortSignal
    const result = await withQuickJsSession(wasm, request, {globals:{},functions:{wait:async (_, abort) => {hostSignal=abort; return new Promise(() => {})}}}, signal(), async session => {
      escaped=session
      return session.evaluate('void wait(); return 7')
    })
    expect(result).toEqual({ok:true,value:7})
    expect(hostSignal.aborted).toBe(true)
    expect(escaped.signal.aborted).toBe(true)
    await expect(escaped.call('anything')).rejects.toThrow('closed')
  })
  it('uses one aggregate host-call budget across evaluations', async () => {
    const result = await withQuickJsSession(wasm, {...request,limits:{...request.limits,maxHostCalls:1}}, {globals:{},functions:{read:async () => 1}}, signal(), async session => {
      await session.call('read')
      return session.call('read')
    })
    expect(result).toMatchObject({ok:false,error:{message:'Host call limit exceeded'}})
  })
  it('shares the CPU budget across separate evaluations', async () => {
    const result = await withQuickJsSession(wasm, {...request,limits:{...request.limits,cpuTimeMs:50}}, empty, signal(), async session => {
      await session.evaluate('const start = Date.now(); while (Date.now() - start < 30) {}')
      return session.evaluate('const start = Date.now(); while (Date.now() - start < 30) {}')
    })
    expect(result).toMatchObject({ok:false,error:{code:'JS_CPU_LIMIT'}})
  })
  it('times out while the host is waiting between evaluations', async () => {
    const result = await withQuickJsSession(wasm, {...request,limits:{...request.limits,timeoutMs:50}}, empty, signal(), async session => {
      await session.evaluate('globalThis.count = 1')
      await new Promise<void>(resolve => {
        if (session.signal.aborted) resolve()
        else session.signal.addEventListener('abort', () => resolve(), {once:true})
      })
      return null
    })
    expect(result).toMatchObject({ok:false,error:{code:'JS_TIMEOUT'}})
  })
  it('cancels guest evaluation and cleans up when the host callback throws', async () => {
    let escaped!: QuickJsSession
    const result = await withQuickJsSession(wasm, request, empty, signal(), async session => {
      escaped=session
      await session.evaluate('globalThis.value = 1')
      throw new Error('host failed')
    })
    expect(result).toMatchObject({ok:false,error:{message:'host failed'}})
    expect(escaped.signal.aborted).toBe(true)
  })
  it('rejects overlapping evaluations without corrupting the active call', async () => {
    let finish!: (value: number) => void
    const result = await withQuickJsSession(wasm, request, {globals:{},functions:{wait:async () => new Promise<number>(resolve => {finish=resolve})}}, signal(), async session => {
      const first = session.evaluate('return await wait()')
      await expect(session.evaluate('return 2')).rejects.toThrow('Await')
      finish(3)
      return first
    })
    expect(result).toEqual({ok:true,value:3})
  })
  it('safely drains an accidentally unawaited evaluation on scope exit', async () => {
    let operation!: Promise<unknown>
    const result = await withQuickJsSession(wasm, request, empty, signal(), async session => {
      operation = session.evaluate('return await new Promise(() => {})')
      return 1
    })
    expect(result).toEqual({ok:true,value:1})
    await expect(operation).rejects.toThrow('interrupted')
  })
  it('preserves JSON keys and strings when calling a guest function', async () => {
    const argument = JSON.parse('{"__proto__":{"safe":true},"text":"line\\nnext"}')
    const result = await withQuickJsSession(wasm, request, empty, signal(), async session => {
      await session.evaluate('globalThis.echo = value => value')
      await expect(session.call('echo', [Infinity])).rejects.toThrow('JSON')
      return session.call('echo', [argument])
    })
    expect(result).toEqual({ok:true,value:argument})
  })
  it('validates JSON arguments and preflights each evaluation', async () => {
    const result = await withQuickJsSession(wasm, request, empty, signal(), async session => {
      await expect(session.evaluate('return import("x")')).rejects.toMatchObject({code:'JS_PREFLIGHT_FAILED'})
      return session.evaluate('return 2')
    })
    expect(result).toEqual({ok:true,value:2})
  })
})
