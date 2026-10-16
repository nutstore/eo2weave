import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xiaohongshuCommentTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-comments'

const origin = 'https://www.xiaohongshu.com'
const noteId = '69e78d620000000021012b9b'
const otherId = '6abcd0b5000000001b01d831'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }

interface Comment {
  comment_id: string
  parent_comment_id: string | null
  id_source: string
  author: string | null
  text: string
}

interface Result {
  status: string
  error_code: string | null
  data: {
    comments: Comment[]
    total_comments_text: string | null
    loaded_parent_count: number
    loaded_reply_count: number
    loaded_count: number
    returned_count: number
    truncated: boolean
    end_of_comments_visible: boolean
    has_unexpanded_replies: boolean
    attempted_rounds: number
    added_count: number
    load_succeeded: boolean
    stop_reason: string
    elapsed_ms: number
  } | null
}

function setPage(id = noteId) {
  const url = new URL(`/explore/${id}`, origin)
  vi.stubGlobal('location', { href: url.href, hostname: url.hostname, pathname: url.pathname, search: '' })
}

function parent(id = 'p1', body = 'Parent body', replies = '') {
  return `<div class="parent-comment" data-comment-id="${id}">
    <div class="comment-item"><span class="user-name">Alice</span><div class="content">${body}</div><span class="date">Today</span></div>
    <div class="reply-container">${replies}</div>
  </div>`
}

function reply(id = 'r1', body = 'Reply body') {
  return `<div class="comment-item" data-comment-id="${id}"><span class="user-name">Bob</span><div class="content">${body}</div></div>`
}

function render(body: string, footer = '') {
  document.body.innerHTML = `<div class="note-scroller"><div class="comments-container"><div class="total">共 23 条评论</div>${body}${footer}</div></div>`
  const scroller = document.querySelector<HTMLElement>('.note-scroller')!
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 })
  return scroller
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return await tools[name](args) as Result
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  setPage()
  document.body.innerHTML = ''
  stateWindow.__INITIAL_STATE__ = { user: { userInfo: { guest: false, userId: 'test-user' } } }
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

describe('Xiaohongshu comment DOM reads', () => {
  it('reads parent/reply relationships and separates displayed total from loaded/returned counts', async () => {
    render(parent('p1', 'Parent body', reply()))
    const response = await call('xhs_read_comments', { limit: 1 })
    expect(response.status).toBe('ok')
    expect(response.data).toMatchObject({ total_comments_text: '共 23 条评论', loaded_parent_count: 1, loaded_reply_count: 1, loaded_count: 2, returned_count: 1, truncated: true })
    expect(response.data?.comments[0]).toMatchObject({ comment_id: 'p1', text: 'Parent body', parent_comment_id: null })
    const all = await call('xhs_read_comments')
    expect(all.data?.comments[1]).toMatchObject({ comment_id: 'r1', text: 'Reply body', parent_comment_id: 'p1' })
  })

  it('excludes nested reply text even when the parent content wraps the reply container', async () => {
    render('<div class="parent-comment" data-comment-id="p1"><span class="name">Alice</span><div class="content">Only parent<div class="reply-container"><div class="child-comment" data-comment-id="r1"><span class="name">Bob</span><div class="content">Only child</div></div></div></div></div>')
    const response = await call('xhs_read_comments')
    expect(response.data?.comments.map((comment) => comment.text)).toEqual(['Only parent', 'Only child'])
  })

  it('ignores comments outside the comments root and replies hidden by an ancestor', async () => {
    render(parent('p1', 'Shown', `<div style="display:none">${reply()}</div>`))
    document.body.insertAdjacentHTML('beforeend', parent('outside', 'Not a comment in this note'))
    const response = await call('xhs_read_comments')
    expect(response.data?.comments.map((comment) => comment.text)).toEqual(['Shown'])
  })

  it('deduplicates repeated DOM IDs and uses stable signatures for ID-less comments', async () => {
    render(parent('p1') + parent('p1') + parent('', 'No ID') + parent('', 'No ID'))
    const first = await call('xhs_read_comments')
    const second = await call('xhs_read_comments')
    expect(first.data?.loaded_count).toBe(2)
    expect(first.data?.comments[1].id_source).toBe('content_signature')
    expect(first.data?.comments).toEqual(second.data?.comments)
  })

  it('honors include_replies while retaining accurate current loaded counts', async () => {
    render(parent('p1', 'Parent body', reply()))
    const response = await call('xhs_read_comments', { include_replies: false })
    expect(response.data).toMatchObject({ loaded_count: 2, returned_count: 1, truncated: false })
    expect(response.data?.comments.every((comment) => comment.parent_comment_id === null)).toBe(true)
  })

  it('accepts an explicit empty state, but not an unrecognized empty container', async () => {
    render('', '<div class="no-comments-text">这是一片荒地</div>')
    expect((await call('xhs_read_comments')).data?.loaded_count).toBe(0)
    render('')
    expect((await call('xhs_read_comments')).error_code).toBe('COMMENTS_NOT_READY')
    document.body.innerHTML = '<div id="detail-title">Note title</div>'
    expect((await call('xhs_read_comments')).error_code).toBe('COMMENTS_UNSUPPORTED')
  })

  it('does not derive totals from expand-reply counts and reports missing totals as null', async () => {
    render(parent('p1', 'Parent body', '<div class="show-more">展开 99 条回复</div>'))
    document.querySelector('.total')?.remove()
    expect((await call('xhs_read_comments')).data?.total_comments_text).toBeNull()
  })

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.1 }, { include_replies: 'false' }])('rejects invalid read parameters %o', async (args) => {
    render(parent())
    expect((await call('xhs_read_comments', args)).status).toBe('error')
  })
})

