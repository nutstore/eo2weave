import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMCPInvokeRequest, WebMCPInvokeResponse } from '@/webmcp/types'
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }))
vi.mock('../tools/vfs-resolver', () => ({ resolveVfsTarget: mocks.resolve }))
import { invokeXiaohongshuVideo } from '../tools/xiaohongshu-video-transfer'
import { receiveXiaohongshuVideoFrame, stageXiaohongshuVideoInvocation, takeXiaohongshuVideo, discardXiaohongshuVideo } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video-transfer'
import { XHS_VIDEO_CHUNK_BYTES } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-video-transfer-protocol'
const args = { action: 'upload', operation_id: 'video-test', video: 'vfs://assets/clip.mov' }
const request: WebMCPInvokeRequest = { groupKey: 'creator', fullToolName: 'xhs_publish_video', binding: 'current-tab', args }
const context = { directoryHandle: null }
const key = Symbol.for('eo2.xhs.video-transfer')
const response = (result: unknown): WebMCPInvokeResponse => ({ ok: true, hostname: 'creator.xiaohongshu.com', toolName: 'xhs_publish_video', fullToolName: 'xhs_publish_video', result })
let captured: File | undefined
const invoke = vi.fn(async (input: WebMCPInvokeRequest) => {
  expect(input.binding).toBe('current-tab')
  if (input.args?._eo2_video_frame) return response(receiveXiaohongshuVideoFrame(input.args))
  const publicArgs = stageXiaohongshuVideoInvocation(input.args!)
  expect(publicArgs).toEqual(args)
  captured = takeXiaohongshuVideo(publicArgs)
  return response({ phase: 'uploaded' })
})
const send = (frame: object, overrides = {}) => receiveXiaohongshuVideoFrame({ ...args, ...overrides, _eo2_video_frame: { transfer_id: 'id', ...frame } })
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); captured = undefined
  mocks.resolve.mockResolvedValue({ kind: 'assets', path: 'clip.mov', backend: { readFile: mocks.read } })
  mocks.read.mockResolvedValue({ content: new Uint8Array([1, 2, 3]), mimeType: 'video/quicktime' })
  invoke.mockImplementation(async (input) => {
    expect(input.binding).toBe('current-tab')
    if (input.args?._eo2_video_frame) return response(receiveXiaohongshuVideoFrame(input.args))
    const publicArgs = stageXiaohongshuVideoInvocation(input.args!)
    expect(publicArgs).toEqual(args); captured = takeXiaohongshuVideo(publicArgs)
    return response({ phase: 'uploaded' })
  })
})
afterEach(() => { delete (window as any)[key]; vi.clearAllTimers(); vi.useRealTimers() })

