import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentApi } from '../../../browser-extension/entrypoints/webmcp/agent-core'
import { runWebMCPPageProbe } from '../../../browser-extension/entrypoints/webmcp/page-api'

afterEach(() => vi.unstubAllGlobals())

describe('WebMCP v6 invocation boundary', () => {
  const tool = { name: 'example', description: 'Example', inputSchema: { type: 'object' } }

  function installContext(executeTool: ReturnType<typeof vi.fn>, native = false) {
    // Map is a real native constructor; its instances model the native API brand.
    // A JavaScript constructor models the v6 polyfill, even with a bound method.
    const ModelContext = native ? Map : class ModelContext {}
    vi.stubGlobal('ModelContext', ModelContext)
    const modelContext = Object.assign(new ModelContext(), {
      getTools: vi.fn().mockResolvedValue([tool]), executeTool,
    })
    vi.stubGlobal('document', {
      modelContext,
    })
  }

  it.each([
    { native: false, args: {} },
    { native: false, args: { query: 'test' } },
    { native: true, args: {} },
    { native: true, args: { query: 'test' } },
  ])('uses the correct input boundary once: %j', async ({ native, args }) => {
    const executeTool = vi.fn().mockImplementation(async (_tool, input) => {
      if (native && typeof input !== 'string') throw new Error('Failed to parse input arguments')
      if (!native && typeof input !== 'object') throw new Error('Expected v6 input object')
      return { received: native ? JSON.parse(input) : input }
    })
    installContext(executeTool, native)

    await expect(resolveAgentApi()!.executeToolByName('example', args)).resolves.toEqual({ received: args })
    expect(await runWebMCPPageProbe({ type: 'invoke', toolName: 'example', args })).toMatchObject({
      ok: true, apiMode: 'documentModelContext', result: { received: args },
    })
    expect(executeTool).toHaveBeenCalledTimes(2)
    for (const call of executeTool.mock.calls) {
      expect(call[0]).toBe(tool)
      expect(call[1]).toEqual(native ? JSON.stringify(args) : args)
    }
  })

  it('does not mistake a bound v6 method for a native context', async () => {
    const executeTool = vi.fn().mockResolvedValue('done')
    installContext(executeTool)
    const context = (document as any).modelContext
    context.executeTool = executeTool.bind(context)

    await resolveAgentApi()!.executeToolByName('example', { query: 'bound' })
    await runWebMCPPageProbe({ type: 'invoke', toolName: 'example', args: { query: 'bound' } })
    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(executeTool).toHaveBeenLastCalledWith(tool, { query: 'bound' })
  })

  it('propagates execution failure without retrying another argument format', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('invalid input object'))
    installContext(executeTool)

    await expect(resolveAgentApi()!.executeToolByName('example', {})).rejects.toThrow('invalid input object')
    expect(executeTool).toHaveBeenCalledTimes(1)
    executeTool.mockClear()
    expect(await runWebMCPPageProbe({ type: 'invoke', toolName: 'example', args: {} })).toMatchObject({
      ok: false, error: 'invalid input object',
    })
    expect(executeTool).toHaveBeenCalledTimes(1)
  })

  it('does not discover or invoke removed navigator APIs', async () => {
    const getTools = vi.fn().mockResolvedValue([tool])
    const executeTool = vi.fn()
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', {
      modelContext: { getTools, executeTool },
      modelContextTesting: { listTools: getTools, executeTool },
    })

    expect(resolveAgentApi()).toBeNull()
    expect(await runWebMCPPageProbe({ type: 'discover' })).toEqual({ ok: true, tools: [] })
    expect(await runWebMCPPageProbe({ type: 'invoke', toolName: 'example', args: {} })).toMatchObject({
      ok: false, errorCode: 'WEBMCP_UNAVAILABLE',
    })
    expect(getTools).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
  })
})
