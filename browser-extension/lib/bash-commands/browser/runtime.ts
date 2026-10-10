import { ensureAttached, sendCommand, detachDebugger, clearDebuggerState, withTabLock } from './cdp'
import { buildBrowserSnapshot, clearSnapshotsForTab } from './snapshot'
import type { BrowserRequest } from './command'
import { BrowserTask } from './task'
import { actionable, withElement } from './target'
import { keyboard, mouse, moveMouse, releaseInput, forgetInput } from './input'
import { evaluatePage } from './evaluate'
import { navigate } from './navigation'
import { BrowserError } from './errors'

const tabSummary = (tab: chrome.tabs.Tab) => ({ tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', active: tab.active, windowId: tab.windowId })
const sessionKey = (owner: string) => `cw_browser_selected:${owner}`
const id = (value: unknown) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Expected a positive Chrome tab ID')
  return n
}
const numeric = (value: unknown) => {
  const n = Number(value)
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(n)) throw new Error('Expected a finite number')
  return n
}
function pageUrl(value: string) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') throw new Error('Expected http://, https:// or about:blank URL')
  return url.href
}
async function selectedTab(owner: string, request: BrowserRequest) {
  if (request.options.tab !== undefined) return id(request.options.tab)
  const stored = (await chrome.storage.session.get(sessionKey(owner)))[sessionKey(owner)]
  if (stored === undefined) throw new Error('No selected tab. Use browser tab-new or browser tab-select <id>.')
  return id(stored)
}

async function screenshot(task: BrowserTask, owner: string, request: BrowserRequest) {
  const { positionals: p, options: o } = request
  if (p[0] && o['full-page']) throw new Error('Element screenshot cannot use --full-page')
  const format = String(o.format ?? 'png')
  if (!['png', 'jpeg'].includes(format)) throw new Error('--format must be png or jpeg')
  const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: Boolean(o['full-page']) }
  if (o.quality !== undefined) {
    const quality = numeric(o.quality)
    if (format !== 'jpeg' || !Number.isInteger(quality) || quality < 0 || quality > 100) throw new Error('--quality requires jpeg and an integer from 0 to 100')
    params.quality = quality
  }
  await task.send('Page.enable')
  if (o['full-page']) {
    const m = await task.send('Page.getLayoutMetrics')
    params.clip = { ...(m.cssContentSize ?? m.contentSize), scale: 1 }
  }
  const capture = async () => ({ tabId: task.tabId, mimeType: `image/${format}`, encoding: 'base64', data: (await task.send('Page.captureScreenshot', params)).data })
  if (!p[0]) return capture()
  return withElement(task, owner, p[0], async objectId => {
    const { quad: q } = await actionable(task, objectId, 'visible')
    const { cssLayoutViewport } = await task.send('Page.getLayoutMetrics')
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
    params.clip = { x: Math.min(...xs) + cssLayoutViewport.pageX, y: Math.min(...ys) + cssLayoutViewport.pageY,
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), scale: 1 }
    params.captureBeyondViewport = true
    return capture()
  })
}

