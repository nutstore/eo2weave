import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFeedFields, readListWindow } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-feed-fields'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'

const origin = 'https://www.xiaohongshu.com'
const id = '6abbda160000000014001437'
const otherId = '69e78d620000000021012b9b'
const authorId = '643751be000000000e01c14b'
const image = 'https://cdn.example/image?sign=keep%2Bvalue&t=123'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
const noteCard = {
  type: 'normal', displayTitle: 'State\nTitle',
  user: { userId: authorId, nickname: 'State author', nickName: 'Alternate', avatar: image },
  interactInfo: { liked: false, likedCount: '0', sharedCount: '1', commentCount: '2', collectedCount: '3.4万', collected: true },
  cover: { width: 1080, height: 1440, url: image, fileId: 'original-file', urlPre: image, urlDefault: image, infoList: [{ imageScene: 'WB_DFT', url: image }] },
}
const feed = { id, modelType: 'note', xsecToken: 'original-token', index: 0, noteCard }
function page(path: string) {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, origin, hostname: url.hostname, pathname: url.pathname, search: url.search })
}
function card(noteId = id) {
  return `<section class="note-item"><a class="cover" href="${origin}/explore/${noteId}?xsec_token=dom-token"><img src="https://cdn.example/dom-only"></a><span class="title">DOM title</span><span class="author"><span class="name">DOM author</span></span><span class="like-count">9</span></section>`
}
beforeEach(() => {
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = card()
  page('/search_result?keyword=AI')
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})
afterEach(() => {
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Xiaohongshu upstream Feed contract', () => {
  it('preserves the complete Feed shape and raw index zero', () => {
    expect(readFeedFields(feed, id)).toEqual({ feed: { ...feed, noteCard: { ...noteCard, video: null } }, feed_scope: 'matched_card_page_state', feed_partial: false })
  })
  it.each(['value', '_value'])('unwraps %s feed and card references', (key) => {
    expect(readFeedFields({ [key]: { ...feed, noteCard: { [key]: noteCard } } }, id).feed?.noteCard?.displayTitle).toBe('State\nTitle')
  })
  it.each([undefined, null, [], {}, { ...feed, id: otherId }, { ...feed, modelType: 'live_v2' }, { ...feed, modelType: 'hot_query' }])('rejects unmatched or non-note feed %#', (value) => {
    expect(readFeedFields(value, id)).toEqual({ feed: null, feed_scope: 'unavailable', feed_partial: true })
  })
  it('does not treat a title without a visible note ID as a match', () => {
    expect(readFeedFields(feed, undefined).feed).toBeNull()
  })
  it('retains empty displayTitle and access token without guessing a title or token', () => {
    expect(readFeedFields({ ...feed, xsecToken: '', noteCard: { ...noteCard, displayTitle: '' } }, id)).toMatchObject({ feed: { xsecToken: '', noteCard: { displayTitle: '' } }, feed_partial: false })
  })
  it('retains explicit empty strings in nested user, counts and cover fields', () => {
    const emptyCard = {
      ...noteCard,
      user: { ...noteCard.user, nickName: '', avatar: '' },
      interactInfo: { ...noteCard.interactInfo, sharedCount: '' },
      cover: { ...noteCard.cover, fileId: '', url: '' },
    }
    expect(readFeedFields({ ...feed, noteCard: emptyCard }, id)).toMatchObject({ feed: { noteCard: { user: { nickName: '', avatar: '' }, interactInfo: { sharedCount: '' }, cover: { fileId: '', url: '' } } }, feed_partial: false })
  })
  it.each([undefined, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('does not manufacture a missing or invalid source index %s', (index) => {
    expect(readFeedFields({ ...feed, index }, id)).toMatchObject({ feed: { index: null }, feed_partial: true })
  })
  it('keeps a valid source index independent of the visible return position', () => {
    expect(readFeedFields({ ...feed, index: 42 }, id).feed?.index).toBe(42)
  })
  it('reports sparse records as partial and does not fill missing fields with Go zero values', () => {
    expect(readFeedFields({ id, noteCard: { type: 'normal' } }, id)).toMatchObject({ feed: { modelType: null, xsecToken: null, index: null, noteCard: { displayTitle: null, user: null, interactInfo: null, cover: null, video: null } }, feed_partial: true })
  })
  it('distinguishes known empty cover infoList from an unavailable array', () => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { ...noteCard.cover, infoList: [] } } }, id)).toMatchObject({ feed: { noteCard: { cover: { infoList: [] } } }, feed_partial: false })
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { ...noteCard.cover, infoList: undefined } } }, id)).toMatchObject({ feed: { noteCard: { cover: { infoList: null } } }, feed_partial: true })
  })
  it.each(['value', '_value'])('reads a %s wrapped infoList', (key) => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { ...noteCard.cover, infoList: { [key]: noteCard.cover.infoList } } } }, id)).toMatchObject({ feed: { noteCard: { cover: { infoList: noteCard.cover.infoList } } }, feed_partial: false })
  })
  it('reports dropped unsafe cover entries as partial', () => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { ...noteCard.cover, infoList: [...noteCard.cover.infoList, { imageScene: 'bad', url: 'javascript:alert(1)' }] } } }, id)).toMatchObject({ feed: { noteCard: { cover: { infoList: [...noteCard.cover.infoList, { imageScene: 'bad', url: null }] } } }, feed_partial: true })
  })
  it('preserves known empty cover strings and zero dimensions without a DOM substitute', () => {
    const cover = { width: 0, height: 0, fileId: '', url: '', urlPre: '', urlDefault: '', infoList: [{ imageScene: '', url: '' }] }
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover } }, id)).toMatchObject({ feed: { noteCard: { cover } }, feed_partial: false })
  })
  it('retains available cover dimensions even when all state URLs are unknown', () => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { width: 1080, height: 1440 } } }, id)).toMatchObject({ feed: { noteCard: { cover: { width: 1080, height: 1440, url: null, urlPre: null, urlDefault: null, fileId: null, infoList: null } } }, feed_partial: true })
  })
  it.each(['javascript:alert(1)', 'data:image/png,x', 'https://user:password@cdn.example/image', '/relative-image'])('does not manufacture or return an unsafe state cover URL %s', (url) => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, cover: { ...noteCard.cover, url } } }, id)).toMatchObject({ feed: { noteCard: { cover: { url: null } } }, feed_partial: true })
  })
  it('preserves upstream video capability including duration zero', () => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, type: 'video', video: { capa: { duration: 0 } } } }, id)).toMatchObject({ feed: { noteCard: { type: 'video', video: { capa: { duration: 0 } } } }, feed_partial: false })
  })
  it('marks malformed video capability as partial', () => {
    expect(readFeedFields({ ...feed, noteCard: { ...noteCard, video: { capa: { duration: '46' } } } }, id).feed_partial).toBe(true)
  })
})

