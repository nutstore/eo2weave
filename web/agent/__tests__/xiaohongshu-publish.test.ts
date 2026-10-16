import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Simulate browser effects for the recipe tests. The real CDP driver and scoped
// transport are exercised separately, rather than treating DOM mocks as CDP proof.
vi.mock('../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input', () => ({
  clickWithCdp: async (el: HTMLElement) => {
    el.scrollIntoView({ block: 'center' })
    while (getComputedStyle(el).display === 'none' || el.hasAttribute('disabled')) await new Promise((resolve) => setTimeout(resolve, 250))
    el.click()
  },
  typeWithCdp: async (el: HTMLElement, text: string, append = false) => {
    el.focus()
    if (el instanceof HTMLInputElement) {
      el.value = append ? el.value + text : text
    } else {
      const range = document.createRange(); range.selectNodeContents(el); if (append) range.collapse(false)
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
      if (document.execCommand) document.execCommand('insertText', false, text)
      else el.textContent = (append ? el.textContent || '' : '') + text
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))
  },
  pressWithCdp: vi.fn(async (key: string, element?: HTMLElement) => {
    element?.focus()
    const el = document.activeElement || document.body
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  }),
  clickPointWithCdp: async (x: number, y: number) => { (document.elementFromPoint(x, y) as HTMLElement | null)?.click() },
}))
import { xiaohongshuPublishTools } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish'
import { xiaohongshuRecipe } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu'
import { findRecipeForLocation } from '../../../browser-extension/entrypoints/webmcp/recipes'
import { imagePayload, imageMime, publishRequest, updatePublishRequest, titleLength } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-policy'
import { editor, editorText, formSnapshot, imageUploadInput } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-dom'
import { stageXiaohongshuImage } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-transfer'
import { pressWithCdp } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input'

const id = 'publish_test_001'
const request = { title: '测试标题', content: '第一行\n第二行', images: ['vfs://assets/test.png'] }
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])
let hitTarget: Element | null = null
function page(path = '/publish/publish', host = 'creator.xiaohongshu.com') {
  const url = new URL(path, `https://${host}`)
  vi.stubGlobal('location', { hostname: host, origin: url.origin, pathname: url.pathname, href: url.href, search: url.search, assign: vi.fn() })
}
function form() {
  document.body.innerHTML = '<div class="img-preview-area"><div class="pr"><img src="image.png"></div></div><div class="d-input"><input></div><div role="textbox" contenteditable="true"><p></p></div><div class="permission-card-wrapper"><div class="d-select-content">公开可见</div></div><div class="post-time-wrapper"><div class="d-switch"><input type="checkbox"></div></div><xhs-publish-btn is-publish="true"></xhs-publish-btn>'
}
function journal(phase = 'ready', overrides: Record<string, unknown> = {}) {
  sessionStorage.setItem('eo2_xhs_image_publish_v1', JSON.stringify({ operation_id: id, request: publishRequest(request), phase, uploaded: 1, pending_index: null, snapshot: formSnapshot(), review: {}, submitted_at: null, evidence: null, ...overrides }))
}
async function call(action: string, args: Record<string, unknown> = {}) {
  const pending = xiaohongshuPublishTools.xhs_publish_content({ action, operation_id: id, ...args })
  if (['prepare', 'upload', 'configure'].includes(action)) await vi.advanceTimersByTimeAsync(1000)
  return await pending as { status: string; error_code: string | null; data: Record<string, unknown>; target_url?: string }
}
beforeEach(() => {
  vi.mocked(pressWithCdp).mockClear()
  vi.useFakeTimers(); page(); sessionStorage.clear(); document.body.innerHTML = ''
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function(this: HTMLElement) { hitTarget = this })
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => hitTarget)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (document as unknown as { execCommand?: unknown }).execCommand; sessionStorage.clear(); document.body.innerHTML = '' })

