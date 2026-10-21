import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executeWebMCPToolInTab, installAdapterInvoker, invokeWebMCPTool } from '../../../browser-extension/entrypoints/webmcp/invoke'
const mocks = vi.hoisted(() => ({ adapter: vi.fn(), send: vi.fn(), script: vi.fn(), info: vi.fn(), get: vi.fn(), route: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/discovery', () => ({
  discoverToolsInTab: vi.fn(), getRecentRoute: mocks.route,
  getRecentTabsForGroup: () => [{ tabId: 102 }], getTabGroupInfo: mocks.info,
  parseHostname: (url: string) => new URL(url).hostname,
  rememberSuccessfulInvocation: vi.fn(),
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/registry', () => ({ getRegistryEntries: async () => [] }))
vi.mock('../../../browser-extension/entrypoints/webmcp/authorization', () => ({
  isHostEnabled: async () => true, isGroupEnabled: async () => true,
  hostDisabledError: vi.fn(), groupDisabledError: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.adapter.mockResolvedValue(null)
  mocks.route.mockReturnValue({ tabId: 102, hostname: 'example.com', groupKey: 'group', toolName: 'native', toolsetSignature: 'signature' })
  mocks.get.mockImplementation(async (id: number) => ({ id, url: 'https://example.com/' }))
  mocks.info.mockImplementation(async (id: number) => ({ groupKey: id === 102 ? 'group' : 'other' }))
  vi.stubGlobal('chrome', { tabs: { get: mocks.get, sendMessage: mocks.send }, scripting: { executeScript: mocks.script }, runtime: {} })
  installAdapterInvoker(mocks.adapter)
})
afterEach(() => vi.unstubAllGlobals())

it('never falls back to a same-host tab when the explicit target does not match', async () => {
  expect(await invokeWebMCPTool({ preferredTabId: 101, groupKey: 'group', fullToolName: 'full', args: {} }))
    .toMatchObject({ ok: false, errorCode: 'TOOL_TARGET_NOT_FOUND' })
  expect(mocks.adapter).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})
it('does not scan other tabs for an explicit target even when no route is cached', async () => {
  mocks.route.mockReturnValue(null)
  expect(await invokeWebMCPTool({ preferredTabId: 101, groupKey: 'group', fullToolName: 'full', args: {} }))
    .toMatchObject({ ok: false, errorCode: 'INVALID_TOOL_NAME' })
  expect(mocks.info).toHaveBeenCalledTimes(1)
  expect(mocks.info).toHaveBeenCalledWith(101)
  expect(mocks.send).not.toHaveBeenCalled()
})
it('executes available adapters without a page relay or script probe', async () => {
  mocks.adapter.mockResolvedValue({ ok: true, value: { status: 'success' } })
  expect(await executeWebMCPToolInTab(101, 'adapter', {})).toMatchObject({ ok: true, result: { status: 'success' } })
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.script).not.toHaveBeenCalled()
})
it('fails closed when an adapter disappears instead of executing a page tool of the same name', async () => {
  expect(await executeWebMCPToolInTab(101, 'adapter', {}, undefined, true)).toMatchObject({ ok: false, errorCode: 'ADAPTER_UNAVAILABLE' })
  expect(mocks.send).not.toHaveBeenCalled()
})
it('does not retry a native mutation after a missing relay response', async () => {
  mocks.send.mockImplementation((_tab, _message, done) => done(undefined))
  expect(await executeWebMCPToolInTab(101, 'native', {})).toMatchObject({ ok: false, errorCode: 'RELAY_NO_RESPONSE' })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.script).not.toHaveBeenCalled()
})
it('only probes the exact tab when no relay receiver exists', async () => {
  mocks.send.mockImplementation((_tab, _message, done) => {
    Object.assign(chrome.runtime, { lastError: { message: 'Could not establish connection. Receiving end does not exist.' } })
    done(undefined)
    Reflect.deleteProperty(chrome.runtime, 'lastError')
  })
  mocks.script.mockResolvedValue([{ result: { ok: true, result: 7 } }])
  expect(await executeWebMCPToolInTab(101, 'native', {})).toMatchObject({ ok: true, result: 7 })
  expect(mocks.script).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 101 } }))
})
it('does not retry on a channel closing after execution may have started', async () => {
  mocks.send.mockImplementation((_tab, _message, done) => {
    Object.assign(chrome.runtime, { lastError: { message: 'The message port closed before a response was received.' } })
    done(undefined)
    Reflect.deleteProperty(chrome.runtime, 'lastError')
  })
  expect(await executeWebMCPToolInTab(101, 'native', {})).toMatchObject({ ok: false, errorCode: 'RELAY_DISCONNECTED' })
  expect(mocks.script).not.toHaveBeenCalled()
})
it('cancels waiting on a native tool without falling back or accepting a late response', async () => {
  let done!: (value: unknown) => void
  mocks.send.mockImplementation((_tab, _message, callback) => { done = callback })
  const controller = new AbortController()
  const running = executeWebMCPToolInTab(101, 'native', {}, controller.signal)
  const stopped = expect(running).rejects.toThrow('stopped')
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  controller.abort(new Error('stopped'))
  await stopped
  done({ ok: true, result: 'late' })
  expect(mocks.script).not.toHaveBeenCalled()
})
