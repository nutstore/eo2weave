import { describe, expect, it } from 'vitest'
import { readProfileFields } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-profile-fields'

const profileId = '60b24594000000000101c9de'
const otherId = '6107e8cc00000000200295dc'
const identity = { profileId, nickname: '可见昵称', redIdText: '小红书号：user123' }
const basicInfo = { gender: 0, ipLocation: '广东', desc: '', imageb: 'https://example.com/large.jpg?signature=keep',
  nickname: '可见昵称', images: 'https://example.com/small.jpg', redId: 'user123' }
const interactions = [{ type: 'follows', name: '关注', count: '0' }, { type: 'fans', name: '粉丝', count: '12345' },
  { type: 'interaction', name: '获赞与收藏', count: '3.4万' }]
function state(data: Record<string, unknown>) { return { user: { userPageData: { value: data } } } }

describe('upstream profile basicInfo and interactions', () => {
  it('maps upstream basicInfo to userBasicInfo without changing zero, empty strings, URLs or count strings', () => {
    const result = readProfileFields(state({ basicInfo, interactions }), identity)
    expect(result).toMatchObject({ userBasicInfo: basicInfo, interactions,
      profile_fields_scope: 'current_profile_page_state', profile_state_match: 'matched',
      profile_match_basis: 'visible_red_id_and_nickname', profile_fields_partial: false })
    expect(Object.keys(result.userBasicInfo!)).toEqual(['gender', 'ipLocation', 'desc', 'imageb', 'nickname', 'images', 'redId'])
  })

  it.each(['plain', 'value', '_value'])('reads the upstream page ref shape %s', (wrapper) => {
    const data = { basicInfo, interactions }
    const pageData = wrapper === 'plain' ? data : { [wrapper]: data }
    expect(readProfileFields({ user: { userPageData: pageData } }, identity).userBasicInfo).toEqual(basicInfo)
  })

  it('uses an exact state profile ID when DOM redId is unavailable', () => {
    const result = readProfileFields(state({ userId: profileId, basicInfo, interactions }), { ...identity, redIdText: null })
    expect(result).toMatchObject({ profile_state_match: 'matched', profile_match_basis: 'state_profile_id', userBasicInfo: basicInfo })
  })

  it('also accepts a profile ID provided in basicInfo, without adding it to the upstream typed fields', () => {
    const result = readProfileFields(state({ basicInfo: { ...basicInfo, userId: profileId }, interactions }), identity)
    expect(result.profile_match_basis).toBe('state_profile_id')
    expect(result.userBasicInfo).not.toHaveProperty('userId')
  })

  it.each([
    [{ userId: otherId, basicInfo, interactions }, 'profile_id_mismatch'],
    [{ userId: profileId, basicInfo: { ...basicInfo, userId: otherId }, interactions }, 'profile_id_mismatch'],
    [{ userId: 123, basicInfo, interactions }, 'invalid_profile_id'],
    [{ basicInfo: { ...basicInfo, nickname: '另一个用户' }, interactions }, 'nickname_mismatch'],
    [{ basicInfo: { ...basicInfo, redId: 'another-red-id' }, interactions }, 'red_id_mismatch'],
  ])('does not return state belonging to a mismatched identity %#', (data, match) => {
    expect(readProfileFields(state(data), identity)).toMatchObject({
      userBasicInfo: null, interactions: null, profile_fields_scope: 'unavailable', profile_state_match: match, profile_fields_partial: true,
    })
  })

  it('does not use nickname alone as proof of identity', () => {
    expect(readProfileFields(state({ basicInfo, interactions }), { ...identity, redIdText: null })).toMatchObject({
      userBasicInfo: null, interactions: null, profile_state_match: 'identity_unverified',
    })
  })

  it('does not use the logged-in userInfo as the viewed profile identity', () => {
    const result = readProfileFields({ user: { userInfo: { userId: profileId }, userPageData: { basicInfo: { nickname: identity.nickname }, interactions } } },
      { ...identity, redIdText: null })
    expect(result.profile_state_match).toBe('identity_unverified')
    expect(result.interactions).toBeNull()
  })

  it.each(['小红书号：user123', '小红书号: user123', '小红书号 user123', 'user123'])('matches the rendered redId label %s', (redIdText) => {
    expect(readProfileFields(state({ basicInfo, interactions }), { ...identity, redIdText }).profile_state_match).toBe('matched')
  })

  it('retains all field keys as null when a matched profile has missing fields', () => {
    const result = readProfileFields(state({ userId: profileId, basicInfo: { nickname: identity.nickname }, interactions: null }), identity)
    expect(result).toMatchObject({ profile_fields_partial: true,
      userBasicInfo: { gender: null, ipLocation: null, desc: null, imageb: null, nickname: identity.nickname, images: null, redId: null }, interactions: null })
  })

  it.each([{ gender: '0' }, { gender: 1.5 }, { gender: Infinity }, { images: 'javascript:alert(1)' }, { imageb: 'https://user:pass@example.com/x' }])('marks malformed typed fields as partial %o', (patch) => {
    const result = readProfileFields(state({ basicInfo: { ...basicInfo, ...patch }, interactions }), identity)
    expect(result.profile_fields_partial).toBe(true)
    expect(result.userBasicInfo![Object.keys(patch)[0] as keyof typeof basicInfo]).toBeNull()
  })

  it('preserves explicit empty image fields instead of inventing URLs', () => {
    expect(readProfileFields(state({ basicInfo: { ...basicInfo, imageb: '', images: '' }, interactions }), identity)).toMatchObject({
      userBasicInfo: { imageb: '', images: '' }, profile_fields_partial: false,
    })
  })

  it('retains numeric gender values without guessing their meaning', () => {
    expect(readProfileFields(state({ basicInfo: { ...basicInfo, gender: 2 }, interactions }), identity).userBasicInfo?.gender).toBe(2)
  })

  it.each(['value', '_value'])('reads wrapped interaction arrays %s', (key) => {
    expect(readProfileFields(state({ basicInfo, interactions: { [key]: interactions } }), identity).interactions).toEqual(interactions)
  })

  it('distinguishes a known empty interaction array from unavailable interactions', () => {
    expect(readProfileFields(state({ basicInfo, interactions: [] }), identity)).toMatchObject({ interactions: [], profile_fields_partial: false })
    expect(readProfileFields(state({ basicInfo }), identity)).toMatchObject({ interactions: null, profile_fields_partial: true })
  })

  it('keeps malformed interaction fields null and does not convert numeric counts to strings', () => {
    const result = readProfileFields(state({ basicInfo, interactions: [{ type: 'fans', name: '粉丝', count: 123 }, null,
      { type: 'future-category', name: '', count: '' }] }), identity)
    expect(result).toMatchObject({ profile_fields_partial: true, interactions: [
      { type: 'fans', name: '粉丝', count: null }, { type: 'future-category', name: '', count: '' },
    ] })
  })

  it.each([{}, { user: { userPageData: null } }, { user: { userPageData: { basicInfo: null, interactions } } }])('does not expose interactions without basic profile identity %#', (input) => {
    expect(readProfileFields(input, identity)).toMatchObject({ userBasicInfo: null, interactions: null, profile_fields_scope: 'unavailable' })
  })
})
