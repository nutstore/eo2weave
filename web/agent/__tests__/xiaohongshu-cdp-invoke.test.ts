import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ route: vi.fn(), group: vi.fn(), hostEnabled: vi.fn(), groupEnabled: vi.fn(), image: vi.fn(), open: vi.fn(), close: vi.fn(), send: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/discovery', () => ({
  getRecentRoute: mocks.route, getTabGroupInfo: mocks.group, parseHostname: (url: string) => new URL(url).hostname,
  getRecentTabsForGroup: () => [], rememberSuccessfulInvocation: vi.fn(), discoverToolsInTab: vi.fn(),
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/registry', () => ({ getRegistryEntries: async () => [] }))
vi.mock('../../../browser-extension/entrypoints/webmcp/authorization', () => ({
  isHostEnabled: mocks.hostEnabled, isGroupEnabled: mocks.groupEnabled,
  hostDisabledError: () => ({ ok: false, errorCode: 'HOST_DISABLED' }), groupDisabledError: () => ({ ok: false, errorCode: 'GROUP_DISABLED' }),
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/page-api', () => ({ runWebMCPPageProbe: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/xiaohongshu-image-transfer', () => ({ prepareRemoteXiaohongshuImage: mocks.image }))
vi.mock('../../../browser-extension/entrypoints/webmcp/xiaohongshu-cdp-input', () => ({ getXhsCdpInput: () => ({ open: mocks.open, close: mocks.close }) }))
// Load the Chrome-only entrypoint at runtime; the web compiler does not own
// its Chrome/WXT globals. The dependency-free input driver is checked directly.
const invokeModulePath = '../../../browser-extension/entrypoints/webmcp/invoke'
const { invokeWebMCPTool } = await import(invokeModulePath)
import { XHS_OPERATION_TIMEOUT_MS } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-input-protocol'
const route = { tabId: 99, hostname: 'creator.xiaohongshu.com', toolName: 'xhs_publish_content', groupKey: 'creator', fullToolName: 'xhs_publish_content', toolsetSignature: 'test', seenAt: 0 }
const request = (action: string, toolName = 'xhs_publish_content') => ({ groupKey: 'creator', fullToolName: toolName, requiredTabId: 7, args: { action, operation_id: 'test' } })
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers()
  mocks.route.mockReturnValue(route); mocks.group.mockResolvedValue({ groupKey: 'creator' })
  mocks.hostEnabled.mockResolvedValue(true); mocks.groupEnabled.mockResolvedValue(true)
  mocks.image.mockImplementation(async (args) => args); mocks.open.mockResolvedValue('internal-session'); mocks.close.mockResolvedValue(undefined)
  mocks.send.mockImplementation((_tab, _message, done) => done({ ok: true, result: { phase: 'ready' } }))
  vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => ({ url: 'https://creator.xiaohongshu.com/publish/publish' })), sendMessage: mocks.send }, runtime: {} })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('CDP within the existing WebMCP invocation', () => {
  it.each([['xhs_post_comment_to_feed', 60_000], ['xhs_reply_comment_in_feed', 300_000], ['xhs_like_feed', 60_000]])('binds %s CDP without changing reviewed arguments or a probe retry', async (toolName, timeoutMs) => {
    mocks.route.mockReturnValue({ ...route, hostname: 'www.xiaohongshu.com', toolName })
    ;(globalThis as any).chrome.tabs.get.mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/test-note' })
    const args = { feed_id: 'test-note', xsec_token: 'test-token', content: '真实评论' }
    const pending = invokeWebMCPTool({ ...request('', toolName as string), args })
    expect(await pending).toMatchObject({ ok: true, tabId: 7 })
    expect(mocks.open).toHaveBeenCalledWith(7, { hostname: 'www.xiaohongshu.com', timeoutMs })
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ args: { ...args, _eo2_input_session: 'internal-session' } })
    expect(args).toEqual({ feed_id: 'test-note', xsec_token: 'test-token', content: '真实评论' })
    expect(mocks.close).toHaveBeenCalledWith('internal-session')
    expect(mocks.image).not.toHaveBeenCalled()
    mocks.send.mockImplementation((_tab, _message, done) => done({ ok: false, errorCode: 'RELAY_UNREACHABLE' }))
    expect(await invokeWebMCPTool({ ...request('', toolName as string), args })).toMatchObject({ errorCode: 'RELAY_UNREACHABLE' })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })
  it('allows the five-minute reply budget and closes the grant on relay timeout', async () => {
    mocks.route.mockReturnValue({ ...route, hostname: 'www.xiaohongshu.com', toolName: 'xhs_reply_comment_in_feed' })
    ;(globalThis as any).chrome.tabs.get.mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/test-note' })
    mocks.send.mockImplementation(() => {})
    const pending = invokeWebMCPTool(request('', 'xhs_reply_comment_in_feed'))
    await vi.advanceTimersByTimeAsync(300_000); expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({ errorCode: 'RELAY_TIMEOUT' })
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it('closes like input after its 60-second page budget and 60-second relay margin', async () => {
    mocks.route.mockReturnValue({ ...route, hostname: 'www.xiaohongshu.com', toolName: 'xhs_like_feed' })
    ;(globalThis as any).chrome.tabs.get.mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/test-note' })
    mocks.send.mockImplementation(() => {})
    const pending = invokeWebMCPTool(request('', 'xhs_like_feed'))
    await vi.advanceTimersByTimeAsync(60_000); expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({ errorCode: 'RELAY_TIMEOUT' })
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledOnce()
  })
  it('closes comment input on the 120-second relay deadline', async () => {
    mocks.route.mockReturnValue({ ...route, hostname: 'www.xiaohongshu.com', toolName: 'xhs_post_comment_to_feed' })
    ;(globalThis as any).chrome.tabs.get.mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/test-note' })
    mocks.send.mockImplementation(() => {})
    const pending = invokeWebMCPTool(request('', 'xhs_post_comment_to_feed'))
    await vi.advanceTimersByTimeAsync(60_000); expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({ errorCode: 'RELAY_TIMEOUT' })
    expect(mocks.close).toHaveBeenCalledOnce()
  })
  it.each(['prepare', 'configure'])('uses the same current-tab input grant for video %s', async (action) => {
    mocks.route.mockReturnValue({ ...route, toolName: 'xhs_publish_video' })
    const input = request(action, 'xhs_publish_video')
    expect(await invokeWebMCPTool(input)).toMatchObject({ ok: true, tabId: 7 })
    expect(mocks.open).toHaveBeenCalledWith(7)
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ toolName: 'xhs_publish_video', args: { ...input.args, _eo2_input_session: 'internal-session' } })
    expect(mocks.close).toHaveBeenCalledWith('internal-session')
  })
  it('does not attach a debugger to video transport frames', async () => {
    mocks.route.mockReturnValue({ ...route, toolName: 'xhs_publish_video' })
    const input = { ...request('upload', 'xhs_publish_video'), args: { action: 'upload', _eo2_video_frame: { kind: 'start' } } }
    expect(await invokeWebMCPTool(input)).toMatchObject({ ok: true, tabId: 7 })
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.send.mock.calls[0][1]).toMatchObject({ args: input.args })
  })
  it.each(['prepare', 'configure'])('attaches only to the bound tab for %s and releases after completion', async (action) => {
    const input = request(action), args = { ...input.args }
    expect(await invokeWebMCPTool(input)).toMatchObject({ ok: true, tabId: 7 })
    expect(mocks.open).toHaveBeenCalledWith(7)
    expect(mocks.send.mock.calls[0].slice(0, 2)).toEqual([7, { type: 'webmcp_invoke_in_tab', toolName: 'xhs_publish_content', args: { ...args, _eo2_input_session: 'internal-session' } }])
    expect(input.args).toEqual(args)
    expect(mocks.close).toHaveBeenCalledWith('internal-session')
  })
  it.each(['status', 'upload', 'open', 'submit'])('does not attach for %s', async (action) => {
    await invokeWebMCPTool(request(action))
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled()
  })
  it.each(['host', 'group'])('respects existing %s authorization before debugger attachment', async (gate) => {
    if (gate === 'host') mocks.hostEnabled.mockResolvedValue(false)
    else mocks.groupEnabled.mockResolvedValue(false)
    expect((await invokeWebMCPTool(request('configure'))).ok).toBe(false)
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.image).not.toHaveBeenCalled()
  })
  it('does not attach when the bound tab changed site', async () => {
    ;(globalThis as any).chrome.tabs.get.mockResolvedValue({ url: 'https://example.com' })
    expect(await invokeWebMCPTool(request('prepare'))).toMatchObject({ errorCode: 'BOUND_TAB_UNAVAILABLE' })
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('returns debugger errors without running page input or a DOM fallback', async () => {
    mocks.open.mockRejectedValue(new Error('Another debugger is attached'))
    expect(await invokeWebMCPTool(request('configure'))).toMatchObject({ ok: false, error: 'Another debugger is attached' })
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled()
  })
  it('releases the input grant when page execution fails', async () => {
    mocks.send.mockImplementation((_tab, _message, done) => done({ ok: false, errorCode: 'PAGE_ERROR', error: 'Element gone' }))
    expect(await invokeWebMCPTool(request('configure'))).toMatchObject({ ok: false, errorCode: 'PAGE_ERROR' })
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce()
  })
  it('waits for the upstream input budget and closes on relay timeout', async () => {
    mocks.send.mockImplementation(() => {})
    const pending = invokeWebMCPTool(request('configure'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(XHS_OPERATION_TIMEOUT_MS)
    expect(await pending).toMatchObject({ errorCode: 'RELAY_TIMEOUT', error: 'WebMCP relay invoke timed out after 360000ms' })
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.send).toHaveBeenCalledOnce()
  })
})