describe('Xiaohongshu list windows and integration', () => {
  it.each([0, 1, 3, 5])('separates rendered and returned counts for %s cards', (count) => {
    const items = Array.from({ length: count }, (_, index) => ({ source: 'dom', index }))
    expect(readListWindow(items, 3)).toEqual({ items: items.slice(0, 3), loaded_count: count, returned_count: Math.min(count, 3), partial: count > 3, return_truncated: count > 3, results_scope: 'currently_loaded', loaded_count_scope: 'currently_rendered_dom' })
  })
  it('labels title-correlated fallback counts without marking feeds as exact matches', async () => {
    document.body.innerHTML = '<main>State Title</main>'
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [feed] } } }
    const result = await tools.xhs_list_search_results({ limit: 3 }) as { data: Record<string, any> }
    expect(result.data).toMatchObject({ loaded_count: 1, returned_count: 1, loaded_count_scope: 'page_state_correlated_with_dom' })
    expect(result.data.items[0]).toMatchObject({ feed: null, feed_scope: 'unavailable', feed_partial: true })
  })
  it.each(['search', 'home', 'profile'])('returns upstream Feed fields on the %s list', async (kind) => {
    if (kind === 'search') stateWindow.__INITIAL_STATE__ = { search: { feeds: { _value: [feed, { ...feed, id: otherId, index: 7 }] } } }
    if (kind === 'home') {
      page('/explore')
      stateWindow.__INITIAL_STATE__ = { feed: { feeds: { value: [feed, { ...feed, id: otherId, index: 7 }] } } }
    }
    if (kind === 'profile') {
      page(`/user/profile/${authorId}`)
      document.body.innerHTML = `<div class="user-page"><span class="user-nickname">DOM author</span><div class="reds-tab-item sub-tab-list active">笔记</div>${card()}${card(otherId)}</div>`
      stateWindow.__INITIAL_STATE__ = { user: { activeTab: { value: { index: 0, query: 'note' } }, notes: { _value: [[feed, { ...feed, id: otherId, index: 7 }]] } } }
    } else document.body.innerHTML = card() + card(otherId)
    const reader = kind === 'search' ? tools.xhs_list_search_results : kind === 'home' ? tools.xhs_list_feeds : tools.xhs_read_profile
    const result = await reader({ limit: 1 }) as { data: Record<string, any> }
    expect(result.data).toMatchObject({ loaded_count: 2, returned_count: 1, return_truncated: true, loaded_count_scope: 'currently_rendered_dom' })
    expect(result.data.items[0]).toMatchObject({ index: 0, title: 'DOM title', note_type: 'normal', feed_scope: 'matched_card_page_state', feed_partial: false, feed: { ...feed, noteCard: { ...noteCard, video: null } }, visible_metrics: { likes_text: '9' } })
    expect(new URL(result.data.items[0].note_url).searchParams.get('xsec_token')).toBe('dom-token')
  })
  it('keeps raw cover fields separate from rendered DOM fallback', async () => {
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [{ ...feed, noteCard: { ...noteCard, cover: undefined } }] } } }
    const result = await tools.xhs_list_search_results({ limit: 1 }) as { data: Record<string, any> }
    expect(result.data.items[0].cover.urlDefault).toBe('https://cdn.example/dom-only')
    expect(result.data.items[0].feed.noteCard.cover).toBeNull()
    expect(result.data.items[0].feed_partial).toBe(true)
  })
  it('does not copy invisible state feeds into the returned list', async () => {
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [feed, { ...feed, id: otherId, noteCard: { ...noteCard, displayTitle: 'Hidden note' } }] } } }
    const result = await tools.xhs_list_search_results({ limit: 3 }) as { data: Record<string, any> }
    expect(result.data.loaded_count).toBe(1)
    expect(result.data.items.map((item: any) => item.feed.id)).toEqual([id])
  })
  it('deduplicates rendered copies by note ID without changing the raw state index', async () => {
    document.body.innerHTML = card() + card()
    stateWindow.__INITIAL_STATE__ = { search: { feeds: { value: [{ ...feed, index: 42 }] } } }
    const result = await tools.xhs_list_search_results({ limit: 3 }) as { data: Record<string, any> }
    expect(result.data).toMatchObject({ loaded_count: 1, returned_count: 1 })
    expect(result.data.items[0]).toMatchObject({ index: 0, feed: { index: 42 } })
  })
  it('reads only the selected profile tab raw fields', async () => {
    page(`/user/profile/${authorId}`)
    document.body.innerHTML = `<div class="user-page"><span class="user-nickname">DOM author</span><div class="reds-tab-item sub-tab-list active">收藏</div>${card()}</div>`
    stateWindow.__INITIAL_STATE__ = { user: { activeTab: { value: { index: 1, query: 'fav' } }, notes: { value: [[{ ...feed, xsecToken: 'wrong', noteCard: { ...noteCard, displayTitle: 'Wrong tab' } }], [feed]] } } }
    const result = await tools.xhs_read_profile({ limit: 1 }) as { data: Record<string, any> }
    expect(result.data.items[0].feed).toMatchObject({ xsecToken: 'original-token', noteCard: { displayTitle: 'State\nTitle' } })
  })
})
