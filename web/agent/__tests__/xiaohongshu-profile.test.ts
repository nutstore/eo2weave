import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
let tools: typeof import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-profile').xiaohongshuProfileTools

const origin = 'https://www.xiaohongshu.com'
const userId = '69e78d620000000021012b9b'
const noteId = '6abcd0b5000000001b01d831'
const otherId = '6abc9b06000000001803952a'
const assign = vi.fn()
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }

interface ToolResult {
  status: string
  error_code: string | null
  target_url?: string
  data: Record<string, any> | null
}

function setPage(path: string) {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, origin: url.origin, hostname: url.hostname, pathname: url.pathname, search: url.search, assign })
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return await tools[name](args) as ToolResult
}

function card(id = noteId, token = '', title = 'Visible card'): string {
  return `<section class="note-item"><a href="${origin}/explore/${id}${token ? `?xsec_token=${token}&extra=keep` : ''}">Cover</a><span class="title">${title}</span><span class="author"><span class="name">Visible author</span></span><span class="like-wrapper"><span class="count">1.2万</span></span></section>`
}

function profile(notes = card()): string {
  return `<div class="user-page"><div class="user-info"><span class="user-nickname">可见昵称</span><span class="user-desc">可见简介</span><span class="user-redId">小红书号：user123</span><span class="user-IP">IP属地：上海</span><div class="data-info"><div><span class="count">12</span><span class="shows">关注</span></div><div><span class="count">3.4万</span><span class="shows">粉丝</span></div><div><span class="count">5.6万</span><span class="shows">获赞与收藏</span></div></div></div><div class="reds-tab-item sub-tab-list active">笔记</div><div class="reds-tab-item sub-tab-list">收藏</div><div class="reds-tab-item sub-tab-list">点赞</div><div class="note-list">${notes}</div></div>`
}

