// Port publish_content validation from xpzouying/xiaohongshu-mcp at 7797fd37.
export const CREATOR_HOST = 'creator.xiaohongshu.com'
export const PUBLISH_URL = `https://${CREATOR_HOST}/publish/publish?source=official`
// A single image is transferred per call to stay below Chrome's JSON message limit.
// Chrome permits 64 MiB JSON messages; base64 consumes four bytes per three source bytes.
// The complete envelope is also checked before sending, including its metadata.
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024
export interface ImagePayload { name: string; mime: string; base64: string }
export interface PublishFormRequest {
  title: string; content: string; tags: string[]; dropped_tags: number
  schedule_at: string | null; visibility: string; products: string[]
}
export interface PublishRequest extends PublishFormRequest { images: string[]; is_original: boolean }
export const PUBLISH_FORM_FIELDS = ['title', 'content', 'tags', 'schedule_at', 'is_original', 'visibility', 'products'] as const
export type PublishFormField = typeof PUBLISH_FORM_FIELDS[number]
export function updatePublishRequest(request: PublishRequest, args: Record<string, unknown>): PublishRequest {
  const updated = updatePublishFormRequest(request, args)
  if (Object.prototype.hasOwnProperty.call(args, 'tags')) {
    updated.dropped_tags = Math.max(0, updated.tags.length - 10)
    updated.tags = updated.tags.slice(0, 10)
  }
  return updated
}
export function titleLength(title: string): number {
  let length = 0
  for (let i = 0; i < title.length; i++) length += title.charCodeAt(i) > 127 ? 2 : 1
  return Math.ceil(length / 2)
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${name} must be an array of strings.`)
  return value as string[]
}
function title(value: unknown): string {
  if (typeof value !== 'string' || titleLength(value) > 20) throw new Error('Title must be a string with upstream weighted length <=20.')
  return value
}
function content(value: unknown): string {
  if (typeof value !== 'string') throw new Error('content must be a string.')
  return value
}
function visibilityValue(value: unknown): string {
  const visibility = value === '' || value === undefined ? '公开可见' : value
  if (!['公开可见', '仅自己可见', '仅互关好友可见'].includes(String(visibility))) throw new Error('Unsupported visibility.')
  return String(visibility)
}
function scheduledTime(value: unknown): string | null {
  const schedule = value === undefined || value === '' ? null : value
  if (schedule !== null) {
    if (typeof schedule !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(schedule)) throw new Error('schedule_at must be RFC3339 with timezone.')
    // Go time.Parse rejects invalid calendar dates that JavaScript Date.parse normalizes.
    const [year, month, day, hour, minute, second] = schedule.slice(0, 19).split(/[-T:]/).map(Number)
    const calendar = new Date(0)
    calendar.setUTCFullYear(year, month - 1, day); calendar.setUTCHours(hour, minute, second, 0)
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw new Error('schedule_at contains an invalid RFC3339 calendar date.')
    const delta = Date.parse(schedule) - Date.now()
    if (!Number.isFinite(delta) || delta < 3600000 || delta > 14 * 86400000) throw new Error('schedule_at must be 1 hour to 14 days ahead.')
  }
  return schedule as string | null
}
function original(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new Error('is_original must be boolean.')
  return value === true
}
function tags(value: unknown): string[] { return strings(value ?? [], 'tags').map((tag) => tag.replace(/^#+/, '')) }
export function publishFormRequest(args: Record<string, unknown>): PublishFormRequest {
  return { title: title(args.title), content: content(args.content), tags: tags(args.tags), dropped_tags: 0,
    schedule_at: scheduledTime(args.schedule_at), visibility: visibilityValue(args.visibility), products: strings(args.products ?? [], 'products') }
}
export function updatePublishFormRequest<T extends PublishFormRequest>(request: T, args: Record<string, unknown>, fields: readonly PublishFormField[] = PUBLISH_FORM_FIELDS): T {
  // EO2 configure is a partial update, unlike the upstream one-shot request.
  // Validate only explicitly supplied fields; do not reparse accepted state.
  const changes: Partial<PublishFormRequest & { is_original: boolean }> = {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(args, field)) continue
    switch (field) {
      case 'title': changes.title = title(args.title); break
      case 'content': changes.content = content(args.content); break
      case 'tags': changes.tags = tags(args.tags); changes.dropped_tags = 0; break
      case 'schedule_at': changes.schedule_at = scheduledTime(args.schedule_at); break
      case 'visibility': changes.visibility = visibilityValue(args.visibility); break
      case 'products': changes.products = strings(args.products ?? [], 'products'); break
      case 'is_original': changes.is_original = original(args.is_original); break
    }
  }
  return { ...request, ...changes }
}
export function publishRequest(args: Record<string, unknown>): PublishRequest {
  const form = publishFormRequest(args)
  const images = strings(args.images, 'images')
  if (!images.length) throw new Error('At least one image is required.')
  // Upstream truncates tags in Publish (images), not PublishVideo.
  return { ...form, tags: form.tags.slice(0, 10), dropped_tags: Math.max(0, form.tags.length - 10), images, is_original: original(args.is_original) }
}
// Port the upstream h2non/filetype v1.1.3 image signatures; site acceptance stays unknown.
export function imageMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 12 && ascii(0, 13) === '\0\0\0\x0cjP  \r\n\x87\n\0') return 'image/jp2'
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png'
  if (ascii(0, 3) === 'GIF') return 'image/gif'
  if (ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 2) === 'BM') return 'image/bmp'
  if (bytes.length > 10 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return ascii(8, 11) === 'CR\x02' ? 'image/x-canon-cr2' : 'image/tiff'
  if (ascii(0, 3) === 'II\xbc') return 'image/vnd.ms-photo'
  if (ascii(0, 4) === '8BPS') return 'image/vnd.adobe.photoshop'
  if (ascii(0, 4) === 'AC10') return 'image/vnd.dwg'
  // Upstream GetFtyp returns empty brands below 17 bytes. IsISOBMFF checks
  // only the available length, not a minimum declared box size.
  if (bytes.length >= 17 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    const compatible = []
    if (size <= bytes.length) {
      for (let i = 16; i < size; i += 4) {
        if (bytes.length >= i + 4) compatible.push(ascii(i, i + 4))
      }
      if (brand === 'heic' || (['mif1', 'msf1'].includes(brand) && compatible.includes('heic'))) return 'image/heif'
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/vnd.microsoft.icon'
  return null
}
export function imagePayload(bytes: Uint8Array, name: string, requireImage = true): ImagePayload {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the Chrome JSON/base64 transport capacity; no image was silently resized or omitted.')
  // Upstream detects remote downloads, while local files are supplied directly.
  const mime = imageMime(bytes) ?? ''
  if (requireImage && !mime) throw new Error('File bytes are not a recognized image format.')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
  const ext = ({ 'image/jpeg': 'jpg', 'image/tiff': 'tif', 'image/x-canon-cr2': 'cr2', 'image/vnd.ms-photo': 'jxr', 'image/vnd.adobe.photoshop': 'psd', 'image/vnd.microsoft.icon': 'ico', 'image/vnd.dwg': 'dwg' } as Record<string, string>)[mime] ?? mime.split('/')[1]
  return { name: name || `image.${ext}`, mime, base64: btoa(binary) }
}
