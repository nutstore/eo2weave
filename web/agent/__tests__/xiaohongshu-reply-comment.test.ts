import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const input = vi.hoisted(() => ({ click: vi.fn(), type: vi.fn(), scroll: vi.fn(), wheel: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input', () => ({
  clickWithCdp: input.click, insertWithCdp: input.type, scrollIntoViewWithCdp: input.scroll, scrollWheelWithCdp: input.wheel,
}))
import { xiaohongshuReplyCommentTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-reply-comment'

const id = '69e78d620000000021012b9b', other = '69e78d620000000021012b9c'
const args = { feed_id: id, xsec_token: 'test-token', comment_id: 'target', content: '回复测试\n保留原文😀' }
const assign = vi.fn()
type Result = { status: string; error_code: string | null; target_url?: string; data: Record<string, any> }
const row = (id = 'target', user = 'target-user') => `<div class="parent-comment"><div class="comment-item" id="comment-${id}"><a data-user-id="${user}"></a><div class="right"><div class="interactions"><span class="reply">回复</span></div></div></div></div>`
function page(path = `/explore/${id}`) {
  const url = new URL(path, 'https://www.xiaohongshu.com')
  vi.stubGlobal('location', { href: url.href, hostname: url.hostname, pathname: url.pathname, origin: url.origin, search: url.search, assign })
}
function rendered(text: string, index = 0) {
  // Supply the rendered browser observation: happy-dom drops BR line breaks.
  Object.defineProperty(document.querySelectorAll('.comments-container')[index], 'innerText', { configurable: true, value: text })
}
async function call(values: Record<string, unknown> = args) {
  const pending = tools.xhs_reply_comment_in_feed(values)
  await vi.runAllTimersAsync()
  return await pending as Result
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 20, 100, 30)] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 20, 100, 30))
  page()
  document.body.innerHTML = `<div class="note-scroller"><div class="comments-container">${row()}</div></div><div class="input-box"><div class="content-edit"><p class="content-input" contenteditable="true">已有输入</p></div></div><div class="bottom"><button class="submit">发送</button></div>`
  input.type.mockImplementation(async (element, text) => { element.textContent += text })
  input.click.mockImplementation(async (element) => { if (element.matches('button.submit')) rendered(args.content) })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('upstream ReplyToComment in the current tab', () => {
  it('selects the ID before user fallback and submits through the upstream reply controls', async () => {
    document.querySelector('.comments-container')!.insertAdjacentHTML('afterbegin', row('another', 'other-user'))
    const response = await call({ ...args, user_id: 'other-user' })
    expect(input.click.mock.calls[0][0]).toBe(document.querySelector('#comment-target .reply'))
    expect(input.click.mock.calls.map(([element]) => element.className)).toEqual(['reply', 'submit'])
    expect(input.type).toHaveBeenCalledWith(document.querySelector('p.content-input'), args.content)
    expect(document.querySelector('p.content-input')!.textContent).toBe('已有输入' + args.content)
    expect(input.scroll).toHaveBeenCalledWith(document.querySelector('#comment-target'))
    expect(input.wheel.mock.calls[0]).toEqual([100, document.querySelector('.note-scroller')])
    expect(response).toMatchObject({ status: 'ok', data: { phase: 'completed', matched_by: 'comment_id', matched_comment_id: 'target', target_user_id: 'other-user', submission_attempted: true, success: true, comment_rendered: true, text_present_before_submit: false, new_comment_id: null, author_verified: null, reply_relationship_verified: null } })
    expect(assign).not.toHaveBeenCalled()
  })
  it.each([undefined, 'missing'])('uses the first user-ID match when comment_id is %s', async (comment_id) => {
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', row('second', 'target-user'))
    const response = await call({ ...args, comment_id, user_id: 'target-user' })
    expect(response).toMatchObject({ status: 'ok', data: { matched_by: 'user_id', matched_comment_id: 'target' } })
    expect(input.click.mock.calls[0][0]).toBe(document.querySelector('#comment-target .reply'))
  })
  it('keeps upstream descendant matching for user fallback and reports the limitation', async () => {
    document.querySelector('#comment-target [data-user-id]')!.setAttribute('data-user-id', 'parent-user')
    document.querySelector('#comment-target')!.insertAdjacentHTML('beforeend', '<div class="comment-item" id="comment-child"><a data-user-id="child-user"></a></div>')
    const response = await call({ ...args, comment_id: undefined, user_id: 'child-user' })
    expect(response).toMatchObject({ data: { matched_by: 'user_id', matched_comment_id: 'target' } })
    expect(response.data.verification_limitations).toContain('including descendants')
  })
  it('expands a nearby nested reply even when its label count is above the batch-reading threshold', async () => {
    document.querySelector('#comment-target')!.remove()
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<span class="show-more">展开 99 条回复</span>')
    input.click.mockImplementation(async (element) => {
      if (element.matches('.show-more')) { element.remove(); document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', row()) }
      if (element.matches('.submit')) rendered(args.content)
    })
    expect(await call()).toMatchObject({ status: 'ok', data: { search: { expanded_controls: 1, scroll_attempts: 0 } } })
    expect(input.click.mock.calls.map(([el]) => el.className)).toEqual(['show-more', 'reply', 'submit'])
  })
  it('loads a target through downward wheel events after the initial 100-pixel activation', async () => {
    document.querySelector('.parent-comment')!.remove()
    input.wheel.mockImplementation(async () => {
      if (input.wheel.mock.calls.length === 2) document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', row())
    })
    expect(await call()).toMatchObject({ status: 'ok', data: { search: { scroll_attempts: 1 } } })
    const deltas = input.wheel.mock.calls.map(([delta]) => delta)
    expect(deltas[0]).toBe(100); expect(deltas[1]).toBeGreaterThanOrEqual(100)
    expect(input.click.mock.calls.filter(([el]) => el.matches('.submit'))).toHaveLength(1)
  })
  it('uses the upstream viewport-center wheel fallback when both scrollers lack a shape', async () => {
    vi.mocked(HTMLElement.prototype.getClientRects).mockReturnValue([] as unknown as DOMRectList)
    expect(await call()).toMatchObject({ status: 'ok' })
    expect(input.wheel.mock.calls[0]).toEqual([100, undefined])
  })
  it('stops at THE END without typing or submitting', async () => {
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<div class="end-container"> theend </div>')
    expect(await call({ ...args, comment_id: 'missing' })).toMatchObject({ error_code: 'COMMENT_NOT_FOUND', data: { submission_attempted: false, search: { stop_reason: 'end_container', scroll_attempts: 1 } } })
    expect(input.type).not.toHaveBeenCalled(); expect(input.click).not.toHaveBeenCalled()
  })
  it('stops after ten unchanged parent-count checks, without interpreting replies as parents', async () => {
    document.querySelector('.parent-comment')!.remove()
    expect(await call({ ...args, comment_id: undefined, user_id: 'missing' })).toMatchObject({ error_code: 'COMMENT_NOT_FOUND', data: { search: { stop_reason: 'stagnation', stagnant_checks: 10, scroll_attempts: 10 } } })
    expect(input.type).not.toHaveBeenCalled()
  })
  it('limits consecutive successful expansion rounds to five before checking the end marker', async () => {
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<span class="show-more">展开更多回复</span><div class="end-container">THE END</div>')
    const response = await call({ ...args, comment_id: 'missing' })
    expect(response).toMatchObject({ error_code: 'COMMENT_NOT_FOUND', data: { search: { expanded_controls: 5, scroll_attempts: 1, stop_reason: 'end_container' } } })
    expect(input.click).toHaveBeenCalledTimes(5); expect(input.type).not.toHaveBeenCalled()
  })
  it('retries only the upstream expansion click up to three times', async () => {
    document.querySelector('#comment-target')!.remove()
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<span class="show-more">展开 2 条回复</span>')
    let tries = 0
    input.click.mockImplementation(async (el) => {
      if (el.matches('.show-more')) {
        if (++tries < 3) throw new Error('temporary overlap')
        el.remove(); document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', row())
      }
      if (el.matches('.submit')) rendered(args.content)
    })
    expect(await call()).toMatchObject({ status: 'ok' }); expect(tries).toBe(3)
    expect(input.click.mock.calls.filter(([el]) => el.matches('.submit'))).toHaveLength(1)
  })
  it.each(['展开 2 条评论', '展开 2 条 回复', '阅读全文'])('skips non-upstream expansion label %s', async (label) => {
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', `<span class="show-more">${label}</span><div class="end-container">THE END</div>`)
    expect(await call({ ...args, comment_id: 'missing' })).toMatchObject({ error_code: 'COMMENT_NOT_FOUND' })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('stops after 25 down-scroll attempts even when parent counts keep growing', async () => {
    document.querySelector('.parent-comment')!.remove()
    document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<div class="end-container"></div>')
    input.wheel.mockImplementation(async () => { document.querySelector('.comments-container')!.insertAdjacentHTML('beforeend', '<div class="parent-comment"></div>') })
    const response = await call({ ...args, comment_id: undefined, user_id: 'missing' })
    expect(response).toMatchObject({ error_code: 'COMMENT_NOT_FOUND', data: { search: { stop_reason: 'scroll_limit', scroll_attempts: 25 } } })
    expect(input.type).not.toHaveBeenCalled()
  })
  it('honors the upstream 90-second search deadline with many nonmatching user rows', async () => {
    document.querySelector('.comments-container')!.innerHTML = Array.from({ length: 40 }, (_, index) => row(`other-${index}`, 'someone-else')).join('')
    const response = await call({ ...args, comment_id: undefined, user_id: 'missing' })
    expect(response).toMatchObject({ error_code: 'COMMENT_NOT_FOUND', data: { search: { stop_reason: 'search_timeout' } } })
    expect(response.data.search.elapsed_ms).toBeGreaterThan(90_000)
    expect(input.type).not.toHaveBeenCalled()
  })
  it('does not equate a successful send click with a confirmed reply', async () => {
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'REPLY_NOT_CONFIRMED', data: { submission_attempted: true, success: false, comment_rendered: false, phase: 'verifying' } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('polls for delayed reply text using the four-second window', async () => {
    input.click.mockImplementation(async (el) => { if (el.matches('.submit')) setTimeout(() => rendered(args.content), 3200) })
    expect(await call()).toMatchObject({ status: 'ok', data: { comment_rendered: true } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('reports a pre-existing substring match while retaining upstream success criteria', async () => {
    rendered('prefix ' + args.content + ' suffix'); input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ status: 'ok', data: { text_present_before_submit: true, success_scope: 'upstream_rendered_text_check', new_comment_verified: null, reply_relationship_verified: null } })
  })
  it('checks only the first comment container', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="comments-container"></div>'); rendered(args.content, 1)
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'REPLY_NOT_CONFIRMED' })
  })
  it('reports uncertain delivery when the send click fails without retrying', async () => {
    input.click.mockImplementation(async (el) => { if (el.matches('.submit')) throw new Error('Debugger detached after press') })
    expect(await call()).toMatchObject({ error_code: 'REPLY_ACTION_FAILED', data: { phase: 'submitting', submission_attempted: null, comment_rendered: null, success: null } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('reports a page change while searching before a reply can be submitted', async () => {
    input.wheel.mockImplementation(async () => page(`/explore/${other}`))
    expect(await call()).toMatchObject({ error_code: 'PAGE_CHANGED', data: { submission_attempted: false } })
    expect(input.type).not.toHaveBeenCalled()
  })
  it('yields navigation without replying and resumes after target discovery', async () => {
    page(`/explore/${other}`)
    const response = await call()
    expect(response).toMatchObject({ status: 'navigated', data: { submission_attempted: false } })
    expect(new URL(response.target_url!).searchParams.get('xsec_source')).toBe('pc_feed')
    expect(input.click).not.toHaveBeenCalled(); expect(input.wheel).not.toHaveBeenCalled()
    page(); expect(await call()).toMatchObject({ status: 'ok' })
  })
  it.each(['feed_id', 'xsec_token', 'content'])('requires upstream nonempty %s', async (key) => {
    expect(await call({ ...args, [key]: '' })).toMatchObject({ error_code: 'INVALID_ARGUMENT' })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('requires at least one target identifier', async () => {
    expect(await call({ ...args, comment_id: undefined })).toMatchObject({ error_code: 'INVALID_ARGUMENT' })
    expect(input.wheel).not.toHaveBeenCalled()
  })
  it('does not trim or cap reply content', async () => {
    const content = '  \n' + '长'.repeat(5000) + '\n  '
    input.click.mockImplementation(async (el) => { if (el.matches('.submit')) rendered(content) })
    expect(await call({ ...args, content })).toMatchObject({ status: 'ok', data: { content } })
    expect(input.type.mock.calls[0][1]).toBe(content)
  })
  it('returns inaccessible-page text without guessing an account restriction', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div class="access-wrapper">当前笔记暂时无法浏览</div>')
    expect(await call()).toMatchObject({ error_code: 'NOTE_UNAVAILABLE', data: { site_error_message: '当前笔记暂时无法浏览', submission_attempted: false } })
    expect(input.click).not.toHaveBeenCalled()
  })
})
