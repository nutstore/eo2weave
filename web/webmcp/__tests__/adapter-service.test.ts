import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdapterService } from '../../../browser-extension/entrypoints/webmcp/adapter-service'
import { ADAPTER_HOST_PORT } from '@creatorweave/shared/webmcp-adapter-protocol'
import { pkg } from './fixtures'
const runner = vi.hoisted(() => vi.fn())
vi.mock('../../../browser-extension/entrypoints/webmcp/adapter-runtime', () => ({ executeAdapterWorkflow: runner }))
const sender = { tab: { id: 8 }, frameId: 0, documentId: 'doc-a', url: 'https://example.com/articles' } as chrome.runtime.MessageSender
function fakePort() {
  let listener: (message: unknown) => void = () => {}
  let disconnect: () => void = () => {}
  const postMessage = vi.fn()
  const port = {
    name: ADAPTER_HOST_PORT, sender: { url: 'https://trusted.test', id: 'extension' }, postMessage,
    onMessage: { addListener: (fn: typeof listener) => { listener = fn } },
    onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn } },
    disconnect: () => disconnect(),
  } as unknown as chrome.runtime.Port
  return { port, postMessage, send: (message: unknown) => listener(message) }
}
function setup() {
  const authorize = vi.fn(async () => {})
  const service = createAdapterService({ loadWasm: async () => ({} as WebAssembly.Module), trusted: s => s.url === 'https://trusted.test', resolveBinding: async () => 8, authorize, changed: vi.fn() })
  const connect = async (binding: string | null = null) => {
    const host = fakePort()
    service.connect(host.port)
    host.send({ kind: 'publish', requestId: 'publish', workspaceId: 'workspace-a', sessionId: crypto.randomUUID(), binding, toolNames: ['read', 'run_code'], packages: [pkg] })
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledWith({ kind: 'published', requestId: 'publish' }))
    return host
  }
  const request = (requestId = 'page-request') => ({ requestId, routeId: service.catalog(sender)[0].routeId, args: {} })
  return { service, connect, request, authorize }
}
beforeEach(() => {
  vi.resetAllMocks()
  runner.mockResolvedValue({ ok: true, value: { status: 'completed', result: 1 } })
})
describe('adapter SW authority and routing', () => {
  it('publishes metadata only and executes source from the SW catalog', async () => {
    const { service, connect, request } = setup()
    await connect()
    expect(JSON.stringify(service.catalog(sender))).not.toContain('sources')
    expect(JSON.stringify(service.catalog(sender))).not.toContain('inspect')
    const result = await service.invoke(sender, { ...request(), source: 'malicious' })
    expect(result.ok).toBe(true)
    expect(runner.mock.calls[0][1]).toBe(pkg.sources['read-title.js'])
    expect(runner.mock.calls[0][3]).toEqual(['read', 'run_code'])
    expect(service.catalog({ ...sender, url: 'https://other.test' })).toEqual([])
  })
  it('fails closed for ambiguous hosts, prefers an explicitly bound host, and rejects stale IDs', async () => {
    const { service, connect, request } = setup()
    const first = await connect()
    const old = request()
    await connect()
    expect(service.catalog(sender)).toEqual([])
    expect(await service.invoke(sender, old)).toMatchObject({ ok: false })
    const bound = await connect('binding')
    expect(service.catalog(sender)).toHaveLength(1)
    expect(service.catalog(sender)[0].routeId).not.toBe(old.routeId)
    bound.port.disconnect()
    first.port.disconnect()
    expect(service.catalog(sender)).toHaveLength(1)
  })
  it('uses independent reverse RPC replies, rejects cross-host replies, and rechecks authorization', async () => {
    const { service, connect, request, authorize } = setup()
    const host = await connect('binding')
    const other = await connect()
    runner.mockImplementation(async (_wasm, _source, _input, _names, invoke, signal) => ({ ok: true, value: await invoke(['read', { path: 'x' }], signal) }))
    const result = service.invoke(sender, request())
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invoke' })))
    const call = host.postMessage.mock.calls.find(([message]) => message.kind === 'invoke')![0]
    other.send({ kind: 'reply', callId: call.callId, result: { ok: true, value: 'wrong' } })
    host.send({ kind: 'reply', callId: call.callId, result: { ok: true, value: 7 } })
    expect(await result).toEqual({ ok: true, value: 7 })
    expect(authorize).toHaveBeenCalledTimes(2)
  })
  it('does not let another document cancel, and disconnect aborts pending reverse RPCs', async () => {
    const { service, connect, request } = setup()
    const host = await connect()
    let signal!: AbortSignal
    runner.mockImplementation(async (_wasm, _source, _input, _names, invoke, callSignal) => {
      signal = callSignal
      return { ok: true, value: await invoke(['read', {}], callSignal) }
    })
    const result = service.invoke(sender, request())
    await vi.waitFor(() => expect(host.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invoke' })))
    service.cancel({ ...sender, documentId: 'doc-other' }, 'page-request')
    expect(signal.aborted).toBe(false)
    host.port.disconnect()
    expect(await result).toMatchObject({ ok: false })
    expect(signal.aborted).toBe(true)
    expect(service.catalog(sender)).toEqual([])
  })
  it('rejects recursive workflows and authorization failures before calling the runner', async () => {
    const { service, connect, request, authorize } = setup()
    await connect()
    authorize.mockRejectedValueOnce(new Error('Host disabled'))
    expect(await service.invoke(sender, request())).toMatchObject({ ok: false, error: { message: 'Host disabled' } })
    expect(runner).not.toHaveBeenCalled()
    runner.mockImplementation(async () => service.invoke(sender, request('nested')))
    expect(await service.invoke(sender, request())).toMatchObject({ ok: false, error: { message: expect.stringContaining('recursive') } })
  })
})

it('cancels promptly even while document authorization is still pending', async () => {
  const { service, connect, request, authorize } = setup()
  await connect()
  authorize.mockImplementationOnce(() => new Promise(() => {}))
  const result = service.invoke(sender, request())
  service.cancelTab(sender.tab!.id!)
  expect(await result).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
  expect(runner).not.toHaveBeenCalled()
})
