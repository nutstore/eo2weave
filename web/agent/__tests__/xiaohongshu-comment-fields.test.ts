import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xiaohongshuCommentTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-comments'
import { commentState, commentFields } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-comment-fields'
import { xiaohongshuRecipe } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu'

const id = '6aa50eba000000002b0246bc'
const other = '69e78d620000000021012b9b'
const origin = 'https://www.xiaohongshu.com'
const stateWindow = window as Window & { __INITIAL_STATE__?: unknown }
const user = { userId: 'user-id', nickname: 'Alice', nickName: null, avatar: 'https://cdn.example/avatar?sign=keep%2Bvalue' }
function source(commentId = 'p1', subComments: unknown[] = []) {
  return { id: commentId, noteId: id, content: `Body ${commentId}`, likeCount: '0', createTime: 1789202106000, ipLocation: '广东', liked: false, userInfo: user, subCommentCount: String(subComments.length), subComments, showTags: ['作者', '置顶'] }
}
function setState(list: unknown, cursor: unknown = 'next-cursor', hasMore: unknown = true) {
  stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: id }, comments: { list, cursor, hasMore } } } } }
}
function reply(replyId = 'r1', style = '') {
  return `<div class="comment-item" id="comment-${replyId}" style="${style}"><span class="user-name">Bob</span><div class="content">Body ${replyId}</div></div>`
}
function parent(replies = '', domId = 'comment-p1') {
  return `<div class="parent-comment"><div class="comment-item" id="${domId}"><span class="user-name">Alice</span><div class="content">Body p1</div><span class="date">Today</span><span class="like-count">0</span></div><div class="reply-container">${replies}</div></div>`
}
function render(html = parent()) {
  document.body.innerHTML = `<div class="note-scroller"><div class="comments-container">${html}</div></div>`
  const scroller = document.querySelector('.note-scroller')!
  Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true })
}
async function read(args: Record<string, unknown> = {}) {
  return await tools.xhs_read_comments(args) as { status: string; recipe_version: string; data: Record<string, any> }
}
beforeEach(() => {
  vi.stubGlobal('location', { href: `${origin}/explore/${id}`, hostname: 'www.xiaohongshu.com', pathname: `/explore/${id}`, search: '', origin })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
  render()
  delete stateWindow.__INITIAL_STATE__
})
afterEach(() => {
  document.body.innerHTML = ''
  delete stateWindow.__INITIAL_STATE__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('Xiaohongshu upstream comment fields', () => {
  it('identifies the executed recipe version on successful reads and errors', async () => {
    setState([source()])
    expect((await read()).recipe_version).toBe(xiaohongshuRecipe.version)
    vi.stubGlobal('location', { href: origin, hostname: 'www.xiaohongshu.com', pathname: '/', search: '', origin })
    const error = await tools.xhs_read_comments({}) as { status: string; recipe_version: string }
    expect(error.status).toBe('error')
    expect(error.recipe_version).toBe(xiaohongshuRecipe.version)
  })
  it('keeps new keys present with null values when comment state is unavailable', async () => {
    const result = await read()
    expect(result.data).toHaveProperty('cursor', null)
    expect(result.data).toHaveProperty('hasMore', null)
    expect(result.data).toHaveProperty('comment_state_scope', 'unavailable')
    const row = result.data.comments[0]
    for (const field of ['userInfo', 'likeCount', 'liked', 'createTime', 'ipLocation', 'subCommentCount', 'showTags']) expect(row).toHaveProperty(field, null)
    expect(row).toHaveProperty('fields_scope', 'unavailable')
    expect(row).toHaveProperty('state_match', 'not_found')
  })
  it('reads exact-ID fields with site DOM prefixes removed', async () => {
    setState([source()])
    const result = await read()
    expect(result.data.comments[0]).toMatchObject({ ...source(), comment_id: 'p1', id_source: 'dom', fields_scope: 'current_note_page_state', state_match: 'matched', sub_comments_scope: 'returned_visible_replies', sub_comments_partial: false })
    expect(result.data).toMatchObject({ cursor: 'next-cursor', hasMore: true, comment_state_scope: 'current_note_page_state', comment_state_partial: false })
  })
  it.each(['data-comment-id', 'data-id'])('normalizes the site prefix in %s attributes for parent and reply IDs', async (attribute) => {
    render(parent(reply()))
    document.querySelector('#comment-p1')!.setAttribute(attribute, 'comment-p1')
    document.querySelector('#comment-r1')!.setAttribute(attribute, 'comment-r1')
    setState([source('p1', [source('r1')])])
    const result = await read()
    expect(result.data.comments[0]).toMatchObject({ comment_id: 'p1', id: 'p1', state_match: 'matched' })
    expect(result.data.comments[1]).toMatchObject({ comment_id: 'r1', id: 'r1', parent_comment_id: 'p1', state_match: 'matched' })
  })
  it('normalizes a prefixed thread fallback ID', async () => {
    render(parent('', ''))
    document.querySelector('.parent-comment')!.setAttribute('data-comment-id', 'comment-p1')
    setState([source()])
    expect((await read()).data.comments[0]).toMatchObject({ comment_id: 'p1', id: 'p1', state_match: 'matched' })
  })
  it('keeps explicit string zero, false, timestamps and independent DOM text', async () => {
    setState([{ ...source(), content: 'State content', likeCount: '12', liked: true }])
    const row = (await read()).data.comments[0]
    expect(row).toMatchObject({ content: 'State content', text: 'Body p1', liked: true, likeCount: '12', likes_text: '0', createTime: 1789202106000, published_at: 'Today' })
  })
  it('returns null for unknown fields instead of zero or false', async () => {
    setState([{ id: 'p1' }])
    expect((await read()).data.comments[0]).toMatchObject({ id: 'p1', noteId: null, likeCount: null, liked: null, createTime: null, userInfo: null, showTags: null, subComments: null, sub_comments_partial: true })
  })
  it('does not merge a similarly worded state comment with a DOM row of another ID', async () => {
    setState([{ ...source('other-id'), content: 'Body p1' }])
    expect((await read()).data.comments[0]).toMatchObject({ comment_id: 'p1', id: null, state_match: 'not_found', fields_scope: 'unavailable' })
  })
  it('does not turn a signature into a server ID or correlate by author/text', async () => {
    render(parent('', ''))
    setState([source()])
    const row = (await read()).data.comments[0]
    expect(row.comment_id).toMatch(/^signature:/)
    expect(row).toMatchObject({ id_source: 'content_signature', id: null, userInfo: null, state_match: 'no_dom_id' })
  })
  it('ignores another note map entry and rejects mismatching detail note IDs', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [other]: { note: { noteId: other }, comments: { list: [source()] } } } } }
    expect((await read()).data).toMatchObject({ comment_state_scope: 'unavailable', cursor: null, hasMore: null })
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { noteId: other }, comments: { list: [source()] } } } } }
    expect((await read()).data.comments[0].fields_scope).toBe('unavailable')
  })
  it('rejects a matching comment ID with the wrong noteId', async () => {
    setState([{ ...source(), noteId: other }])
    expect((await read()).data.comments[0]).toMatchObject({ id: null, state_match: 'note_mismatch', fields_scope: 'unavailable' })
  })
  it('does not index replies belonging to a wrong-note parent', async () => {
    render(parent(reply()))
    setState([{ ...source('p1', [{ id: 'r1' }]), noteId: other }])
    expect((await read()).data.comments[1]).toMatchObject({ id: null, state_match: 'not_found' })
  })
  it('rejects duplicate state IDs rather than arbitrarily choosing a record', async () => {
    setState([source(), { ...source(), userInfo: { nickname: 'Wrong' } }])
    const result = await read()
    expect(result.data.comments[0]).toMatchObject({ id: null, state_match: 'ambiguous_id' })
    expect(result.data.comment_state_partial).toBe(true)
  })
  it('keeps parent/reply metadata associated with the exact parent ID', async () => {
    render(parent(reply()))
    setState([source('p1', [{ ...source('r1'), userInfo: { ...user, nickname: 'Bob' } }])])
    const result = await read()
    expect(result.data).toMatchObject({ loaded_count: 2, returned_count: 2 })
    expect(result.data.comments[1]).toMatchObject({ id: 'r1', parent_comment_id: 'p1', fields_scope: 'current_note_page_state' })
    expect(result.data.comments[0].subComments[0]).toEqual(result.data.comments[1])
    expect(result.data.comments[0].sub_comments_partial).toBe(false)
  })
  it('rejects a reply attached to a different state parent', async () => {
    render(parent(reply()))
    setState([source(), source('p2', [source('r1')])])
    expect((await read()).data.comments[1]).toMatchObject({ id: null, state_match: 'parent_mismatch' })
  })
  it('does not leak hidden or unloaded state comments or replies', async () => {
    render(parent(reply() + reply('r2', 'display:none')))
    setState([source('p1', [source('r1'), source('r2'), source('r3')]), source('hidden-parent')])
    const result = await read()
    expect(result.data.loaded_count).toBe(2)
    expect(result.data.comments[0].subComments.map((row: any) => row.id)).toEqual(['r1'])
    expect(result.data.comments[0].sub_comments_partial).toBe(true)
    expect(JSON.stringify(result.data.comments)).not.toContain('hidden-parent')
    expect(JSON.stringify(result.data.comments)).not.toContain('Body r2')
  })
  it('does not enrich a reply beneath an ambiguous parent ID', async () => {
    render(parent(reply()))
    setState([source('p1', [source('r1')]), source('p1')])
    expect((await read()).data.comments[1]).toMatchObject({ id: null, state_match: 'parent_mismatch' })
  })
  it('honors limit without leaking excluded replies through subComments', async () => {
    render(parent(reply()))
    setState([source('p1', [source('r1')])])
    expect((await read({ limit: 1 })).data).toMatchObject({ returned_count: 1, loaded_count: 2, truncated: true, comments: [{ subComments: [], sub_comments_partial: true }] })
  })
  it('honors include_replies=false in both flat and nested outputs', async () => {
    render(parent(reply()))
    setState([source('p1', [source('r1')])])
    const result = await read({ include_replies: false })
    expect(result.data.comments).toHaveLength(1)
    expect(result.data.comments[0]).toMatchObject({ subComments: [], sub_comments_partial: true })
  })
  it('handles ref-wrapped lists, nested replies and tags', async () => {
    render(parent(reply()))
    setState({ value: [{ ...source(), subComments: { _value: [source('r1')] }, showTags: { value: ['作者'] } }] }, '', false)
    const result = await read()
    expect(result.data).toMatchObject({ cursor: '', hasMore: false, comment_state_partial: false })
    expect(result.data.comments[0]).toMatchObject({ showTags: ['作者'], subComments: [{ id: 'r1' }] })
  })
  it('does not coerce malformed pagination, timestamps or liked values', async () => {
    setState([{ ...source(), createTime: NaN, liked: 'false', showTags: ['作者', 1] }], 0, 'false')
    expect((await read()).data).toMatchObject({ cursor: null, hasMore: null, comments: [{ createTime: null, liked: null, showTags: null }] })
  })
  it('does not equate hasMore=false with all replies loaded', async () => {
    setState([source('p1', [source('r1')])], '', false)
    const result = await read()
    expect(result.data).toMatchObject({ hasMore: false, end_of_comments_visible: false })
    expect(result.data.comments[0]).toMatchObject({ subComments: [], sub_comments_partial: true })
  })
  it('retains pagination evidence even when the state list is unavailable', async () => {
    setState('invalid-list', 'known-cursor', false)
    expect((await read()).data).toMatchObject({ cursor: 'known-cursor', hasMore: false, comment_state_partial: true, comments: [{ id: null }] })
  })
  it('reads newly loaded reply fields from updated state without inflating DOM added_count', async () => {
    render(parent('<button class="show-more">展开1条回复</button>'))
    setState([source()])
    document.querySelector('button')!.addEventListener('click', () => {
      document.querySelector('.reply-container')!.innerHTML = reply()
      setState([source('p1', [source('r1')])])
    })
    const result = await tools.xhs_load_more_comments({ expand_replies: true, max_rounds: 1 }) as { data: Record<string, any> }
    expect(result.data).toMatchObject({ added_count: 1, loaded_count: 2, returned_count: 2, load_succeeded: true })
    expect(result.data.comments[1]).toMatchObject({ id: 'r1', fields_scope: 'current_note_page_state' })
  })
  it('bounds cyclic and oversized state traversal', () => {
    const cycle = source()
    cycle.subComments.push(cycle)
    setState([cycle])
    const state = commentState(stateWindow.__INITIAL_STATE__, id)
    expect(state.partial).toBe(true)
    expect(commentFields(state, 'p1', null, true).state_match).toBe('ambiguous_id')
    setState(Array.from({ length: 10001 }, (_, i) => ({ id: `id-${i}` })))
    expect(commentState(stateWindow.__INITIAL_STATE__, id).partial).toBe(true)
  })
})