describe('authorized video file transport', () => {
  it('keeps the supplied browser File type instead of generic backend metadata', async () => {
    mocks.read.mockResolvedValue({ content: new File([new Uint8Array([1, 2, 3])], 'clip.mov', { type: 'video/quicktime' }), mimeType: 'application/octet-stream' })
    await invokeXiaohongshuVideo(request, context, invoke)
    expect(captured).toMatchObject({ type: 'video/quicktime', size: 3 })
  })
  it('preserves every byte, filename and MIME through multiple chunks and keeps payloads private', async () => {
    const bytes = Uint8Array.from({ length: XHS_VIDEO_CHUNK_BYTES * 2 + 17 }, (_, i) => i % 251)
    mocks.read.mockResolvedValue({ content: bytes, mimeType: 'video/quicktime' })
    expect(await invokeXiaohongshuVideo(request, context, invoke)).toMatchObject({ result: { phase: 'uploaded' } })
    expect(mocks.resolve).toHaveBeenCalledWith(args.video, context, 'read')
    expect(mocks.read).toHaveBeenCalledWith('clip.mov', { encoding: 'binary' })
    expect(captured).toMatchObject({ name: 'clip.mov', type: 'video/quicktime', size: bytes.length })
    const copied = new Uint8Array(await captured!.arrayBuffer())
    expect(copied.length).toBe(bytes.length)
    expect(copied.every((value, index) => value === bytes[index])).toBe(true)
    expect(invoke.mock.calls.filter(([input]) => !input.args?._eo2_video_frame)).toHaveLength(1)
    expect(invoke.mock.calls.filter(([input]) => (input.args?._eo2_video_frame as any)?.kind === 'chunk')).toHaveLength(3)
    expect(request.args).toEqual(args)
    expect((window as any)[key].transfers.size).toBe(0)
  })
  it('does not inherit the image transport size limit', async () => {
    const bytes = new Uint8Array(49 * 1024 * 1024 + 17); bytes[0] = 137; bytes[bytes.length - 1] = 42
    mocks.read.mockResolvedValue({ content: bytes })
    await invokeXiaohongshuVideo(request, context, invoke)
    expect(captured!.size).toBe(bytes.length)
    const actual = new Uint8Array(await captured!.arrayBuffer())
    expect(actual[0]).toBe(137); expect(actual.at(-1)).toBe(42)
    for (const [input] of invoke.mock.calls) expect(JSON.stringify(input).length).toBeLessThan(2 * 1024 * 1024)
  }, 30_000)
  it('adds no format, extension or empty-file business rule', async () => {
    mocks.resolve.mockResolvedValue({ kind: 'workspace', path: 'raw.unknown', backend: { readFile: mocks.read } })
    mocks.read.mockResolvedValue({ content: new Uint8Array() })
    await invokeXiaohongshuVideo(request, context, invoke)
    expect(captured).toMatchObject({ name: 'raw.unknown', type: '', size: 0 })
  })
  it('does not read or transport files for configure and status', async () => {
    const direct = vi.fn(async () => response({ phase: 'ready' }))
    for (const action of ['prepare', 'configure', 'status', 'open']) await invokeXiaohongshuVideo({ ...request, args: { action } }, context, direct)
    expect(mocks.read).not.toHaveBeenCalled(); expect(direct).toHaveBeenCalledTimes(4)
  })
  it.each(['https://example.com/a.mp4', 'D:\\outside\\a.mp4', '/outside/a.mp4'])('does not invent access to %s', async (video) => {
    await expect(invokeXiaohongshuVideo({ ...request, args: { ...args, video } }, context, invoke)).rejects.toThrow()
    expect(mocks.read).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled()
  })
  it('rejects agent-supplied transfer references, missing files and unrelated VFS namespaces', async () => {
    await expect(invokeXiaohongshuVideo({ ...request, args: { ...args, _eo2_video_transfer: 'id' } }, context, invoke)).rejects.toThrow('EO2')
    mocks.read.mockRejectedValue(new Error('File missing'))
    await expect(invokeXiaohongshuVideo(request, context, invoke)).rejects.toThrow('File missing')
    mocks.resolve.mockResolvedValue({ kind: 'agent', backend: { readFile: mocks.read } })
    await expect(invokeXiaohongshuVideo(request, context, invoke)).rejects.toThrow('workspace or assets')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('cleans up a failed chunk without calling the website upload action', async () => {
    invoke.mockImplementation(async (input) => {
      if ((input.args?._eo2_video_frame as any)?.kind === 'chunk') return { ...response(null), ok: false, error: 'Relay disconnected' }
      return response(receiveXiaohongshuVideoFrame(input.args!))
    })
    await expect(invokeXiaohongshuVideo(request, context, invoke)).rejects.toThrow('Relay disconnected')
    expect(invoke.mock.calls.every(([input]) => input.args?._eo2_video_frame)).toBe(true)
    expect((window as any)[key].transfers.size).toBe(0)
  })
  it('cleans up cancellation between chunks without retransmitting', async () => {
    const controller = new AbortController()
    invoke.mockImplementation(async (input) => {
      const result = receiveXiaohongshuVideoFrame(input.args!)
      if ((input.args?._eo2_video_frame as any)?.kind === 'start') controller.abort()
      return response(result)
    })
    await expect(invokeXiaohongshuVideo(request, { ...context, abortSignal: controller.signal }, invoke)).rejects.toThrow('aborted')
    expect(invoke).toHaveBeenCalledTimes(2)
    expect((window as any)[key].transfers.size).toBe(0)
  })
  it('returns a final invocation error once and releases unused bytes', async () => {
    invoke.mockImplementation(async (input) => input.args?._eo2_video_frame ? response(receiveXiaohongshuVideoFrame(input.args)) : { ...response(null), ok: false, errorCode: 'PAGE_ERROR' })
    expect(await invokeXiaohongshuVideo(request, context, invoke)).toMatchObject({ ok: false, errorCode: 'PAGE_ERROR' })
    expect(invoke.mock.calls.filter(([input]) => !input.args?._eo2_video_frame)).toHaveLength(1)
    expect((window as any)[key].transfers.size).toBe(0)
  })
})

describe('video assembly integrity', () => {
  it('rejects missing, reordered, oversized and changed-source bytes without exposing a partial file', () => {
    send({ kind: 'start', name: 'clip', mime: '', size: 3 })
    expect(() => send({ kind: 'finish' })).toThrow('incomplete')
    expect(() => send({ kind: 'chunk', index: 1, base64: 'AQ==' })).toThrow('order')
    expect(() => send({ kind: 'chunk', index: 0, base64: 'AQIDBA==' })).toThrow('size')
    expect(() => send({ kind: 'chunk', index: 0, base64: 'AQ==' }, { video: 'changed' })).toThrow('unavailable')
    expect(() => stageXiaohongshuVideoInvocation({ ...args, _eo2_video_transfer: 'id' })).toThrow('Complete')
    expect(takeXiaohongshuVideo(args)).toBeUndefined()
  })
  it('requires the complete file and exact source, strips internals and consumes once', () => {
    send({ kind: 'start', name: 'clip', mime: 'video/mp4', size: 3 })
    send({ kind: 'chunk', index: 0, base64: 'AQID' }); send({ kind: 'finish' })
    expect(() => stageXiaohongshuVideoInvocation({ ...args, video: 'changed', _eo2_video_transfer: 'id' })).toThrow('source')
    const publicArgs = stageXiaohongshuVideoInvocation({ ...args, _eo2_video_transfer: 'id' })
    expect(publicArgs).toEqual(args); expect(takeXiaohongshuVideo(publicArgs)?.size).toBe(3)
    expect(takeXiaohongshuVideo(publicArgs)).toBeUndefined()
  })
  it('cleans up discarded or inactive transfers', async () => {
    send({ kind: 'start', name: 'clip', mime: '', size: 0 }); send({ kind: 'finish' })
    stageXiaohongshuVideoInvocation({ ...args, _eo2_video_transfer: 'id' })
    discardXiaohongshuVideo({ _eo2_video_transfer: 'id' }); expect(takeXiaohongshuVideo(args)).toBeUndefined()
    send({ kind: 'start', name: 'clip', mime: '', size: 0 })
    await vi.advanceTimersByTimeAsync(300_000)
    expect((window as any)[key].transfers.size).toBe(0)
  })
})
