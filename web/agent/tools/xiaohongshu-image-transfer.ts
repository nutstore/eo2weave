import type { ToolContext } from './tool-types'
import { resolveVfsTarget } from './vfs-resolver'
import { imagePayload } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-policy'

/** Resolve only the authorized source requested in the reviewed tool arguments. */
export async function prepareXiaohongshuImage(args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
  if ('_eo2_image' in args) throw new Error('Image bytes are supplied by EO2, not Agent arguments.')
  if (args.action !== 'upload') return args
  if (typeof args.image !== 'string' || !args.image) throw new Error('upload requires the exact image source and image_index.')
  if (/^https?:\/\//i.test(args.image)) return args
  // Absolute disk paths must first be mapped to an authorized workspace root.
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(args.image)) throw new Error('Use an authorized workspace relative or vfs path; arbitrary absolute disk paths are not available to page tools.')
  const target = await resolveVfsTarget(args.image, context, 'read')
  if (target.kind !== 'workspace' && target.kind !== 'assets') throw new Error('Images must come from the authorized workspace or assets.')
  const file = await target.backend.readFile(target.path, { encoding: 'binary' })
  if (typeof file.content === 'string') throw new Error('Expected binary image bytes.')
  const bytes = file.content instanceof Blob ? new Uint8Array(await file.content.arrayBuffer()) : file.content instanceof Uint8Array ? file.content : new Uint8Array(file.content)
  if (context.abortSignal?.aborted) throw new Error('Image transfer aborted.')
  return { ...args, _eo2_image: imagePayload(bytes, target.path.split('/').pop() || 'image') }
}