describe('upstream publish_content contract', () => {
  it('uses the exact supported hosts and marks publishing non-read-only', () => {
    expect(findRecipeForLocation('creator.xiaohongshu.com', '/publish/publish')?.id).toBe('xiaohongshu')
    expect(findRecipeForLocation('fake.xiaohongshu.com', '/publish/publish')).toBeUndefined()
    expect(xiaohongshuRecipe.tools.find((tool) => tool.name === 'xhs_publish_content')?.readOnlyHint).toBe(false)
  })
  it.each([['中'.repeat(20), 20], ['a'.repeat(40), 20], ['😀', 2], ['a中b', 2]])('ports UTF16 weighted title length %s', (title, expected) => { expect(titleLength(title)).toBe(expected) })
  it('retains full body, ordered images and first 10 tags while reporting truncation', () => {
    const parsed = publishRequest({ ...request, tags: Array.from({ length: 12 }, (_, i) => `#标签${i}`) })
    expect(parsed.content).toBe(request.content); expect(parsed.images).toEqual(request.images)
    expect(parsed.tags).toHaveLength(10); expect(parsed.dropped_tags).toBe(2)
  })
  it.each(['中'.repeat(21), 'a'.repeat(41)])('rejects upstream overlength title before actions', (title) => { expect(() => publishRequest({ ...request, title })).toThrow('<=20') })
  it('validates the upstream 1-hour/14-day scheduling range', () => {
    expect(() => publishRequest({ ...request, schedule_at: new Date(Date.now() + 3599000).toISOString() })).toThrow('1 hour')
    expect(() => publishRequest({ ...request, schedule_at: new Date(Date.now() + 14 * 86400000 + 1000).toISOString() })).toThrow('14 days')
    expect(publishRequest({ ...request, schedule_at: new Date(Date.now() + 3600000).toISOString() }).schedule_at).toBeTruthy()
  })
  it('retains omitted options and tag truncation while validating newly supplied settings', () => {
    const original = publishRequest({ ...request, tags: Array.from({ length: 12 }, (_, i) => `#tag${i}`), visibility: '仅自己可见', is_original: true })
    expect(updatePublishRequest(original, { content: 'new body' })).toMatchObject({
      content: 'new body', tags: original.tags, dropped_tags: 2, is_original: true, visibility: '仅自己可见', images: original.images,
    })
    expect(() => updatePublishRequest(original, { visibility: 'unsupported' })).toThrow('Unsupported visibility')
  })
  it('does not revalidate a previously accepted scheduled time when only visibility changes', () => {
    const schedule_at = new Date(Date.now() + 3600000).toISOString()
    const original = publishRequest({ ...request, schedule_at })
    vi.setSystemTime(Date.now() + 60000)
    expect(updatePublishRequest(original, { visibility: '仅自己可见' }).schedule_at).toBe(schedule_at)
    expect(() => updatePublishRequest(original, { schedule_at })).toThrow('1 hour')
  })
  it('validates image bytes and refuses HTML disguised as an image', () => {
    expect(imagePayload(png, 'image.png').mime).toBe('image/png')
    expect(() => imagePayload(new TextEncoder().encode('<html>not an image</html>'), 'image.png')).toThrow('recognized')
  })
  it.each([
    [[0, 0, 0, 12, 106, 80, 32, 32, 13, 10, 135, 10, 0], 'image/jp2'],
    [[73, 73, 42, 0, 0, 0, 0, 0, 67, 82, 2], 'image/x-canon-cr2'],
    [[73, 73, 42, 0, 0, 0, 0, 0, 0, 0, 0], 'image/tiff'],
    [[73, 73, 188], 'image/vnd.ms-photo'],
    [[56, 66, 80, 83], 'image/vnd.adobe.photoshop'],
    [[0, 0, 1, 0], 'image/vnd.microsoft.icon'],
    [[65, 67, 49, 48], 'image/vnd.dwg'],
  ] as const)('retains upstream image matcher %s', (bytes, mime) => { expect(imageMime(Uint8Array.from(bytes))).toBe(mime) })
  it('rejects calendar dates that Go RFC3339 parsing rejects', () => {
    expect(() => publishRequest({ ...request, schedule_at: '2027-02-30T10:30:00+08:00' })).toThrow('invalid RFC3339')
  })
  it('does not add nonempty title or topic business validation to the upstream contract', () => {
    const parsed = publishRequest({ ...request, title: '', tags: ['#', ''], visibility: '' })
    expect(parsed.title).toBe(''); expect(parsed.tags).toEqual(['', '']); expect(parsed.visibility).toBe('公开可见')
  })
  it('preserves explicit line breaks in paragraph and hard-break editors', () => {
    form(); const el = document.querySelector<HTMLElement>('[role="textbox"]')!
    el.innerHTML = '<p>第一行</p><p>第二行<br>第三行</p>'
    expect(editorText(el)).toBe('第一行\n第二行\n第三行')
  })
})
describe('current tab publication lifecycle', () => {
  it('ignores off-screen and tiny-opacity tab copies observed in the creator page', async () => {
    document.body.innerHTML = '<div style="position:absolute;left:-9999px;top:-9999px"><div class="creator-tab" id="probe"><span>上传图文</span></div></div><div class="creator-tab" id="real"><span>上传图文</span></div><div class="creator-tab" style="opacity:1e-05" id="faded"><span>上传图文</span></div><input type="file" class="upload-input">'
    const clicked = vi.fn()
    for (const tab of document.querySelectorAll('.creator-tab')) tab.addEventListener('click', () => clicked(tab.id))

    expect((await call('prepare', request)).status).toBe('ok')
    expect(clicked.mock.calls).toEqual([['real']])
  })
  it('chooses the upstream first visible tab even when several matching tabs are rendered', async () => {
    document.body.innerHTML = '<div class="creator-tab" id="first">上传图文</div><div class="creator-tab" id="second">上传图文</div><input type="file" class="upload-input">'
    const first = vi.fn(), second = vi.fn()
    document.getElementById('first')!.addEventListener('click', first)
    document.getElementById('second')!.addEventListener('click', second)
    expect((await call('prepare', request)).status).toBe('ok')
    expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled()
  })
  it('skips a negative-coordinate tab copy and waits for the image form after switching', async () => {
    document.body.innerHTML = '<div class="creator-tab" id="probe">上传图文</div><div class="creator-tab" id="real">上传图文</div>'
    vi.spyOn(document.getElementById('probe')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(-9710, -9910, 64, 24))
    document.getElementById('real')!.addEventListener('click', () => {
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<input type="file" class="upload-input">'), 500)
    })
    expect((await call('prepare', request)).data.phase).toBe('prepared')
    expect(document.querySelector('input.upload-input')).not.toBeNull()
  })
  it('waits for creator tabs to render instead of rejecting the initial loading page', async () => {
    setTimeout(() => { document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input">' }, 500)
    const pending = xiaohongshuPublishTools.xhs_publish_content({ action: 'prepare', operation_id: id, ...request })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ status: 'ok', data: { phase: 'prepared', submit_attempted: false } })
  })
  it('sends one transferred image through the file input and waits for its preview', async () => {
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input"><div class="img-preview-area"></div>'
    expect((await call('prepare', request)).status).toBe('ok')
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const onChange = vi.fn(() => { document.querySelector('.img-preview-area')!.innerHTML = '<div class="pr"><img src="uploaded.png"></div>' })
    fileInput.addEventListener('change', onChange)
    stageXiaohongshuImage({ action: 'upload', operation_id: id, image_index: 0, image: request.images[0], _eo2_image: imagePayload(png, 'photo.png') })
    const response = await call('upload', { image_index: 0, image: request.images[0] })
    expect(response.data.phase).toBe('uploaded'); expect(fileInput.files?.[0].name).toBe('photo.png')
    expect(onChange).toHaveBeenCalledTimes(1)
    await call('upload', { image_index: 0, image: request.images[0] }); expect(onChange).toHaveBeenCalledTimes(1)
  })
  it('uploads two ordered images when the first upload replaces the form with two hidden image inputs', async () => {
    const images = ['图库/坚果云1.png', '图库/坚果云工作台.png']
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input"><div class="img-preview-area"></div>'
    expect((await call('prepare', { ...request, images })).status).toBe('ok')
    const firstInput = document.querySelector<HTMLInputElement>('input.upload-input')!
    const selected = vi.fn()
    const unselected = vi.fn()
    firstInput.addEventListener('change', () => {
      document.querySelector('.img-preview-area')!.innerHTML = '<div class="pr"><img src="first.png"></div>'
      firstInput.remove()
      document.body.insertAdjacentHTML('beforeend', '<input id="add" type="file" accept=".jpg,.jpeg,.png,.webp" hidden multiple><input id="replace" type="file" accept=".jpg,.jpeg,.png,.webp" hidden><input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx" hidden>')
      document.getElementById('add')!.addEventListener('change', () => {
        selected(); document.querySelector('.img-preview-area')!.insertAdjacentHTML('beforeend', '<div class="pr"><img src="second.png"></div>')
      })
      document.getElementById('replace')!.addEventListener('change', unselected)
    })
    stageXiaohongshuImage({ action: 'upload', operation_id: id, image_index: 0, image: images[0], _eo2_image: imagePayload(png, 'first.png') })
    expect((await call('upload', { image_index: 0, image: images[0] })).data).toMatchObject({ phase: 'prepared', uploaded_count: 1, dom_preview_count: 1 })
    stageXiaohongshuImage({ action: 'upload', operation_id: id, image_index: 1, image: images[1], _eo2_image: imagePayload(png, 'second.png') })
    expect((await call('upload', { image_index: 1, image: images[1] })).data).toMatchObject({ phase: 'uploaded', uploaded_count: 2, rendered_preview_count: 2, dom_preview_count: 2, submit_attempted: false })
    expect((document.getElementById('add') as HTMLInputElement).files?.[0].name).toBe('second.png')
    expect(selected).toHaveBeenCalledOnce(); expect(unselected).not.toHaveBeenCalled()
    await call('upload', { image_index: 1, image: images[1] }); expect(selected).toHaveBeenCalledOnce()
  })
  it('keeps upstream input ordering and first-input fallback without requiring visible file inputs', () => {
    document.body.innerHTML = '<input id="document" type="file" accept=".pdf"><input id="first" type="file" accept="IMAGE/*" hidden><input id="second" type="file" accept=".png" hidden><input class="upload-input" type="file" id="initial1"><input class="upload-input" type="file" id="initial2">'
    expect(imageUploadInput(true)?.id).toBe('initial1')
    expect(imageUploadInput(false)?.id).toBe('first')
    document.querySelectorAll('input').forEach((el) => el.removeAttribute('accept'))
    expect(imageUploadInput(false)?.id).toBe('document')
    document.body.innerHTML = ''; expect(imageUploadInput(false)).toBeNull()
  })
  it('acknowledges upstream DOM preview thresholds while reporting visible count separately', async () => {
    form(); journal('upload_pending', { uploaded: 0, pending_index: 0 })
    document.querySelector('.img-preview-area')!.innerHTML = '<div class="pr" hidden></div><div class="pr"></div>'
    expect((await call('status')).data).toMatchObject({ phase: 'uploaded', uploaded_count: 1, dom_preview_count: 2, rendered_preview_count: 1 })
  })
  it('selects the first editor when several valid controls match', () => {
    document.body.innerHTML = '<div role="textbox" contenteditable="true" id="first"></div><div role="textbox" contenteditable="true" id="second"></div><xhs-publish-btn id="publish1"></xhs-publish-btn><xhs-publish-btn id="publish2"></xhs-publish-btn>'
    expect(editor().id).toBe('first')
    document.body.innerHTML = '<div class="ql-editor" id="quill"></div><div class="publish-page-publish-btn"><button class="bg-red" id="old1"></button><button class="bg-red" id="old2"></button></div>'
    expect(editor().id).toBe('quill')
  })
  it('preserves untouched default options and tolerates duplicate title and editor controls', async () => {
    form(); journal('uploaded')
    document.querySelector('.permission-card-wrapper')!.remove()
    const scheduled = document.querySelector<HTMLInputElement>('.post-time-wrapper input')!
    scheduled.checked = true
    document.body.insertAdjacentHTML('beforeend', '<div class="d-input"><input id="otherTitle"></div><div role="textbox" contenteditable="true" id="otherBody"></div><div class="custom-switch-card">原创声明<div class="d-switch"><input type="checkbox" checked></div></div><div class="custom-switch-card">原创声明<div class="d-switch"><input type="checkbox"></div></div>')
    const original = document.querySelector<HTMLInputElement>('.custom-switch-card input')!
    const toggles = vi.fn(); scheduled.parentElement!.addEventListener('click', toggles); original.parentElement!.addEventListener('click', toggles)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const response = await call('configure')
    expect(response.status).toBe('ok'); expect(response.data.phase).toBe('ready')
    expect(response.data.review).toMatchObject({ observed_options: { visibility: null, scheduled: true, is_original: true } })
    expect(toggles).not.toHaveBeenCalled(); expect((document.getElementById('otherTitle') as HTMLInputElement).value).toBe('')
    expect(document.getElementById('otherBody')!.textContent).toBe('')
  })
  it('selects the first matching visibility option without requiring a unique option', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, visibility: '仅自己可见' }) })
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option" id="choice1">仅自己可见</div><div class="custom-option" id="choice2">仅自己可见</div></div></div>')
    const chosen = vi.fn(), ignored = vi.fn()
    document.getElementById('choice1')!.addEventListener('click', () => { chosen(); document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    document.getElementById('choice2')!.addEventListener('click', ignored)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).status).toBe('ok'); expect(chosen).toHaveBeenCalledOnce(); expect(ignored).not.toHaveBeenCalled()
  })
  it('applies a new visibility passed directly to configure instead of using the saved public setting', async () => {
    form(); journal('ready')
    const title = document.querySelector<HTMLInputElement>('.d-input input')!
    title.value = '保留当前标题'
    const body = editor(); body.innerHTML = '<p>保留当前正文</p><p><a>#已有话题</a></p>'
    const initialHTML = body.innerHTML
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper" hidden><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div><input type="file" accept=".png">')
    const dropdown = document.querySelector<HTMLElement>('.d-select-content')!
    const menu = document.querySelector<HTMLElement>('.d-options-wrapper')!
    const opened = vi.fn(() => { menu.hidden = false })
    dropdown.addEventListener('click', opened)
    const selected = vi.fn(() => { dropdown.textContent = '仅自己可见'; menu.hidden = true })
    document.querySelector('.custom-option')!.addEventListener('click', selected)
    const uploaded = vi.fn(); document.querySelector('input[type="file"]')!.addEventListener('change', uploaded)
    const published = vi.fn(); document.querySelector('xhs-publish-btn')!.addEventListener('click', published)
    const response = await call('configure', { visibility: '仅自己可见' })
    expect(response.status).toBe('ok')
    expect(response.data.review).toMatchObject({ visibility: '仅自己可见', observed_options: { visibility: '仅自己可见' }, observed_text: { title: '保留当前标题' } })
    expect(opened).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledOnce()
    expect(title.value).toBe('保留当前标题'); expect(body.innerHTML).toBe(initialHTML)
    expect(uploaded).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled()
    expect((await call('status')).data.review).toMatchObject({ visibility: '仅自己可见' })
    expect(response.data).toMatchObject({ uploaded_count: 1, submit_attempted: false, publication_enabled: false })
  })
  it('selects non-focusable visibility controls without applying the publish-tab active rule', async () => {
    form(); journal('ready')
    const dropdown = document.querySelector<HTMLElement>('.d-select-content')!
    dropdown.tabIndex = -1
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option" tabindex="-1">仅自己可见</div></div></div>')
    const selected = vi.fn(() => { dropdown.textContent = '仅自己可见' })
    document.querySelector('.custom-option')!.addEventListener('click', selected)
    expect((await call('configure', { visibility: '仅自己可见' })).data.review).toMatchObject({ observed_options: { visibility: '仅自己可见' } })
    expect(selected).toHaveBeenCalledOnce()
  })
  it('waits for the first matching option to become visible rather than choosing a later visible copy', async () => {
    form(); journal('ready')
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option" id="firstOption" style="display:none">仅自己可见</div><div class="custom-option" id="laterOption">仅自己可见</div></div></div>')
    const first = document.getElementById('firstOption')!, chosen = vi.fn(), ignored = vi.fn()
    first.addEventListener('click', chosen)
    document.getElementById('laterOption')!.addEventListener('click', ignored)
    setTimeout(() => { first.style.display = '' }, 1250)
    const pending = xiaohongshuPublishTools.xhs_publish_content({ action: 'configure', operation_id: id, visibility: '仅自己可见' })
    await vi.advanceTimersByTimeAsync(750)
    expect(chosen).not.toHaveBeenCalled(); expect(ignored).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ status: 'ok' })
    expect(chosen).toHaveBeenCalledOnce(); expect(ignored).not.toHaveBeenCalled()
  })
  it('waits for the visibility dropdown to appear before trying to open it', async () => {
    form(); journal('ready')
    document.querySelector('.permission-card-wrapper')!.remove()
    const selected = vi.fn()
    setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<div class="permission-card-wrapper"><div class="d-select-content">公开可见</div></div>')
      document.querySelector('.d-select-content')!.addEventListener('click', () => {
        document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
        document.querySelector('.custom-option')!.addEventListener('click', selected)
      })
    }, 750)
    const pending = xiaohongshuPublishTools.xhs_publish_content({ action: 'configure', operation_id: id, visibility: '仅自己可见' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ status: 'ok' }); expect(selected).toHaveBeenCalledOnce()
  })
  it.each([{}, { visibility: '仅自己可见' }])('retains the partial update scope after failure when retrying with %s', async (retryArgs) => {
    form(); journal('ready')
    expect((await call('configure', { visibility: '仅自己可见' })).error_code).toBe('PUBLISH_STEP_FAILED')
    expect(JSON.parse(sessionStorage.getItem('eo2_xhs_image_publish_v1')!).configure_fields).toEqual(['visibility'])
    const title = document.querySelector<HTMLInputElement>('.d-input input')!, body = editor()
    title.value = '保留网页标题'; body.innerHTML = '<p>保留网页正文</p><p><a>#已有话题</a></p>'
    const initialHTML = body.innerHTML
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div><input type="file">')
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    const uploaded = vi.fn(), published = vi.fn(), scheduled = vi.fn()
    document.querySelector('input[type="file"]')!.addEventListener('change', uploaded)
    document.querySelector('xhs-publish-btn')!.addEventListener('click', published)
    document.querySelector('.d-switch')!.addEventListener('click', scheduled)
    const response = await call('configure', retryArgs)
    expect(response).toMatchObject({ status: 'ok', data: { uploaded_count: 1, phase: 'ready' } })
    expect(response.data.review).toMatchObject({ observed_options: { visibility: '仅自己可见' } })
    expect(title.value).toBe('保留网页标题'); expect(body.innerHTML).toBe(initialHTML)
    expect(uploaded).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled(); expect(scheduled).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('eo2_xhs_image_publish_v1')!).configure_fields).toBeUndefined()
  })
  it('combines a new requested field with the failed partial update without rewriting unrelated content', async () => {
    form(); journal('ready')
    expect((await call('configure', { visibility: '仅自己可见' })).status).toBe('error')
    const body = editor(); body.innerHTML = '<p>保留正文和话题</p>'
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    const response = await call('configure', { title: '新标题' })
    expect(response.status).toBe('ok')
    expect(response.data.review).toMatchObject({ observed_text: { title: '新标题', content: '保留正文和话题' }, observed_options: { visibility: '仅自己可见' } })
  })
  it('accepts a visibility-only retry of a legacy configuring journal without rewriting the body', async () => {
    form(); journal('configuring')
    const body = editor(); body.innerHTML = '<p>旧版本准备好的正文</p>'
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    const selected = vi.fn(); document.querySelector('.custom-option')!.addEventListener('click', selected)
    expect((await call('configure', { visibility: '仅自己可见' })).status).toBe('ok')
    expect(body.innerHTML).toBe('<p>旧版本准备好的正文</p>'); expect(selected).toHaveBeenCalledOnce()
  })
  it('accepts the complete configure arguments used in the user report while preserving uploaded images', async () => {
    form(); journal('ready')
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure', { title: '修改标题', content: '修改正文', tags: [], visibility: '仅自己可见' })
    await vi.advanceTimersByTimeAsync(1000)
    const response = await pending
    expect(response.data.review).toMatchObject({ visibility: '仅自己可见', observed_text: { title: '修改标题', content: '修改正文' }, observed_options: { visibility: '仅自己可见' } })
    expect(response.data.uploaded_count).toBe(1)
  })
  it('preserves unrelated scheduled and original settings during a visibility-only update', async () => {
    form(); const schedule_at = new Date(Date.now() + 3600000).toISOString()
    journal('ready', { request: publishRequest({ ...request, schedule_at, is_original: true, products: ['existing-product'] }) })
    vi.setSystemTime(Date.now() + 60000)
    document.body.insertAdjacentHTML('beforeend', '<div class="custom-switch-card">原创声明<div class="d-switch"><input type="checkbox" checked></div></div><div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    const scheduled = document.querySelector<HTMLInputElement>('.post-time-wrapper input')!
    scheduled.checked = true
    const toggled = vi.fn(); scheduled.parentElement!.addEventListener('click', toggled)
    document.querySelector('.custom-switch-card .d-switch')!.addEventListener('click', toggled)
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    expect((await call('configure', { visibility: '仅自己可见' })).data.review).toMatchObject({ schedule_at, is_original: true, observed_options: { scheduled: true, is_original: true, visibility: '仅自己可见' } })
    expect(toggled).not.toHaveBeenCalled()
    expect(JSON.parse(sessionStorage.getItem('eo2_xhs_image_publish_v1')!).request.products).toEqual(['existing-product'])
  })
  it('uses configure overrides on the first fill as well as subsequent updates', async () => {
    form(); journal('uploaded')
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    document.querySelector('.custom-option')!.addEventListener('click', () => { document.querySelector('.d-select-content')!.textContent = '仅自己可见' })
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure', { visibility: '仅自己可见' }); await vi.advanceTimersByTimeAsync(1000)
    const response = await pending
    expect(response.data.review).toMatchObject({ visibility: '仅自己可见', observed_text: { title: request.title, content: request.content }, observed_options: { visibility: '仅自己可见' } })
  })
  it('rejects unsupported new settings before changing the current form or saved request', async () => {
    form(); journal('ready')
    const before = sessionStorage.getItem('eo2_xhs_image_publish_v1')
    const clicked = vi.fn(); document.querySelector('.d-select-content')!.addEventListener('click', clicked)
    expect((await call('configure', { visibility: 'unsupported' })).error_code).toBe('PUBLISH_STEP_FAILED')
    expect(sessionStorage.getItem('eo2_xhs_image_publish_v1')).toBe(before)
    expect(clicked).not.toHaveBeenCalled()
  })
  it('uses first matching product controls and saves the first selected modal', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, products: ['product-test'] }) })
    document.body.insertAdjacentHTML('beforeend', '<button id="add1"><span class="d-text">添加商品</span></button><button id="add2"><span class="d-text">添加商品</span></button><div class="multi-goods-selector-modal" id="modal1" hidden><input placeholder="搜索商品ID 或 商品名称"><input placeholder="搜索商品ID 或 商品名称"><div class="goods-list-normal"><div class="good-card-container">商品一<div class="d-checkbox"><input type="checkbox"></div><div class="d-checkbox"><input type="checkbox"></div></div></div><div class="goods-selected-footer"><button id="save1">保存</button><button id="save2">保存</button></div></div><div class="multi-goods-selector-modal" id="modal2" hidden></div>')
    const ignored = vi.fn(), saved = vi.fn()
    document.getElementById('add1')!.addEventListener('click', () => { document.getElementById('modal1')!.hidden = false; document.getElementById('modal2')!.hidden = false })
    document.getElementById('add2')!.addEventListener('click', ignored)
    const checkbox = document.querySelector<HTMLInputElement>('#modal1 .d-checkbox input')!
    checkbox.parentElement!.addEventListener('click', () => { checkbox.checked = true })
    document.getElementById('save1')!.addEventListener('click', () => { saved(); document.getElementById('modal1')!.hidden = true })
    document.getElementById('save2')!.addEventListener('click', ignored)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(5000)
    const response = await pending
    expect(response.status).toBe('ok'); expect(response.data.review).toMatchObject({ products: [{ keyword: 'product-test', selected: '商品一' }] })
    expect(saved).toHaveBeenCalledOnce(); expect(ignored).not.toHaveBeenCalled()
    expect(checkbox.checked).toBe(true)
  })
  it('fills the upstream editors, verifies multiline text and reaches ready without publishing', async () => {
    form(); journal('uploaded')
    const body = document.querySelector<HTMLElement>('[role="textbox"]')!
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => {
      const append = window.getSelection()?.getRangeAt(0).collapsed
      body.textContent = (append ? body.textContent : '') + value
      return true
    }) })
    const response = await call('configure')
    expect(response.status).toBe('ok'); expect(response.data.phase).toBe('ready')
    expect(editorText(body)).toBe(request.content)
    expect(response.data.submit_attempted).toBe(false)
  })
  it('reports website-normalized text without enforcing our exact-text gate', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, title: ' 标题 ' }) })
    const title = document.querySelector<HTMLInputElement>('.d-input input')!
    title.addEventListener('input', () => { title.value = title.value.trim() })
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value.replace(/\n/g, ' '); return true }) })
    const response = await call('configure')
    expect(response.status).toBe('ok')
    expect(response.data.review).toMatchObject({ observed_text: { title: '标题', content: '第一行 第二行' } })
    expect(response.data).toMatchObject({ publication_enabled: false, published_verified: false, submit_attempted: false })
  })
  it('does not generalize tab hit-testing to text and option controls', async () => {
    form(); journal('uploaded'); vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    expect((await call('configure')).status).toBe('ok')
  })
  it('uses the first topic suggestion without requiring a synchronous HTML mutation', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, tags: ['话题'] }) })
    document.body.insertAdjacentHTML('beforeend', '<div id="creator-editor-topic-container"><div class="item">话题一</div><div class="item">话题二</div></div>')
    const clicked = vi.fn(); document.querySelector('.item')!.addEventListener('click', clicked)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = (window.getSelection()?.getRangeAt(0).collapsed ? body.textContent : '') + value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(6000)
    expect((await pending).data.review).toMatchObject({ topics: [{ selected: '话题一', method: 'first_suggestion_clicked' }] })
    expect(clicked).toHaveBeenCalledOnce()
    expect(vi.mocked(pressWithCdp).mock.calls.map(([key]) => key)).toEqual([...Array(20).fill('ArrowDown'), 'Enter', 'Enter'])
    expect(vi.mocked(pressWithCdp).mock.calls.every(([, element]) => element === body)).toBe(true)
  })
  it('reports visibility observations without requiring matching label text', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, visibility: '仅自己可见' }) })
    document.body.insertAdjacentHTML('beforeend', '<div class="d-options-wrapper"><div class="d-grid-item"><div class="custom-option">仅自己可见</div></div></div>')
    const clicked = vi.fn(); document.querySelector('.custom-option')!.addEventListener('click', clicked)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).data.review).toMatchObject({ visibility: '仅自己可见', observed_options: { visibility: '公开可见' } })
    expect(clicked).toHaveBeenCalledOnce()
  })
  it('uses the requested timestamp zone and clicks scheduling without requiring readable checkbox state', async () => {
    form(); const schedule_at = new Date(Date.now() + 7200000).toISOString().replace(/Z$/, '+00:00')
    journal('uploaded', { request: publishRequest({ ...request, schedule_at }) })
    const schedule = document.querySelector<HTMLElement>('.d-switch')!; schedule.innerHTML = ''
    const clicked = vi.fn(); schedule.addEventListener('click', clicked)
    document.body.insertAdjacentHTML('beforeend', '<div class="date-picker-container"><input></div>')
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(2000)
    expect((await pending).data.review).toMatchObject({ observed_options: { scheduled: null, scheduled_at: schedule_at.slice(0, 16).replace('T', ' ') } })
    expect(clicked).toHaveBeenCalledOnce()
  })
  it('inherits original-declaration notice retry without imposing a final switch-state requirement', async () => {
    form(); journal('uploaded', { request: publishRequest({ ...request, is_original: true }) })
    document.body.insertAdjacentHTML('beforeend', '<div class="custom-switch-card">原创声明<div class="d-switch" id="original"></div></div><div class="footer" id="notice" hidden>原创声明须知<div class="d-checkbox"></div></div><div class="footer" id="declaration" hidden>声明原创<div class="d-checkbox"></div><button class="custom-button" disabled>声明原创</button></div>')
    document.getElementById('original')!.addEventListener('click', () => { document.getElementById('notice')!.hidden = false; document.getElementById('declaration')!.hidden = false })
    const notice = vi.fn(), retry = vi.fn(), confirmed = vi.fn()
    document.querySelector('#notice .d-checkbox')!.addEventListener('click', notice)
    document.querySelector('#declaration .d-checkbox')!.addEventListener('click', () => { retry(); document.querySelector('button.custom-button')!.removeAttribute('disabled') })
    document.querySelector('button.custom-button')!.addEventListener('click', confirmed)
    const body = editor()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true }) })
    const pending = call('configure'); await vi.advanceTimersByTimeAsync(4000)
    expect((await pending).data.review).toMatchObject({ is_original: true, observed_options: { is_original: null } })
    expect(notice).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledOnce(); expect(confirmed).toHaveBeenCalledOnce()
  })
  it('reconfigures a prepared form when explicitly asked instead of returning an old review', async () => {
    form(); journal('ready', { review: { old: true } })
    const body = editor()
    const writes = vi.fn((_command: string, _ui: boolean, value: string) => { body.textContent = value; return true })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: writes })
    expect((await call('configure')).data.review).not.toEqual({ old: true })
    expect(writes).toHaveBeenCalledOnce()
    const updated = await call('prepare', { ...request, content: '更新后的正文' })
    expect(updated.data.uploaded_count).toBe(1)
    expect((await call('configure')).data.review).toMatchObject({ observed_text: { content: '更新后的正文' } })
    expect(writes).toHaveBeenCalledTimes(2)
  })
  it('inherits tab popover dismissal rather than requiring manual removal', async () => {
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input"><div class="d-popover"></div>'
    vi.spyOn(document, 'elementFromPoint').mockImplementation(() => document.querySelector('.d-popover') ?? document.querySelector('.creator-tab'))
    const pending = call('prepare', request); await vi.advanceTimersByTimeAsync(2000)
    expect((await pending).status).toBe('ok')
    expect(document.querySelector('.d-popover')).toBeNull()
  })
  it('does not require an arbitrary operation identifier character set or length', async () => {
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input">'
    expect((await call('prepare', { ...request, operation_id: '图文一' })).status).toBe('ok')
  })
  it('opens the upstream publish URL in the current tab', async () => {
    page('/explore', 'www.xiaohongshu.com')
    const response = await call('open')
    expect(response.status).toBe('navigated'); expect(response.target_url).toBe('https://creator.xiaohongshu.com/publish/publish?source=official')
  })
  it('allows changing text and options in the same preparation', async () => {
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input">'
    expect((await call('prepare', request)).status).toBe('ok')
    expect((await call('prepare', { ...request, content: 'changed' })).status).toBe('ok')
    expect(JSON.parse(sessionStorage.getItem('eo2_xhs_image_publish_v1')!).request.content).toBe('changed')
  })
  it('retains existing website content and reports it separately from requested uploads', async () => {
    form(); const body = editor(); body.textContent = 'existing draft'
    expect((await call('prepare', request))).toMatchObject({ status: 'ok', data: { existing_preview_count: 1, uploaded_count: 0 } })
    expect(editorText(body)).toBe('existing draft')
    expect((await call('status')).data.uploaded_count).toBe(0)
  })
  it('does not count an existing preview as the completion of a newly supplied image', async () => {
    form(); document.body.insertAdjacentHTML('beforeend', '<input type="file" accept=".png" hidden>')
    await call('prepare', request)
    stageXiaohongshuImage({ action: 'upload', operation_id: id, image_index: 0, image: request.images[0], _eo2_image: imagePayload(png, 'photo.png') })
    const pending = call('upload', { image_index: 0, image: request.images[0] })
    await vi.advanceTimersByTimeAsync(21000)
    expect((await pending).error_code).toBe('UPLOAD_PENDING')
    expect((await call('status')).data.uploaded_count).toBe(0)
    document.querySelector('.img-preview-area')!.insertAdjacentHTML('beforeend', '<div class="pr"></div>')
    expect((await call('status')).data).toMatchObject({ uploaded_count: 1, dom_preview_count: 2, existing_preview_count: 1 })
  })
  it('removes submit from discovery while retaining the existing write authorization annotation', () => {
    const tool = xiaohongshuRecipe.tools.find((entry) => entry.name === 'xhs_publish_content')!
    const schema = tool.inputSchema as { properties: { action: { enum: string[] } } }
    expect(schema.properties.action.enum).not.toContain('submit')
    expect(tool.readOnlyHint).toBe(false)
  })
  it.each(['ready', 'submitted', 'verified'])('blocks stale submit calls in %s state before any webpage interaction', async (phase) => {
    form(); journal(phase); const clicked = vi.fn()
    document.querySelector('xhs-publish-btn')!.addEventListener('click', clicked)
    const before = sessionStorage.getItem('eo2_xhs_image_publish_v1')
    expect((await call('submit', { confirm: true }))).toMatchObject({ error_code: 'PUBLICATION_DEFERRED', data: { publication_enabled: false, submit_attempted: false } })
    expect(sessionStorage.getItem('eo2_xhs_image_publish_v1')).toBe(before)
    expect(clicked).not.toHaveBeenCalled()
  })
  it('does not globally lock another requested publication after an unknown outcome', async () => {
    form(); journal('submitted', { submitted_at: '2026-10-09T05:34:10Z' })
    document.body.innerHTML = '<div class="creator-tab">上传图文</div><input type="file" class="upload-input">'
    expect((await call('prepare', { ...request, operation_id: 'new_requested_publication' })).data).toMatchObject({
      operation_id: 'new_requested_publication', phase: 'prepared', submit_attempted: false,
    })
  })
  it('keeps historical unknown submission results unknown while publication is deferred', async () => {
    form(); journal('submitted', { submitted_at: new Date().toISOString() })
    page('/new/home'); document.body.innerHTML = '<h1>创作中心</h1>'
    expect((await call('status')).error_code).toBe('PUBLISH_RESULT_UNKNOWN')
    document.body.innerHTML = '<h1>发布成功</h1>'
    expect((await call('status')).error_code).toBe('PUBLISH_RESULT_UNKNOWN')
  })
  it('preserves upload-pending state across status without sending a second image', async () => {
    form(); journal('upload_pending', { uploaded: 0, pending_index: 0 })
    expect((await call('status')).data.phase).toBe('uploaded')
    expect((await call('upload', { image_index: 0, image: request.images[0] })).data.uploaded_count).toBe(1)
  })
  it('restarts image preparation explicitly after refresh has removed acknowledged previews', async () => {
    form(); journal('ready')
    document.querySelector('.img-preview-area')!.innerHTML = ''
    expect((await call('prepare', request)).data).toMatchObject({ phase: 'prepared', uploaded_count: 0, existing_preview_count: 0 })
  })
  it('preserves upstream website length validation during preparation', async () => {
    form(); journal('uploaded')
    document.body.insertAdjacentHTML('beforeend', '<div class="title-container"><div class="max_suffix">标题超过长度</div></div>')
    expect((await call('configure')).error_code).toBe('PUBLISH_STEP_FAILED')
    expect((await call('status')).data.submit_attempted).toBe(false)
  })
})
