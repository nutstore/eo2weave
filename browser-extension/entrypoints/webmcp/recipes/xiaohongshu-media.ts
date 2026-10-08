// Adapt the upstream Cover and DetailImageInfo JSON contracts to the current tab.
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

function imageUrl(value: unknown): string | null {
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
  const url = imageUrl(image.currentSrc || image.getAttribute('src'))
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
  const urlDefault = imageUrl(image.urlDefault)
  const urlPre = imageUrl(image.urlPre)
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
    const url = imageUrl(image?.url)
    return url ? [{ imageScene: text(image?.imageScene), url }] : []
  }) : []
  const image = Array.from(card.querySelectorAll<HTMLImageElement>('.cover img, img.cover, .note-cover img, .cover-container img'))
    .filter(rendered).map(domImage).find((entry) => entry !== null)
  const url = imageUrl(state?.url)
  const urlPre = imageUrl(state?.urlPre)
  const urlDefault = imageUrl(state?.urlDefault)
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
