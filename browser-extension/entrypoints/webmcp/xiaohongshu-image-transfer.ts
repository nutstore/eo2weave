import { imagePayload, MAX_IMAGE_BYTES } from './recipes/xiaohongshu-publish-policy'

/** Download in the extension worker, where host permissions permit cross-origin images. */
export async function prepareRemoteXiaohongshuImage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (args.action !== 'upload' || typeof args.image !== 'string' || !/^https?:\/\//i.test(args.image)) return args
  const url = new URL(args.image)
  let response: Response
  try { response = await fetch(url.href, { credentials: 'omit', signal: AbortSignal.timeout(30000), referrerPolicy: 'no-referrer' }) }
  catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Request failed.'
    throw new Error(`Image download request failed: ${message.replace(/https?:\/\/[^\s]+/gi, '[source URL omitted]')}`)
  }
  if (response.status !== 200) throw new Error(`Image download failed (HTTP ${response.status}); source URL omitted.`)
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new Error('Image exceeds Chrome JSON/base64 transport capacity.')
  if (!response.body) throw new Error('Image download returned no body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds Chrome JSON/base64 transport capacity.')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const payload = imagePayload(bytes, '')
  return { ...args, _eo2_image: payload }
}
