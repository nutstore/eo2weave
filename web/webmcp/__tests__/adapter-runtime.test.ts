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
const workflow = (run: string, inspect = "return { status: 'ready' }") => `export default [{
  description: 'Test', inputSchema: { type: 'object' }, outputSchema: { type: 'number' },
  async inspect({input, state}) { ${inspect} }, async run({input, state}) { ${run} }
}]`
const execute = (source: string, invoke = vi.fn(async () => 5), controller = new AbortController()) =>
  executeAdapterWorkflow(wasm, source, {}, ['read'], invoke, controller.signal)
describe('SW adapter QuickJS workflow', () => {
  it('uses async tool bindings without exposing DOM or host APIs', async () => {
    const invoke = vi.fn(async () => 5)
    const result = await execute(workflow("if (typeof document !== 'undefined' || typeof fetch !== 'undefined') throw new Error('host leaked'); return (await tools.read({path: 'x'})) + 1"), invoke)
    expect(result).toEqual({ ok: true, value: { status: 'completed', result: 6 } })
    expect(invoke).toHaveBeenCalledWith(['read', { path: 'x' }], expect.any(AbortSignal))
  })
  it('validates output and rejects unavailable tools', async () => {
    expect(await execute(workflow("return 'bad'"))).toMatchObject({ ok: false, error: { message: expect.stringContaining('Step 1 output') } })
    expect(await execute(workflow("return await invokeTool('missing', {})"))).toMatchObject({ ok: false, error: { message: expect.stringContaining('Tool unavailable') } })
  })
  it('invokes run_code when the workspace host exposes it', async () => {
    const invoke = vi.fn(async () => 5)
    const result = await executeAdapterWorkflow(wasm, workflow("return await tools.run_code({purpose: 'Compose tools', code: 'return 5'})"), {}, ['read', 'run_code'], invoke, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: { status: 'completed', result: 5 } })
    expect(invoke).toHaveBeenCalledWith(['run_code', { purpose: 'Compose tools', code: 'return 5' }], expect.any(AbortSignal))
  })
  it('blocks before side effects and passes state between steps', async () => {
    const invoke = vi.fn(async () => 5)
    expect(await execute(workflow('return await tools.read({})', "return { status: 'blocked', message: 'Not ready' }"), invoke))
      .toMatchObject({ ok: true, value: { status: 'blocked', step: 1, message: 'Not ready' } })
    expect(invoke).not.toHaveBeenCalled()
    const source = workflow('state.value = 4; return 1').slice(0, -1) + `, {
      description: 'Next', inputSchema: { type: 'number' }, outputSchema: { type: 'number' },
      inspect() { return {status: 'ready'} }, run({input, state}) { return input + state.value }
    }]`
    expect(await execute(source)).toEqual({ ok: true, value: { status: 'completed', result: 5 } })
  })
  it('cancels in-flight tools and interrupts CPU loops', async () => {
    const controller = new AbortController()
    const invoke = vi.fn(async () => { controller.abort(); return 5 })
    expect(await execute(workflow('return await tools.read({})'), invoke, controller)).toMatchObject({ ok: false })
    expect(await execute(workflow('while (true) {}'))).toMatchObject({ ok: false, error: { code: 'JS_CPU_LIMIT' } })
  })
})

it('validates the first input before inspect and later inputs before advancing', async () => {
  const invoke = vi.fn(async () => 5)
  expect(await executeAdapterWorkflow(wasm, workflow('return 1', "await tools.read({}); return {status: 'ready'}"), 42, ['read'], invoke, new AbortController().signal))
    .toMatchObject({ ok: false, error: { message: expect.stringContaining('Step 1 input') } })
  expect(invoke).not.toHaveBeenCalled()
  const source = workflow('return 1').slice(0, -1) + `, {
    description: 'Next', inputSchema: { type: 'string' }, outputSchema: true,
    async inspect() { await tools.read({}); return {status: 'ready'} }, run() { return null }
  }]`
  expect(await execute(source, invoke)).toMatchObject({ ok: false, error: { message: expect.stringContaining('Step 2 input') } })
  expect(invoke).not.toHaveBeenCalled()
})
it('rejects invalid inspection states and normalizes undefined outputs to null', async () => {
  expect(await execute(workflow('return 1', "return {status: 'skip'}")))
    .toMatchObject({ ok: false, error: { message: expect.stringContaining('inspect must return') } })
  const source = workflow('return undefined').replace("outputSchema: { type: 'number' }", 'outputSchema: { type: "null" }')
  expect(await execute(source)).toEqual({ ok: true, value: { status: 'completed', result: null } })
})
it('executes under a host CSP that forbids JavaScript Function compilation', async () => {
  const original = globalThis.Function
  globalThis.Function = (() => { throw new Error('unsafe-eval forbidden') }) as unknown as FunctionConstructor
  try {
    expect(await execute(workflow('return 8'))).toEqual({ ok: true, value: { status: 'completed', result: 8 } })
  } finally { globalThis.Function = original }
})
