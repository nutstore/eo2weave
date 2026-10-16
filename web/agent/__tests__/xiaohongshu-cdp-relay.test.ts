import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAgentEnvelope, WEBMCP_INVOKE_IN_TAB_TYPE } from '../../../browser-extension/entrypoints/webmcp/relay-protocol'
import { XHS_INPUT_MESSAGE, XHS_OPERATION_TIMEOUT_MS } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-input-protocol'
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes', () => ({ ENABLED_RECIPES_STORAGE_KEY: 'recipes', findRecipeForLocation: () => undefined, findRecipesForHostname: () => [] }))
const scriptPath = '../../../browser-extension/entrypoints/webmcp.content'
let runtimeListener: (message: unknown, sender: unknown, response: (value: unknown) => void) => boolean
let messageListeners: Array<(event: MessageEvent) => void>
const send = vi.fn(), post = vi.fn()
const emit = (data: unknown, source: unknown = window) => messageListeners.forEach((listener) => listener({ source, data } as MessageEvent))
const input = (session = 'grant') => ({ type: XHS_INPUT_MESSAGE, session, requestId: 'input-id', operation: { kind: 'key', key: 'Enter' } })
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); send.mockReset().mockResolvedValue({ ok: true }); post.mockReset(); messageListeners = []
  vi.stubGlobal('defineContentScript', (options: unknown) => options)
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) }, onChanged: { addListener: vi.fn() } }, runtime: { sendMessage: send, onMessage: { addListener: (listener: typeof runtimeListener) => { runtimeListener = listener } } } })
  vi.spyOn(window, 'postMessage').mockImplementation(post)
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') messageListeners.push(listener) }) as typeof window.addEventListener)
  const { default: script } = await import(scriptPath)
  script.main()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function start(toolName = 'xhs_publish_content') {
  const response = vi.fn()
  expect(runtimeListener({ type: WEBMCP_INVOKE_IN_TAB_TYPE, toolName, args: { action: 'configure', _eo2_input_session: 'grant' } }, {}, response)).toBe(true)
  return { response, requestId: post.mock.calls.at(-1)![0].requestId }
}
describe('isolated-world CDP relay', () => {
  it.each(['xhs_publish_content', 'xhs_publish_video', 'xhs_post_comment_to_feed', 'xhs_reply_comment_in_feed', 'xhs_like_feed'])('forwards %s input only during the invocation received from the extension', async (toolName) => {
    emit(input()); expect(send).not.toHaveBeenCalled()
    const { response, requestId } = start(toolName)
    emit(input('wrong')); emit(input(), null); expect(send).not.toHaveBeenCalled()
    emit(input()); await Promise.resolve()
    expect(send).toHaveBeenCalledWith(input())
    expect(post.mock.calls.at(-1)![0]).toMatchObject({ type: 'cw_xhs_cdp_input_response', requestId: 'input-id', session: 'grant', ok: true })
    emit(buildAgentEnvelope({ kind: 'invoke-response', requestId, ok: true, result: { phase: 'ready' } }))
    expect(response).toHaveBeenCalledOnce()
    emit(input()); expect(send).toHaveBeenCalledOnce()
  })
  it.each(['xhs_publish_content', 'xhs_publish_video', 'xhs_reply_comment_in_feed'])('removes %s input capability on relay timeout using the upstream budget', async (toolName) => {
    const { response } = start(toolName)
    await vi.advanceTimersByTimeAsync(60_000); expect(response).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(XHS_OPERATION_TIMEOUT_MS)
    expect(response.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'RELAY_TIMEOUT' })
    emit(input()); expect(send).not.toHaveBeenCalled()
  })
  it('reports background transport errors to the requesting page operation', async () => {
    start(); send.mockRejectedValue(new Error('Debugger detached')); emit(input())
    await Promise.resolve(); await Promise.resolve()
    expect(post.mock.calls.at(-1)![0]).toMatchObject({ type: 'cw_xhs_cdp_input_response', ok: false, error: 'Debugger detached' })
  })
  it('expires the comment relay after its 60-second page budget plus transport margin', async () => {
    const { response } = start('xhs_post_comment_to_feed')
    await vi.advanceTimersByTimeAsync(60_000); expect(response).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(response.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'RELAY_TIMEOUT' })
    emit(input()); expect(send).not.toHaveBeenCalled()
  })
})
