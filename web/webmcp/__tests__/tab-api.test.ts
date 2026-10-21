import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabWebMCPApi } from '../../../browser-extension/entrypoints/webmcp/tab-api'

const mocks = vi.hoisted(() => ({ discover: vi.fn(), execute: vi.fn(), host: vi.fn(), group: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/discovery', () => ({
  discoverToolsInTab: mocks.discover,
  parseHostname: (url: string) => {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname : null
  },
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/invoke', () => ({ executeWebMCPToolInTab: mocks.execute }))
vi.mock('../../../browser-extension/entrypoints/webmcp/authorization', () => ({ isHostEnabled: mocks.host, isGroupEnabled: mocks.group }))

const descriptor = { routeId: 'route', name: 'com.example.focus', description: 'Focus', urlRegex: '^https://example.com/.*$', inputSchema: { type: 'object' } }
const get = vi.fn()
const list = vi.fn()
const api = () => createTabWebMCPApi({ listForTab: list })
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('chrome', { tabs: { get } })
  get.mockImplementation(async (id: number) => ({ id, url: `https://example.com/${id}` }))
  list.mockResolvedValue([descriptor])
  mocks.discover.mockResolvedValue({ ok: true, tools: [{ name: 'native', description: 'Native', inputSchema: { type: 'object' } }] })
  mocks.host.mockResolvedValue(true)
  mocks.group.mockResolvedValue(true)
  mocks.execute.mockResolvedValue({ ok: true, result: { focused: true } })
})
afterEach(() => vi.unstubAllGlobals())

describe('exact-tab WebMCP API', () => {
  it('merges live page tools with SW adapters even before their proxy is injected', async () => {
    const result = await api().listForTab(101)
    expect(result).toMatchObject({ tabId: 101, url: 'https://example.com/101', tools: [
      { name: 'native', source: 'page' }, { name: descriptor.name, source: 'adapter', inputSchema: descriptor.inputSchema },
    ] })
    expect(mocks.discover).toHaveBeenCalledWith(101)
    expect(list).toHaveBeenCalledWith(101)
    expect(get.mock.calls.every(([id]) => id === 101)).toBe(true)
  })
  it('deduplicates proxies in favor of the authoritative adapter metadata', async () => {
    mocks.discover.mockResolvedValue({ ok: true, tools: [{ name: descriptor.name, description: 'Stale proxy' }] })
    expect((await api().listForTab(101)).tools).toEqual([expect.objectContaining({ name: descriptor.name, description: 'Focus', source: 'adapter' })])
  })
  it('passes exact names and tab IDs without same-host fallback', async () => {
    await expect(api().invokeForTab(101, descriptor.name, { query: 'hello' })).resolves.toMatchObject({ tabId: 101, result: { focused: true } })
    expect(mocks.execute).toHaveBeenCalledWith(101, descriptor.name, { query: 'hello' }, undefined, true)
    await expect(api().invokeForTab(102, 'missing', {})).rejects.toMatchObject({ details: { code: 'TOOL_NOT_FOUND' } })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps page execution distinct from adapter execution', async () => {
    await api().invokeForTab(101, 'native', {})
    expect(mocks.execute).toHaveBeenCalledWith(101, 'native', {}, undefined, false)
  })
  it('does not probe a disabled host or an unsupported URL', async () => {
    mocks.host.mockResolvedValue(false)
    await expect(api().listForTab(101)).rejects.toMatchObject({ details: { code: 'HOST_DISABLED' } })
    get.mockResolvedValue({ id: 101, url: 'edge://extensions/' })
    await expect(api().listForTab(101)).rejects.toMatchObject({ details: { code: 'UNSUPPORTED_URL' } })
    expect(mocks.discover).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
  it('enforces group authorization for discovery and execution', async () => {
    mocks.group.mockResolvedValue(false)
    await expect(api().invokeForTab(101, 'native', {})).rejects.toMatchObject({ details: { code: 'GROUP_DISABLED' } })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('rejects navigation during discovery instead of pairing old tools with a new URL', async () => {
    get.mockResolvedValueOnce({ url: 'https://example.com/old' }).mockResolvedValue({ url: 'https://example.com/new' })
    await expect(api().invokeForTab(101, 'native', {})).rejects.toMatchObject({ details: { code: 'PAGE_CHANGED' } })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('reports incomplete page discovery without hiding available SW adapters', async () => {
    mocks.discover.mockResolvedValue({ ok: false, error: 'Probe unavailable' })
    expect(await api().listForTab(101)).toMatchObject({ pageProbeError: 'Probe unavailable', tools: [{ name: descriptor.name }] })
  })
  it('does not claim a tool is missing when page discovery failed', async () => {
    mocks.discover.mockResolvedValue({ ok: false, error: 'Probe unavailable' })
    await expect(api().invokeForTab(101, 'native', {})).rejects.toMatchObject({ details: { code: 'DISCOVERY_FAILED' } })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('propagates execution failures without retries', async () => {
    mocks.execute.mockResolvedValue({ ok: false, errorCode: 'ADAPTER_UNAVAILABLE', error: 'Host disconnected' })
    await expect(api().invokeForTab(101, descriptor.name, {})).rejects.toMatchObject({ message: 'Host disconnected', details: { code: 'ADAPTER_UNAVAILABLE' } })
    expect(mocks.execute).toHaveBeenCalledTimes(1)
  })
  it('does not execute after cancellation during discovery', async () => {
    const controller = new AbortController()
    mocks.discover.mockImplementation(() => { controller.abort(new Error('stopped')); return new Promise(() => {}) })
    await expect(api().invokeForTab(101, 'native', {}, controller.signal)).rejects.toThrow('stopped')
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('rejects non-object arguments before discovering or executing', async () => {
    await expect(api().invokeForTab(101, 'native', [] as never)).rejects.toMatchObject({ details: { code: 'INVALID_ARGUMENTS' } })
    expect(mocks.discover).not.toHaveBeenCalled()
  })
})
