import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readUser, readInteractInfo, readCardFields } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-fields'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'
import { searchItems } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-page'

const origin = 'https://www.xiaohongshu.com'
const id = '6abbda160000000014001437'
const otherId = '69e78d620000000021012b9b'
const user = { userId: otherId, nickname: 'Author', nickName: 'Alternate', avatar: 'https://cdn.example/avatar?sign=keep%2Bvalue' }
const info = { liked: false, likedCount: '0', sharedCount: '12', commentCount: '4', collectedCount: '3.4万', collected: true }
const noteCard = { user, interactInfo: info, video: { capa: { duration: 46 } } }
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
function page(path: string) {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, origin, hostname: url.hostname, pathname: url.pathname, search: url.search })
}
function card() {
  return `<section class="note-item"><a class="cover" href="${origin}/explore/${id}?xsec_token=page-token"></a><span class="title">Current title</span><span class="author"><span class="name">Author</span></span><span class="like-count">9</span></section>`
}
beforeEach(() => {
  document.body.innerHTML = '<div id="detail-title">Current title</div>'
  delete stateWindow.__INITIAL_STATE__
  page(`/explore/${id}`)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})
afterEach(() => {
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('Xiaohongshu upstream user and interaction fields', () => {
  it('preserves both nickname variants, ID and signed avatar URL', () => {
    expect(readUser(user)).toEqual(user)
    expect(readUser({ value: user })).toEqual(user)
  })
  it('keeps explicit false, true and string zero without numeric conversion', () => {
    expect(readInteractInfo(info)).toEqual(info)
    expect(readInteractInfo({ _value: info })).toEqual(info)
  })
  it('does not turn absent states into false or absent counts into zero', () => {
    expect(readInteractInfo({ liked: 'false', likedCount: 0, collected: 0 })).toEqual({ liked: null, likedCount: null, sharedCount: null, commentCount: null, collectedCount: null, collected: null })
    expect(readUser({ nickname: 'Author' })).toEqual({ userId: null, nickname: 'Author', nickName: null, avatar: null })
  })
  it.each(['javascript:alert(1)', 'data:image/png,x', 'https://user:pass@cdn.example/avatar', 'blob:local', '/relative-avatar'])('rejects unsupported avatar URL %s', (avatar) => {
    expect(readUser({ avatar })!.avatar).toBeNull()
  })
  it('distinguishes unavailable records and empty known records', () => {
    expect(readUser(undefined)).toBeNull()
    expect(readInteractInfo([])).toBeNull()
    expect(readCardFields(undefined)).toEqual({ user: null, interactInfo: null, video: null, fields_scope: 'unavailable' })
    expect(readCardFields({})).toMatchObject({ fields_scope: 'matched_card_page_state', user: null, interactInfo: null })
  })
  it('adapts only upstream video capability on cards', () => {
    expect(readCardFields(noteCard)).toEqual({ user, interactInfo: info, video: { capa: { duration: 46 } }, fields_scope: 'matched_card_page_state' })
    expect(readCardFields({ video: { capa: { duration: '46' } } }).video!.capa!.duration).toBeNull()
    expect(readCardFields({ video: { capa: { duration: 0 } } }).video!.capa!.duration).toBe(0)
  })
  it('reads exact current note metadata without converting its timestamp', async () => {
    const time = 1780000000123
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: {
      [id]: { note: { noteId: id, user, interactInfo: info, time, ipLocation: '浙江', xsecToken: 'exact-token' } },
      [otherId]: { note: { noteId: otherId, user: { ...user, nickname: 'Wrong' } } },
    } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ user, interactInfo: info, time, ipLocation: '浙江', xsecToken: 'exact-token', fields_scope: 'current_note_page_state' })
  })
  it('leaves metadata unknown when state is mismatching or absent', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: otherId, user, interactInfo: info, time: 123 } } } } }
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ user: null, interactInfo: null, time: null, ipLocation: null, xsecToken: null, fields_scope: 'unavailable' })
  })
  it('does not infer metadata from a visible author and metrics', async () => {
    document.body.innerHTML += '<div class="author-container"><span class="username">Author</span></div><div class="interact-container"><div class="like-wrapper"><span class="count">12</span></div></div>'
    const result = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(result.data).toMatchObject({ author: 'Author', visible_metrics: { likes_text: '12' }, user: null, interactInfo: null })
  })
  it('associates search metadata with exact visible card ID, separating visible counts', () => {
    page('/search_result?keyword=AI')
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [
      { id: otherId, modelType: 'note', noteCard: { ...noteCard, user: { ...user, nickname: 'Wrong' } } },
      { id, modelType: 'note', noteCard },
    ] } } }
    expect(searchItems()[0]).toMatchObject({ user, interactInfo: info, video: { capa: { duration: 46 } }, visible_metrics: { likes_text: '9' }, fields_scope: 'matched_card_page_state' })
  })
  it('does not borrow card fields through title-only correlation', () => {
    page('/search_result?keyword=AI')
    document.body.innerHTML = '<div>Current title</div>'
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [{ id, modelType: 'note', noteCard: { ...noteCard, displayTitle: 'Current title' } }] } } }
    expect(searchItems()[0]).toMatchObject({ user: null, interactInfo: null, video: null, fields_scope: 'unavailable' })
  })
  it('reads home card metadata by exact ID', async () => {
    page('/explore')
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = { feed: { feeds: { value: [{ id, modelType: 'note', noteCard }] } } }
    const result = await tools.xhs_list_feeds({ limit: 1 }) as { data: { items: unknown[] } }
    expect(result.data.items[0]).toMatchObject({ user, interactInfo: info, video: { capa: { duration: 46 } } })
  })
  it('does not mark missing home state as matched merely because a card is visible', async () => {
    page('/explore')
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = { feed: { feeds: { value: [{ id, modelType: 'note' }] } } }
    const result = await tools.xhs_list_feeds({ limit: 1 }) as { data: { items: unknown[] } }
    expect(result.data.items[0]).toMatchObject({ user: null, interactInfo: null, fields_scope: 'unavailable' })
  })
  it('reads only the selected profile tab metadata', async () => {
    page(`/user/profile/${otherId}`)
    document.body.innerHTML = `<div class="user-page"><span class="user-nickname">Author</span><div class="reds-tab-item sub-tab-list active">收藏</div>${card()}</div>`
    stateWindow.__INITIAL_STATE__ = { user: { activeTab: { value: { index: 1, query: 'fav' } }, notes: { value: [
      [{ id, noteCard: { ...noteCard, user: { ...user, nickname: 'Wrong tab' } } }],
      [{ id, noteCard }],
    ] } } }
    const result = await tools.xhs_read_profile({ limit: 1 }) as { data: { items: unknown[] } }
    expect(result.data.items[0]).toMatchObject({ user, interactInfo: info, video: { capa: { duration: 46 } } })
  })
})
