// Adapt selectors and ordering from upstream xiaohongshu/publish.go at a5c8f779.
// Rod/CDP input is replaced with browser DOM input; every requested setting is verified.
import { visible, clean } from './xiaohongshu-page'
import type { PublishRequest } from './xiaohongshu-publish-policy'

export const delay = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export function rendered(el: Element | null): el is HTMLElement {
  if (!visible(el)) return false
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const style = getComputedStyle(p)
    if (p.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  }
  return true
}
export function elements(selector: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(rendered)
}
export function one(selector: string, root: ParentNode = document): HTMLElement {
  const found = elements(selector, root)
  if (found.length !== 1) throw new Error(`Expected one visible ${selector}; found ${found.length}.`)
  return found[0]
}
export function disabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled') || el.getAttribute('submit-disabled') === 'true'
}
export function clickable(el: HTMLElement): HTMLElement {
  if (!rendered(el) || disabled(el)) throw new Error('Control is hidden or disabled.')
  el.scrollIntoView({ block: 'center' })
  const rect = el.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width * .65, rect.top + rect.height / 2)
  if (!hit || !(hit === el || el.contains(hit))) throw new Error('Control is obscured; close the website overlay manually.')
  if (el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(rect.left + rect.width * .65, rect.top + rect.height / 2)
    if (inner instanceof HTMLElement && !disabled(inner)) return inner
  }
  return el
}
export function click(el: HTMLElement) { clickable(el).click() }
export async function until(check: () => boolean, deadline: number, message: string) {
  while (Date.now() < deadline) { if (check()) return; await delay() }
  throw new Error(message)
}
export function input(el: HTMLInputElement, value: string) {
  if (el.disabled || el.readOnly) throw new Error('Input is disabled or read-only.')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('Native input setter unavailable.')
  el.focus(); setter.call(el, value)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
}
export function editor(): HTMLElement {
  for (const selector of ['div[role="textbox"][contenteditable="true"]', 'div.tiptap[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]']) {
    const found = elements(selector)
    if (found.length) return one(selector)
  }
  const placeholders = elements('p[data-placeholder]').filter((el) => el.getAttribute('data-placeholder')?.includes('输入正文描述'))
  const parents = [...new Set(placeholders.map((el) => el.closest<HTMLElement>('[role="textbox"][contenteditable="true"]')).filter(rendered))]
  if (parents.length !== 1) throw new Error('Body editor unavailable or ambiguous.')
  return parents[0]
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
function writeEditor(el: HTMLElement, text: string, append = false) {
  el.focus()
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  if (append) range.collapse(false)
  selection?.removeAllRanges(); selection?.addRange(range)
  // execCommand uses the editor's input pipeline and supports Tiptap/Quill.
  if (!document.execCommand('insertText', false, text)) throw new Error('Website editor rejected DOM input; fill it manually and report the limitation.')
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
}
export function previews(): HTMLElement[] { return elements('.img-preview-area .pr') }
export function checked(el: HTMLElement): boolean | null {
  const box = el.matches('input[type="checkbox"]') ? el as HTMLInputElement : el.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box) return box.checked
  const aria = el.getAttribute('aria-checked')
  if (aria === 'true' || aria === 'false') return aria === 'true'
  if (el.querySelector('.d-checkbox-simulator.checked') || el.classList.contains('checked')) return true
  return null
}
async function setSwitch(el: HTMLElement, want: boolean, deadline: number) {
  const state = checked(el)
  if (state === null) throw new Error('Switch state unavailable; requested setting cannot be verified.')
  if (state !== want) click(el)
  await until(() => checked(el) === want, deadline, 'Switch selection not verified.')
}
export function challenge(): boolean {
  return elements('.captcha-container, .captcha-modal, .verify-container, .verify-dialog, .login-container, .login-modal').length > 0 || /\/login(?:\/|$)/.test(location.pathname)
}
export function lengthError(): string | null {
  return elements('div.title-container div.max_suffix, div.edit-container div.length-error').map((el) => clean(el.innerText)).filter(Boolean).join('; ') || null
}
function permission(): string { return clean(one('div.permission-card-wrapper div.d-select-content').innerText) }
function originalSwitch(): HTMLElement | null {
  const cards = elements('div.custom-switch-card').filter((el) => clean(el.innerText).includes('原创声明'))
  const switches = cards.length === 1 ? elements('div.d-switch', cards[0]) : []
  return switches.length === 1 ? switches[0] : null
}
export function formSnapshot(): string {
  const title = one('div.d-input input') as HTMLInputElement
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
  const tab = elements('div.creator-tab').filter((el) => clean(el.innerText) === '上传图文')
  if (tab.length !== 1) throw new Error('Upload image tab unavailable or ambiguous.')
  click(tab[0])
  await until(() => document.querySelector('input.upload-input[type="file"]') !== null, deadline, 'Image upload input did not appear.')
}
export async function configureForm(request: PublishRequest, deadline: number) {
  const title = one('div.d-input input') as HTMLInputElement
  input(title, request.title)
  await until(() => title.value === request.title, deadline, 'Title did not retain the requested text.')
  const body = editor()
  writeEditor(body, request.content)
  await until(() => editorText(body) === request.content, deadline, 'Body did not retain exact text and newlines.')
  const guide = elements('.feature-guide__btn')
  if (guide.length === 1) click(guide[0])
  title.focus(); title.blur()
  const topicResults: Array<{ requested: string; selected: string | null; method: string }> = []
  if (request.tags.length) writeEditor(body, '\n\n', true)
  for (const tag of request.tags) {
    if (Date.now() >= deadline) throw new Error('Topic configuration exceeded call budget.')
    writeEditor(body, '#', true); await delay(200); writeEditor(body, tag, true); await delay(1000)
    const suggestions = elements('#creator-editor-topic-container .item')
    if (suggestions.length) {
      const selected = clean(suggestions[0].innerText)
      const before = body.innerHTML
      click(suggestions[0]); await delay(500)
      if (body.innerHTML === before || !editorText(body).includes(tag)) throw new Error('Topic selection was not observed in the editor.')
      topicResults.push({ requested: tag, selected, method: 'first_suggestion' })
    } else {
      writeEditor(body, ' ', true)
      topicResults.push({ requested: tag, selected: null, method: 'plain_text_fallback' })
    }
  }
  if (lengthError()) throw new Error(`Website length validation: ${lengthError()}`)
  const schedule = elements('.post-time-wrapper .d-switch')
  if (schedule.length === 1) await setSwitch(schedule[0], request.schedule_at !== null, deadline)
  else if (request.schedule_at) throw new Error('Scheduled publishing switch unavailable.')
  if (request.schedule_at) {
    // The creator date field is China local time, independent of the device timezone.
    const date = new Date(Date.parse(request.schedule_at) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
    const dateInput = one('.date-picker-container input') as HTMLInputElement
    input(dateInput, date)
    await until(() => dateInput.value === date, deadline, 'Scheduled date/time did not verify.')
  }
  if (!permission().includes(request.visibility)) {
    click(one('div.permission-card-wrapper div.d-select-content')); await delay(500)
    const opts = elements('div.d-options-wrapper div.d-grid-item div.custom-option').filter((el) => clean(el.innerText).includes(request.visibility))
    if (opts.length !== 1) throw new Error('Requested visibility unavailable or ambiguous.')
    click(opts[0])
    await until(() => permission().includes(request.visibility), deadline, 'Requested visibility did not verify.')
  }
  const original = originalSwitch()
  if (!original && request.is_original) throw new Error('Original declaration unavailable.')
  if (original && checked(original) !== request.is_original) {
    if (checked(original) === null) throw new Error('Original declaration state unknown.')
    click(original); await delay(800)
    if (request.is_original) {
      const footers = elements('div.footer').filter((el) => /原创声明须知|声明原创/.test(clean(el.innerText)))
      if (footers.length) {
        const footer = footers.find((el) => clean(el.innerText).includes('声明原创')) ?? footers[0]
        const box = one('div.d-checkbox', footer)
        await setSwitch(box, true, deadline)
        click(one('button.custom-button', footer))
      }
    }
    await until(() => checked(original) === request.is_original, deadline, 'Original declaration did not verify.')
  }
  const productResults = await bindProducts(request.products, deadline)
  if (title.value !== request.title || !editorText(body).startsWith(request.content)) throw new Error('Text changed while configuring options.')
  if (challenge() || lengthError()) throw new Error('Website validation or authentication requires user action.')
  return { topics: topicResults, products: productResults, visibility: request.visibility, is_original: request.is_original, schedule_at: request.schedule_at, dropped_tags: request.dropped_tags }
}
async function bindProducts(products: string[], deadline: number) {
  const results: Array<{ keyword: string; selected: string }> = []
  if (!products.length) return results
  const spans = elements('span.d-text').filter((el) => clean(el.innerText) === '添加商品')
  if (spans.length !== 1) throw new Error('Add product unavailable; account product capability may be missing.')
  const trigger = spans[0].closest<HTMLElement>('button, .d-button')
  if (!trigger) throw new Error('Add product control unavailable.')
  click(trigger)
  await until(() => elements('.multi-goods-selector-modal').length === 1, deadline, 'Product modal did not open.')
  const modal = one('.multi-goods-selector-modal')
  for (const keyword of products) {
    const search = one('input[placeholder="搜索商品ID 或 商品名称"]', modal) as HTMLInputElement
      input(search, keyword)
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      search.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
      await delay(1000)
      await until(() => !elements('.goods-list-loading', modal).length && elements('.goods-list-normal .good-card-container', modal).length > 0,
        Math.min(deadline, Date.now() + 10000), 'Product search results did not become available.')
    const card = elements('.goods-list-normal .good-card-container', modal)[0]
    const box = one('.d-checkbox', card)
    await setSwitch(box, true, deadline)
    results.push({ keyword, selected: clean(card.innerText).slice(0, 400) })
  }
  const saves = elements('.goods-selected-footer button, .goods-selected-footer .d-button--primary', modal)
  const unique = saves.filter((el) => !saves.some((parent) => parent !== el && parent.contains(el)))
  if (unique.length !== 1) throw new Error('Product save control unavailable or ambiguous.')
  click(unique[0])
  await until(() => !rendered(modal), deadline, 'Product modal did not close; binding not verified.')
  // Preserve the selected identities for the visible review. Saving alone is not publication.
  return results
}
export function publishButton(): HTMLElement {
  const widgets = elements('xhs-publish-btn').filter((el) => el.getAttribute('is-publish') !== 'false')
  if (widgets.length === 1) return widgets[0]
  if (widgets.length > 1) throw new Error('Publish widget ambiguous.')
  return one('.publish-page-publish-btn button.bg-red')
}
export function successEvidence(): { signal: string; text: string; url: string } | null {
  // Unlike upstream's URL-only test, require an explicit rendered success message.
  // No guessed success-page classes: inspect actual visible leaf text as evidence.
  const messages = elements('body *').filter((el) => el.children.length === 0)
    .filter((el) => !el.closest('[contenteditable], input, textarea, .img-preview-area, .multi-goods-selector-modal'))
    .filter((el) => /^(?:笔记)?(?:发布成功|定时发布设置成功|定时发布成功)(?:[！!\s]|$)/.test(clean(el.innerText)))
  if (!messages.length) return null
  return { signal: 'explicit_publish_success_message', text: clean(messages[0].innerText).slice(0, 200), url: location.origin + location.pathname }
}
