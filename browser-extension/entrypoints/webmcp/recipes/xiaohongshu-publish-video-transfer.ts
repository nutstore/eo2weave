import { XHS_OPERATION_TIMEOUT_MS } from '../xiaohongshu-input-protocol'
import { videoFrame, XHS_VIDEO_CHUNK_BYTES } from '../xiaohongshu-video-transfer-protocol'

interface Entry { identity: string; name: string; mime: string; size: number; received: number; chunks: Uint8Array[]; file?: File; timer?: ReturnType<typeof setTimeout> }
const key = Symbol.for('eo2.xhs.video-transfer')
interface Store { transfers: Map<string, Entry>; invocations: Map<string, string> }
type TransferWindow = Window & { [key]?: Store }
function store(): Store {
  const target = window as TransferWindow
  return target[key] ?? (target[key] = { transfers: new Map(), invocations: new Map() })
}
function identity(args: Record<string, unknown>): string { return JSON.stringify([args.operation_id, args.video]) }
function discard(id: string) {
  const entry = store().transfers.get(id)
  if (entry) {
    clearTimeout(entry.timer); store().transfers.delete(id)
    if (store().invocations.get(entry.identity) === id) store().invocations.delete(entry.identity)
  }
}
function touch(id: string, entry: Entry) {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => discard(id), XHS_OPERATION_TIMEOUT_MS)
}
export function receiveXiaohongshuVideoFrame(args: Record<string, unknown>) {
  if (args.action !== 'upload' || typeof args.video !== 'string' || typeof args.operation_id !== 'string') throw new Error('Video frames require the reviewed upload source and operation.')
  const frame = videoFrame(args._eo2_video_frame), id = frame.transfer_id, source = identity(args)
  if (frame.kind === 'abort') {
    const entry = store().transfers.get(id)
    if (entry && entry.identity !== source) throw new Error('Video transfer source changed.')
    discard(id)
  } else if (frame.kind === 'start') {
    if (store().transfers.has(id)) throw new Error('Video transfer reference already exists.')
    const entry: Entry = { identity: source, name: frame.name, mime: frame.mime, size: frame.size, received: 0, chunks: [] }
    store().transfers.set(id, entry); touch(id, entry)
  } else {
    const entry = store().transfers.get(id)
    if (!entry || entry.identity !== source || entry.file) throw new Error('Video transfer unavailable or already assembled.')
    if (frame.kind === 'chunk') {
      if (frame.index !== entry.chunks.length) throw new Error('Video chunk order mismatch.')
      const binary = atob(frame.base64), bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
      if (bytes.length > XHS_VIDEO_CHUNK_BYTES || entry.received + bytes.length > entry.size) throw new Error('Video chunk exceeds the declared transfer size.')
      entry.chunks.push(bytes); entry.received += bytes.length
    } else {
      if (entry.received !== entry.size) throw new Error('Video file transfer is incomplete.')
      entry.file = new File(entry.chunks, entry.name, { type: entry.mime })
      entry.chunks = []
    }
    touch(id, entry)
  }
  return { _eo2_video_transfer_ack: { transfer_id: id, kind: frame.kind, ...(frame.kind === 'chunk' ? { index: frame.index } : {}) } }
}
export function stageXiaohongshuVideoInvocation(args: Record<string, unknown>): Record<string, unknown> {
  const { _eo2_video_transfer, _eo2_video_frame, ...publicArgs } = args
  if (_eo2_video_transfer !== undefined) {
    if (typeof _eo2_video_transfer !== 'string') throw new Error('Invalid video file reference.')
    const entry = store().transfers.get(_eo2_video_transfer)
    if (!entry?.file || entry.identity !== identity(args)) throw new Error('Complete video transfer unavailable for this source.')
    store().invocations.set(entry.identity, _eo2_video_transfer)
  }
  return publicArgs
}
export function takeXiaohongshuVideo(args: Record<string, unknown>): File | undefined {
  const id = store().invocations.get(identity(args))
  if (!id) return undefined
  const file = store().transfers.get(id)?.file
  discard(id)
  return file
}
export function discardXiaohongshuVideo(args: Record<string, unknown>) {
  if (typeof args._eo2_video_transfer === 'string') discard(args._eo2_video_transfer)
}
