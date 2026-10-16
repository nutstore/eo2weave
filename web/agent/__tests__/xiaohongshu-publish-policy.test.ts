// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  imageMime, publishFormRequest, publishRequest, titleLength,
  updatePublishFormRequest, updatePublishRequest, PUBLISH_FORM_FIELDS,
} from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-policy'
import type { PublishRequest } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-policy'

const base = { title: '准备测试', content: '第一行\n第二行', images: ['vfs://assets/image.png'] }
const hour = 3600000, day = 86400000
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z')) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('upstream UTF-16 title weighting', () => {
  it.each([
    ['', 0], ['a', 1], ['ab', 1], ['abc', 2], ['a中b', 2], ['😀', 2],
    ['！？', 2], ['中'.repeat(20), 20], ['a'.repeat(40), 20], ['a' + '中'.repeat(19), 20],
  ])('measures %s as %s', (title, length) => expect(titleLength(title as string)).toBe(length))
  it.each(['中'.repeat(20), 'a'.repeat(40), '😀'.repeat(10)])('accepts the exact 20-unit boundary', (title) => {
    expect(publishRequest({ ...base, title }).title).toBe(title)
  })
  it.each(['中'.repeat(21), 'a'.repeat(41), '😀'.repeat(10) + 'a'])('rejects over the boundary', (title) => {
    expect(() => publishRequest({ ...base, title })).toThrow('<=20')
  })
})

describe('upstream RFC3339 schedule and 1h–14d window', () => {
  it.each([
    [hour - 1, false], [hour, true], [hour + 1, true],
    [14 * day - 1, true], [14 * day, true], [14 * day + 1, false],
  ])('handles the exact window edge at %s milliseconds', (offset, accepted) => {
    const schedule_at = new Date(Date.now() + offset).toISOString()
    if (accepted) expect(publishRequest({ ...base, schedule_at }).schedule_at).toBe(schedule_at)
    else expect(() => publishRequest({ ...base, schedule_at })).toThrow('1 hour to 14 days')
  })
  it.each(['2030-01-01T01:00:00Z', '2030-01-01T09:00:00+08:00', '2029-12-31T20:00:00-05:00', '2030-01-01T01:00:00.123456789Z'])('retains a valid timezone/fractional form %s', (schedule_at) => {
    expect(publishRequest({ ...base, schedule_at }).schedule_at).toBe(schedule_at)
  })
  it.each(['2030-01-01T01:00:00', '2030-01-01 01:00:00Z', '2030-1-1T01:00:00Z', '2030-01-01', 'tomorrow', 123])('rejects a non-RFC3339 input %s', (schedule_at) => {
    expect(() => publishRequest({ ...base, schedule_at })).toThrow('RFC3339')
  })
  it.each(['2030-02-30T01:00:00Z', '2030-02-29T01:00:00Z', '2030-04-31T01:00:00Z', '2030-00-01T01:00:00Z', '2030-01-00T01:00:00Z', '2030-01-01T24:00:00Z', '2030-01-01T01:60:00Z', '2030-01-01T01:00:60Z'])('rejects Go-invalid calendar values before window validation %s', (schedule_at) => {
    expect(() => publishRequest({ ...base, schedule_at })).toThrow('invalid RFC3339 calendar')
  })
  it('accepts a valid leap day within the window', () => {
    vi.setSystemTime(new Date('2028-02-28T00:00:00Z'))
    expect(publishRequest({ ...base, schedule_at: '2028-02-29T00:00:00Z' }).schedule_at).toBe('2028-02-29T00:00:00Z')
  })
})

function ftyp(brand: string, compatible: string[] = [], size = 16 + compatible.length * 4): Uint8Array {
  const bytes = new Uint8Array(Math.max(17, 16 + compatible.length * 4))
  new DataView(bytes.buffer).setUint32(0, size)
  bytes.set(new TextEncoder().encode('ftyp' + brand), 4)
  compatible.forEach((value, i) => bytes.set(new TextEncoder().encode(value), 16 + i * 4))
  return bytes
}
describe('h2non/filetype v1.1.3 image signatures', () => {
  it.each([
    [[255, 216, 255], 'image/jpeg'], [[137, 80, 78, 71], 'image/png'],
    [[71, 73, 70], 'image/gif'], [[0, 0, 0, 0, 0, 0, 0, 0, 87, 69, 66, 80], 'image/webp'],
    [[73, 73, 42, 0, 0, 0, 0, 0, 67, 82, 2], 'image/x-canon-cr2'],
    [[77, 77, 0, 42, 0, 0, 0, 0, 67, 82, 2], 'image/x-canon-cr2'],
    [[73, 73, 42, 0, 0, 0, 0, 0, 67, 82, 1], 'image/tiff'],
  ] as const)('matches upstream minimal bytes %s', (bytes, expected) => {
    expect(imageMime(Uint8Array.from(bytes))).toBe(expected)
  })
  it.each([['heic', []], ['mif1', ['heic']], ['msf1', ['avif', 'heic']]] as const)('accepts upstream HEIF brand %s with %s', (brand, compatible) => {
    expect(imageMime(ftyp(brand, [...compatible]))).toBe('image/heif')
  })
  it.each([['mif1', []], ['msf1', ['avif']], ['avif', ['heic']], ['heix', []]] as const)('rejects unsupported HEIF brand %s with %s', (brand, compatible) => {
    expect(imageMime(ftyp(brand, [...compatible]))).toBeNull()
  })
  it('rejects a box size beyond available bytes', () => expect(imageMime(ftyp('heic', [], 100))).toBeNull())
  it('returns no HEIF brand for the upstream 16-byte GetFtyp boundary', () => expect(imageMime(ftyp('heic').slice(0, 16))).toBeNull())
  it.each([0, 8])('does not add a declared-box-size minimum absent from upstream (%s)', (size) => expect(imageMime(ftyp('heic', [], size))).toBe('image/heif'))
  it('checks the upstream full compatible brand even when declared size ends within it', () => {
    expect(imageMime(ftyp('mif1', ['heic'], 17))).toBe('image/heif')
  })
  it.each([[], [255, 216], [137, 80, 78], [71, 73], [60, 104, 116, 109, 108, 62]].map((bytes) => ({ bytes })))('rejects incomplete or non-image bytes $bytes', ({ bytes }) => {
    expect(imageMime(Uint8Array.from(bytes))).toBeNull()
  })
})

