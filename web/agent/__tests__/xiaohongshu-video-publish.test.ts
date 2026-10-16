import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input', () => ({
  clickWithCdp: vi.fn(async (el: HTMLElement) => { el.click(); el.focus() }),
  typeWithCdp: vi.fn(async (el: HTMLElement, value: string, append = false) => {
    el.focus()
    if (el instanceof HTMLInputElement) el.value = append ? el.value + value : value
    else el.textContent = (append ? el.textContent || '' : '') + value
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
  }),
  pressWithCdp: vi.fn(async (_key: string, el?: HTMLElement) => { el?.focus() }),
  clickPointWithCdp: vi.fn(async () => {}),
}))
import { xiaohongshuVideoPublishTools, videoRequest, videoProcessingState, videoUploadInput } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video'
import { receiveXiaohongshuVideoFrame, stageXiaohongshuVideoInvocation } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video-transfer'
import { xiaohongshuRecipe } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu'
import { pressWithCdp, typeWithCdp } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input'
const args = { title: '测试视频', content: '第一段\n第二段😀', video: 'vfs://assets/video.mov', operation_id: '视频准备' }
function page(host = 'creator.xiaohongshu.com', path = '/publish/publish') {
  vi.stubGlobal('location', { hostname: host, pathname: path, href: `https://${host}${path}`, assign: vi.fn() })
}
function form() {
  document.body.innerHTML = '<div class="creator-tab">上传图文</div><div class="creator-tab">上传视频</div><input class="upload-input" type="file"><div class="d-input"><input></div><div role="textbox" contenteditable="true"></div><div class="permission-card-wrapper"><div class="d-select-content">公开可见</div></div><xhs-publish-btn is-publish="true" submit-disabled="false"></xhs-publish-btn>'
  const input = document.querySelector<HTMLInputElement>('.upload-input')!
  Object.defineProperty(input, 'files', { configurable: true, writable: true, value: [] })
}
function stageFile(source = args.video) {
  const request = { action: 'upload', operation_id: args.operation_id, video: source }, transfer_id = crypto.randomUUID()
  const frame = (value: object) => receiveXiaohongshuVideoFrame({ ...request, _eo2_video_frame: { ...value, transfer_id } })
  frame({ kind: 'start', name: 'video.mov', mime: 'video/quicktime', size: 3 })
  frame({ kind: 'chunk', index: 0, base64: btoa('abc') }); frame({ kind: 'finish' })
  stageXiaohongshuVideoInvocation({ ...request, _eo2_video_transfer: transfer_id })
}
async function call(action: string, extra: Record<string, unknown> = {}) {
  const pending = xiaohongshuVideoPublishTools.xhs_publish_video({ action, operation_id: args.operation_id, ...extra })
  const settled = pending as Promise<any>
  await vi.advanceTimersByTimeAsync(20_000)
  return settled
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); sessionStorage.clear(); page(); form()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => Array.from(document.querySelectorAll('.creator-tab')).find((el) => el.textContent === '上传视频') ?? null)
  vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: (file: File) => this.files.push(file) } })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); delete (window as any)[Symbol.for('eo2.xhs.video-transfer')] })
