import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRelayEnvelope } from '../../../browser-extension/entrypoints/webmcp/relay-protocol'
import { takeXiaohongshuVideo } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video-transfer'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/agent-core', () => ({ resolveAgentApi: mocks.resolve }))
const scriptPath = '../../../browser-extension/entrypoints/webmcp-injected.content'
const post = vi.fn()
let listeners: Array<(event: MessageEvent) => void>
const args = { action: 'upload', operation_id: 'video-test', video: 'vfs://assets/clip.mp4' }
async function call(args: Record<string, unknown>, id = 'request', toolName = 'xhs_publish_video') {
  listeners.forEach((listener) => listener(new MessageEvent('message', { source: window, data: buildRelayEnvelope({ kind: 'invoke-request', requestId: id, toolName, args }) })))
  await vi.advanceTimersByTimeAsync(0)
  return post.mock.calls.map(([event]) => event).find((event) => event.kind === 'invoke-response' && event.requestId === id)
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers(); listeners = []
  mocks.resolve.mockReturnValue({ mode: 'polyfill', getTools: async () => [], onToolsChanged: () => () => {}, executeToolByName: mocks.execute })
  mocks.execute.mockResolvedValue({ phase: 'uploaded' })
  vi.stubGlobal('defineContentScript', (options: unknown) => options)
  vi.spyOn(window, 'postMessage').mockImplementation(post)
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: (event: MessageEvent) => void) => { if (type === 'message') listeners.push(listener) }) as typeof window.addEventListener)
  const { default: script } = await import(scriptPath); script.main()
})
afterEach(() => {
  ;(window as any).__cwWebmcpAgentState?.dispose()
  delete (window as any).__cwWebmcpAgentState
  delete (window as any)[Symbol.for('eo2.xhs.video-transfer')]
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const frame = (kind: string, extra = {}) => ({ ...args, _eo2_video_frame: { kind, transfer_id: 'transfer', ...extra } })
async function assemble() {
  await call(frame('start', { name: 'clip.mp4', mime: 'video/mp4', size: 3 }), 'start')
  await call(frame('chunk', { index: 0, base64: 'AQID' }), 'chunk')
  await call(frame('finish'), 'finish')
}
describe('MAIN-world video relay', () => {
  it.each([['xhs_post_comment_to_feed', 60_000], ['xhs_reply_comment_in_feed', 300_000], ['xhs_like_feed', 60_000]])('runs %s with scoped input and cleans up after errors', async (toolName, timeoutMs) => {
    const commentArgs = { feed_id: 'test-note', xsec_token: 'test-token', content: '评论' }
    mocks.execute.mockImplementation(async (name, values) => {
      expect(name).toBe(toolName); expect(values).toEqual(commentArgs)
      const input = (window as any)[Symbol.for('eo2.xhs.cdp-input')]
      expect(input.session).toBe('internal'); expect(input.timeoutMs).toBe(timeoutMs)
      throw new Error('Comment not confirmed')
    })
    expect(await call({ ...commentArgs, _eo2_input_session: 'internal' }, 'comment', toolName as string)).toMatchObject({ ok: false, error: 'Comment not confirmed' })
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect((window as any)[Symbol.for('eo2.xhs.cdp-input')]).toBeUndefined()
  })
  it('reports a cancelled like as unknown without a likely-success response or retry', async () => {
    mocks.execute.mockRejectedValue(new Error('Tool execution cancelled, since tool definition was updated'))
    expect(await call({ feed_id: 'test-note', xsec_token: 'test-token', _eo2_input_session: 'internal' }, 'like', 'xhs_like_feed')).toMatchObject({ ok: false, errorCode: 'LIKE_RESULT_UNKNOWN' })
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect((window as any)[Symbol.for('eo2.xhs.cdp-input')]).toBeUndefined()
  })
  it('assembles frames without invoking upload, then invokes once with public arguments and complete bytes', async () => {
    await assemble()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(post.mock.calls.map(([event]) => event).find((event) => event.requestId === 'finish')).toMatchObject({ ok: true, result: { _eo2_video_transfer_ack: { kind: 'finish', transfer_id: 'transfer' } } })
    let file: File | undefined
    mocks.execute.mockImplementation(async (_name, input) => { file = takeXiaohongshuVideo(input); return { phase: 'uploaded' } })
    expect(await call({ ...args, _eo2_video_transfer: 'transfer', _eo2_input_session: 'internal' })).toMatchObject({ ok: true, result: { phase: 'uploaded' } })
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledWith('xhs_publish_video', args)
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(takeXiaohongshuVideo(args)).toBeUndefined()
  })
  it('reports incomplete transport without running a website action', async () => {
    expect(await call(frame('start', { name: 'clip.mp4', mime: '', size: 3 }), 'start')).toMatchObject({ ok: true })
    expect(await call(frame('finish'))).toMatchObject({ ok: false, errorCode: 'INVOKE_FAILED', error: 'Video file transfer is incomplete.' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('discards unused complete bytes when the actual tool fails', async () => {
    await assemble(); mocks.execute.mockRejectedValue(new Error('Page input missing'))
    expect(await call({ ...args, _eo2_video_transfer: 'transfer' })).toMatchObject({ ok: false, error: 'Page input missing' })
    expect(takeXiaohongshuVideo(args)).toBeUndefined()
  })
  it('reports interrupted preparation without claiming likely publication success', async () => {
    mocks.execute.mockRejectedValue(new Error('Tool execution cancelled, since tool definition was updated'))
    expect(await call({ action: 'configure', operation_id: 'video-test' })).toMatchObject({ ok: false, errorCode: 'VIDEO_PREPARATION_INTERRUPTED' })
  })
})
