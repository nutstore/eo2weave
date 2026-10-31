import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { executeWebMCPToolInTab, installAdapterInvoker, invokeWebMCPTool } from '../../../browser-extension/entrypoints/webmcp/invoke'
const mocks = vi.hoisted(() => ({ adapter: vi.fn(), send: vi.fn(), script: vi.fn(), info: vi.fn(), get: vi.fn(), route: vi.fn(), catalog: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/discovery', () => ({
  discoverToolsInTab: mocks.info,
  currentAdapterCatalogForTab: mocks.catalog,
  parseHostname: (url: string) => new URL(url).hostname,
  parseOrigin: (url: string) => new URL(url).origin,
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/registry', () => ({ getRegistryEntries: mocks.route }))
vi.mock('../../../browser-extension/entrypoints/webmcp/authorization', () => ({
  isHostEnabled: async () => true,
  hostDisabledError: vi.fn(),
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.adapter.mockResolvedValue(null)
  mocks.catalog.mockResolvedValue(null)
  mocks.route.mockResolvedValue([{
    tabId: 102,
    origin: 'https://example.com',
    hostname: 'example.com',
    tools: [{ name: 'native', description: '', inputSchema: { type: 'object' } }],
  }])
  mocks.get.mockImplementation(async (id: number) => ({ id, url: 'https://example.com/' }))
  mocks.info.mockResolvedValue({ ok: true, tools: [] })
  vi.stubGlobal('chrome', { tabs: { get: mocks.get, sendMessage: mocks.send }, scripting: { executeScript: mocks.script }, runtime: {} })
  installAdapterInvoker(mocks.adapter)
})
afterEach(() => vi.unstubAllGlobals())

it('never falls back to a same-host tab when the exact target lacks the tool', async () => {
  expect(await invokeWebMCPTool({
    targetTabId: 101,
    origin: 'https://example.com',
    toolName: 'native',
    args: {},
  })).toMatchObject({ ok: false, errorCode: 'TOOL_NOT_FOUND' })
  expect(mocks.adapter).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})
it('probes only the exact target tab', async () => {
  expect(await invokeWebMCPTool({
    targetTabId: 101,
    origin: 'https://example.com',
    toolName: 'native',
    args: {},
  })).toMatchObject({ ok: false, errorCode: 'TOOL_NOT_FOUND' })
  expect(mocks.info).toHaveBeenCalledTimes(1)
  expect(mocks.info).toHaveBeenCalledWith(101)
  expect(mocks.send).not.toHaveBeenCalled()
})
it('rejects a target tab that no longer has the expected origin', async () => {
  expect(await invokeWebMCPTool({
    targetTabId: 101,
    origin: 'https://other.example',
    toolName: 'native',
    args: {},
  })).toMatchObject({ ok: false, errorCode: 'TARGET_ORIGIN_MISMATCH' })
  expect(mocks.info).not.toHaveBeenCalled()
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

it('rejects a stale adapter-served invocation instead of falling back to the page relay (round-5)', async () => {
  // Sourcery round-5 regression guard: the registry entry still carries a
  // name marked adapter-owned after the catalog dropped the route (the next
  // adapter-merge discovery has not reconciled it yet). The web app —
  // holding the adapter's previously trusted description — invokes it:
  // invokeAdapter returns null, and the old behavior fell back to the page
  // relay, executing a colliding PAGE tool under the adapter's description.
  // The invocation must be rejected outright instead.
  mocks.route.mockResolvedValue([{
    tabId: 102,
    origin: 'https://example.com',
    hostname: 'example.com',
    tools: [{
      name: 'com.example.main.send_message',
      description: 'Adapter copy (stale).',
      inputSchema: { type: 'object' },
      adapterOwned: true,
    }],
  }])
  // The CURRENT catalog no longer serves the name…
  mocks.catalog.mockResolvedValue([])
  const response = await invokeWebMCPTool({
    targetTabId: 102,
    origin: 'https://example.com',
    toolName: 'com.example.main.send_message',
    args: {},
  })
  expect(response).toMatchObject({ ok: false, errorCode: 'TOOL_NOT_FOUND' })
  // …and neither the page relay nor the script probe ever ran.
  expect(mocks.adapter).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.script).not.toHaveBeenCalled()
})

it('a live adapter-served invocation still passes the catalog revalidation (round-5)', async () => {
  mocks.route.mockResolvedValue([{
    tabId: 102,
    origin: 'https://example.com',
    hostname: 'example.com',
    tools: [{
      name: 'com.example.main.send_message',
      description: 'Adapter copy.',
      inputSchema: { type: 'object' },
      adapterOwned: true,
    }],
  }])
  // The catalog still serves the name → the call proceeds to the adapter…
  mocks.catalog.mockResolvedValue([
    { name: 'com.example.main.send_message', description: 'Adapter copy.', inputSchema: { type: 'object' } },
  ])
  mocks.adapter.mockResolvedValue({ ok: true, value: { status: 'sent' } })
  const response = await invokeWebMCPTool({
    targetTabId: 102,
    origin: 'https://example.com',
    toolName: 'com.example.main.send_message',
    args: {},
  })
  expect(response).toMatchObject({ ok: true, result: { status: 'sent' } })
  expect(mocks.adapter).toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
})

it('a route withdrawn after catalog revalidation fails closed instead of running the page tool (round-6)', async () => {
  // Sourcery round-6: the route can be withdrawn BETWEEN the pre-call
  // catalog revalidation and the adapter invocation — invokeAdapter then
  // returns null, and the old call fell through to the page relay, running
  // a colliding PAGE tool under the adapter's previously trusted
  // description. invokeWebMCPTool must pass adapterOnly for adapter-owned
  // names so a null adapter result fails closed.
  mocks.route.mockResolvedValue([{
    tabId: 102,
    origin: 'https://example.com',
    hostname: 'example.com',
    tools: [{
      name: 'com.example.main.send_message',
      description: 'Adapter copy.',
      inputSchema: { type: 'object' },
      adapterOwned: true,
    }],
  }])
  // The catalog still serves the name at revalidation time…
  mocks.catalog.mockResolvedValue([
    { name: 'com.example.main.send_message', description: 'Adapter copy.', inputSchema: { type: 'object' } },
  ])
  // …but the route is gone by invocation time (invokeAdapter returns null).
  mocks.adapter.mockResolvedValue(null)
  const response = await invokeWebMCPTool({
    targetTabId: 102,
    origin: 'https://example.com',
    toolName: 'com.example.main.send_message',
    args: {},
  })
  expect(response).toMatchObject({ ok: false, errorCode: 'ADAPTER_UNAVAILABLE' })
  // The page relay and script probe never ran.
  expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.script).not.toHaveBeenCalled()
})
