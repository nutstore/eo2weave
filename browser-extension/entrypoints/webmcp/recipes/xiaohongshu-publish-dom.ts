// Adapt selectors and ordering from upstream xiaohongshu/publish.go at a5c8f779.
// Input uses the upstream-style CDP driver in the current tab; observations stay separate.
import { visible, clean } from './xiaohongshu-page'
import type { PublishFormRequest, PublishFormField } from './xiaohongshu-publish-policy'
import { sampleInputTiming } from '../xiaohongshu-input-protocol'
import { clickWithCdp, typeWithCdp, pressWithCdp, clickPointWithCdp } from './xiaohongshu-publish-input'

export const delay = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function rendered(el: Element | null): el is HTMLElement {
  if (!visible(el)) return false
  // Port upstream isElementVisible exclusions for duplicated hidden controls.
  if (el.tabIndex === -1 && el.hasAttribute('tabindex') && !el.classList.contains('active')) return false
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const style = getComputedStyle(p)
    if (p.hidden || p.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden'
      || style.opacity === '0' || Number(style.opacity) === 0.00001 || style.left === '-9999px' || style.top === '-9999px') return false
  }
  return true
}
export function elements(selector: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(rendered)
}
export function first(selector: string, root: ParentNode = document): HTMLElement {
  const found = elements(selector, root)[0]
  if (!found) throw new Error(`Visible control unavailable: ${selector}.`)
  return found
}
export function imageUploadInput(firstImage: boolean): HTMLInputElement | null {
  // Port findImageUploadInput; hidden inputs remain valid upload targets.
  if (firstImage) return document.querySelector<HTMLInputElement>('input.upload-input[type="file"]')
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
  return inputs.find((el) => {
    const accept = el.accept.toLowerCase()
    return accept.includes('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.heic'].some((ext) => accept.includes(ext))
  }) ?? inputs[0] ?? null
}
export function disabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled') || el.getAttribute('submit-disabled') === 'true'
}
export async function click(el: HTMLElement, _deadline = Date.now() + 15000) {
  await clickWithCdp(el)
}
export async function until(check: () => boolean, deadline: number, message: string) {
  while (Date.now() < deadline) { if (check()) return; await delay() }
  throw new Error(message)
}
function visibilityControlVisible(el: HTMLElement): boolean {
  if (!visible(el)) return false
  // Port humanize.Visible for this control, without the publish-tab exclusions.
  let opacity = 1
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const value = Number.parseFloat(style.opacity)
    if (!Number.isNaN(value)) opacity *= value
  }
  return opacity >= 0.1
}
async function clickVisibilityControl(el: HTMLElement, deadline: number) {
  await click(el, deadline)
}
async function setVisibility(visibility: string, deadline: number) {
  if (visibility === '公开可见') return
  let dropdown: HTMLElement | null = null
  await until(() => !!(dropdown = document.querySelector<HTMLElement>('div.permission-card-wrapper div.d-select-content')),
    deadline, 'Visibility dropdown unavailable after waiting for the website.')
  await clickVisibilityControl(dropdown!, deadline); await delay(500)
  // Upstream enumerates every matching option, then waits to click the first
  // text match. Do not filter out a hidden or non-focusable option beforehand.
  const options = document.querySelectorAll<HTMLElement>('div.d-options-wrapper div.d-grid-item div.custom-option')
  for (const option of options) {
    if (!clean(option.innerText).includes(visibility)) continue
    await clickVisibilityControl(option, deadline); await delay(200)
    return
  }
  throw new Error('Requested visibility unavailable.')
}
export async function input(el: HTMLInputElement, value: string) {
  await typeWithCdp(el, value)
}
export function editor(): HTMLElement {
  for (const selector of ['div[role="textbox"][contenteditable="true"]', 'div.tiptap[contenteditable="true"]', 'div.ql-editor']) {
    const found = elements(selector)
    if (found.length) return found[0]
  }
  const placeholders = elements('p[data-placeholder]').filter((el) => el.getAttribute('data-placeholder')?.includes('输入正文描述'))
  // Port findTextboxParent's five-parent search without adding editable attributes.
  let parent = placeholders[0]?.parentElement ?? null
  for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
    if (parent.getAttribute('role') === 'textbox') return parent
  }
  throw new Error('Body editor unavailable.')
}
export function editorText(el: HTMLElement): string {
  // Tiptap paragraph boundaries and explicit hard breaks must preserve body newlines.
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof HTMLBRElement) return '\n'
    return Array.from(node.childNodes).map(walk).join('')
  }
  const blocks = Array.from(el.children)
  return blocks.length && blocks.every((block) => ['P', 'DIV'].includes(block.tagName))
    ? blocks.map((block) => block.childNodes.length === 1 && block.firstChild instanceof HTMLBRElement ? '' : walk(block)).join('\n') : walk(el)
}
async function writeEditor(el: HTMLElement, text: string, append = false) {
  await typeWithCdp(el, text, append)
}
export function previews(): HTMLElement[] {
  // Upstream counts all preview nodes, not only visible preview nodes.
  return Array.from(document.querySelectorAll<HTMLElement>('.img-preview-area .pr'))
}
export function checked(el: HTMLElement): boolean | null {
  const box = el.matches('input[type="checkbox"]') ? el as HTMLInputElement : el.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box) return box.checked
  const aria = el.getAttribute('aria-checked')
  if (aria === 'true' || aria === 'false') return aria === 'true'
  if (el.querySelector('.d-checkbox-simulator.checked') || el.classList.contains('checked')) return true
  return null
}
export function lengthError(): string | null {
  return elements('div.title-container div.max_suffix, div.edit-container div.length-error').map((el) => clean(el.innerText)).filter(Boolean).join('; ') || null
}
function permission(): string | null {
  const control = Array.from(document.querySelectorAll<HTMLElement>('div.permission-card-wrapper div.d-select-content')).find(visibilityControlVisible)
  return control ? clean(control.innerText) : null
}
function originalSwitch(): HTMLElement | null {
  const cards = elements('div.custom-switch-card').filter((el) => clean(el.innerText).includes('原创声明'))
  for (const card of cards) {
    const control = elements('div.d-switch', card)[0]
    if (control) return control
  }
  return null
}
export function formSnapshot(): string {
  const title = first('div.d-input input') as HTMLInputElement
  const body = editor()
  const schedule = elements('.post-time-wrapper .d-switch')[0]
  const original = originalSwitch()
  return JSON.stringify({ title: title.value, body: editorText(body), body_html: body.innerHTML,
    images: previews().map((el) => el.querySelector('img')?.getAttribute('src') ?? el.innerHTML),
    visibility: permission(), schedule: schedule ? checked(schedule) : null,
    date: (elements('.date-picker-container input')[0] as HTMLInputElement | undefined)?.value ?? null,
    original: original ? checked(original) : null,
  })
}
export async function imageTab(deadline: number) {
  if (previews().length || elements('div.d-input input').length) return
  await selectPublishTab('上传图文', deadline)
}
export async function selectPublishTab(label: string, deadline: number) {
  let selected: HTMLElement | undefined
  // Upstream getTabElement chooses the first visible matching tab, not a
  // unique text match. Off-screen probe copies must not count as controls.
  await until(() => {
    selected = elements('div.creator-tab').find((el) => {
      if (clean(el.innerText) !== label) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
    })
    return selected !== undefined
  }, deadline, `Publish tab ${label} unavailable after waiting for the creator page.`)
  // Upstream checks tab obstruction, dismisses d-popover and retries this action.
  while (Date.now() < deadline) {
    const tab = selected!
    tab.scrollIntoView({ block: 'center' })
    const rect = tab.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit === tab || (hit && tab.contains(hit))) { await click(tab, deadline); break }
    await dismissPopCover()
    await delay(200)
    if (Date.now() >= deadline) throw new Error(`Publish tab ${label} remained obscured after dismissing the overlay.`)
  }
  // Upstream waits one second after selecting the image tab so its Vue form
  // replaces the default video input before the first file is supplied.
  await delay(1000)
  const inputSelector = label === '上传视频' ? '.upload-input, input[type="file"]' : 'input.upload-input[type="file"]'
  await until(() => document.querySelector(inputSelector) !== null, deadline, 'Upload input did not appear.')
}
async function dismissPopCover() {
  const popover = () => document.querySelector('div.d-popover')
  await pressWithCdp('Escape')
  await delay(200)
  if (!popover()) return
  await clickPointWithCdp(380 + Math.random() * 100, 20 + Math.random() * 60)
  await delay(200)
  popover()?.remove()
}
export async function configureForm(request: PublishFormRequest & { is_original?: boolean }, deadline: number, fields?: ReadonlySet<PublishFormField>, kind: 'image' | 'video' = 'image') {
  const apply = (field: PublishFormField) => !fields || fields.has(field)
  const title = first('div.d-input input') as HTMLInputElement
  if (apply('title')) {
    await input(title, request.title)
    const titleError = elements('div.title-container div.max_suffix').map((el) => clean(el.innerText)).filter(Boolean).join('; ')
    if (kind === 'image' && titleError) throw new Error(`Website length validation: ${titleError}`)
    if (kind === 'video') await delay(sampleInputTiming(-0.51, 0.40, 200, 3000))
  }
  let body: HTMLElement | undefined
  await until(() => {
    try { body = editor(); return true } catch { return false }
  }, Math.min(deadline, Date.now() + 10000), 'Body editor unavailable after waiting for the website.')
  const contentEditor = body!
  // Updating body or topics rebuilds the topic-bearing editor from the requested
  // body. A visibility-only update leaves the current text and topics untouched.
  const writeBody = apply('content') || apply('tags')
  if (writeBody) {
    await writeEditor(contentEditor, request.content)
    const guide = elements('.feature-guide__btn')
    if (kind === 'image' && guide.length) {
      // Upstream treats closing the optional feature guide as best effort.
      try { await click(guide[0], deadline) } catch { /* Continue with the upstream title click. */ }
    }
    // Port waitAndClickTitleInput instead of substituting focus/blur.
    await delay(1000); await click(title, deadline)
  }
  const topicResults: Array<{ requested: string; selected: string | null; method: string }> = []
  if (writeBody && request.tags.length) {
    // Port inputTags' editor focus, 20 ArrowDown keys and two Enter keys.
    await delay(1000)
    for (let i = 0; i < 20; i++) { await pressWithCdp('ArrowDown', contentEditor); await delay(10) }
    await pressWithCdp('Enter', contentEditor); await pressWithCdp('Enter', contentEditor)
    await delay(1000)
  }
  for (const tag of writeBody ? request.tags : []) {
    if (Date.now() >= deadline) throw new Error('Topic configuration exceeded call budget.')
    await writeEditor(contentEditor, '#', true); await delay(200); await writeEditor(contentEditor, tag, true); await delay(1000)
    const suggestions = elements('#creator-editor-topic-container .item')
    if (suggestions.length) {
      const selected = clean(suggestions[0].innerText)
      await click(suggestions[0], deadline); await delay(500)
      topicResults.push({ requested: tag, selected, method: 'first_suggestion_clicked' })
    } else {
      await writeEditor(contentEditor, ' ', true)
      topicResults.push({ requested: tag, selected: null, method: 'plain_text_fallback' })
    }
  }
  if (kind === 'image' && lengthError()) throw new Error(`Website length validation: ${lengthError()}`)
  if (kind === 'video' && writeBody) await delay(sampleInputTiming(-0.51, 0.40, 200, 3000))
  const schedule = elements('.post-time-wrapper .d-switch')
  if (apply('schedule_at') && request.schedule_at && !schedule.length) throw new Error('Scheduled publishing switch unavailable.')
  if (apply('schedule_at') && request.schedule_at) {
    await click(schedule[0], deadline); await delay(800)
    // Match Go t.Format: retain the wall-clock time in the supplied RFC3339 zone.
    const date = request.schedule_at.slice(0, 16).replace('T', ' ')
    const dateInput = first('.date-picker-container input') as HTMLInputElement
    await input(dateInput, date)
    await delay(500)
  }
  if (apply('visibility')) await setVisibility(request.visibility, deadline)
  const original = originalSwitch()
  const warnings: string[] = []
  if (apply('is_original') && !original && request.is_original) throw new Error('Original declaration unavailable.')
  if (apply('is_original') && request.is_original && original && checked(original) !== true) {
    await click(original, deadline); await delay(500)
    await confirmOriginalDeclaration(deadline, warnings)
  }
  const productResults = apply('products') ? await bindProducts(request.products, deadline, warnings) : []
  if (kind === 'image' && lengthError()) throw new Error(`Website length validation: ${lengthError()}`)
  return { topics: topicResults, products: productResults, visibility: request.visibility, is_original: request.is_original, schedule_at: request.schedule_at, dropped_tags: request.dropped_tags,
    observed_text: { title: title.value, content: editorText(contentEditor), length_unit: 'utf16_code_units' }, warnings,
    observed_options: { visibility: permission(), is_original: original ? checked(original) : null, scheduled: schedule.length ? checked(schedule[0]) : null,
      scheduled_at: (elements('.date-picker-container input')[0] as HTMLInputElement | undefined)?.value ?? null } }
}
async function confirmOriginalDeclaration(deadline: number, warnings: string[]) {
  const footer = (text: string) => elements('div.footer').find((el) => clean(el.innerText).includes(text))
  const checkNotice = async (root: HTMLElement) => {
    const box = first('div.d-checkbox', root)
    if (checked(box) !== true) await click(box, deadline)
  }
  await delay(800)
  const notice = footer('原创声明须知')
  if (!notice) warnings.push('Original declaration notice footer was not found.')
  else { try { await checkNotice(notice) } catch (caught) { warnings.push(caught instanceof Error ? caught.message : 'Original notice checkbox action failed.') } }
  await delay(500)
  const declaration = footer('声明原创')
  if (!declaration) throw new Error('Original declaration confirmation footer unavailable.')
  const button = first('button.custom-button', declaration)
  if (disabled(button)) {
    try { await checkNotice(declaration) } catch (caught) { warnings.push(caught instanceof Error ? caught.message : 'Original notice retry failed.') }
    await delay(300)
    if (disabled(button)) throw new Error('Original declaration confirmation button remains disabled.')
  }
  await click(button, deadline); await delay(300)
}
async function bindProducts(products: string[], deadline: number, warnings: string[]) {
  const results: Array<{ keyword: string; selected: string; observed_checked: boolean | null }> = []
  const failures: Array<{ keyword: string; message: string }> = []
  if (!products.length) return results
  const spans = elements('span.d-text').filter((el) => clean(el.innerText) === '添加商品')
  if (!spans.length) throw new Error('Add product unavailable; account product capability may be missing.')
  let trigger: HTMLElement | null = null
  for (const span of spans) {
    let parent = span.parentElement
    for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      if (parent.tagName === 'BUTTON' || parent.className.includes('d-button')) { trigger = parent; break }
    }
    if (trigger) break
  }
  if (!trigger) throw new Error('Add product control unavailable.')
  await click(trigger, deadline)
  await until(() => elements('.multi-goods-selector-modal').length > 0, Math.min(deadline, Date.now() + 15000), 'Product modal did not open.')
  const modal = first('.multi-goods-selector-modal')
  for (const keyword of products) {
    try {
      const search = first('input[placeholder="搜索商品ID 或 商品名称"]', modal) as HTMLInputElement
      await input(search, keyword)
      await pressWithCdp('Enter')
      await delay(1000)
      await until(() => !elements('.goods-list-loading', modal).length && elements('.goods-list-normal .good-card-container', modal).length > 0,
        Math.min(deadline, Date.now() + 10000), 'Product search results did not become available.')
      const card = elements('.goods-list-normal .good-card-container', modal)[0]
      const box = first('.d-checkbox', card)
      if (checked(box) !== true) { await click(box, deadline); await delay(800 + Math.random() * 700) }
      results.push({ keyword, selected: clean(card.innerText).slice(0, 400), observed_checked: checked(box) })
    } catch (caught) {
      failures.push({ keyword, message: caught instanceof Error ? caught.message : 'Product selection failed.' })
    }
    if (Date.now() >= deadline) {
      failures.push({ keyword, message: 'Product configuration exceeded the page call budget.' })
      break
    }
  }
  // Port the upstream save fallback and warning-only close timeout.
  let saved = false
  for (const selector of ['.goods-selected-footer button', '.goods-selected-footer .d-button--primary']) {
    const save = elements(selector, modal)[0]
    if (!save) continue
    try { await click(save, deadline); saved = true; break }
    catch (caught) { warnings.push(caught instanceof Error ? caught.message : 'Product save click failed.') }
  }
  if (!saved) warnings.push('Product save control was unavailable or could not be clicked.')
  try { await until(() => !rendered(modal), Math.min(deadline, Date.now() + 5000), 'Product modal did not close; binding was not verified.') }
  catch (caught) { warnings.push(caught instanceof Error ? caught.message : 'Product modal close timeout.') }
  // Upstream attempts the remaining keywords and saves before reporting failures.
  if (failures.length) throw new Error(`Product selection failed: ${JSON.stringify(failures)}`)
  // Preserve the selected identities for the visible review. Saving alone is not publication.
  return results
}
