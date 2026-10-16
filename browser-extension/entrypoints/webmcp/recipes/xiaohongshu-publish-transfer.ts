import type { ImagePayload } from './xiaohongshu-publish-policy'

// MAIN-world bundles share only this short-lived transport slot, never the tool schema.
const key = Symbol.for('eo2.xhs.image-transfer')
type TransferWindow = Window & { [key]?: Map<string, ImagePayload> }
function slots(): Map<string, ImagePayload> {
  const target = window as TransferWindow
  return target[key] ?? (target[key] = new Map())
}
function identity(args: Record<string, unknown>): string {
  return JSON.stringify([args.operation_id, args.image_index, args.image])
}
export function stageXiaohongshuImage(args: Record<string, unknown>): Record<string, unknown> {
  const { _eo2_image, ...publicArgs } = args
  if (_eo2_image !== undefined && args.action === 'upload') slots().set(identity(args), _eo2_image as ImagePayload)
  return publicArgs
}
export function takeXiaohongshuImage(args: Record<string, unknown>): ImagePayload | undefined {
  const payload = slots().get(identity(args))
  discardXiaohongshuImage(args)
  return payload
}
export function discardXiaohongshuImage(args: Record<string, unknown>) { slots().delete(identity(args)) }
