import { XHS_INPUT_SLOT, XHS_OPERATION_TIMEOUT_MS, isXhsInputRequest, sampleInputTiming as timing } from './xiaohongshu-input-protocol'
import type { XhsInputRequest, XhsInputOperation } from './xiaohongshu-input-protocol'

interface DebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>
  detach(target: { tabId: number }): Promise<void>
  sendCommand(target: { tabId: number }, method: string, params?: object): Promise<unknown>
  onDetach?: { addListener(listener: (source: { tabId?: number }) => void): void }
}
interface Point { x: number; y: number }
interface Session { tabId: number; hostname: string; timeoutMs: number; deadline: number; pointer: Point; queue: Promise<unknown>; active: boolean }
interface Geometry { left: number; right: number; top: number; bottom: number; x: number; y: number }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const stateFunction = `function() {
  let opacity = 1;
  for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') { opacity = 0; break; }
    const value = parseFloat(style.opacity); if (!isNaN(value)) opacity *= value;
  }
  return { opacity, enabled: !this.disabled, writable: !this.readOnly,
    pointerEvents: getComputedStyle(this).pointerEvents, hasRect: this.getClientRects().length > 0,
    width: innerWidth, height: innerHeight, scrollX, scrollY };
}`

export function createXhsCdpInput(api: DebuggerApi) {
  const sessions = new Map<string, Session>()
  api.onDetach?.addListener(({ tabId }) => {
    for (const [token, session] of sessions) if (session.tabId === tabId) { session.active = false; sessions.delete(token) }
  })
  const command = async (session: Session, method: string, params?: object): Promise<any> => {
    if (!session.active) throw new Error('CDP input invocation has ended or detached.')
    if (Date.now() >= session.deadline) throw new Error(`Upstream ${session.timeoutMs / 1000}-second input context expired.`)
    return api.sendCommand({ tabId: session.tabId }, method, params)
  }
  const call = async (session: Session, objectId: string, functionDeclaration: string, args: unknown[] = []) => {
    const response = await command(session, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, userGesture: true,
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'CDP element operation failed.')
    return response.result?.value
  }
  const shape = async (session: Session, objectId: string): Promise<Geometry> => {
    const response = await command(session, 'DOM.getContentQuads', { objectId })
    // Rod OnePointInside uses the first quad whose signed area is >= 1.
    const quad = response.quads?.find((q: number[]) => q.length === 8 &&
      (q[0] * q[3] - q[2] * q[1] + q[2] * q[5] - q[4] * q[3] + q[4] * q[7] - q[6] * q[5] + q[6] * q[1] - q[0] * q[7]) / 2 >= 1)
    if (!quad) throw new Error('Element has no visible clickable shape.')
    const first = response.quads[0] // humanize jitterOn/stillOn use the first quad.
    return { left: first[0], right: first[4], top: first[1], bottom: first[5],
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 }
  }
  const waitState = async (session: Session, objectId: string, field: 'enabled' | 'writable') => {
    while (!(await call(session, objectId, stateFunction))[field]) await sleep(250)
  }
  const scrollIntoView = async (session: Session, objectId: string) => {
    // Port Rod v0.116.2 ScrollIntoView: WaitVisible, equal quads on successive
    // animation frames, then DOM.scrollIntoViewIfNeeded.
    while (true) {
      const state = await call(session, objectId, stateFunction)
      if (state.opacity > 0 && state.hasRect) break
      await sleep(250)
    }
    let previous: string | undefined
    while (true) {
      await command(session, 'Runtime.evaluate', { expression: 'new Promise(requestAnimationFrame)', awaitPromise: true, returnByValue: true })
      const current = JSON.stringify(await command(session, 'DOM.getContentQuads', { objectId }))
      if (current === previous) break
      previous = current
    }
    await command(session, 'DOM.scrollIntoViewIfNeeded', { objectId })
  }
  const move = async (session: Session, target: Point) => {
    // Port humanize/mouse.go: bounded cubic Bezier path and eased steps.
    const start = session.pointer, dx = target.x - start.x, dy = target.y - start.y, distance = Math.hypot(dx, dy)
    const emit = async (point: Point) => {
      await command(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 })
      session.pointer = point
    }
    if (distance < 6) { await emit(target); return }
    const steps = Math.max(10, Math.min(40, Math.round(distance / 10)))
    let offset = distance * (0.05 + Math.random() * 0.10)
    if (Math.random() < 0.5) offset = -offset
    const nx = -dy / distance, ny = dx / distance
    const c1 = { x: start.x + dx / 3 + nx * offset, y: start.y + dy / 3 + ny * offset }
    const c2 = { x: start.x + dx * 2 / 3 + nx * offset * 0.5, y: start.y + dy * 2 / 3 + ny * offset * 0.5 }
    const perStep = 5 + Math.floor(Math.random() * 5)
    for (let i = 1; i <= steps; i++) {
      if (i === steps) { await emit(target); break }
      const ratio = i / steps, t = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2, u = 1 - t
      await sleep(perStep)
      await emit({ x: u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * target.x,
        y: u ** 3 * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * target.y })
    }
  }
  const pressAndRelease = async (session: Session, point: Point) => {
    await command(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(timing(-2.47, 0.33, 45, 250))
    await command(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 })
  }
  const key = async (session: Session, name: 'Enter' | 'Escape' | 'Backspace' | 'ArrowDown') => {
    const code = name === 'Enter' ? 13 : name === 'Escape' ? 27 : name === 'ArrowDown' ? 40 : 8
    const params = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
    await command(session, 'Input.dispatchKeyEvent', { type: name === 'Enter' ? 'keyDown' : 'rawKeyDown', ...params, ...(name === 'Enter' ? { text: '\r' } : {}) })
    await command(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const input = async (session: Session, op: XhsInputOperation) => {
    if (op.kind === 'key' && !op.element) { await key(session, op.key); return }
    if (op.kind === 'click-point') {
      const viewport = await command(session, 'Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true })
      const [width, height] = viewport.result.value
      if (op.x < 0 || op.y < 0 || op.x > width || op.y > height) throw new Error('Click point is outside the viewport.')
      await move(session, op); await pressAndRelease(session, op); return
    }
    // Resolve the exact DOM element retained by the recipe; no guessed parent selectors.
    const response = await command(session, 'Runtime.evaluate', {
      expression: `window[Symbol.for(${JSON.stringify(XHS_INPUT_SLOT)})]?.elements.get(${JSON.stringify(op.element)})`,
      returnByValue: false, objectGroup: 'eo2-xhs-input',
    })
    const objectId = response.result?.objectId
    if (!objectId || response.result?.subtype !== 'node') throw new Error('The requested page element is no longer available.')
    try {
      await scrollIntoView(session, objectId)
      if (op.kind === 'key') {
        // Rod Element.KeyActions focuses the requested editor before its keys.
        await call(session, objectId, 'function() { this.focus(); }')
        await key(session, op.key)
        return
      }
      if (op.kind === 'type') {
        // Rod Focus and SelectAllText also use element-bound evaluation. Selection
        // replacement/end positioning adapts EO2's existing editing workflow.
        if (op.preserveSelection) await call(session, objectId, 'function() { this.focus(); }')
        else await call(session, objectId, `function(append) {
          this.focus();
          if (typeof this.select === 'function') { if (append) this.setSelectionRange(this.value.length, this.value.length); else this.select(); }
          else { const range = document.createRange(); range.selectNodeContents(this); if (append) range.collapse(false);
            const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
        }`, [op.append])
        await waitState(session, objectId, 'enabled'); await waitState(session, objectId, 'writable')
        if (!op.text && !op.append && !op.preserveSelection) await key(session, 'Backspace')
        for (const character of op.text) {
          await command(session, 'Input.insertText', { text: character })
          await sleep(timing(-2.12, 0.50, 30, 400))
        }
        return
      }
      // Rod WaitInteractable retries covered controls; humanize.Click then checks
      // opacity, moves, waits for enabled state, and rechecks the pointer geometry.
      let rect: Geometry
      while (true) {
        const state = await call(session, objectId, stateFunction)
        if (state.pointerEvents === 'none') throw new Error('Element does not accept pointer events.')
        rect = await shape(session, objectId)
        // Rod checks containment through CDP's hit node, including descendant
        // targets. Do not add a separate document.elementFromPoint policy.
        const hit = await command(session, 'DOM.getNodeForLocation', { x: Math.trunc(rect.x) + Math.trunc(state.scrollX), y: Math.trunc(rect.y) + Math.trunc(state.scrollY) })
        const resolved = await command(session, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId })
        let contained: boolean
        try {
          const result = await command(session, 'Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(other) { return this.contains(other); }', arguments: [{ objectId: resolved.object.objectId }], returnByValue: true })
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'CDP containment check failed.')
          contained = result.result.value
        } finally { await api.sendCommand({ tabId: session.tabId }, 'Runtime.releaseObject', { objectId: resolved.object.objectId }).catch(() => {}) }
        if (contained) {
          if (state.opacity < 0.1) throw new Error('Element is not visible enough to receive pointer input.')
          break
        }
        await sleep(250)
        await scrollIntoView(session, objectId)
      }
      const jitter = (size: number) => (Math.random() - 0.5) * 2 * Math.min(Math.abs(size) * 0.15, 8)
      const point = { x: rect.x + jitter(rect.right - rect.left), y: rect.y + jitter(rect.bottom - rect.top) }
      const viewport = await call(session, objectId, stateFunction)
      if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) throw new Error('Click point is outside the viewport.')
      await move(session, point); await sleep(timing(-1.20, 0.35, 200, 1200))
      await waitState(session, objectId, 'enabled')
      const current = await shape(session, objectId), state = await call(session, objectId, stateFunction)
      if (point.x < current.left - 1 || point.x > current.right + 1 || point.y < current.top - 1 || point.y > current.bottom + 1 || state.opacity < 0.1) throw new Error('Element moved or became invisible before mouse press.')
      await pressAndRelease(session, point)
    } finally { await api.sendCommand({ tabId: session.tabId }, 'Runtime.releaseObject', { objectId }).catch(() => {}) }
  }
  return {
    async open(tabId: number, options = { hostname: 'creator.xiaohongshu.com', timeoutMs: XHS_OPERATION_TIMEOUT_MS }): Promise<string> {
      await api.attach({ tabId }, '1.3')
      const token = crypto.randomUUID()
      sessions.set(token, { tabId, ...options, deadline: Date.now() + options.timeoutMs, pointer: { x: 0, y: 0 }, queue: Promise.resolve(), active: true })
      return token
    },
    async close(token: string): Promise<void> {
      const session = sessions.get(token)
      if (!session) return
      session.active = false
      sessions.delete(token)
      await api.detach({ tabId: session.tabId })
    },
    async handle(value: unknown, sender: { tab?: { id?: number }; frameId?: number; url?: string }) {
      if (!isXhsInputRequest(value)) throw new Error('Invalid internal CDP input request.')
      const request: XhsInputRequest = value, session = sessions.get(request.session)
      if (!session || sender.tab?.id !== session.tabId || sender.frameId !== 0 || new URL(sender.url || 'about:blank').hostname !== session.hostname) throw new Error('No authorized input invocation for this tab.')
      const result = session.queue.then(() => input(session, request.operation))
      session.queue = result.catch(() => {})
      await result
      return { ok: true }
    },
  }
}
let instance: ReturnType<typeof createXhsCdpInput> | undefined
export function getXhsCdpInput() {
  if (!instance) {
    const api = (globalThis as unknown as { chrome?: { debugger?: DebuggerApi } }).chrome?.debugger
    if (!api) throw new Error('Chrome debugger input API unavailable. Reload the extension with its debugger permission.')
    instance = createXhsCdpInput(api)
  }
  return instance
}