describe('Xiaohongshu bounded comment loading', () => {
  it('observes newly loaded rows after scrolling, within the requested round count', async () => {
    const scroller = render(parent())
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
        setTimeout(() => document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2', 'New row')), 250)
      },
    })
    const pending = call('xhs_load_more_comments', { max_rounds: 1 })
    await vi.advanceTimersByTimeAsync(500)
    const response = await pending
    expect(response.data).toMatchObject({ loaded_count: 2, added_count: 1, attempted_rounds: 1, load_succeeded: true, stop_reason: 'round_limit' })
  })

  it('does not treat scrolling without additions as success or proof of completion', async () => {
    render(parent())
    const pending = call('xhs_load_more_comments', { max_rounds: 1 })
    await vi.advanceTimersByTimeAsync(4500)
    const response = await pending
    expect(response.data).toMatchObject({ added_count: 0, load_succeeded: false, stop_reason: 'no_new_comments', end_of_comments_visible: false, attempted_rounds: 1 })
  })

  it('only clicks recognized reply expansion controls in the comment container', async () => {
    render(parent('p1', 'Parent body', '<button class="show-more">展开 2 条回复</button><button class="show-more">回复</button><button class="show-more">点赞</button>'))
    document.body.insertAdjacentHTML('beforeend', '<button class="show-more">展开 2 条回复</button>')
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.show-more'))
    const clicks = buttons.map((button, index) => {
      const listener = vi.fn(() => {
        if (index === 0) button.insertAdjacentHTML('beforebegin', reply())
      })
      button.addEventListener('click', listener)
      return listener
    })
    const response = await call('xhs_load_more_comments', { max_rounds: 1, expand_replies: true })
    expect(response.data).toMatchObject({ added_count: 1, load_succeeded: true })
    expect(clicks[0]).toHaveBeenCalledOnce()
    clicks.slice(1).forEach((click) => expect(click).not.toHaveBeenCalled())
  })

  it('expands the four-reply label without depending on a parent-comment wrapper and excludes SVG labels', async () => {
    const scroller = render(parent('p1', '煮粥是怎么不扑锅的呀', reply('r1', '锅盖不要全盖住')),
      '<div class="show-more"><svg><title>svg</title></svg><span>展开</span> 4 条 <span>回复</span><span hidden>duplicate</span></div>')
    const button = document.querySelector<HTMLElement>('.show-more')!
    const scroll = vi.fn()
    button.scrollIntoView = scroll
    button.addEventListener('click', () => {
      document.querySelector('.reply-container')?.insertAdjacentHTML('beforeend', [2, 3, 4, 5].map((n) => reply(`r${n}`)).join(''))
      button.remove()
    })
    const response = await call('xhs_load_more_comments', { max_rounds: 2, expand_replies: true, limit: 20 })
    expect(response.status).toBe('ok')
    expect(scroll).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'instant' })
    expect(scroller.scrollTop).toBe(0)
    expect(response.data).toMatchObject({
      added_count: 4, loaded_reply_count: 5, attempted_rounds: 1, stop_reason: 'no_expand_controls',
      actions: ['expand_replies'],
      reply_expansion: { requested: true, clicked_count: 1, added_reply_count: 4, succeeded: true },
    })
    expect(response.data?.comments.filter((row) => row.parent_comment_id === 'p1')).toHaveLength(5)
  })

  it('reports missing expansion controls without silently falling back to list scrolling', async () => {
    const scroller = render(parent('p1', 'Parent body', '<button class="show-more">回复</button>'))
    const response = await call('xhs_load_more_comments', { expand_replies: true })
    expect(response.error_code).toBe('REPLY_EXPAND_UNAVAILABLE')
    expect(scroller.scrollTop).toBe(0)
    expect(response.data).toMatchObject({ attempted_rounds: 0, actions: [], load_succeeded: false,
      reply_expansion: { succeeded: false, clicked_count: 0, diagnostics: [{ controls: [{ text: '回复', recognized: false }] }] } })
  })

  it('does not click hidden or disabled reply controls', async () => {
    const scroller = render(parent('p1', 'Parent body', '<button class="show-more" disabled>展开 4 条回复</button><div hidden><button class="show-more">展开 4 条回复</button></div>'))
    const click = vi.spyOn(HTMLElement.prototype, 'click')
    expect((await call('xhs_load_more_comments', { expand_replies: true })).error_code).toBe('REPLY_EXPAND_UNAVAILABLE')
    expect(click).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(0)
  })

  it('does not click a control covered by another element after scrolling it into view', async () => {
    render(parent('p1', 'Parent body', '<div class="show-more">展开 4 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    const click = vi.spyOn(button, 'click')
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 30))
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body)
    const pending = call('xhs_load_more_comments', { expand_replies: true })
    await vi.advanceTimersByTimeAsync(300)
    const response = await pending
    expect(response.error_code).toBe('REPLY_EXPAND_CLICK_FAILED')
    expect(click).not.toHaveBeenCalled()
    expect(response.data).toMatchObject({ actions: [], reply_expansion: { succeeded: false, clicked_count: 0 } })
  })

  it('reports an ineffective expansion click instead of claiming it loaded replies', async () => {
    render(parent('p1', 'Parent body', '<div class="show-more">展开 4 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    // Loading another parent is not evidence of a successful reply expansion.
    button.addEventListener('click', () => document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2')))
    const pending = call('xhs_load_more_comments', { expand_replies: true, max_rounds: 1 })
    await vi.advanceTimersByTimeAsync(3000)
    const response = await pending
    expect(response.error_code).toBe('REPLY_EXPAND_NOT_OBSERVED')
    expect(response.data).toMatchObject({ actions: ['expand_replies'], added_count: 1, stop_reason: 'no_new_replies',
      reply_expansion: { clicked_count: 1, added_reply_count: 0, succeeded: false } })
  })

  it('keeps upstream default no-expansion behavior when expand_replies is omitted', async () => {
    const scroller = render(parent('p1', 'Parent body', '<div class="show-more">展开 4 条回复</div>'))
    const click = vi.spyOn(document.querySelector<HTMLElement>('.show-more')!, 'click')
    const pending = call('xhs_load_more_comments', { max_rounds: 1 })
    await vi.advanceTimersByTimeAsync(3000)
    const response = await pending
    expect(click).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(response.data).toMatchObject({ actions: ['scroll_changed'], reply_expansion: { requested: false, succeeded: false } })
  })

  it('reports explicit list end independently from still-collapsed replies', async () => {
    render(parent('p1', 'Parent body', '<div class="show-more">展开 2 条回复</div>'), '<div class="end-container">THE END</div>')
    const response = await call('xhs_load_more_comments')
    expect(response.data).toMatchObject({ end_of_comments_visible: true, has_unexpanded_replies: true, attempted_rounds: 0, stop_reason: 'end_of_list', load_succeeded: false })
  })

  it('waits for asynchronous replies at the parent-list end and can reuse an expand-more control', async () => {
    render(parent('p1', 'Parent body', '<div class="show-more">展开更多回复</div>'), '<div class="end-container">THE END</div>')
    const button = document.querySelector<HTMLElement>('.show-more')!
    let count = 0
    button.addEventListener('click', () => {
      const index = ++count
      setTimeout(() => button.insertAdjacentHTML('beforebegin', reply(`r${index}`, `Reply ${index}`)), 250)
    })
    const pending = call('xhs_load_more_comments', { max_rounds: 2, expand_replies: true })
    await vi.advanceTimersByTimeAsync(1000)
    const response = await pending
    expect(response.data).toMatchObject({ added_count: 2, attempted_rounds: 2, load_succeeded: true, stop_reason: 'round_limit', has_unexpanded_replies: true })
  })

  it('stops on navigation during the wait instead of reading comments from another note', async () => {
    render(parent())
    const pending = call('xhs_load_more_comments')
    setTimeout(() => { setPage(otherId); render(parent('other', 'Other note comment')) }, 250)
    await vi.advanceTimersByTimeAsync(500)
    const response = await pending
    expect(response.error_code).toBe('PAGE_CHANGED')
    expect(response.data).toBeNull()
  })

  it('stops when a login gate appears while loading', async () => {
    render(parent())
    const pending = call('xhs_load_more_comments')
    setTimeout(() => { stateWindow.__INITIAL_STATE__ = { user: { userInfo: { guest: true } } } }, 250)
    await vi.advanceTimersByTimeAsync(500)
    expect((await pending).error_code).toBe('LOGIN_REQUIRED')
  })

  it('reports a timeout when a visible loading indicator never resolves', async () => {
    render(parent(), '<div class="loading">Loading</div>')
    const pending = call('xhs_load_more_comments', { max_rounds: 1 })
    await vi.advanceTimersByTimeAsync(4500)
    expect((await pending).data?.stop_reason).toBe('timeout')
  })

  it('rejects unsupported scrolling rather than scrolling unrelated page elements', async () => {
    const scroller = render(parent())
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 200 })
    const response = await call('xhs_load_more_comments')
    expect(response.error_code).toBe('COMMENTS_SCROLL_UNSUPPORTED')
  })

  it.each([{ max_rounds: 0 }, { max_rounds: 501 }, { expand_replies: 'true' }, { limit: 101 }, { max_comment_items: '20' }, { reply_limit: 1.5 }, { scroll_speed: 'instant' }])('rejects unbounded or invalid loading arguments %o', async (args) => {
    render(parent())
    expect((await call('xhs_load_more_comments', args)).status).toBe('error')
  })
})