beforeEach(async () => {
  vi.resetModules()
  tools = (await import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-profile')).xiaohongshuProfileTools
  vi.useFakeTimers()
  assign.mockReset()
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  setPage('/explore')
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete stateWindow.__INITIAL_STATE__
  document.body.innerHTML = ''
})

describe('Xiaohongshu home feed and profile', () => {
  it('reads only visible home cards and enriches their links by exact ID', async () => {
    document.body.innerHTML = card()
    stateWindow.__INITIAL_STATE__ = {
      feed: { feeds: { value: [
        { id: otherId, modelType: 'note', xsecToken: 'wrong-token', noteCard: { displayTitle: 'Visible card' } },
        { id: noteId, modelType: 'note', xsecToken: 'correct-token' },
      ] } },
    }
    const result = await call('xhs_list_feeds')
    expect(result.status).toBe('ok')
    expect(result.data).toMatchObject({ loaded_count: 1, returned_count: 1, results_scope: 'currently_loaded' })
    expect(result.data!.items[0]).toMatchObject({ title: 'Visible card', author: 'Visible author', visible_metrics: { likes_text: '1.2万' } })
    expect(new URL(result.data!.items[0].note_url).searchParams.get('xsec_token')).toBe('correct-token')
  })

  it('keeps signed DOM card links without borrowing a token from a different ID', async () => {
    document.body.innerHTML = card(noteId, 'page-token')
    stateWindow.__INITIAL_STATE__ = { feed: { feeds: [{ id: otherId, xsecToken: 'wrong-token' }] } }
    const result = await call('xhs_list_feeds')
    expect(result.data!.items[0].note_url).toBe(`${origin}/explore/${noteId}?xsec_token=page-token&extra=keep`)
  })

  it('reports a missing feed DOM as timeout even when hidden state contains cards', async () => {
    stateWindow.__INITIAL_STATE__ = { feed: { feeds: [{ id: noteId, xsecToken: 'invisible', noteCard: { displayTitle: 'Do not expose me' } }] } }
    const pending = call('xhs_list_feeds')
    await vi.advanceTimersByTimeAsync(10250)
    expect((await pending).error_code).toBe('PAGE_TIMEOUT')
  })

  it('waits for visible cards to arrive rather than returning a premature empty list', async () => {
    const pending = call('xhs_list_feeds')
    setTimeout(() => { document.body.innerHTML = card() }, 500)
    await vi.advanceTimersByTimeAsync(750)
    expect((await pending).data).toMatchObject({ loaded_count: 1, is_empty: false })
  })

  it('requires the home route and provides an explicit same-tab navigation tool', async () => {
    setPage('/search_result?keyword=test')
    expect((await call('xhs_list_feeds')).error_code).toBe('NOT_FEED_PAGE')
    const result = await call('xhs_open_home')
    expect(result.target_url).toBe(`${origin}/explore`)
    await vi.advanceTimersByTimeAsync(150)
    expect(assign).toHaveBeenCalledWith(`${origin}/explore`)
  })

  it.each([
    `https://evil.example/user/profile/${userId}`,
    `http://www.xiaohongshu.com/user/profile/${userId}`,
    `https://user:password@www.xiaohongshu.com/user/profile/${userId}`,
    `https://www.xiaohongshu.com:444/user/profile/${userId}`,
    `https://www.xiaohongshu.com:443/user/profile/${userId}`,
    `${origin}/explore/${noteId}`,
    `${origin}/user/profile/a`,
  ])('rejects unsafe profile target %s', async (profileUrl) => {
    expect((await call('xhs_open_profile', { profile_url: profileUrl })).error_code).toBe('INVALID_TARGET')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves caller query parameters and clicks the matching visible user link in this tab', async () => {
    const bare = `${origin}/user/profile/${userId}?extra=keep`
    document.body.innerHTML = `<a target="_blank" href="${origin}/user/profile/${userId}?xsec_token=page-token&xsec_source=pc_note">Author</a>`
    const link = document.querySelector<HTMLAnchorElement>('a')!
    const onClick = vi.fn((event: MouseEvent) => {
      event.preventDefault()
      const url = new URL(link.href)
      expect(url.searchParams.get('extra')).toBe('keep')
      expect(url.searchParams.get('xsec_token')).toBe('page-token')
      expect(link.target).toBe('_self')
    })
    link.addEventListener('click', onClick)
    expect((await call('xhs_open_profile', { profile_url: bare })).data?.navigation_method).toBe('page_click')
    await vi.advanceTimersByTimeAsync(150)
    expect(onClick).toHaveBeenCalledOnce()
    expect(assign).not.toHaveBeenCalled()
    expect(link.target).toBe('_blank')
  })

  it('reads visible profile fields and only the selected tab state for access parameters', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    stateWindow.__INITIAL_STATE__ = { user: {
      activeTab: { value: { index: 0, query: 'note' } },
      notes: { value: [[{ id: noteId, xsecToken: 'correct-token' }], [{ id: noteId, xsecToken: 'wrong-token' }]] },
      userPageData: { value: { basicInfo: { nickname: 'Invisible nickname', desc: 'Invisible description' } } },
    } }
    const result = await call('xhs_read_profile', { limit: 1 })
    expect(result.data).toMatchObject({ nickname: '可见昵称', description: '可见简介', red_id_text: '小红书号：user123', location_text: 'IP属地：上海', profile_tab: 'notes', profile_scope: 'visible_dom', visible_metrics: { following_text: '12', followers_text: '3.4万', likes_and_favorites_text: '5.6万' } })
    expect(new URL(result.data!.items[0].note_url).searchParams.get('xsec_token')).toBe('correct-token')
    expect(result.data).toMatchObject({ userBasicInfo: null, interactions: null, profile_fields_scope: 'unavailable', profile_state_match: 'nickname_mismatch' })
  })

  it('returns the upstream profile state contract alongside independent DOM fields', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    const basicInfo = { gender: 0, nickname: '可见昵称', desc: '状态简介', redId: 'user123', ipLocation: '上海',
      imageb: 'https://example.com/large.jpg', images: 'https://example.com/small.jpg' }
    const interactions = [{ type: 'follows', name: '关注', count: '12' }, { type: 'fans', name: '粉丝', count: '34001' }, { type: 'interaction', name: '获赞与收藏', count: '56002' }]
    stateWindow.__INITIAL_STATE__ = { user: { userPageData: { _value: { basicInfo, interactions } } } }
    const response = await call('xhs_read_profile', { limit: 1 })
    expect(response.status).toBe('ok')
    expect(response.data).toMatchObject({ nickname: '可见昵称', description: '可见简介',
      userBasicInfo: basicInfo, interactions, profile_fields_scope: 'current_profile_page_state', profile_state_match: 'matched',
      profile_match_basis: 'visible_red_id_and_nickname', profile_fields_partial: false,
      visible_metrics: { followers_text: '3.4万', likes_and_favorites_text: '5.6万' }, returned_count: 1 })
    expect(response.data!.interactions).toHaveLength(3)
  })

  it('rejects another profile ID in cached state even when the visible nickname matches', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    stateWindow.__INITIAL_STATE__ = { user: { userPageData: { value: { userId: otherId,
      basicInfo: { nickname: '可见昵称', redId: 'user123', desc: 'Cached other profile' }, interactions: [{ type: 'fans', name: '粉丝', count: '999999' }] } } } }
    const response = await call('xhs_read_profile')
    expect(response.data).toMatchObject({ userBasicInfo: null, interactions: null, profile_state_match: 'profile_id_mismatch', profile_fields_partial: true })
    expect(response.data!.description).toBe('可见简介')
  })

  it('does not invent missing profile fields or an unknown selected tab', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = `<div class="user-profile"><span class="user-nickname">Visible name</span>${card()}</div>`
    stateWindow.__INITIAL_STATE__ = { user: { userPageData: { basicInfo: { desc: 'Hidden bio', redId: 'hidden-id' }, interactions: [{ type: 'fans', count: 123 }] } } }
    const result = await call('xhs_read_profile')
    expect(result.data).toMatchObject({ nickname: 'Visible name', description: null, red_id_text: null, location_text: null, profile_tab: null, visible_metrics: { following_text: null, followers_text: null, likes_and_favorites_text: null } })
    expect(result.data).toMatchObject({ userBasicInfo: null, interactions: null, profile_state_match: 'identity_unverified' })
  })

  it('distinguishes an explicit empty profile from missing cards', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile('<div class="empty-notes">还没有发布笔记</div>')
    const pending = call('xhs_read_profile')
    await vi.advanceTimersByTimeAsync(1250)
    expect((await pending).data).toMatchObject({ items: [], is_empty: true })
    document.querySelector('.empty-notes')!.remove()
    const missing = call('xhs_read_profile')
    await vi.advanceTimersByTimeAsync(10250)
    expect((await missing).error_code).toBe('PAGE_TIMEOUT')
  })

  it('keeps selected-tab verification separate from observing a results refresh', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('.sub-tab-list'))
    stateWindow.__INITIAL_STATE__ = { user: {
      activeTab: { value: { index: 0, query: 'note' } },
      notes: { value: [[{ id: noteId, xsecToken: 'correct-token' }]] },
    } }
    tabs[1].addEventListener('click', () => {
      tabs[0].classList.remove('active')
      tabs[1].classList.add('active')
    })
    const pending = call('xhs_select_profile_tab', { tab: 'favorites' })
    await vi.advanceTimersByTimeAsync(3150)
    expect((await pending).data).toMatchObject({ profile_tab: 'favorites', selection_verified: true, results_refresh_observed: false })
    const read = call('xhs_read_profile')
    await vi.advanceTimersByTimeAsync(10250)
    expect((await read).error_code).toBe('PROFILE_RESULTS_PENDING')
  })

  it('observes new cards after selecting a visible profile tab', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('.sub-tab-list'))
    tabs[2].addEventListener('click', () => {
      tabs[0].classList.remove('active')
      tabs[2].setAttribute('aria-selected', 'true')
      document.querySelector('.note-list')!.innerHTML = card(otherId, 'new-token')
    })
    const pending = call('xhs_select_profile_tab', { tab: 'liked' })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).data).toMatchObject({ profile_tab: 'liked', selection_verified: true, results_refresh_observed: true, results_ready: true })
    expect((await call('xhs_read_profile')).data!.items[0].note_url).toContain(otherId)
  })

  it('reports unavailable or unconfirmed tabs without claiming their content is empty', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    document.querySelectorAll('.sub-tab-list')[2].remove()
    expect((await call('xhs_select_profile_tab', { tab: 'liked' })).error_code).toBe('PROFILE_TAB_UNAVAILABLE')
    const pending = call('xhs_select_profile_tab', { tab: 'favorites' })
    await vi.advanceTimersByTimeAsync(3150)
    expect((await pending).error_code).toBe('PROFILE_TAB_NOT_APPLIED')
  })

  it('separates unavailable and logged-out states from loading errors', async () => {
    setPage('/404')
    expect((await call('xhs_read_profile')).error_code).toBe('PROFILE_UNAVAILABLE')
    setPage(`/user/profile/${userId}`)
    stateWindow.__INITIAL_STATE__ = { user: { userInfo: { guest: true } } }
    expect((await call('xhs_read_profile')).error_code).toBe('LOGIN_REQUIRED')
  })

  it('exposes a complete visible author profile URL for the next tool step', async () => {
    document.body.innerHTML = card()
    const authorUrl = `${origin}/user/profile/${userId}?xsec_token=user-token&xsec_source=pc_note`
    document.querySelector('.author')!.innerHTML = `<a href="${authorUrl}"><span class="name">Visible author</span></a>`
    expect((await call('xhs_list_feeds')).data!.items[0].author_profile_url).toBe(authorUrl)
  })

  it.each([0, 21, 1.5, null, true, '5'])('rejects invalid result limits %s', async (limit) => {
    expect((await call('xhs_list_feeds', { limit })).error_code).toBe('INVALID_LIMIT')
  })

  it('rejects a profile read if another profile opens during loading', async () => {
    setPage(`/user/profile/${userId}`)
    const pending = call('xhs_read_profile')
    setTimeout(() => {
      setPage(`/user/profile/${otherId}`)
      document.body.innerHTML = profile()
    }, 500)
    await vi.advanceTimersByTimeAsync(750)
    expect((await pending).error_code).toBe('PAGE_CHANGED')
  })

  it('does not treat a transient cleared list or loading new cards as completed tab results', async () => {
    setPage(`/user/profile/${userId}`)
    document.body.innerHTML = profile()
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('.sub-tab-list'))
    tabs[1].addEventListener('click', () => {
      tabs[0].classList.remove('active')
      tabs[1].classList.add('active')
      document.querySelector('.note-list')!.innerHTML = '<div class="loading">Loading</div>'
      setTimeout(() => { document.querySelector('.note-list')!.insertAdjacentHTML('beforeend', card(otherId)) }, 500)
    })
    const pending = call('xhs_select_profile_tab', { tab: 'favorites' })
    await vi.advanceTimersByTimeAsync(3150)
    expect((await pending).data?.results_ready).toBe(false)
    const read = call('xhs_read_profile')
    setTimeout(() => { document.querySelector('.loading')!.remove() }, 500)
    await vi.advanceTimersByTimeAsync(1750)
    expect((await read).data?.items[0].note_url).toContain(otherId)
  })
})
