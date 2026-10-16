// Internal file transport, not additional Agent actions or website size rules.
export const XHS_VIDEO_CHUNK_BYTES = 1024 * 1024
export type VideoTransferFrame =
  | { kind: 'start'; transfer_id: string; name: string; mime: string; size: number }
  | { kind: 'chunk'; transfer_id: string; index: number; base64: string }
  | { kind: 'finish' | 'abort'; transfer_id: string }
export function videoFrame(value: unknown): VideoTransferFrame {
  if (!value || typeof value !== 'object') throw new Error('Invalid video transport frame.')
  const frame = value as VideoTransferFrame
  if (typeof frame.transfer_id !== 'string' || !frame.transfer_id) throw new Error('Missing video transfer reference.')
  if (frame.kind === 'start' && typeof frame.name === 'string' && typeof frame.mime === 'string' && Number.isSafeInteger(frame.size) && frame.size >= 0) return frame
  if (frame.kind === 'chunk' && Number.isSafeInteger(frame.index) && frame.index >= 0 && typeof frame.base64 === 'string' && frame.base64.length <= Math.ceil(XHS_VIDEO_CHUNK_BYTES / 3) * 4) return frame
  if (frame.kind === 'finish' || frame.kind === 'abort') return frame
  throw new Error('Invalid video transport frame or chunk capacity exceeded.')
}