describe('Xiaohongshu upstream comment loading policy', () => {
  async function load(args: Record<string, unknown>) {
    const pending = call('xhs_load_more_comments', args)
    await vi.advanceTimersByTimeAsync(51_000)
    return pending
  }

  it('uses a cumulative parent target independently of returned rows and replies', async () => {
    const scroller = render(parent('p1', 'Parent', Array.from({ length: 25 }, (_, i) => reply(`r${i}`)).join('')))
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => {
      top = value
      if (!document.querySelector('[data-comment-id="p2"]')) document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2'))
    } })
    const response = await load({ max_comment_items: 2, limit: 1, max_rounds: 2 })
    expect(response.data).toMatchObject({ loaded_parent_count: 2, loaded_reply_count: 25, returned_count: 1,
      parent_target_reached: true, stop_reason: 'target_reached', added_parent_count: 1,
      loading_policy: { max_comment_items: 2, returned_limit: 1, mode: 'load_parent_comments' } })
    expect(scroller.scrollTop).toBeGreaterThan(0)
  })

  it('does not scroll when the cumulative parent target is already met', async () => {
    const scroller = render(parent('p1') + parent('p2'))
    const response = await call('xhs_load_more_comments', { max_comment_items: 2, limit: 1 })
    expect(scroller.scrollTop).toBe(0)
    expect(response.data).toMatchObject({ attempted_rounds: 0, parent_target_reached: true, returned_count: 1, stop_reason: 'target_reached' })
  })

  it('allows a website batch to overshoot the loading target without treating limit as the target', async () => {
    const scroller = render(parent())
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => 0, set: () => {
      if (!document.querySelector('[data-comment-id="p2"]')) document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2') + parent('p3') + parent('p4'))
    } })
    const response = await load({ max_comment_items: 2, limit: 1, max_rounds: 1 })
    expect(response.data).toMatchObject({ loaded_parent_count: 4, returned_count: 1, parent_target_reached: true, stop_reason: 'target_reached' })
  })

  it('skips reply buttons above the upstream default threshold, but expands smaller ones', async () => {
    render(parent('p1', 'Parent', '<div class="show-more">展开 11 条回复</div><div class="show-more">展开 4 条回复</div>'))
    const [large, small] = Array.from(document.querySelectorAll<HTMLElement>('.show-more'))
    const largeClick = vi.spyOn(large, 'click')
    small.addEventListener('click', () => small.insertAdjacentHTML('beforebegin', reply()))
    const response = await call('xhs_load_more_comments', { expand_replies: true, max_rounds: 1 })
    expect(largeClick).not.toHaveBeenCalled()
    expect(response.data).toMatchObject({ reply_expansion: { clicked_count: 1, skipped_by_reply_limit: 1, succeeded: true }, loading_policy: { reply_limit: 10 } })
  })

  it('reports threshold skips as policy decisions, without clicking or scrolling', async () => {
    const scroller = render(parent('p1', 'Parent', '<div class="show-more">展开 11 条回复</div>'))
    const click = vi.spyOn(document.querySelector<HTMLElement>('.show-more')!, 'click')
    const response = await call('xhs_load_more_comments', { expand_replies: true, reply_limit: 0 })
    expect(response.status).toBe('ok')
    expect(response.data).toMatchObject({ actions: [], stop_reason: 'reply_limit', reply_expansion: { succeeded: false, skipped_by_reply_limit: 1 } })
    expect(click).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(0)
  })

  it('honors an explicit larger reply threshold', async () => {
    render(parent('p1', 'Parent', '<div class="show-more">展开 11 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    button.addEventListener('click', () => button.insertAdjacentHTML('beforebegin', reply()))
    const response = await call('xhs_load_more_comments', { expand_replies: true, reply_limit: 11, max_rounds: 1 })
    expect(response.data).toMatchObject({ reply_expansion: { succeeded: true, skipped_by_reply_limit: 0 }, loading_policy: { reply_limit: 11 } })
  })

  it('retries scroll failures before dispatching a single successful expansion click', async () => {
    render(parent('p1', 'Parent', '<div class="show-more">展开 4 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    button.scrollIntoView = vi.fn().mockImplementationOnce(() => { throw new Error('transient') }).mockImplementationOnce(() => { throw new Error('transient') })
    button.addEventListener('click', () => button.insertAdjacentHTML('beforebegin', reply()))
    const response = await load({ expand_replies: true, max_rounds: 1 })
    expect(response.data).toMatchObject({ reply_expansion: { clicked_count: 1, succeeded: true }, retry_summary: { click_attempts: 3 } })
  })

  it('stops if the tab changes between click retries', async () => {
    render(parent('p1', 'Parent', '<div class="show-more">展开 4 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    button.scrollIntoView = vi.fn(() => { throw new Error('transient') })
    const click = vi.spyOn(button, 'click')
    setTimeout(() => setPage(otherId), 50)
    const response = await load({ expand_replies: true, max_rounds: 1 })
    expect(response.error_code).toBe('PAGE_CHANGED')
    expect(click).not.toHaveBeenCalled()
  })

  it('continues after a round with no new comments and observes later asynchronous parents', async () => {
    render(parent())
    setTimeout(() => document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2')), 3500)
    const response = await load({ max_comment_items: 2, max_rounds: 3 })
    expect(response.data).toMatchObject({ parent_target_reached: true, stop_reason: 'target_reached', loaded_parent_count: 2 })
    expect(response.data?.attempted_rounds).toBeGreaterThan(1)
  })

  it('combines expansion and parent loading only when a parent target is supplied', async () => {
    const scroller = render(parent('p1', 'Parent', '<div class="show-more">展开 4 条回复</div>'))
    const button = document.querySelector<HTMLElement>('.show-more')!
    button.addEventListener('click', () => { button.insertAdjacentHTML('beforebegin', reply()); button.remove() })
    let top = 0
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => {
      top = value
      if (!document.querySelector('[data-comment-id="p2"]')) document.querySelector('.comments-container')?.insertAdjacentHTML('beforeend', parent('p2'))
    } })
    const response = await load({ expand_replies: true, max_comment_items: 2, max_rounds: 3 })
    expect(response.data).toMatchObject({ actions: ['expand_replies', 'scroll_changed'], parent_target_reached: true, loaded_parent_count: 2,
      reply_expansion: { succeeded: true, added_reply_count: 1 }, loading_policy: { mode: 'load_parent_comments' } })
  })

  it('yields partial progress within the EO2 relay deadline', async () => {
    render(parent())
    const response = await load({ max_comment_items: 1000, max_rounds: 500 })
    expect(response.data).toMatchObject({ parent_target_reached: false, loading_partial: true, stop_reason: 'time_limit' })
    expect(response.data?.attempted_rounds).toBeLessThan(500)
    expect(response.data?.elapsed_ms).toBeLessThanOrEqual(50_000)
  })
})
