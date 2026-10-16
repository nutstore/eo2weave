// Adapt User, InteractInfo and card Video from upstream xiaohongshu/types.go.
// Source: xpzouying/xiaohongshu-mcp at a5c8f7799980ba1fdd501999843eb2d17e4c9a9f.
// Callers must associate state with the exact visible card or current note ID.
export function fieldRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ref = value as Record<string, unknown>
  const object = ref.value ?? ref._value ?? value
  return object && typeof object === 'object' && !Array.isArray(object) ? object as Record<string, unknown> : null
}

export function fieldText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function readUser(value: unknown) {
  const user = fieldRecord(value)
  if (!user) return null
  let avatar: string | null = null
  const source = fieldText(user.avatar)
  if (source) {
    try {
      const url = new URL(source)
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) avatar = url.href
    } catch { /* Unknown avatar URLs remain null. */ }
  }
  return { userId: fieldText(user.userId), nickname: fieldText(user.nickname), nickName: fieldText(user.nickName), avatar }
}

export function readInteractInfo(value: unknown) {
  const info = fieldRecord(value)
  if (!info) return null
  return {
    liked: typeof info.liked === 'boolean' ? info.liked : null,
    likedCount: fieldText(info.likedCount),
    sharedCount: fieldText(info.sharedCount),
    commentCount: fieldText(info.commentCount),
    collectedCount: fieldText(info.collectedCount),
    collected: typeof info.collected === 'boolean' ? info.collected : null,
  }
}

export function readCardFields(value: unknown) {
  const card = fieldRecord(value)
  const video = fieldRecord(card?.video)
  const capa = fieldRecord(video?.capa)
  const duration = capa?.duration
  return {
    user: readUser(card?.user),
    interactInfo: readInteractInfo(card?.interactInfo),
    video: video ? { capa: capa ? { duration: typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 ? duration : null } : null } : null,
    fields_scope: card ? 'matched_card_page_state' : 'unavailable',
  }
}
