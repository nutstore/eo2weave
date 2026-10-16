import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const input = vi.hoisted(() => ({ click: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input', () => ({ clickWithCdp: input.click }))
import { xiaohongshuLikeTools as tools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-like'

const id = '69e78d620000000021012b9b', other = '69e78d620000000021012b9c'
const args = { feed_id: id, xsec_token: 'test-token' }
const assign = vi.fn()
const stateWindow = window as Window & { __INITIAL_STATE__?: any }
type Result = { status: string; error_code: string | null; target_url?: string; data: Record<string, any> }
function page(path = `/explore/${id}`, origin = 'https://www.xiaohongshu.com') {
  const url = new URL(path, origin)
  vi.stubGlobal('location', { href: url.href, hostname: url.hostname, pathname: url.pathname, origin: url.origin, search: url.search, assign })
}
function state(liked: unknown = false, collected: unknown = false) {
  stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { note: { interactInfo: { liked, collected } } } } } }
}
function info() { return stateWindow.__INITIAL_STATE__.note.noteDetailMap[id].note.interactInfo }
async function call(values: Record<string, unknown> = args): Promise<Result> {
  const pending = tools.xhs_like_feed(values)
  await vi.runAllTimersAsync()
  return await pending as Result
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); page(); state()
  document.body.innerHTML = '<div class="interact-container"><div class="left"><span class="like-lottie">点赞</span></div></div>'
  input.click.mockImplementation(async () => { info().liked = !info().liked })
})
afterEach(() => { delete stateWindow.__INITIAL_STATE__; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('upstream LikeAction in the current tab', () => {
  it('likes the first upstream button and verifies exact page state', async () => {
    state(false, true)
    expect(await call()).toMatchObject({ status: 'ok', recipe_version: '0.7.4', data: { unlike: false, target_liked: true, phase: 'completed', click_attempts: 1, completed_clicks: 1, click_attempted: true, state_verified: true, skipped_noop: false, success_scope: 'upstream_state_check', state_before: { liked: false, collected: true }, state_after: { liked: true, collected: true, liked_raw: true, liked_value_source: 'page_boolean' } } })
    expect(input.click).toHaveBeenCalledOnce()
    expect(input.click).toHaveBeenCalledWith(document.querySelector('.interact-container .left .like-lottie'))
    expect(assign).not.toHaveBeenCalled()
  })
  it('unlikes without touching collected state', async () => {
    state(true, true)
    expect(await call({ ...args, unlike: true })).toMatchObject({ status: 'ok', data: { target_liked: false, state_after: { liked: false, collected: true } } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it.each([true, false])('skips a note already in requested liked=%s state', async (liked) => {
    state(liked)
    expect(await call({ ...args, unlike: !liked })).toMatchObject({ status: 'ok', data: { success: true, skipped_noop: true, click_attempts: 0, click_attempted: false, state_verified: true, state_after: null, success_scope: 'upstream_initial_state_check' } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('waits for delayed state without a second click', async () => {
    input.click.mockImplementation(async () => { setTimeout(() => { info().liked = true }, 3200) })
    expect(await call()).toMatchObject({ status: 'ok', data: { click_attempts: 1, state_after: { liked: true } } })
  })
  it('inherits the second click only after the first verification window', async () => {
    const times: number[] = []
    input.click.mockImplementation(async () => { times.push(Date.now()); if (times.length === 2) info().liked = true })
    expect(await call()).toMatchObject({ status: 'ok', data: { click_attempts: 2, completed_clicks: 2 } })
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(4000)
  })
  it('does not report click-only success and stops after two clicks', async () => {
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_NOT_CONFIRMED', data: { success: false, state_verified: false, click_attempts: 2, completed_clicks: 2, verification_timeout_ms: 4000, verification_poll_ms: 500 } })
    expect(input.click).toHaveBeenCalledTimes(2)
  })
  it('still clicks after the initial missing-state error', async () => {
    delete stateWindow.__INITIAL_STATE__
    input.click.mockImplementation(async () => { state(true) })
    expect(await call()).toMatchObject({ status: 'ok', data: { state_before: null, initial_state_error: expect.stringContaining('No feed detail'), state_after: { liked: true } } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('stops after one click if state remains missing', async () => {
    delete stateWindow.__INITIAL_STATE__; input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_STATE_UNAVAILABLE', data: { success: false, state_after: null, completed_clicks: 1 } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('stops immediately if state disappears during verification', async () => {
    input.click.mockImplementation(async () => { setTimeout(() => { delete stateWindow.__INITIAL_STATE__ }, 1000) })
    expect(await call()).toMatchObject({ error_code: 'LIKE_STATE_UNAVAILABLE' })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('does not substitute a DOM icon or count for state', async () => {
    document.querySelector('.like-lottie')!.innerHTML = '<svg><use href="#liked"></use></svg><span>999</span>'
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_NOT_CONFIRMED' })
  })
  it('does not borrow another note or unwrap a value/ref', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [other]: { note: { interactInfo: { liked: true } } }, value: { [id]: { note: { interactInfo: { liked: true } } } } } } }
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_STATE_UNAVAILABLE', data: { initial_state_error: expect.stringContaining('not in noteDetailMap') } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it.each([undefined, null])('reports the upstream default for liked=%s separately from raw state', async (liked) => {
    state(liked); if (liked === undefined) delete info().liked
    expect(await call({ ...args, unlike: true })).toMatchObject({ status: 'ok', data: { skipped_noop: true, state_before: { liked: false, liked_raw: null, liked_field_present: liked !== undefined, liked_value_source: liked === null ? 'upstream_go_null_ignored' : 'upstream_go_bool_default' } } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('preserves defaults for null nested structs', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: null } } }
    expect(await call({ ...args, unlike: true })).toMatchObject({ status: 'ok', data: { state_before: { liked: false, liked_field_present: false } } })
  })
  it.each(['true', 1, {}])('decodes liked=%j as an error instead of truthiness', async (liked) => {
    state(liked); input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_STATE_UNAVAILABLE', data: { state_before: null, initial_state_error: expect.stringContaining('Go bool') } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('validates collected and all map entries as Go does', async () => {
    state(true); stateWindow.__INITIAL_STATE__.note.noteDetailMap[other] = { note: { interactInfo: { collected: 'false' } } }
    input.click.mockResolvedValue(undefined)
    expect(await call()).toMatchObject({ error_code: 'LIKE_STATE_UNAVAILABLE', data: { state_before: null } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('matches Go fields case-insensitively and does not reset bools on null', async () => {
    stateWindow.__INITIAL_STATE__ = { note: { noteDetailMap: { [id]: { Note: { InteractInfo: { Liked: true, liked: null, Collected: true } } } } } }
    expect(await call()).toMatchObject({ status: 'ok', data: { skipped_noop: true, state_before: { liked: true, collected: true, liked_raw: null, liked_value_source: 'upstream_go_null_ignored' } } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('does not click if the upstream page evaluation would throw', async () => {
    const circular: any = {}; circular.self = circular; stateWindow.__INITIAL_STATE__.note.noteDetailMap = circular
    expect(await call()).toMatchObject({ error_code: 'LIKE_ACTION_FAILED', data: { click_attempted: false, success: null } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('reports an interrupted click as unknown without another attempt', async () => {
    input.click.mockRejectedValue(new Error('Debugger detached after mouse press'))
    expect(await call()).toMatchObject({ error_code: 'LIKE_ACTION_FAILED', data: { click_attempted: null, completed_clicks: 0, state_verified: null, success: null } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('stops if the tab changes after clicking', async () => {
    input.click.mockImplementation(async () => { page(`/explore/${other}`) })
    expect(await call()).toMatchObject({ error_code: 'PAGE_CHANGED', data: { success: null } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('takes the first button without requiring uniqueness', async () => {
    document.querySelector('.left')!.insertAdjacentHTML('beforeend', '<span class="like-lottie">another</span>')
    expect(await call()).toMatchObject({ status: 'ok' })
    expect(input.click).toHaveBeenCalledWith(document.querySelector('.like-lottie'))
  })
  it('waits for a missing button until the page budget', async () => {
    document.querySelector('.like-lottie')!.remove()
    expect(await call()).toMatchObject({ error_code: 'LIKE_ACTION_FAILED', data: { click_attempted: false, success: null } })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('waits for a late button within the original page budget', async () => {
    document.querySelector('.like-lottie')!.remove()
    setTimeout(() => { document.querySelector('.left')!.innerHTML = '<span class="like-lottie">late</span>' }, 7000)
    expect(await call()).toMatchObject({ status: 'ok', data: { click_attempts: 1 } })
    expect(input.click).toHaveBeenCalledOnce()
  })
  it('does not add a site-error/login gate absent from upstream LikeAction', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="error-wrapper">site message</div><div class="login-container">login</div>')
    expect(await call()).toMatchObject({ status: 'ok' })
  })
  it('yields navigation without a click then resumes with the same unlike', async () => {
    page(`/explore/${other}`)
    const opening = await call({ ...args, unlike: true })
    expect(opening).toMatchObject({ status: 'navigated', data: { feed_id: id, unlike: true, target_liked: false, click_attempted: false } })
    const url = new URL(opening.target_url!)
    expect(url.searchParams.get('xsec_token')).toBe(args.xsec_token)
    expect(url.searchParams.get('xsec_source')).toBe('pc_feed')
    expect(input.click).not.toHaveBeenCalled()
    page(); state(true)
    expect(await call({ ...args, unlike: true })).toMatchObject({ status: 'ok', data: { state_after: { liked: false } } })
  })
  it.each(['feed_id', 'xsec_token'])('requires the upstream nonempty %s string', async (key) => {
    expect(await call({ ...args, [key]: '' })).toMatchObject({ error_code: 'INVALID_ARGUMENT' })
    expect(input.click).not.toHaveBeenCalled()
  })
  it('preserves raw whitespace and handler defaults without new validation', async () => {
    page('/explore')
    const response = await call({ feed_id: ' ', xsec_token: ' ', unlike: 'true' })
    expect(response).toMatchObject({ status: 'navigated', data: { feed_id: ' ', unlike: false, target_liked: true } })
    expect(new URL(response.target_url!).searchParams.get('xsec_token')).toBe(' ')
  })
  it('rejects a non-main-site tab', async () => {
    page('/explore', 'https://example.com')
    expect(await call()).toMatchObject({ error_code: 'UNSUPPORTED_PAGE' })
    expect(input.click).not.toHaveBeenCalled()
  })
})
