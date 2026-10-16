import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xiaohongshuToolImplementations as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-tools'
import { xiaohongshuRecipe } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu'

const origin = 'https://www.xiaohongshu.com'
const noteId = '69e78d620000000021012b9b'
const otherId = '6abcd0b5000000001b01d831'
const bareUrl = `${origin}/explore/${noteId}`
const signedUrl = `${origin}/search_result/${noteId}?xsec_token=example-token&xsec_source=pc_search&extra=keep`
const assign = vi.fn()
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }

interface Result {
  status: string
  error_code: string | null
  page_kind: string
  target_url?: string
  data: {
    items?: Array<{ note_url: string | null }>
    navigation_method?: string
    site_error_code?: string | null
    site_error_message?: string | null
    title?: string | null
    note_id?: string | null
  } | null
}

function setPage(path: string) {
  const url = new URL(path, origin)
  vi.stubGlobal('location', {
    href: url.href,
    origin: url.origin,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    assign,
  })
}

function setFeeds(feeds: Array<{ id: string; xsecToken: string; title?: string }>) {
  stateWindow.__INITIAL_STATE__ = {
    search: {
      feeds: {
        value: feeds.map((feed) => ({
          id: feed.id,
          xsecToken: feed.xsecToken,
          modelType: 'note',
          noteCard: { displayTitle: feed.title ?? 'Same title', type: 'normal' },
        })),
      },
    },
  }
}

function renderCard(links: string) {
  document.body.innerHTML = `<section class="note-item">${links}<span class="title">Same title</span></section>`
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return await tools[name](args) as Result
}