async function uploaded() { await call('prepare', args); stageFile(); return call('upload', { video: args.video }) }
describe('video preparation follows upstream publish_with_video', () => {
  it('registers the complete preparation API as a write tool without invented video options', () => {
    const tool = xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_publish_video')!
    expect(tool.readOnlyHint).toBe(false)
    const schema = tool.inputSchema as any
    expect(schema.properties.action.enum).toEqual(['open', 'prepare', 'upload', 'configure', 'status'])
    expect(schema.properties).not.toHaveProperty('is_original'); expect(schema.properties).not.toHaveProperty('cover')
  })
  it('shares upstream title, tag, schedule and visibility rules while requiring one local source', () => {
    expect(videoRequest({ ...args, tags: Array(12).fill('#话题') })).toMatchObject({ tags: Array(12).fill('话题'), dropped_tags: 0 })
    expect(() => videoRequest({ ...args, title: '中'.repeat(21) })).toThrow('<=20')
    expect(() => videoRequest({ ...args, video: '' })).toThrow('local video')
    expect(() => videoRequest({ ...args, video: ['a.mp4'] })).toThrow('local video')
    expect(() => videoRequest({ ...args, video: 'https://example.com/video.mp4' })).toThrow('local video')
    expect(() => videoRequest({ ...args, schedule_at: new Date(Date.now() + 30_000).toISOString() })).toThrow('1 hour')
    expect(videoRequest({ ...args, video: 'vfs://assets/unusual.file', content: '' }).video).toBe('vfs://assets/unusual.file')
  })
  it('selects upload-video rather than treating an existing title field as proof of the selected tab', async () => {
    const clicked = vi.fn(); document.querySelectorAll('.creator-tab')[1].addEventListener('click', clicked)
    expect(await call('prepare', args)).toMatchObject({ status: 'ok', data: { phase: 'prepared', supplied_to_page: false } })
    expect(clicked).toHaveBeenCalledOnce()
  })
  it('inherits .upload-input and the first input[type=file] fallback without accept/uniqueness filters', () => {
    document.body.innerHTML = '<input type="file" accept=""><input type="file" accept="video/*">'
    expect(videoUploadInput()).toBe(document.querySelector('input'))
    document.querySelectorAll('input')[1].className = 'upload-input'
    expect(videoUploadInput()).toBe(document.querySelectorAll('input')[1])
  })
  it('reports processing complete only through the upstream widget readiness rule', () => {
    const widget = document.querySelector('xhs-publish-btn')!
    widget.setAttribute('submit-disabled', 'true')
    document.body.insertAdjacentHTML('beforeend', '<div class="cover">处理完成 100%</div><div class="publish-page-publish-btn"><button class="bg-red">发布</button></div>')
    expect(videoProcessingState()).toMatchObject({ ready: false, button_kind: 'widget' })
    widget.setAttribute('is-publish', 'false')
    expect(videoProcessingState()).toMatchObject({ ready: true, button_kind: 'legacy' })
  })
  it.each(['disabled', 'aria-disabled="true"', 'class="bg-red disabled"'])('inherits old-button disabling through %s', (attribute) => {
    document.body.innerHTML = `<div class="publish-page-publish-btn"><button ${attribute.includes('class=') ? attribute : `class="bg-red" ${attribute}`}>发布</button></div>`
    expect(videoProcessingState()).toMatchObject({ ready: false, button_kind: 'legacy' })
  })
  it('does not count hidden or save-only controls as processing completion', () => {
    document.body.innerHTML = '<xhs-publish-btn style="display:none"></xhs-publish-btn><xhs-publish-btn is-publish="false"></xhs-publish-btn><button>暂存离开</button>'
    expect(videoProcessingState()).toMatchObject({ ready: false, button_kind: null })
  })
  it('waits for the actual processing control and does not resupply on status', async () => {
    await call('prepare', args); stageFile()
    const widget = document.querySelector('xhs-publish-btn')!, changed = vi.fn()
    widget.setAttribute('submit-disabled', 'true'); document.querySelector('.upload-input')!.addEventListener('change', changed)
    setTimeout(() => widget.setAttribute('submit-disabled', 'false'), 1500)
    expect(await call('upload', { video: args.video })).toMatchObject({ status: 'ok', data: { phase: 'uploaded', supplied_to_page: true, file: { name: 'video.mov', size: 3 }, published_verified: false } })
    expect(changed).toHaveBeenCalledOnce()
    expect(await call('status')).toMatchObject({ status: 'ok', data: { phase: 'uploaded' } })
    expect(changed).toHaveBeenCalledOnce()
  })
  it('runs all video topics instead of applying the image-only ten-topic cap', async () => {
    const tags = Array.from({ length: 12 }, (_, i) => `话题${i}`)
    await call('prepare', { ...args, tags }); stageFile(); await call('upload', { video: args.video })
    document.body.insertAdjacentHTML('beforeend', '<div id="creator-editor-topic-container"><div class="item">实际建议</div></div>')
    const pending = xiaohongshuVideoPublishTools.xhs_publish_video({ action: 'configure', operation_id: args.operation_id })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toMatchObject({ status: 'ok', data: { review: { dropped_tags: 0, topics: tags.map((requested) => ({ requested, selected: '实际建议' })) } } })
    expect(vi.mocked(typeWithCdp).mock.calls.filter(([, text]) => tags.includes(text))).toHaveLength(12)
  })
  it('supplies new transferred bytes on an explicit upload after an earlier website rejection', async () => {
    await call('prepare', args); stageFile()
    const widget = document.querySelector('xhs-publish-btn')!, changed = vi.fn()
    widget.setAttribute('submit-disabled', 'true')
    document.querySelector('.upload-input')!.addEventListener('change', changed)
    const pending = xiaohongshuVideoPublishTools.xhs_publish_video({ action: 'upload', operation_id: args.operation_id, video: args.video })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await pending).toMatchObject({ error_code: 'VIDEO_PROCESSING_PENDING', data: { supplied_to_page: true, phase: 'processing' } })
    stageFile()
    document.querySelector('.upload-input')!.addEventListener('change', () => widget.setAttribute('submit-disabled', 'false'))
    expect(await call('upload', { video: args.video })).toMatchObject({ status: 'ok', data: { phase: 'uploaded' } })
    expect(changed).toHaveBeenCalledTimes(2)
  })
  it('does not return false upload success from a historical supply record when new bytes are missing', async () => {
    await uploaded()
    expect(await call('upload', { video: args.video })).toMatchObject({ status: 'error', error_code: 'VIDEO_TRANSFER_UNAVAILABLE' })
  })
  it('clears prior configuration evidence when an explicit upload supplies the file again', async () => {
    await uploaded(); await call('configure')
    expect(await call('status')).toMatchObject({ data: { phase: 'ready', review: { observed_text: { title: args.title } } } })
    const changed = vi.fn(); document.querySelector('.upload-input')!.addEventListener('change', changed)
    stageFile()
    expect(await call('upload', { video: args.video })).toMatchObject({ status: 'ok', data: { phase: 'uploaded', review: null } })
    expect(changed).toHaveBeenCalledOnce()
  })
  it('allows status to continue a five-minute processing wait without resupplying the video', async () => {
    await call('prepare', args); stageFile()
    const widget = document.querySelector('xhs-publish-btn')!, changed = vi.fn()
    widget.setAttribute('submit-disabled', 'true'); document.querySelector('.upload-input')!.addEventListener('change', changed)
    const pending = xiaohongshuVideoPublishTools.xhs_publish_video({ action: 'upload', operation_id: args.operation_id, video: args.video })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(await pending).toMatchObject({ error_code: 'VIDEO_PROCESSING_PENDING', data: {
      phase: 'processing', supplied_in_this_call: true, supplied_in_current_runtime: true, next_action: 'status',
    } })
    expect(await call('status')).toMatchObject({ data: {
      phase: 'processing', supplied_in_this_call: false, supplied_in_current_runtime: true, next_action: 'status',
    } })
    widget.setAttribute('submit-disabled', 'false')
    expect(await call('status')).toMatchObject({ status: 'ok', data: { phase: 'uploaded' } })
    expect(changed).toHaveBeenCalledOnce()
  })
  it('reports an assignment failure without falsely marking the file as supplied', async () => {
    await call('prepare', args); stageFile()
    Object.defineProperty(document.querySelector('.upload-input'), 'files', { set: () => { throw new Error('Assignment rejected') } })
    expect(await call('upload', { video: args.video })).toMatchObject({ error_code: 'PUBLISH_STEP_FAILED', data: { supplied_to_page: false } })
  })
  it('fills title/body and topics using shared CDP input and stops before publish', async () => {
    await call('prepare', { ...args, tags: ['话题'] }); stageFile(); await call('upload', { video: args.video })
    document.body.insertAdjacentHTML('beforeend', '<div id="creator-editor-topic-container"><div class="item">首个话题</div></div>')
    const clicked = vi.fn(); document.querySelector('xhs-publish-btn')!.addEventListener('click', clicked)
    expect(await call('configure')).toMatchObject({ status: 'ok', data: { phase: 'ready', publication_enabled: false, published_verified: false, review: { topics: [{ selected: '首个话题' }] } } })
    expect(vi.mocked(pressWithCdp).mock.calls.map(([key]) => key)).toEqual([...Array(20).fill('ArrowDown'), 'Enter', 'Enter'])
    expect(vi.mocked(typeWithCdp).mock.calls.some(([, value]) => value === args.content)).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
  })
  it('updates only visibility after preparation and preserves text and uploaded file', async () => {
    await uploaded(); await call('configure')
    const body = document.querySelector('[contenteditable]')!, title = document.querySelector<HTMLInputElement>('.d-input input')!
    title.value = '手动标题'; body.textContent = '手动正文'
    const writes = vi.mocked(typeWithCdp).mock.calls.length
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    expect(await call('configure', { visibility: '仅自己可见' })).toMatchObject({ status: 'ok', data: { phase: 'ready', review: { observed_text: { title: '手动标题', content: '手动正文' }, observed_options: { visibility: '仅自己可见' } } } })
    expect(vi.mocked(typeWithCdp).mock.calls).toHaveLength(writes)
  })
  it('retains the local modification scope after a failed visibility change', async () => {
    await uploaded(); await call('configure')
    const writes = vi.mocked(typeWithCdp).mock.calls.length
    expect(await call('configure', { visibility: '仅自己可见' })).toMatchObject({ error_code: 'PUBLISH_STEP_FAILED' })
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    expect(await call('configure')).toMatchObject({ status: 'ok', data: { phase: 'ready' } })
    expect(vi.mocked(typeWithCdp).mock.calls).toHaveLength(writes)
  })
  it('does not apply the image-only guide, original declaration or extra length-error check to video', async () => {
    await uploaded()
    document.body.insertAdjacentHTML('beforeend', '<button class="feature-guide__btn">关闭</button><div class="edit-container"><div class="length-error">示例提示</div></div><div class="custom-switch-card">原创声明<div class="d-switch"></div></div>')
    const clicks = vi.fn(); document.querySelector('.feature-guide__btn')!.addEventListener('click', clicks); document.querySelector('.d-switch')!.addEventListener('click', clicks)
    const response = await call('configure')
    expect(response.status).toBe('ok'); expect(response.data.review).not.toHaveProperty('is_original'); expect(response.data.review.observed_options).not.toHaveProperty('is_original')
    expect(clicks).not.toHaveBeenCalled()
  })
  it('uses RFC3339 wall-clock scheduling and does not revalidate an unchanged time on partial edits', async () => {
    const schedule_at = new Date(Date.now() + 7200_000).toISOString()
    await call('prepare', { ...args, schedule_at }); stageFile(); await call('upload', { video: args.video })
    document.body.insertAdjacentHTML('beforeend', '<div class="post-time-wrapper"><div class="d-switch"></div></div><div class="date-picker-container"><input></div>')
    expect(await call('configure')).toMatchObject({ status: 'ok', data: { review: { observed_options: { scheduled_at: schedule_at.slice(0, 16).replace('T', ' ') } } } })
    vi.setSystemTime(Date.now() + 90 * 60_000)
    expect(await call('configure', { title: '更新标题' })).toMatchObject({ status: 'ok' })
  })
  it('refuses configure before the file is supplied and reports missing transferred bytes', async () => {
    await call('prepare', args)
    expect(await call('configure')).toMatchObject({ error_code: 'VIDEO_PROCESSING_PENDING' })
    expect(await call('upload', { video: args.video })).toMatchObject({ error_code: 'VIDEO_TRANSFER_UNAVAILABLE' })
  })
  it('retains the already supplied file when explicitly updating the same preparation', async () => {
    await uploaded()
    const changed = vi.fn(); document.querySelector('.upload-input')!.addEventListener('change', changed)
    expect(await call('prepare', { ...args, content: '更新文稿' })).toMatchObject({ status: 'ok', data: { phase: 'uploaded', supplied_to_page: true } })
    expect(await call('configure')).toMatchObject({ status: 'ok', data: { review: { observed_text: { content: '更新文稿' } } } })
    expect(changed).not.toHaveBeenCalled()
  })
  it('directs a fresh preparation to upload without claiming the ready button supplied a file', async () => {
    const response = await call('prepare', args)
    expect(response).toMatchObject({ status: 'ok', data: {
      phase: 'prepared', recorded_phase: 'prepared', supplied_to_page: false,
      supplied_in_this_call: false, supplied_in_current_runtime: false,
      file_scope: 'historical_supply_record', file_acceptance_verified: null, next_action: 'upload',
    } })
    expect(response.data.next_step).toContain('prepare does not upload')
    expect(document.querySelector<HTMLInputElement>('.upload-input')!.files).toHaveLength(0)
  })
  it('reports a restored legacy record on an empty uploader as unconfirmed instead of ongoing processing', async () => {
    const file = { name: 'video.mov', size: 87425348, mime: 'video/quicktime' }
    sessionStorage.setItem('eo2_xhs_video_prepare_v1', JSON.stringify({
      operation_id: args.operation_id, request: videoRequest(args), phase: 'ready', supplied_to_page: true, file, review: null,
    }))
    document.querySelector('xhs-publish-btn')!.remove()
    const changed = vi.fn()
    document.querySelector('.upload-input')!.addEventListener('change', changed)
    expect(await call('status')).toMatchObject({ status: 'ok', data: {
      phase: 'supply_unconfirmed', recorded_phase: 'ready', file, supplied_to_page: true,
      supplied_in_this_call: false, supplied_in_current_runtime: null,
      file_acceptance_verified: null, processing: { ready: false, button_kind: null }, next_action: null,
    } })
    const prepared = await call('prepare', { ...args, content: '新的正文' })
    expect(prepared).toMatchObject({ status: 'ok', data: {
      phase: 'supply_unconfirmed', recorded_phase: 'ready', file,
      supplied_in_this_call: false, supplied_in_current_runtime: null, next_action: null,
    } })
    expect(prepared.data.next_step).toContain('historical supply record')
    expect(prepared.data.next_step).toContain('explicitly call upload')
    expect(prepared.data.next_step).not.toContain('Query status')
    expect(await call('status')).toMatchObject({ data: { phase: 'supply_unconfirmed' } })
    expect(changed).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('.upload-input')!.files).toHaveLength(0)
  })
  it('allows explicit upload after an unconfirmed historical record and reports only that call as supplying', async () => {
    sessionStorage.setItem('eo2_xhs_video_prepare_v1', JSON.stringify({
      operation_id: args.operation_id, request: videoRequest(args), phase: 'processing', supplied_to_page: true,
      file: { name: 'old.mov', size: 87425348, mime: 'video/quicktime' }, review: null, supply_runtime_id: 'previous-runtime',
    }))
    const widget = document.querySelector('xhs-publish-btn')!
    widget.setAttribute('submit-disabled', 'true')
    expect(await call('status')).toMatchObject({ data: { phase: 'supply_unconfirmed', supplied_in_current_runtime: null } })
    const changed = vi.fn(() => widget.setAttribute('submit-disabled', 'false'))
    document.querySelector('.upload-input')!.addEventListener('change', changed)
    stageFile()
    expect(await call('upload', { video: args.video })).toMatchObject({ status: 'ok', data: {
      phase: 'uploaded', recorded_phase: 'uploaded', supplied_in_this_call: true,
      supplied_in_current_runtime: true, file: { name: 'video.mov', size: 3 },
      file_acceptance_verified: null, next_action: 'configure',
    } })
    expect(await call('status')).toMatchObject({ data: {
      phase: 'uploaded', supplied_in_this_call: false, supplied_in_current_runtime: true, next_action: 'configure',
    } })
    expect(await call('prepare', { ...args, content: '只更新文稿' })).toMatchObject({ data: {
      phase: 'uploaded', supplied_in_this_call: false, supplied_in_current_runtime: true, next_action: 'configure',
    } })
    expect(changed).toHaveBeenCalledOnce()
  })
  it.each(['processing', 'uploaded', 'configuring', 'ready'])('does not configure a different ready video from a restored %s record', async (phase) => {
    sessionStorage.setItem('eo2_xhs_video_prepare_v1', JSON.stringify({
      operation_id: args.operation_id, request: videoRequest(args), phase, supplied_to_page: true,
      file: { name: 'old.mov', size: 87425348, mime: 'video/quicktime' }, review: null,
    }))
    document.querySelector<HTMLInputElement>('.d-input input')!.value = '另一个视频的标题'
    document.querySelector('[contenteditable]')!.textContent = '另一个视频的正文'
    expect(await call('status')).toMatchObject({ status: 'ok', data: {
      phase: 'supply_unconfirmed', recorded_phase: phase, processing: { ready: true }, supplied_in_current_runtime: null,
      supplied_in_this_call: false, file_acceptance_verified: null, next_action: null,
    } })
    expect(await call('prepare', args)).toMatchObject({ data: { phase: 'supply_unconfirmed', recorded_phase: phase, next_action: null } })
    expect(await call('configure', { content: '不应写入' })).toMatchObject({ error_code: 'VIDEO_SUPPLY_UNCONFIRMED', data: { phase: 'supply_unconfirmed', next_action: null } })
    expect(document.querySelector<HTMLInputElement>('.d-input input')!.value).toBe('另一个视频的标题')
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('另一个视频的正文')
    expect(typeWithCdp).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('.upload-input')!.files).toHaveLength(0)
  })
  it('does not call a previously ready form ready when the page returns to an empty uploader', async () => {
    await uploaded(); await call('configure')
    const changed = vi.fn()
    document.querySelector('.upload-input')!.addEventListener('change', changed)
    document.querySelector('xhs-publish-btn')!.remove()
    expect(await call('status')).toMatchObject({ data: {
      phase: 'supply_unconfirmed', recorded_phase: 'ready', supplied_in_this_call: false,
      supplied_in_current_runtime: true, file_acceptance_verified: null, next_action: null,
    } })
    expect(changed).not.toHaveBeenCalled()
  })
  it('does not reuse supply evidence after a script reload when another video is ready', async () => {
    await uploaded(); await call('configure')
    const journal = sessionStorage.getItem('eo2_xhs_video_prepare_v1')
    form()
    document.querySelector<HTMLInputElement>('.d-input input')!.value = '手动上传的其他视频'
    vi.resetModules()
    const { xiaohongshuVideoPublishTools: reloaded } = await import('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-video')
    expect(await reloaded.xhs_publish_video({ action: 'status', operation_id: args.operation_id })).toMatchObject({ data: {
      phase: 'supply_unconfirmed', recorded_phase: 'ready', supplied_in_current_runtime: null, processing: { ready: true }, next_action: null,
    } })
    expect(await reloaded.xhs_publish_video({ action: 'configure', operation_id: args.operation_id, content: '旧任务正文' })).toMatchObject({ error_code: 'VIDEO_SUPPLY_UNCONFIRMED' })
    expect(document.querySelector<HTMLInputElement>('.d-input input')!.value).toBe('手动上传的其他视频')
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('')
    expect(sessionStorage.getItem('eo2_xhs_video_prepare_v1')).toBe(journal)
    expect(document.querySelector<HTMLInputElement>('.upload-input')!.files).toHaveLength(0)
  })
  it('never executes a stale final-submission call', async () => {
    const click = vi.fn(); document.querySelector('xhs-publish-btn')!.addEventListener('click', click)
    expect(await call('submit')).toMatchObject({ error_code: 'PUBLICATION_DEFERRED' })
    expect(click).not.toHaveBeenCalled()
  })
  it('navigates in the same tab and requires rediscovery on the creator host', async () => {
    page('www.xiaohongshu.com', '/explore')
    expect(await call('prepare', args)).toMatchObject({ error_code: 'NOT_CREATOR_PAGE' })
    expect(await call('open')).toMatchObject({ status: 'navigated', target_url: 'https://creator.xiaohongshu.com/publish/publish?source=official' })
  })
})
