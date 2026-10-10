import { sendCommand } from './cdp'
import type { BrowserTask } from './task'

const keyMap: Record<string, [string, string, number]> = {
  Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27],
  Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38],
  ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34],
  Space: [' ', 'Space', 32], Control: ['Control', 'ControlLeft', 17], Shift: ['Shift', 'ShiftLeft', 16], Alt: ['Alt', 'AltLeft', 18], Meta: ['Meta', 'MetaLeft', 91],
}

type Key = { key: string; code: string; windowsVirtualKeyCode: number }
const states = new Map<number, { x: number; y: number; buttons: number; keys: Map<string, Key> }>()
const modifier = (key: string) => ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key] ?? 0)
function state(tabId: number) {
  let value = states.get(tabId)
  if (!value) { value = { x: 0, y: 0, buttons: 0, keys: new Map() }; states.set(tabId, value) }
  return value
}
export function forgetInput(tabId: number) { states.delete(tabId) }
function modifiers(tabId: number) { return [...state(tabId).keys.keys()].reduce((bits, key) => bits | modifier(key), 0) }
function button(value = 'left') {
  const buttons = ({ left: 1, right: 2, middle: 4 } as Record<string, number>)[value]
  if (!buttons) throw new Error('Button must be left, right or middle')
  return { button: value, buttons }
}
export async function mouse(task: BrowserTask, type: string, point?: { x: number; y: number }, btn = 'left', clickCount = 1, delta?: { deltaX: number; deltaY: number }) {
  const s = state(task.tabId!), b = button(btn)
  const next = type === 'mousePressed' ? s.buttons | b.buttons : type === 'mouseReleased' ? s.buttons & ~b.buttons : s.buttons
  await task.send('Input.dispatchMouseEvent', { type, x: point?.x ?? s.x, y: point?.y ?? s.y,
    button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : b.button,
    buttons: next, modifiers: modifiers(task.tabId!), clickCount, ...delta })
  s.buttons = next
  if (point) { s.x = point.x; s.y = point.y }
}
export async function moveMouse(task: BrowserTask, target: { x: number; y: number }) {
  const from = { ...state(task.tabId!) }
  const steps = Math.max(1, Math.min(25, Math.ceil(Math.hypot(target.x - from.x, target.y - from.y) / 15)))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, smooth = t * t * (3 - 2 * t)
    await mouse(task, 'mouseMoved', { x: from.x + (target.x - from.x) * smooth, y: from.y + (target.y - from.y) * smooth })
  }
}
export async function keyboard(task: BrowserTask, chord: string, mode = 'press') {
  const platform = await chrome.runtime.getPlatformInfo()
  const primary = platform.os === 'mac' ? 'Meta' : 'Control'
  const parts = chord.replaceAll('ControlOrMeta', primary).split('+'), last = parts.pop()!
  let bits = modifiers(task.tabId!)
  for (const part of parts) {
    const bit = modifier(part === 'Ctrl' ? 'Control' : part)
    if (!bit) throw new Error(`Unknown keyboard modifier ${part}`)
    bits |= bit
  }
  const mapped = Object.entries(keyMap).find(([key]) => key.toLowerCase() === last.toLowerCase())?.[1]
  if (!mapped && last.length !== 1) throw new Error(`Unknown key ${last}`)
  const [rawKey, code, windowsVirtualKeyCode] = mapped ?? [last, /^[a-z]$/i.test(last) ? `Key${last.toUpperCase()}` : /^\d$/.test(last) ? `Digit${last}` : '', last.toUpperCase().charCodeAt(0)]
  const key = rawKey.length === 1 && bits & 8 ? rawKey.toUpperCase() : rawKey
  const s = state(task.tabId!), payload = { key, code, windowsVirtualKeyCode }
  const commands = (bits & modifier(primary)) && key.toLowerCase() === 'a' ? ['selectAll'] : undefined
  const text = !(bits & (1 | 2 | 4)) ? (key === 'Enter' ? '\r' : key.length === 1 ? key : '') : ''
  if (mode !== 'keyup') {
    await task.send('Input.dispatchKeyEvent', { ...payload, modifiers: bits | modifier(key), type: text ? 'keyDown' : 'rawKeyDown', commands, ...(text ? { text, unmodifiedText: text } : {}) })
    s.keys.set(key, payload)
  }
  if (mode !== 'keydown') {
    await task.send('Input.dispatchKeyEvent', { ...payload, modifiers: bits & ~modifier(key), type: 'keyUp' })
    s.keys.delete(key)
  }
}
/** Release held inputs after failure/cancel so the next task starts usable. */
export async function releaseInput(tabId: number) {
  const s = states.get(tabId)
  if (!s) return
  for (const [btn, bit] of [['left', 1], ['right', 2], ['middle', 4]] as const) {
    if (s.buttons & bit) await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x, y: s.y, button: btn, buttons: 0, clickCount: 1 }).catch(() => {})
  }
  for (const key of s.keys.values()) await sendCommand(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyUp', modifiers: 0 }).catch(() => {})
  forgetInput(tabId)
}
