import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const scriptPath = '../../../browser-extension/entrypoints/injected.content'
let bridge: { webMCPInvoke: (request: object) => Promise<any> }
let listeners: Array<(event: MessageEvent) => void>
const post = vi.fn()
const request = { groupKey: 'main', fullToolName: 'www_xiaohongshu_com__xhs_like_feed', binding: 'reviewed-binding', args: { feed_id: 'note', xsec_token: 'token', unlike: true } }
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers(); listeners = []
  vi.stubGlobal('defineContentScript', (options: unknown) => options)
  vi.stubGlobal('__CW_CODEX_OAUTH__', false)
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') listeners.push(listener) }) as typeof window.addEventListener)
  vi.spyOn(window, 'postMessage').mockImplementation(post)
  const { default: script } = await import(scriptPath); script.main()
  bridge = (window as any).__agentWeb
})
afterEach(() => {
  ;(window as any).__agentWebBridgeState?.dispose()
  delete (window as any).__agentWebBridgeState; delete (window as any).__agentWeb
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
describe('like invocation outer bridge budget', () => {
  it('keeps a bound like pending beyond the generic 35 seconds and passes arguments intact', async () => {
    const settled = vi.fn()
    const pending = bridge.webMCPInvoke(request).then(settled)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()
    const envelope = post.mock.calls.find(([message]) => message.type === 'webmcp_invoke_tool')![0]
    expect(envelope.payload).toEqual(request)
    listeners.forEach((listener) => listener(new MessageEvent('message', { source: window, data: { __agentWebBridge: true, __agentWebResponse: true, id: envelope.id, response: { ok: true, result: { success: true } } } })))
    await pending
    expect(settled).toHaveBeenCalledWith({ ok: true, result: { success: true } })
    expect(post).toHaveBeenCalledOnce()
  })
  it('expires at 60-second page budget plus 60-second relay and 35-second bridge margins', async () => {
    const settled = vi.fn()
    const pending = bridge.webMCPInvoke(request).then(settled)
    await vi.advanceTimersByTimeAsync(154_999); expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await pending
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'BRIDGE_TIMEOUT' }))
    expect(post).toHaveBeenCalledOnce()
  })
})