beforeEach(() => {
  vi.useFakeTimers()
  assign.mockReset()
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  setPage('/search_result?keyword=test')
  // happy-dom does not calculate layout; CSS still controls hidden elements.
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

describe('Xiaohongshu note navigation regressions', () => {
  it('registers every implemented tool and marks account logout as non-read-only', () => {
    expect(xiaohongshuRecipe.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(tools).sort())
    expect(xiaohongshuRecipe.tools).toHaveLength(21)
    expect(xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_logout')?.readOnlyHint).toBe(false)
    expect(xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_post_comment_to_feed')?.readOnlyHint).toBe(false)
    expect(xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_reply_comment_in_feed')?.readOnlyHint).toBe(false)
    expect(xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_like_feed')?.readOnlyHint).toBe(false)
    expect(xiaohongshuRecipe.version).toBe('0.7.4')
  })

  it('returns a visible complete author profile link so the agent can continue to the profile', async () => {
    setPage(`/explore/${noteId}`)
    const profileUrl = `${origin}/user/profile/${otherId}?xsec_token=profile-token&xsec_source=pc_note`
    document.body.innerHTML = `<div class="author-container"><a href="${profileUrl}"><span class="username">Author</span></a></div><div id="detail-title">Note</div>`
    const response = await tools.xhs_read_current_note({}) as { data: Record<string, unknown> }
    expect(response.data.author_profile_url).toBe(profileUrl)
  })

  it('opens a rendered home card in the same tab using its complete source URL', async () => {
    setPage('/explore')
    renderCard(`<a href="${signedUrl}" target="_blank">Cover</a>`)
    const link = document.querySelector('a')!
    let target: string | null = null
    link.addEventListener('click', (event) => { event.preventDefault(); target = link.getAttribute('target') })
    const response = await call('xhs_open_note', { note_url: signedUrl })
    expect(response.status).toBe('navigated')
    await vi.advanceTimersByTimeAsync(200)
    expect(target).toBe('_self')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(assign).not.toHaveBeenCalled()
  })

  it('keeps the complete interactive URL when a bare SEO link comes first', async () => {
    renderCard(`<a style="display:none" href="${bareUrl}"></a><a href="${signedUrl}">Cover</a>`)

    const result = await call('xhs_list_search_results', { limit: 3 })

    expect(result.status).toBe('ok')
    expect(result.data?.items?.[0].note_url).toBe(signedUrl)
  })

  it('enriches a bare link only from the exact note ID, preserving existing query parameters', async () => {
    renderCard(`<a href="${bareUrl}?extra=keep">Cover</a>`)
    setFeeds([
      { id: otherId, xsecToken: 'wrong-token' },
      { id: noteId, xsecToken: 'right-token' },
    ])

    const result = await call('xhs_list_search_results')
    const url = new URL(result.data!.items![0].note_url!)

    expect(url.pathname).toBe(`/explore/${noteId}`)
    expect(url.searchParams.get('xsec_token')).toBe('right-token')
    expect(url.searchParams.get('xsec_source')).toBe('pc_search')
    expect(url.searchParams.get('extra')).toBe('keep')
  })

  it('does not borrow a token from another note with the same title', async () => {
    renderCard(`<a href="${bareUrl}">Cover</a>`)
    setFeeds([{ id: otherId, xsecToken: 'wrong-token' }])

    const result = await call('xhs_list_search_results')

    expect(result.data?.items?.[0].note_url).toBe(bareUrl)
  })

  it('uses the real card click in the same tab and can read the resulting search-note route', async () => {
    renderCard(`<a style="display:none" href="${bareUrl}"></a><a class="cover" target="_blank" href="${signedUrl}">Cover</a>`)
    const cover = document.querySelector<HTMLAnchorElement>('.cover')!
    const onClick = vi.fn((event: MouseEvent) => {
      event.preventDefault()
      expect(cover.target).toBe('_self')
      expect(cover.href).toBe(signedUrl)
      setPage(signedUrl)
      document.body.innerHTML = '<div class="note-scroller"><h1 id="detail-title">Opened note</h1><div id="detail-desc">Visible content</div></div>'
    })
    cover.addEventListener('click', onClick)

    const opened = await call('xhs_open_note', { note_url: bareUrl })
    expect(opened.status).toBe('navigated')
    expect(opened.data?.navigation_method).toBe('page_click')
    expect(opened.target_url).toBe(signedUrl)
    expect(onClick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)

    expect(onClick).toHaveBeenCalledOnce()
    expect(assign).not.toHaveBeenCalled()
    expect(cover.target).toBe('_blank')
    const read = await call('xhs_read_current_note')
    expect(read.status).toBe('ok')
    expect(read.data).toMatchObject({ title: 'Opened note', note_id: noteId })
  })

  it('supplies the complete state-backed URL to a bare card without discarding its click handler', async () => {
    renderCard(`<a href="${bareUrl}">Cover</a>`)
    setFeeds([{ id: noteId, xsecToken: 'right-token' }])
    const link = document.querySelector<HTMLAnchorElement>('.note-item a')!
    const onClick = vi.fn((event: MouseEvent) => {
      event.preventDefault()
      expect(new URL(link.href).searchParams.get('xsec_token')).toBe('right-token')
    })
    link.addEventListener('click', onClick)

    await call('xhs_open_note', { note_url: bareUrl })
    await vi.advanceTimersByTimeAsync(150)

    expect(onClick).toHaveBeenCalledOnce()
    expect(link.href).toBe(bareUrl)
    expect(assign).not.toHaveBeenCalled()
  })

  it('rejects a note that is absent from the current search results', async () => {
    renderCard(`<a href="${signedUrl}">Cover</a>`)

    const result = await call('xhs_open_note', { note_url: `${origin}/explore/${otherId}?xsec_token=other` })

    expect(result.error_code).toBe('STALE_RESULT')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not directly navigate an incomplete URL when there is no result card', async () => {
    setPage('/explore')

    const result = await call('xhs_open_note', { note_url: bareUrl })

    expect(result.error_code).toBe('NOTE_LINK_INCOMPLETE')
    expect(vi.getTimerCount()).toBe(0)
    expect(assign).not.toHaveBeenCalled()
  })

  it('preserves a complete URL when opening another note from a detail page', async () => {
    setPage(`/explore/${otherId}`)

    const result = await call('xhs_open_note', { note_url: signedUrl })
    expect(result.data?.navigation_method).toBe('url')
    await vi.advanceTimersByTimeAsync(150)

    expect(assign).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith(signedUrl)
  })

  it('classifies a redirected 404 as unavailable and retains the site error without inventing a cause', async () => {
    setPage('/404?error_code=300031&error_msg=Note%20cannot%20be%20viewed')

    const result = await call('xhs_read_current_note')

    expect(result.page_kind).toBe('unavailable')
    expect(result.error_code).toBe('NOTE_UNAVAILABLE')
    expect(result.data).toMatchObject({ site_error_code: '300031', site_error_message: 'Note cannot be viewed' })
  })

  it('rejects external and credential-bearing note URLs', async () => {
    setPage('/explore')
    for (const note_url of [`https://other.example/explore/${noteId}`, `https://name:secret@www.xiaohongshu.com/explore/${noteId}`]) {
      expect((await call('xhs_open_note', { note_url })).error_code).toBe('INVALID_TARGET')
    }
    expect(vi.getTimerCount()).toBe(0)
  })
})
