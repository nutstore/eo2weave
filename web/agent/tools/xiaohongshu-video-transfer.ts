import type { ToolContext } from './tool-types'
import type { WebMCPInvokeRequest, WebMCPInvokeResponse } from '@/webmcp/types'
import { resolveVfsTarget } from './vfs-resolver'
import { XHS_VIDEO_CHUNK_BYTES } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-video-transfer-protocol'

/** One reviewed upload call internally transports the complete authorized file. */
export async function invokeXiaohongshuVideo(request: WebMCPInvokeRequest, context: ToolContext, invoke: (request: WebMCPInvokeRequest) => Promise<WebMCPInvokeResponse>): Promise<WebMCPInvokeResponse> {
  const args = request.args || {}
  if (Object.keys(args).some((name) => name.startsWith('_eo2_'))) throw new Error('Video bytes and transfer references are supplied by EO2, not Agent arguments.')
  if (args.action !== 'upload') return invoke(request)
  if (typeof args.video !== 'string' || !args.video) throw new Error('upload requires the prepared video source.')
  if (/^https?:\/\//i.test(args.video)) throw new Error('Upstream publish_with_video accepts a local video file, not a remote URL.')
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(args.video)) throw new Error('Use an authorized workspace relative or vfs path for the local video.')
  const target = await resolveVfsTarget(args.video, context, 'read')
  if (target.kind !== 'workspace' && target.kind !== 'assets') throw new Error('Video must come from the authorized workspace or assets.')
  const file = await target.backend.readFile(target.path, { encoding: 'binary' })
  if (typeof file.content === 'string') throw new Error('Expected binary video file bytes.')
  const blob = file.content instanceof Blob ? file.content : new Blob([file.content])
  const id = crypto.randomUUID()
  const checkAbort = () => { if (context.abortSignal?.aborted) throw new Error('Video file transfer aborted.') }
  const frame = async (value: object) => {
    const response = await invoke({ ...request, args: { ...args, _eo2_video_frame: { ...value, transfer_id: id } } })
    const result = typeof response.result === 'string' ? JSON.parse(response.result) : response.result
    const ack = (result as { _eo2_video_transfer_ack?: { transfer_id: string; kind: string; index?: number } } | undefined)?._eo2_video_transfer_ack
    const expected = value as { kind: string; index?: number }
    if (!response.ok || ack?.transfer_id !== id || ack.kind !== expected.kind || ack.index !== expected.index) throw new Error(response.error || 'Video transport acknowledgment unavailable. Reload the extension and page.')
  }
  try {
    checkAbort()
    await frame({ kind: 'start', name: target.path.split('/').pop() || 'video', mime: file.mimeType || blob.type, size: blob.size })
    for (let offset = 0, index = 0; offset < blob.size; offset += XHS_VIDEO_CHUNK_BYTES, index++) {
      checkAbort()
      const bytes = new Uint8Array(await blob.slice(offset, offset + XHS_VIDEO_CHUNK_BYTES).arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
      await frame({ kind: 'chunk', index, base64: btoa(binary) })
    }
    checkAbort(); await frame({ kind: 'finish' }); checkAbort()
    return await invoke({ ...request, args: { ...args, _eo2_video_transfer: id } })
  } finally {
    // Cleanup never changes the website or retransmits the file.
    await frame({ kind: 'abort' }).catch(() => {})
  }
}
