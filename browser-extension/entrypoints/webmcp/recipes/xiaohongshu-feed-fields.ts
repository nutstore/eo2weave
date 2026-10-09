// Adapt Feed / NoteCard from upstream xiaohongshu/types.go.
// Lists follow search.go, feeds.go and user_profile.go, restricted to matched rendered cards.
import { fieldRecord, readCardFields } from './xiaohongshu-fields'

function rawText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function containsUnknown(value: unknown): boolean {
  if (value === null) return true
  if (Array.isArray(value)) return value.some(containsUnknown)
  return typeof value === 'object' && value !== null && Object.values(value).some(containsUnknown)
}

function preserveEmptyStrings<T extends object>(parsed: T | null, source: unknown): T | null {
  if (!parsed) return null
  const raw = fieldRecord(source)
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) =>
    [key, value === null && raw?.[key] === '' ? '' : value])) as T
}

function rawMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '') return value
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null
  } catch { return null }
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readFeedCover(value: unknown) {
  const cover = fieldRecord(value)
  if (!cover) return { cover: null, partial: true }
  const source = cover.infoList
  const wrapper = source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : null
  const info = wrapper ? wrapper.value ?? wrapper._value ?? source : source
  const infoList = Array.isArray(info) ? info.flatMap((entry) => {
    const image = fieldRecord(entry)
    return image ? [{ imageScene: rawText(image.imageScene), url: rawMediaUrl(image.url) }] : []
  }) : null
  return {
    cover: {
      width: nonnegativeInteger(cover.width), height: nonnegativeInteger(cover.height),
      url: rawMediaUrl(cover.url), fileId: rawText(cover.fileId),
      urlPre: rawMediaUrl(cover.urlPre), urlDefault: rawMediaUrl(cover.urlDefault), infoList,
    },
    partial: Array.isArray(info) && infoList?.length !== info.length,
  }
}

export function readFeedFields(value: unknown, visibleNoteId: string | undefined) {
  const source = fieldRecord(value)
  if (!visibleNoteId || source?.id !== visibleNoteId ||
    (source.modelType !== undefined && source.modelType !== 'note')) {
    return { feed: null, feed_scope: 'unavailable', feed_partial: true }
  }
  const card = fieldRecord(source.noteCard)
  const fields = readCardFields(card)
  const cover = readFeedCover(card?.cover)
  const noteCard = card ? {
    type: rawText(card.type),
    displayTitle: rawText(card.displayTitle),
    user: preserveEmptyStrings(fields.user, card.user),
    interactInfo: preserveEmptyStrings(fields.interactInfo, card.interactInfo),
    // No DOM dimensions or URLs may substitute for upstream cover fields.
    cover: cover.cover,
    video: fields.video,
  } : null
  const feed = {
    id: visibleNoteId,
    modelType: rawText(source.modelType),
    xsecToken: rawText(source.xsecToken),
    index: nonnegativeInteger(source.index),
    noteCard,
  }
  // Video is optional in the upstream contract; an absent video is not a missing field.
  const checkedCard = noteCard ? { ...noteCard, video: card?.video === undefined || card.video === null ? [] : noteCard.video } : null
  return {
    feed,
    feed_scope: 'matched_card_page_state',
    feed_partial: containsUnknown({ ...feed, noteCard: checkedCard }) || cover.partial,
  }
}

export function readListWindow<T extends { source: string }>(items: T[], limit: number) {
  const truncated = items.length > limit
  return {
    items: items.slice(0, limit),
    loaded_count: items.length,
    returned_count: Math.min(items.length, limit),
    partial: truncated,
    return_truncated: truncated,
    results_scope: 'currently_loaded',
    loaded_count_scope: items.some((item) => item.source === 'page_state_correlated_with_dom')
      ? 'page_state_correlated_with_dom' : 'currently_rendered_dom',
  }
}
