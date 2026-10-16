import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createXhsCdpInput } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-cdp-input'
import { XHS_INPUT_MESSAGE, XHS_INPUT_SLOT, XHS_OPERATION_TIMEOUT_MS, XHS_COMMENT_TIMEOUT_MS } from '../../../browser-extension/entrypoints/webmcp/xiaohongshu-input-protocol'
import { clickWithCdp, typeWithCdp, withXhsInputSession } from '../../../browser-extension/entrypoints/webmcp/recipes/xiaohongshu-publish-input'

const sender = { tab: { id: 7 }, frameId: 0, url: 'https://creator.xiaohongshu.com/publish/publish' }
const request = (session: string, operation: object) => ({ type: XHS_INPUT_MESSAGE, session, requestId: 'request-test', operation })
function fixture() {
  const state = { opacity: 1, enabled: true, writable: true, pointerEvents: 'auto', hasRect: true, width: 1000, height: 800, scrollX: 0, scrollY: 0 }
  const api = { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), onDetach: { addListener: vi.fn((_listener: (source: { tabId?: number }) => void) => {}) },
    sendCommand: vi.fn(async (_target: object, method: string, params: any): Promise<any> => {
      if (method === 'Runtime.evaluate') return params.expression === '[innerWidth, innerHeight]' ? { result: { value: [1000, 800] } } : { result: { objectId: 'element-1', subtype: 'node' } }
      if (method === 'DOM.getContentQuads') return { quads: [[100, 100, 200, 100, 200, 140, 100, 140]] }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'hit-node' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: params.functionDeclaration.includes('this.contains') ? true : state } }
      return {}
    }),
  }
  return { api, state, driver: createXhsCdpInput(api) }
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (window as any)[Symbol.for(XHS_INPUT_SLOT)] })

