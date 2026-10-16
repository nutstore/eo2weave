import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentApi } from '../../../browser-extension/entrypoints/webmcp/agent-core'
import { runWebMCPPageProbe } from '../../../browser-extension/entrypoints/webmcp/page-api'

const objectSchema = { type: 'object', properties: {} }
type Adapter = (args: Record<string, unknown>) => Promise<unknown>

const adapters: Array<{ name: string; create: () => Adapter }> = [
  { name: 'static page agent', create: () => {
    const api = resolveAgentApi()
    expect(api?.mode).toBe('documentModelContext')
    return (args) => api!.executeToolByName('test_tool', args)
  } },
  { name: 'serialized page probe', create: () => {
    // Chrome serializes this function without importing its module scope.
    const probe: typeof runWebMCPPageProbe = new Function(`return (${runWebMCPPageProbe.toString()})`)()
    return (args) => probe({ type: 'invoke', toolName: 'test_tool', args })
  } },
]

function installContext(schema: unknown, serialized: boolean, marked = false, failAfterExecution = false) {
  const target = { name: 'test_tool', description: 'Test invocation contract', inputSchema: schema }
  const callback = vi.fn((args: Record<string, unknown>) => {
    if (failAfterExecution) throw new Error('Execution failed after its side effect')
    return args
  })
  const executeTool = vi.fn(async (tool: unknown, input: unknown) => {
    expect(tool).toBe(target)
    if (serialized && typeof input !== 'string') throw new Error('Failed to parse input arguments')
    if (!serialized && (typeof input !== 'object' || input === null)) throw new TypeError('inputObject must be an object')
    return callback(serialized ? JSON.parse(input as string) : input as Record<string, unknown>)
  })
  const context = { getTools: vi.fn(async () => [target]), executeTool,
    ...(marked ? { __isWebMCPPolyfill: true } : {}) }
  vi.stubGlobal('document', { modelContext: context })
  vi.stubGlobal('navigator', {})
  return { context, executeTool, callback }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each(adapters)('$name argument compatibility', ({ name, create }) => {
  it.each([
    { label: 'legacy native context without a polyfill marker', schema: JSON.stringify(objectSchema), serialized: true },
    { label: 'legacy native context with an empty schema string', schema: '', serialized: true },
    { label: 'current context with an object schema', schema: objectSchema, serialized: false },
    { label: 'current context without a schema', schema: undefined, serialized: false },
    { label: 'marked v4 context with an object schema', schema: objectSchema, serialized: true, marked: true },
  ])('invokes $label exactly once', async ({ schema, serialized, marked }) => {
    const { executeTool, callback } = installContext(schema, serialized, marked)
    const args = { content: '学到了', nested: { enabled: true, values: [1, null, 'text'] } }
    const result = await create()(args)
    if (name === 'serialized page probe') expect(result).toMatchObject({ ok: true, result: args })
    else expect(result).toEqual(args)
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(args)
  })

  it('passes empty read arguments to an unmarked legacy native context', async () => {
    const { executeTool, callback } = installContext(JSON.stringify(objectSchema), true)
    await create()({})
    expect(executeTool.mock.calls[0][1]).toBe('{}')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({})
  })

  it.each([true, false])('does not retry after a write throws (serialized=%s)', async (serialized) => {
    const { executeTool, callback } = installContext(serialized ? JSON.stringify(objectSchema) : objectSchema, serialized, false, true)
    const invocation = create()({ content: 'One write only' })
    if (name === 'serialized page probe') {
      await expect(invocation).resolves.toMatchObject({ ok: false, errorCode: 'INVOKE_FAILED' })
    } else {
      await expect(invocation).rejects.toThrow('Execution failed after its side effect')
    }
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })
})

it('preserves the testing-only API JSON contract', async () => {
  const executeTool = vi.fn(async (_name: string, input: string) => JSON.parse(input))
  vi.stubGlobal('document', {})
  vi.stubGlobal('navigator', { modelContextTesting: { listTools: async () => [], executeTool } })
  const api = resolveAgentApi()
  expect(api?.mode).toBe('modelContextTesting')
  await api!.executeToolByName('test_tool', { content: '学到了' })
  expect(executeTool).toHaveBeenCalledTimes(1)
  expect(executeTool).toHaveBeenCalledWith('test_tool', '{"content":"学到了"}')
})
