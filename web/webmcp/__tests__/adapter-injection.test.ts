import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapterInjector } from '../../../browser-extension/entrypoints/webmcp/adapter-injector'
import { manifest } from './fixtures'
const descriptor = { routeId: 'route-1', name: 'com.example.tools.read-title', description: 'Read title', urlRegex: manifest.tools[0].urlRegex, inputSchema: { type: 'object' } }
const invoke = vi.fn(async () => ({ status: 'success', result: 'title' }))

vi.mock('../../../browser-extension/entrypoints/webmcp/register-tools', () => ({ registerPageTools: vi.fn(async () => {}) }))
import { registerPageTools } from '../../../browser-extension/entrypoints/webmcp/register-tools'
beforeEach(() => vi.clearAllMocks())

describe('package injection', () => {
  it('matches URL regexes, namespaces names, and preserves unchanged registrations', async () => {
    let href = 'https://other.test/articles'
    const sync = createAdapterInjector(() => href, invoke)
    await sync([descriptor])
    expect(registerPageTools).not.toHaveBeenCalled()
    href = 'https://example.com/articles'
    await sync([descriptor])
    await sync([descriptor])
    expect(registerPageTools).toHaveBeenCalledTimes(1)
    const [tools] = vi.mocked(registerPageTools).mock.calls[0]
    expect(tools[0].name).toBe('com.example.tools.read-title')
    expect(tools[0].inputSchema).toEqual({ type: 'object' })
    expect(await tools[0].execute({})).toEqual({ status: 'success', result: 'title' })
    expect(invoke).toHaveBeenCalledWith(descriptor, {}, expect.any(AbortSignal))
    href = 'https://example.com/other'
    expect(() => tools[0].execute({})).toThrow('no longer matches')
    await sync([descriptor])
    expect(vi.mocked(registerPageTools).mock.calls[0][1].signal.aborted).toBe(true)
  })
  it('withdraws removed or changed tools and allows the same name in different packages', async () => {
    const sync = createAdapterInjector(() => 'https://example.com/articles', invoke)
    await sync([descriptor, { ...descriptor, routeId: 'route-2', name: 'com.other.tools.read-title' }])
    expect(registerPageTools).toHaveBeenCalledTimes(2)
    const first = vi.mocked(registerPageTools).mock.calls[0][1]
    await sync([{ ...descriptor, description: 'Updated', routeId: 'route-new' }])
    expect(first.signal.aborted).toBe(true)
    const updated = vi.mocked(registerPageTools).mock.calls[2][1]
    await sync([])
    expect(updated.signal.aborted).toBe(true)
  })
  it('keeps an already-triggered workflow independent of proxy withdrawal on navigation', async () => {
    let href = 'https://example.com/articles'
    const sync = createAdapterInjector(() => href, invoke)
    await sync([descriptor])
    const [tools, registration] = vi.mocked(registerPageTools).mock.calls[0]
    let complete!: (result: { status: string; result: string }) => void
    invoke.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const result = tools[0].execute({})
    const executionSignal = (invoke.mock.calls[0] as unknown as [unknown, unknown, AbortSignal])[2]
    href = 'https://destination.test/results'
    await sync([])
    expect(registration.signal.aborted).toBe(true)
    expect(executionSignal.aborted).toBe(false)
    complete({ status: 'success', result: 'destination title' })
    await expect(result).resolves.toEqual({ status: 'success', result: 'destination title' })
  })
  it('serializes overlapping updates and retries failed registrations', async () => {
    const sync = createAdapterInjector(() => 'https://example.com/articles', invoke)
    vi.mocked(registerPageTools).mockRejectedValueOnce(new Error('Name collision'))
    await expect(sync([descriptor])).rejects.toThrow('Name collision')
    await Promise.all([sync([descriptor]), sync([])])
    expect(vi.mocked(registerPageTools).mock.calls[1][1].signal.aborted).toBe(true)
  })
})
