import { sendCommand } from './cdp'
import { BrowserError } from './errors'
import { getLatestSnapshotForScope } from './snapshot'
import type { BrowserTask } from './task'

/** Runs in the page, returning a unique live Element rather than a fallback match. */
function findElement(selector: string) {
  const found: Element[] = []
  const visit = (root: Document | ShadowRoot) => {
    found.push(...root.querySelectorAll(selector))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot)
  }
  visit(document)
  if (!found.length) return null
  if (found.length > 1) throw new Error(JSON.stringify({ reason: 'AMBIGUOUS_TARGET', count: found.length,
    candidates: found.slice(0, 5).map(el => ({ tag: el.tagName.toLowerCase(), text: el.textContent?.slice(0, 120), ariaLabel: el.getAttribute('aria-label') })) }))
  return found[0]
}

export async function withElement<T>(task: BrowserTask, owner: string, target: string, run: (id: string) => Promise<T>): Promise<T> {
  const tabId = task.tabId!
  let id: string
  if (/^(?:f\d+)?e\d+$/.test(target)) {
    const snapshot = getLatestSnapshotForScope(owner, tabId)
    const tab = await task.wait(chrome.tabs.get(tabId))
    if (!snapshot || snapshot.url !== tab.url) throw new BrowserError('Snapshot expired; capture a fresh snapshot', { target })
    const node = snapshot.nodes.find(node => node.ref === target)
    if (!node) throw new BrowserError('Reference absent from the latest snapshot', { target, snapshotId: snapshot.snapshotId })
    const resolved = await task.send('DOM.resolveNode', { backendNodeId: node.backendNodeId })
    id = resolved.object?.objectId
  } else {
    id = await task.poll(async () => (await task.evaluate(`(${findElement.toString()})(${JSON.stringify(target)})`, false))?.objectId)
  }
  if (!id) throw new BrowserError('Target detached; capture a fresh snapshot', { target })
  try {
    if (!await task.call(id, 'function() { return this.isConnected; }')) throw new BrowserError('Target detached; capture a fresh snapshot', { target })
    return await run(id)
  } finally {
    // Cleanup must still run after cancellation.
    await sendCommand(tabId, 'Runtime.releaseObject', { objectId: id }).catch(() => {})
  }
}

function inspect(this: HTMLElement, mode: 'pointer' | 'edit' | 'visible', append: boolean) {
  if (!this.isConnected) return { ok: false, fatal: true, reason: 'Target detached' }
  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const r = this.getBoundingClientRect(), s = getComputedStyle(this)
  if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return { ok: false, reason: 'Target not visible' }
  if (mode !== 'visible' && (this.matches(':disabled') || this.closest('[inert]') || this.getAttribute('aria-disabled') === 'true')) return { ok: false, reason: 'Target disabled' }
  const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2
  const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2
  if (mode === 'pointer') {
    let hit = document.elementFromPoint(x, y)
    while (hit?.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner }
    let current: Node | null = hit
    while (current && current !== this) current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null)
    if (!current) return { ok: false, reason: 'Target obscured', blocker: hit?.outerHTML.slice(0, 300) }
  }
  if (mode === 'edit') {
    if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
      if (this.readOnly) return { ok: false, reason: 'Target readonly' }
      if (this instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(this.type)) {
        return { ok: false, fatal: true, reason: `Input type ${this.type} does not accept text input` }
      }
      this.focus()
      if (append) {
        // Email/number inputs do not implement setSelectionRange.
        if (this.selectionStart !== null) this.setSelectionRange(this.value.length, this.value.length)
      } else this.select()
    } else if (this.isContentEditable) {
      this.focus()
      const range = document.createRange(); range.selectNodeContents(this)
      if (append) range.collapse(false)
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    } else return { ok: false, fatal: true, reason: 'Target is not editable' }
  }
  return { ok: true, point: { x, y }, rect: { x: r.x, y: r.y, width: r.width, height: r.height } }
}

export async function actionable(task: BrowserTask, id: string, mode: 'pointer' | 'edit' | 'visible', append = false) {
  let previous: { x: number; y: number; width: number; height: number } | undefined
  let last: unknown
  try {
    return await task.poll(async () => {
      const state = await task.call(id, inspect.toString(), [mode, append])
      last = state
      if (state.fatal) throw new BrowserError(state.reason, state)
      if (!state.ok) { previous = undefined; return undefined }
      const stable = previous && ['x', 'y', 'width', 'height'].every(k => Math.abs(previous![k as keyof typeof previous] - state.rect[k]) < 0.5)
      previous = state.rect
      if (!stable) return undefined
      const { model } = await task.send('DOM.getBoxModel', { objectId: id })
      const q: number[] = model.border
      return { ...state.point, quad: q }
    })
  } catch (error) {
    if (task.signal.aborted) throw new BrowserError(String(task.signal.reason?.message ?? 'Canceled'), { target: last })
    throw error
  }
}