describe('image tag truncation and partial configuration', () => {
  it.each([0, 10, 11, 12])('retains ordered first 10 tags and accounts for drops at %s', (count) => {
    const tags = Array.from({ length: count }, (_, i) => `##tag${i}`)
    expect(publishRequest({ ...base, tags })).toMatchObject({ tags: tags.slice(0, 10).map((value) => value.slice(2)), dropped_tags: Math.max(0, count - 10) })
  })
  it('retains the accepted request without revalidating omitted fields', () => {
    const accepted = publishRequest({ ...base, tags: Array.from({ length: 12 }, (_, i) => `tag${i}`), schedule_at: '2030-01-01T01:00:00Z', is_original: true })
    vi.setSystemTime(Date.now() + hour)
    const updated = updatePublishRequest(accepted, { content: 'new body' })
    expect(updated).toEqual({ ...accepted, content: 'new body' })
    expect(updated.tags).toBe(accepted.tags)
    expect(updated.images).toBe(accepted.images)
    expect(accepted.content).toBe(base.content)
    expect(() => updatePublishRequest(accepted, { schedule_at: accepted.schedule_at })).toThrow('1 hour')
  })
  it.each([
    ['title', '中'.repeat(21)], ['content', 1], ['visibility', 'legacy-visibility'],
    ['products', [1]], ['is_original', 'legacy-flag'], ['tags', [1]],
  ])('does not parse unchanged stored %s but validates an explicit update', (field, value) => {
    // A stored request can predate validation changes. Only supplied fields
    // may be rejected during configure; the accepted journal is not a new request.
    const stored = { ...publishRequest(base), [field]: value } as PublishRequest
    const changes = field === 'content' ? { visibility: '仅自己可见' } : { content: 'new body' }
    expect(updatePublishRequest(stored, changes)).toEqual({ ...stored, ...changes })
    expect(() => updatePublishRequest(stored, { [field]: value })).toThrow()
  })
  it('recomputes dropped_tags only when tags are explicitly replaced', () => {
    const accepted = publishRequest({ ...base, tags: Array.from({ length: 12 }, (_, i) => `tag${i}`) })
    expect(updatePublishRequest(accepted, { visibility: '仅自己可见' }).dropped_tags).toBe(2)
    expect(updatePublishRequest(accepted, { tags: ['#new'] })).toMatchObject({ tags: ['new'], dropped_tags: 0 })
    expect(updatePublishRequest(accepted, { tags: Array.from({ length: 11 }, () => '#new') }).dropped_tags).toBe(1)
  })
  it('distinguishes omitted fields from explicit clearing/default values', () => {
    const accepted = publishRequest({ ...base, visibility: '仅自己可见', is_original: true, schedule_at: '2030-01-01T01:00:00Z' })
    expect(updatePublishRequest(accepted, {})).toEqual(accepted)
    expect(updatePublishRequest(accepted, { title: '', content: '', tags: undefined, visibility: undefined, is_original: undefined, schedule_at: undefined, products: undefined })).toMatchObject({
      title: '', content: '', tags: [], dropped_tags: 0, visibility: '公开可见', is_original: false, schedule_at: null, products: [],
    })
  })
  it('ignores inherited update fields', () => {
    const accepted = publishRequest(base)
    expect(updatePublishRequest(accepted, Object.create({ title: '中'.repeat(21) }))).toEqual(accepted)
  })
  it('keeps video tags untruncated and excludes image-only originality updates', () => {
    const accepted = { ...publishFormRequest(base), video: 'vfs://assets/video.mp4' }
    const tags = Array.from({ length: 13 }, (_, i) => `#tag${i}`)
    expect(updatePublishFormRequest(accepted, { tags, is_original: 'invalid' }, PUBLISH_FORM_FIELDS.filter((field) => field !== 'is_original'))).toEqual({
      ...accepted, tags: tags.map((tag) => tag.slice(1)), dropped_tags: 0,
    })
  })
})
