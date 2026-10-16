import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const input = vi.hoisted(() => ({ click: vi.fn(), type: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input', () => ({ clickWithCdp: input.click, insertWithCdp: input.type }))
import { xiaohongshuPostCommentTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-post-comment'

const id = '69e78d620000000021012b9b', other = '69e78d620000000021012b9c'
const args = { feed_id: id, xsec_token: 'test-token', content: '评论测试\n保留原文😀' }
const assign = vi.fn()
type Result = { status: string; error_code: string | null; target_url?: string; data: Record<string, unknown> }
function renderedComment(text: string, index = 0) {
  // happy-dom's innerText drops BR line breaks. Supply the browser's rendered
  // observation explicitly so multiline matching is tested without normalizing it.
  Object.defineProperty(document.querySelectorAll('.comments-container')[index], 'innerText', { configurable: true, value: text })
}
function page(path = `/explore/${id}`) {
  const url = new URL(path, 'https://www.xiaohongshu.com')
  vi.stubGlobal('location', { href: url.href, hostname: url.hostname, pathname: url.pathname, origin: url.origin, search: url.search, assign })
}
async function call(values: Record<string, unknown> = args) {
  const pending = tools.xhs_post_comment_to_feed(values)
  await vi.runAllTimersAsync()
  return await pending as Result
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  page()
  document.body.innerHTML = '<div class="note-scroller"></div><div class="input-box"><div class="content-edit"><span>说点什么</span><p class="content-input" contenteditable="true">已有输入</p></div></div><div class="bottom"><button class="submit">发送</button></div><div class="comments-container"></div>'
  input.type.mockImplementation(async (element, text) => { element.textContent += text })
  input.click.mockImplementation(async (element) => {
    if (element.matches('button.submit')) renderedComment(args.content)
  })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('upstream PostComment in the current tab', () => {
  it('uses the upstream selectors in order, preserves content and verifies rendered text', async () => {
    const response = await call()
    expect(input.click.mock.calls.map(([element]) => element.tagName)).toEqual(['SPAN', 'BUTTON'])
    expect(input.type).toHaveBeenCalledWith(document.querySelector('p.content-input'), args.content)
    expect(document.querySelector('p.content-input')!.textContent).toBe('已有输入' + args.content)
    expect(input.click.mock.invocationCallOrder[0]).toBeLessThan(input.type.mock.invocationCallOrder[0])
    expect(input.type.mock.invocationCallOrder[0]).toBeLessThan(input.click.mock.invocationCallOrder[1])
    expect(response).toMatchObject({ status: 'ok', data: { feed_id: id, content: args.content, success: true, comment_rendered: true, submission_attempted: true, text_present_before_submit: false, new_comment_id: null, new_comment_verified: null, author_verified: null } })
    expect(assign).not.toHaveBeenCalled()
  })
  it('does not treat input or sending as success when the comment never appears', async () => {
    input.click.mockResolvedValue(undefined)
    const response = await call()
    expect(response).toMatchObject({ status: 'error', error_code: 'COMMENT_NOT_CONFIRMED', data: { phase: 'verifying', submission_attempted: true, comment_rendered: false, success: false, verification_timeout_ms: 4000, verification_poll_ms: 300 } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('polls for a delayed rendered comment without another click', async () => {
    input.click.mockImplementation(async (element) => {
      if (element.matches('button.submit')) setTimeout(() => { renderedComment(args.content) }, 3200)
    })
    expect(await call()).toMatchObject({ status: 'ok', data: { comment_rendered: true } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('retains the upstream substring check and reports its pre-existing-text limitation', async () => {
    renderedComment('existing prefix ' + args.content + ' reply suffix')
    input.click.mockResolvedValue(undefined)
    const response = await call()
    expect(response).toMatchObject({ status: 'ok', data: { text_present_before_submit: true, success_scope: 'upstream_rendered_text_check', new_comment_verified: null } })
    expect(response.data.verification_limitations).toContain('pre-existing')
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('checks only the first comments container, as upstream does', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="comments-container"></div>')
    renderedComment(args.content, 1)
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'COMMENT_NOT_CONFIRMED' })
  })
  it('uses the first matching control without a uniqueness constraint', async () => {
    document.querySelector('.content-edit')!.insertAdjacentHTML('beforeend', '<span>第二个入口</span>')
    expect(await call()).toMatchObject({ status: 'ok' })
    expect(input.click.mock.calls[0][0]).toBe(document.querySelector('.content-edit span'))
  })
  it('yields target navigation without typing or submitting, then resumes on the target page', async () => {
    page(`/explore/${other}`)
    const opening = await call()
    expect(opening).toMatchObject({ status: 'navigated', data: { feed_id: id, submission_attempted: false, comment_rendered: null } })
    const url = new URL(opening.target_url!)
    expect(url.pathname).toBe(`/explore/${id}`)
    expect(url.searchParams.get('xsec_token')).toBe(args.xsec_token)
    expect(url.searchParams.get('xsec_source')).toBe('pc_feed')
    expect(assign).toHaveBeenCalledWith(opening.target_url)
    expect(input.click).not.toHaveBeenCalled(); expect(input.type).not.toHaveBeenCalled()
    page(); expect(await call()).toMatchObject({ status: 'ok' })
  })
  it.each(['feed_id', 'xsec_token', 'content'])('rejects missing %s using the upstream nonempty-string requirement', async (key) => {
    expect(await call({ ...args, [key]: '' })).toMatchObject({ error_code: 'INVALID_ARGUMENT' })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('does not trim whitespace or cap comment length', async () => {
    const content = '  \n' + '长'.repeat(5000) + '\n  '
    input.click.mockImplementation(async (element) => { if (element.matches('button.submit')) renderedComment(content) })
    expect(await call({ ...args, content })).toMatchObject({ status: 'ok', data: { content } })
    expect(input.type.mock.calls[0][1]).toBe(content)
  })
  it('returns site error text without attributing an account restriction', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div class="access-wrapper">当前笔记暂时无法浏览</div>')
    expect(await call()).toMatchObject({ error_code: 'NOTE_UNAVAILABLE', data: { site_error_message: '当前笔记暂时无法浏览', submission_attempted: false } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('continues after the upstream readiness wait if the comment controls exist', async () => {
    document.querySelector('.note-scroller')!.remove()
    expect(await call()).toMatchObject({ status: 'ok' })
  })
  it('reports missing comment controls before any submission', async () => {
    document.querySelector('.content-edit span')!.remove()
    expect(await call()).toMatchObject({ error_code: 'COMMENT_ACTION_FAILED', data: { phase: 'opening_input', submission_attempted: false, comment_rendered: null } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('reports input failures without clicking send', async () => {
    input.type.mockRejectedValue(new Error('Debugger detached'))
    expect(await call()).toMatchObject({ error_code: 'COMMENT_ACTION_FAILED', data: { phase: 'typing', submission_attempted: false, success: null } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('reports unknown delivery after a failed CDP send click without retrying', async () => {
    input.click.mockImplementation(async (element) => { if (element.matches('button.submit')) throw new Error('Debugger detached after mouse press') })
    expect(await call()).toMatchObject({ error_code: 'COMMENT_ACTION_FAILED', data: { phase: 'submitting', submission_attempted: null, success: null } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('stops after a document change during input', async () => {
    input.type.mockImplementation(async () => { page(`/explore/${other}`) })
    expect(await call()).toMatchObject({ error_code: 'PAGE_CHANGED', data: { submission_attempted: false } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('refuses posting on creator pages', async () => {
    page('https://creator.xiaohongshu.com/publish/publish')
    expect(await call()).toMatchObject({ error_code: 'UNSUPPORTED_PAGE' })
    expect(input.click).not.toHaveBeenCalled()
  })
})