async function runTab(task: BrowserTask, owner: string, request: BrowserRequest): Promise<unknown> {
  const { command, positionals: p, options: o, stdin } = request, tabId = task.tabId!
  task.check()
  await task.wait(chrome.tabs.get(tabId))
  if (command === 'close' || command === 'tab-close') { await task.wait(chrome.tabs.remove(tabId)); return { tabId, closed: true } }
  if (command === 'detach') { await releaseInput(tabId); await task.wait(detachDebugger(tabId)); clearSnapshotsForTab(tabId); return { tabId, detached: true } }
  await task.wait(ensureAttached(tabId))
  if (['goto', 'reload', 'go-back', 'go-forward'].includes(command)) {
    clearSnapshotsForTab(tabId)
    await navigate(task, command, command === 'goto' ? pageUrl(p[0]) : undefined, String(o['wait-until'] ?? 'load'))
    return tabSummary(await task.wait(chrome.tabs.get(tabId)))
  }
  if (command === 'snapshot') {
    const capture = async (backendId?: number) => {
      const s = await task.wait(buildBrowserSnapshot(tabId, { session_id: owner, target: p[0], target_backend_node_id: backendId, boxes: o.boxes, signal: task.signal }))
      return { tabId, url: s.url, title: s.title, snapshotId: s.snapshotId, tree: s.treeText, nodes: s.nodes }
    }
    return p[0] ? withElement(task, owner, p[0], async objectId => capture((await task.send('DOM.describeNode', { objectId })).node.backendNodeId)) : capture()
  }
  if (command === 'eval') return p[1]
    ? withElement(task, owner, p[1], objectId => evaluatePage(task, p[0] ?? stdin, objectId))
    : evaluatePage(task, p[0] ?? stdin)
  if (command === 'screenshot') return screenshot(task, owner, request)
  if (command === 'dialog-accept' || command === 'dialog-dismiss') {
    await task.send('Page.handleJavaScriptDialog', { accept: command === 'dialog-accept', ...(p[0] === undefined ? {} : { promptText: p[0] }) })
    return { tabId, accepted: command === 'dialog-accept' }
  }
  if (['press', 'keydown', 'keyup'].includes(command)) { await keyboard(task, p[0], command); return { tabId, key: p[0] } }
  if (['mousemove', 'mousedown', 'mouseup', 'mousewheel'].includes(command)) {
    if (command === 'mousemove') await moveMouse(task, { x: numeric(p[0]), y: numeric(p[1]) })
    else if (command === 'mousewheel') await mouse(task, 'mouseWheel', undefined, 'left', 0, { deltaX: numeric(p[0]), deltaY: numeric(p[1]) })
    else await mouse(task, command === 'mousedown' ? 'mousePressed' : 'mouseReleased', undefined, p[0])
    return { tabId }
  }
  if (command === 'drag') {
    return withElement(task, owner, p[0], start => withElement(task, owner, p[1], async end => {
      await actionable(task, end, 'visible')
      const from = await actionable(task, start, 'pointer')
      await moveMouse(task, from); await mouse(task, 'mousePressed', from)
      const to = await actionable(task, end, 'pointer')
      await moveMouse(task, to); await mouse(task, 'mouseReleased', to)
      return { tabId, dragged: true }
    }))
  }
  return withElement(task, owner, p[0], async objectId => {
    if (command === 'fill' || command === 'type') {
      await actionable(task, objectId, 'edit', command === 'type')
      if (command === 'type') {
        await task.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 0 })
        await task.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 0 })
      }
      const text = p[1] ?? stdin
      if (text) await task.send('Input.insertText', { text })
      else if (command === 'fill') await keyboard(task, 'Delete')
      return { tabId, action: command }
    }
    if (command === 'select') {
      await actionable(task, objectId, 'visible')
      const values = await task.call(objectId, `function(values) {
        if (!(this instanceof HTMLSelectElement) || this.matches(':disabled')) throw new Error('Target is not an enabled select');
        if (!this.multiple && values.length > 1) throw new Error('Select does not allow multiple values');
        for (const value of values) if (![...this.options].some(o => o.value === value && !o.disabled && !o.parentElement.disabled)) throw new Error('Option not found or disabled: ' + value);
        for (const o of this.options) o.selected = values.includes(o.value);
        this.dispatchEvent(new Event('input',{bubbles:true})); this.dispatchEvent(new Event('change',{bubbles:true}));
        return [...this.selectedOptions].map(o => o.value);
      }`, [p.slice(1)])
      return { tabId, values }
    }
    const checked = () => task.call(objectId, `function() {
      if (!['checkbox','radio'].includes(this.type) && !['checkbox','radio','switch'].includes(this.getAttribute('role'))) throw new Error('Target is not a checkbox or radio');
      return this.checked ?? this.getAttribute('aria-checked') === 'true';
    }`)
    if (['check', 'uncheck'].includes(command) && await checked() === (command === 'check')) return { tabId, checked: command === 'check' }
    const pos = await actionable(task, objectId, 'pointer')
    await moveMouse(task, pos)
    // Hover handlers may move or cover the target. Re-check before dispatching input.
    const final = await actionable(task, objectId, 'pointer')
    if (command !== 'hover') {
      for (let count = 1; count <= (command === 'dblclick' ? 2 : 1); count++) {
        await mouse(task, 'mousePressed', final, p[1], count)
        await mouse(task, 'mouseReleased', final, p[1], count)
      }
    }
    if (['check', 'uncheck'].includes(command)) {
      if (await checked() !== (command === 'check')) throw new BrowserError('Checkbox did not reach the requested state')
      return { tabId, checked: command === 'check' }
    }
    return { tabId, action: command }
  })
}

export async function runBrowserRequest(owner: string, request: BrowserRequest, signal?: AbortSignal): Promise<unknown> {
  const task = new BrowserTask(Number(request.options.timeout ?? 10000), signal)
  const { command, positionals: p, options: o } = request
  try {
    if (command === 'tab-list') {
      const tabs = await task.wait(chrome.tabs.query({}))
      const selected = (await task.wait(chrome.storage.session.get(sessionKey(owner))))[sessionKey(owner)]
      return { tabs: tabs.filter(tab => tab.id !== undefined).map(tab => ({ ...tabSummary(tab), selected: tab.id === selected })) }
    }
    if (command === 'tab-select') {
      const tab = await task.wait(chrome.tabs.update(id(p[0]), { active: true }))
      await task.wait(chrome.storage.session.set({ [sessionKey(owner)]: tab.id }))
      return tabSummary(tab)
    }
    if (command === 'open' || command === 'tab-new') {
      // Create blank first, then observe navigation from its start.
      const tab = await task.wait(chrome.tabs.create({ url: 'about:blank', active: !o.background }))
      task.tabId = id(tab.id)
      await task.wait(chrome.storage.session.set({ [sessionKey(owner)]: tab.id }))
      if (!p[0]) return tabSummary(tab)
      request = { ...request, command: 'goto' }
    } else task.tabId = command === 'tab-close' && p[0] ? id(p[0]) : await task.wait(selectedTab(owner, request))
    // Dialog responses must be able to unblock an in-flight page evaluation.
    if (command.startsWith('dialog-')) return await runTab(task, owner, request)
    return await task.wait(withTabLock(task.tabId!, async () => {
      task.check()
      try { return await runTab(task, owner, request) }
      catch (error) { await releaseInput(task.tabId!); throw error }
    }))
  } finally {
    task.dispose()
  }
}

export function installBrowserLifecycle() {
  const clear = (tabId: number) => { clearDebuggerState(tabId); clearSnapshotsForTab(tabId); forgetInput(tabId) }
  chrome.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) clear(source.tabId) })
  chrome.tabs.onRemoved.addListener(clear)
  chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading' || change.url) clearSnapshotsForTab(tabId) })
}
