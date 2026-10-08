// Port UserBasicInfo/UserInteractions from upstream xiaohongshu/types.go.
// user_profile.go reads user.userPageData.value/_value.basicInfo and interactions.
import { fieldRecord } from './xiaohongshu-fields'

export interface VisibleProfileIdentity {
  profileId: string
  nickname: string | null
  redIdText: string | null
}

const normalized = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
const sourceText = (value: unknown): string | null => typeof value === 'string' ? value : null

function imageUrl(value: unknown): string | null {
  if (value === '') return ''
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null
  } catch { return null }
}

function interactionArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  const ref = value && typeof value === 'object' ? value as Record<string, unknown> : null
  const array = ref?.value ?? ref?._value
  return Array.isArray(array) ? array : null
}

export function readProfileFields(state: unknown, visible: VisibleProfileIdentity) {
  const unavailable = (match: string) => ({
    userBasicInfo: null,
    interactions: null,
    profile_fields_scope: 'unavailable' as const,
    profile_state_match: match,
    profile_match_basis: null,
    profile_fields_partial: true,
  })
  const data = fieldRecord(fieldRecord(fieldRecord(state)?.user)?.userPageData)
  if (!data) return unavailable('unavailable')
  const basic = fieldRecord(data.basicInfo)
  if (!basic) return unavailable('basic_info_unavailable')

  // Upstream's typed BasicInfo omits userId; some site versions include it.
  // Never use user.userInfo (the signed-in account) as the viewed profile ID.
  const ids = [data.userId, basic.userId].filter((id) => id !== undefined && id !== null && id !== '')
  if (ids.some((id) => typeof id !== 'string')) return unavailable('invalid_profile_id')
  if (ids.some((id) => id !== visible.profileId)) return unavailable('profile_id_mismatch')
  const nickname = normalized(basic.nickname)
  const visibleNickname = normalized(visible.nickname)
  const redId = normalized(basic.redId)
  const visibleRedId = normalized(visible.redIdText).replace(/^小红书号\s*[:：]?\s*/, '')
  if (nickname && visibleNickname && nickname !== visibleNickname) return unavailable('nickname_mismatch')
  if (redId && visibleRedId && redId !== visibleRedId) return unavailable('red_id_mismatch')
  const byId = ids.length > 0
  // A nickname alone is insufficient: different profiles may share a nickname.
  if (!byId && !(redId && redId === visibleRedId && nickname && nickname === visibleNickname)) {
    return unavailable('identity_unverified')
  }

  const userBasicInfo = {
    gender: typeof basic.gender === 'number' && Number.isSafeInteger(basic.gender) ? basic.gender : null,
    ipLocation: sourceText(basic.ipLocation),
    desc: sourceText(basic.desc),
    imageb: imageUrl(basic.imageb),
    nickname: sourceText(basic.nickname),
    images: imageUrl(basic.images),
    redId: sourceText(basic.redId),
  }
  const list = interactionArray(data.interactions)
  let partial = Object.values(userBasicInfo).some((value) => value === null) || list === null
  const interactions = list?.flatMap((value) => {
    const entry = fieldRecord(value)
    if (!entry) { partial = true; return [] }
    const item = { type: sourceText(entry.type), name: sourceText(entry.name), count: sourceText(entry.count) }
    if (Object.values(item).some((value) => value === null)) partial = true
    return [item]
  }) ?? null
  return {
    userBasicInfo,
    interactions,
    profile_fields_scope: 'current_profile_page_state' as const,
    profile_state_match: 'matched',
    profile_match_basis: byId ? 'state_profile_id' : 'visible_red_id_and_nickname',
    profile_fields_partial: partial,
  }
}
