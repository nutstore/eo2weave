// Adapt the upstream image and VideoDetail JSON contracts to the current tab.
// Source: xpzouying/xiaohongshu-mcp, xiaohongshu/types.go at a5c8f7799980ba1fdd501999843eb2d17e4c9a9f.
// Detail extraction follows feed_detail.go: noteDetailMap indexed by the exact note ID.
export interface ImageInfo {
  imageScene: string | null
  url: string
}

export interface CoverInfo {
  width: number | null
  height: number | null
  url: string | null
  fileId: string | null
  urlPre: string | null
  urlDefault: string | null
  infoList: ImageInfo[]
}

export interface DetailImageInfo {
  width: number | null
  height: number | null
  urlDefault: string | null
  urlPre: string | null
  livePhoto: boolean | null
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const ref = value as Record<string, unknown>
  return ref.value ?? ref._value ?? value
}

function record(value: unknown): Record<string, unknown> | null {
  const object = unwrap(value)
  return object && typeof object === 'object' && !Array.isArray(object)
    ? object as Record<string, unknown> : null
}

function dimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function mediaUrl(value: unknown): string | null {
  const input = text(value)
  if (!input) return null
  try {
    const url = new URL(input, location.origin)
    // Preserve signed query parameters; do not manufacture CDN variants.
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function rendered(image: HTMLImageElement): boolean {
  if (!image.getClientRects().length) return false
  for (let element: HTMLElement | null = image; element; element = element.parentElement) {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
  }
  return true
}

function domImage(image: HTMLImageElement): DetailImageInfo | null {
  const url = mediaUrl(image.currentSrc || image.getAttribute('src'))
  if (!url) return null
  return {
    width: dimension(image.naturalWidth),
    height: dimension(image.naturalHeight),
    urlDefault: url,
    urlPre: null,
    livePhoto: null,
  }
}

function stateImage(value: unknown): DetailImageInfo | null {
  const image = record(value)
  if (!image) return null
  const urlDefault = mediaUrl(image.urlDefault)
  const urlPre = mediaUrl(image.urlPre)
  if (!urlDefault && !urlPre) return null
  return {
    width: dimension(image.width),
    height: dimension(image.height),
    urlDefault,
    urlPre,
    livePhoto: typeof image.livePhoto === 'boolean' ? image.livePhoto : null,
  }
}

export function readCardCover(card: HTMLElement, stateCover?: unknown): CoverInfo | null {
  const state = record(stateCover)
  const info = unwrap(state?.infoList)
  const infoList: ImageInfo[] = Array.isArray(info) ? info.flatMap((entry) => {
    const image = record(entry)
    const url = mediaUrl(image?.url)
    return url ? [{ imageScene: text(image?.imageScene), url }] : []
  }) : []
  const image = Array.from(card.querySelectorAll<HTMLImageElement>('.cover img, img.cover, .note-cover img, .cover-container img'))
    .filter(rendered).map(domImage).find((entry) => entry !== null)
  const url = mediaUrl(state?.url)
  const urlPre = mediaUrl(state?.urlPre)
  const urlDefault = mediaUrl(state?.urlDefault)
  if (!url && !urlPre && !urlDefault && !infoList.length && !image) return null
  return {
    width: dimension(state?.width) ?? image?.width ?? null,
    height: dimension(state?.height) ?? image?.height ?? null,
    url,
    fileId: text(state?.fileId),
    urlPre,
    urlDefault: urlDefault ?? image?.urlDefault ?? null,
    infoList,
  }
}

const streamIntegers = [
  'width', 'height', 'duration', 'size', 'fps', 'rotate', 'streamType', 'hdrType',
  'videoBitrate', 'videoDuration', 'avgBitrate', 'audioBitrate', 'audioDuration',
  'audioChannels', 'weight', 'defaultStream',
] as const
const streamDecimals = ['volume', 'vmaf', 'psnr', 'ssim'] as const
const streamStrings = ['format', 'qualityType', 'streamDesc', 'videoCodec', 'audioCodec'] as const

type NullableNumbers<K extends string> = { [P in K]: number | null }
type NullableStrings<K extends string> = { [P in K]: string | null }
export type VideoStream = NullableNumbers<typeof streamIntegers[number] | typeof streamDecimals[number]>
  & NullableStrings<typeof streamStrings[number]> & { masterUrl: string | null; backupUrls: string[] | null }
export interface VideoSubtitle {
  url: string
  language: string | null
  format: number | null
  type: number | null
}

function numeric(value: unknown, integer = true): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    && (!integer || Number.isSafeInteger(value)) ? value : null
}

function numericFields<K extends string>(state: Record<string, unknown>, keys: readonly K[], integer = true): NullableNumbers<K> {
  return Object.fromEntries(keys.map((key) => [key, numeric(state[key], integer)])) as NullableNumbers<K>
}

function stringFields<K extends string>(state: Record<string, unknown>, keys: readonly K[]): NullableStrings<K> {
  return Object.fromEntries(keys.map((key) => [key, text(state[key])])) as NullableStrings<K>
}

export function readNoteVideo(stateVideo: unknown) {
  const state = record(stateVideo)
  if (!state) return { video: null, video_scope: 'unavailable', video_partial: true, subtitles_scope: 'unavailable' }

  let partial = false
  const image = record(state.image)
  const capa = record(state.capa)
  const media = record(state.media)
  const meta = record(media?.video)
  const rawStreams = record(media?.stream)
  const stream = rawStreams ? Object.fromEntries(Object.entries(rawStreams).flatMap(([encoding, entries]) => {
    const list = unwrap(entries)
    if (!Array.isArray(list)) { partial = true; return [] }
    return [[encoding, list.flatMap((entry): VideoStream[] => {
      const item = record(entry)
      if (!item) { partial = true; return [] }
      const masterUrl = mediaUrl(item.masterUrl)
      if (item.masterUrl != null && !masterUrl) partial = true
      const rawBackups = unwrap(item.backupUrls)
      let backupUrls: string[] | null = null
      if (Array.isArray(rawBackups)) {
        backupUrls = rawBackups.flatMap((value) => {
          const url = mediaUrl(value)
          if (!url) partial = true
          return url ? [url] : []
        })
      } else if (rawBackups != null) partial = true
      return [{
        ...numericFields(item, streamIntegers),
        ...numericFields(item, streamDecimals, false),
        ...stringFields(item, streamStrings),
        masterUrl, backupUrls,
      }]
    })]]
  })) : null
  if (!media || !rawStreams) partial = true

  // Mirror upstream VideoDetail.UnmarshalJSON: mediaV2 contributes only subtitles.
  // A malformed optional copy must not discard the primary video streams.
  let rawSubtitles: unknown = state.subtitles
  let subtitlesScope = rawSubtitles == null ? 'unavailable' : 'video.subtitles'
  if (typeof state.mediaV2 === 'string' && state.mediaV2 !== '') {
    try {
      const decoded: unknown = JSON.parse(state.mediaV2)
      const copy = record(decoded)
      const videoCopy = record(copy?.video)
      if ((decoded != null && !copy) || (copy?.video != null && !videoCopy)) throw new Error('Invalid mediaV2 shape')
      const candidate = videoCopy?.subtitles
      if (candidate != null && !record(candidate)) throw new Error('Invalid mediaV2 subtitles')
      rawSubtitles = candidate
      subtitlesScope = rawSubtitles == null ? 'unavailable' : 'video.mediaV2'
    } catch {
      partial = true
    }
  } else if (state.mediaV2 != null && typeof state.mediaV2 !== 'string') partial = true
  const subtitleMap = record(rawSubtitles)
  if (rawSubtitles != null && !subtitleMap) { partial = true; subtitlesScope = 'unavailable' }
  const subtitles = subtitleMap ? Object.fromEntries(Object.entries(subtitleMap).flatMap(([language, entries]) => {
    const list = unwrap(entries)
    if (!Array.isArray(list)) { partial = true; return [] }
    return [[language, list.flatMap((entry): VideoSubtitle[] => {
      const subtitle = record(entry)
      const url = mediaUrl(subtitle?.url)
      if (!url) { partial = true; return [] }
      return [{ url, language: text(subtitle?.language), format: numeric(subtitle?.format), type: numeric(subtitle?.type) }]
    })]]
  })) : null
  const rawTypes = unwrap(meta?.streamTypes)
  const streamTypes = Array.isArray(rawTypes) ? rawTypes.flatMap((value) => {
    const number = numeric(value)
    if (number === null) partial = true
    return number === null ? [] : [number]
  }) : null
  if (rawTypes != null && !Array.isArray(rawTypes)) partial = true

  return {
    video: {
      // These are file IDs, not URLs; do not manufacture CDN addresses.
      image: image ? stringFields(image, ['firstFrameFileid', 'thumbnailFileid']) : null,
      capa: capa ? { duration: numeric(capa.duration) } : null,
      media: media ? {
        videoId: numeric(media.videoId),
        // Preserve upstream units: capability/meta duration in seconds, stream duration in milliseconds.
        video: meta ? { ...numericFields(meta, ['duration', 'hdrType', 'drmType', 'bizName']), ...stringFields(meta, ['md5', 'bizId']), streamTypes } : null,
        stream,
      } : null,
      subtitles,
    },
    video_scope: 'current_note_page_state',
    video_partial: partial,
    subtitles_scope: subtitlesScope,
  }
}

export function readNoteImages(stateImages: unknown, root: ParentNode) {
  const raw = unwrap(stateImages)
  if (Array.isArray(raw)) {
    const imageList = raw.map(stateImage).filter((image): image is DetailImageInfo => image !== null)
    // An explicit empty array is meaningful; malformed entries are partial.
    if (imageList.length || raw.length === 0) return {
      imageList,
      image_list_scope: 'current_note_page_state',
      image_list_partial: imageList.length !== raw.length,
    }
  }

  const seen = new Set<string>()
  const imageList = Array.from(root.querySelectorAll<HTMLImageElement>('.note-slider-img, .note-slider img, .swiper-slide img'))
    .filter(rendered).flatMap((element) => {
      const image = domImage(element)
      if (!image?.urlDefault || seen.has(image.urlDefault)) return []
      seen.add(image.urlDefault)
      return [image]
    })
  return {
    imageList,
    image_list_scope: imageList.length ? 'currently_rendered_dom' : 'unavailable',
    image_list_partial: true,
  }
}