describe('upstream browser input adapted to the current tab', () => {
  it('scrolls the retained comment node into view without clicking or typing', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await driver.handle(request(session, { kind: 'scroll-into-view', element: 'comment-node' }), sender)
    expect(api.sendCommand.mock.calls.some(([, method]) => method === 'DOM.scrollIntoViewIfNeeded')).toBe(true)
    expect(api.sendCommand.mock.calls.some(([, method]) => method.startsWith('Input.'))).toBe(false)
    expect(api.sendCommand.mock.calls.at(-1)?.[1]).toBe('Runtime.releaseObject')
  })
  it('sends browser wheel events within the scroller and retains the pointer across notches', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const first = driver.handle(request(session, { kind: 'scroll-wheel', element: 'scroller', delta: 100 }), sender)
    await vi.runAllTimersAsync(); await first
    const moves = api.sendCommand.mock.calls.filter(([, method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved').length
    await driver.handle(request(session, { kind: 'scroll-wheel', element: 'scroller', delta: 120 }), sender)
    expect(api.sendCommand.mock.calls.filter(([, method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved')).toHaveLength(moves)
    expect(api.sendCommand.mock.calls.filter(([, method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel').map(([, , params]) => params)).toEqual([
      { type: 'mouseWheel', x: 150, y: 120, deltaX: 0, deltaY: 100 },
      { type: 'mouseWheel', x: 150, y: 120, deltaX: 0, deltaY: 120 },
    ])
    expect(api.sendCommand.mock.calls.some(([, method]) => method === 'DOM.scrollIntoViewIfNeeded')).toBe(false)
  })
  it('uses the upstream viewport center when no scroller node is supplied', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const pending = driver.handle(request(session, { kind: 'scroll-wheel', delta: 100 }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(api.sendCommand.mock.calls.at(-1)?.slice(1)).toEqual(['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 100 }])
  })
  it('keeps scroll input inside the grant and rejects malformed internal wheel messages', async () => {
    const { driver } = fixture(), session = await driver.open(7)
    await expect(driver.handle(request(session, { kind: 'scroll-wheel', delta: Infinity }), sender)).rejects.toThrow('Invalid')
    await expect(driver.handle(request(session, { kind: 'scroll-into-view', element: 'comment' }), { ...sender, tab: { id: 8 } })).rejects.toThrow('authorized')
    await driver.close(session)
    await expect(driver.handle(request(session, { kind: 'scroll-wheel', delta: 100 }), sender)).rejects.toThrow('authorized')
  })
  it('grants comment input only to the main-site tab and preserves upstream focus-only typing', async () => {
    const { driver, api } = fixture(), session = await driver.open(7, { hostname: 'www.xiaohongshu.com', timeoutMs: XHS_COMMENT_TIMEOUT_MS })
    const mainSender = { ...sender, url: 'https://www.xiaohongshu.com/explore/test-note' }
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), sender)).rejects.toThrow('authorized')
    const pending = driver.handle(request(session, { kind: 'type', element: 'comment', text: '中😀\n文', append: false, preserveSelection: true }), mainSender)
    await vi.runAllTimersAsync(); await pending
    expect(api.sendCommand.mock.calls.filter(([, method]) => method === 'Input.insertText').map(([, , params]) => params.text)).toEqual(['中', '😀', '\n', '文'])
    const evaluations = api.sendCommand.mock.calls.filter(([, method]) => method === 'Runtime.callFunctionOn').map(([, , params]) => params.functionDeclaration)
    expect(evaluations).toContain('function() { this.focus(); }')
    expect(evaluations.some((source) => /selectNodeContents|setSelectionRange|\.select\(/.test(source))).toBe(false)
    vi.setSystemTime(Date.now() + XHS_COMMENT_TIMEOUT_MS)
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), mainSender)).rejects.toThrow('60-second')
    await driver.close(session)
    expect(api.detach).toHaveBeenCalledWith({ tabId: 7 })
  })
  it('moves the browser pointer and presses/releases once using the original element', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const pending = driver.handle(request(session, { kind: 'click', element: 'element-reference' }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(api.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
    const commands = api.sendCommand.mock.calls
    const mouse = commands.filter(([, method]) => method === 'Input.dispatchMouseEvent').map(([, , params]) => params)
    expect(mouse.slice(0, -2).every((event) => event.type === 'mouseMoved')).toBe(true)
    expect(mouse.slice(-2)).toEqual([
      { type: 'mousePressed', x: 150, y: 120, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 150, y: 120, button: 'left', buttons: 0, clickCount: 1 },
    ])
    expect(commands.find(([, method]) => method === 'Runtime.evaluate')?.[2].expression).toContain('element-reference')
    expect(commands.some(([, , params]) => params?.functionDeclaration?.includes('.click('))).toBe(false)
    expect(commands.every(([target]) => (target as { tabId: number }).tabId === 7)).toBe(true)
    await driver.close(session); expect(api.detach).toHaveBeenCalledWith({ tabId: 7 })
  })
  it('inserts Unicode characters through CDP after focusing and selecting the field', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const pending = driver.handle(request(session, { kind: 'type', element: 'body', text: '中😀\n文', append: false }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(api.sendCommand.mock.calls.filter(([, method]) => method === 'Input.insertText').map(([, , params]) => params.text)).toEqual(['中', '😀', '\n', '文'])
    expect(api.sendCommand.mock.calls.find(([, method, params]) => method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.focus()'))?.[2].arguments).toEqual([{ value: false }])
  })
  it('clears an empty replacement with the browser Backspace key and supports append', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await driver.handle(request(session, { kind: 'type', element: 'title', text: '', append: false }), sender)
    expect(api.sendCommand.mock.calls.filter(([, method]) => method === 'Input.dispatchKeyEvent').map(([, , params]) => [params.type, params.key])).toEqual([['rawKeyDown', 'Backspace'], ['keyUp', 'Backspace']])
    const pending = driver.handle(request(session, { kind: 'type', element: 'title', text: 'a', append: true }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(api.sendCommand.mock.calls.filter(([, method, params]) => method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.focus()')).at(-1)?.[2].arguments).toEqual([{ value: true }])
  })
  it('uses browser key events for Enter and Escape', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await driver.handle(request(session, { kind: 'key', key: 'Enter' }), sender)
    await driver.handle(request(session, { kind: 'key', key: 'Escape' }), sender)
    expect(api.sendCommand.mock.calls.map(([, , params]) => [params.type, params.key])).toEqual([['keyDown', 'Enter'], ['keyUp', 'Enter'], ['rawKeyDown', 'Escape'], ['keyUp', 'Escape']])
  })
  it('focuses the original editor before the upstream ArrowDown key', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await driver.handle(request(session, { kind: 'key', key: 'ArrowDown', element: 'editor' }), sender)
    const calls = api.sendCommand.mock.calls
    expect(calls.findIndex(([, method, params]) => method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.focus()'))).toBeLessThan(calls.findIndex(([, method]) => method === 'Input.dispatchKeyEvent'))
    expect(calls.filter(([, method]) => method === 'Input.dispatchKeyEvent').map(([, , params]) => [params.type, params.key, params.windowsVirtualKeyCode])).toEqual([['rawKeyDown', 'ArrowDown', 40], ['keyUp', 'ArrowDown', 40]])
  })
  it('retries a covered control before dispatching the single browser click', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const original = api.sendCommand.getMockImplementation()!
    let containsCalls = 0
    api.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.contains')) return { result: { value: ++containsCalls > 1 } }
      return original(target, method, params)
    })
    const pending = driver.handle(request(session, { kind: 'click', element: 'dropdown' }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(containsCalls).toBe(2)
    expect(api.sendCommand.mock.calls.filter(([, method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed')).toHaveLength(1)
  })
  it('inherits Rod OnePointInside rather than inventing a minimum clickable size', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const original = api.sendCommand.getMockImplementation()!
    api.sendCommand.mockImplementation(async (target, method, params) => method === 'DOM.getContentQuads'
      ? { quads: [[0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]] } : original(target, method, params))
    await expect(driver.handle(request(session, { kind: 'click', element: 'tiny' }), sender)).rejects.toThrow('no visible clickable shape')
    expect(api.sendCommand.mock.calls.some(([, method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
  })
  it('stops queued and running input after detachment without reattaching', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const original = api.sendCommand.getMockImplementation()!
    api.sendCommand.mockImplementation(async (target, method, params) => {
      if (method === 'Input.insertText') api.onDetach.addListener.mock.calls[0][0]({ tabId: 7 })
      return original(target, method, params)
    })
    const pending = driver.handle(request(session, { kind: 'type', element: 'body', text: 'ab', append: false }), sender)
    const assertion = expect(pending).rejects.toThrow('detached')
    await vi.runAllTimersAsync(); await assertion
    expect(api.sendCommand.mock.calls.filter(([, method]) => method === 'Input.insertText')).toHaveLength(1)
    expect(api.attach).toHaveBeenCalledOnce()
  })
  it('uses the same input driver for the upstream empty-position click', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    const pending = driver.handle(request(session, { kind: 'click-point', x: 400, y: 30 }), sender)
    await vi.runAllTimersAsync(); await pending
    expect(api.sendCommand.mock.calls.filter(([, method]) => method === 'Input.dispatchMouseEvent').slice(-2).map(([, , params]) => params.type)).toEqual(['mousePressed', 'mouseReleased'])
    await expect(driver.handle(request(session, { kind: 'click-point', x: 1001, y: 30 }), sender)).rejects.toThrow('outside the viewport')
  })
  it.each([{ ...sender, tab: { id: 9 } }, { ...sender, frameId: 1 }, { ...sender, url: 'https://example.com' }])('refuses requests outside the authorized tab context', async (other) => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), other)).rejects.toThrow('authorized')
    expect(api.sendCommand).not.toHaveBeenCalled()
  })
  it('does not grant arbitrary protocol commands or reuse a closed invocation', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    await expect(driver.handle(request(session, { kind: 'Runtime.evaluate', expression: 'bad' }), sender)).rejects.toThrow('Invalid')
    await driver.close(session)
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), sender)).rejects.toThrow('authorized')
    expect(api.sendCommand).not.toHaveBeenCalled()
  })
  it('reports debugger attachment failure without executing a fallback click', async () => {
    const { driver, api } = fixture(); api.attach.mockRejectedValueOnce(new Error('Another debugger attached'))
    await expect(driver.open(7)).rejects.toThrow('Another debugger')
    expect(api.sendCommand).not.toHaveBeenCalled(); expect(api.detach).not.toHaveBeenCalled()
  })
  it('uses the upstream operation deadline and stops after debugger detachment', async () => {
    const { driver, api } = fixture(), session = await driver.open(7)
    vi.setSystemTime(Date.now() + XHS_OPERATION_TIMEOUT_MS)
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), sender)).rejects.toThrow('expired')
    api.onDetach.addListener.mock.calls[0][0]({ tabId: 7 })
    await expect(driver.handle(request(session, { kind: 'key', key: 'Enter' }), sender)).rejects.toThrow('authorized')
    expect(api.sendCommand).not.toHaveBeenCalled()
  })
  it('does not silently fall back when the recipe has no input session', async () => {
    await expect(clickWithCdp(document.createElement('div'))).rejects.toThrow('session unavailable')
    await expect(typeWithCdp(document.createElement('input'), 'test')).rejects.toThrow('session unavailable')
  })
  it('retains the exact element only during an input request and cleans the page context', async () => {
    const element = document.createElement('div')
    const post = vi.spyOn(window, 'postMessage').mockImplementation((value: any) => {
      const context = (window as any)[Symbol.for(XHS_INPUT_SLOT)]
      expect(context.elements.get(value.operation.element)).toBe(element)
      window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'cw_xhs_cdp_input_response', session: value.session, requestId: value.requestId, ok: true } }))
    })
    await withXhsInputSession('session-1', () => clickWithCdp(element))
    expect(post).toHaveBeenCalledOnce(); expect((window as any)[Symbol.for(XHS_INPUT_SLOT)]).toBeUndefined()
  })
})
