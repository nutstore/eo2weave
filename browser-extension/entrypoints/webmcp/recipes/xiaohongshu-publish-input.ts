import { XHS_INPUT_MESSAGE, XHS_INPUT_RESPONSE, XHS_INPUT_SLOT, XHS_OPERATION_TIMEOUT_MS } from '../xiaohongshu-input-protocol'
import type { XhsInputOperation } from '../xiaohongshu-input-protocol'

interface InputContext { session: string; elements: Map<string, HTMLElement> }
const slot = Symbol.for(XHS_INPUT_SLOT)
type InputWindow = Window & { [slot]?: InputContext }

export async function withXhsInputSession<T>(session: unknown, run: () => Promise<T>): Promise<T> {
  if (typeof session !== 'string') return run()
  const target = window as InputWindow, previous = target[slot]
  target[slot] = { session, elements: new Map() }
  try { return await run() } finally {
    if (previous) target[slot] = previous
    else delete target[slot]
  }
}
async function send(operation: XhsInputOperation, element?: HTMLElement): Promise<void> {
  const context = (window as InputWindow)[slot]
  if (!context) throw new Error('CDP input session unavailable. Reload the extension and page, then invoke this tool through EO2.')
  const requestId = crypto.randomUUID()
  if (element && 'element' in operation) { operation.element = requestId; context.elements.set(requestId, element) }
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); window.removeEventListener('message', receive) }
      const receive = (event: MessageEvent) => {
        const data = event.data
        if (event.source !== window || data?.type !== XHS_INPUT_RESPONSE || data.requestId !== requestId || data.session !== context.session) return
        cleanup()
        if (data.ok) resolve()
        else reject(new Error(typeof data.error === 'string' ? data.error : 'CDP input failed.'))
      }
      const timeout = setTimeout(() => { cleanup(); reject(new Error('CDP input response timed out.')) }, XHS_OPERATION_TIMEOUT_MS)
      window.addEventListener('message', receive)
      window.postMessage({ type: XHS_INPUT_MESSAGE, session: context.session, requestId, operation }, location.origin)
    })
  } finally { context.elements.delete(requestId) }
}
export const clickWithCdp = (element: HTMLElement) => send({ kind: 'click', element: '' }, element)
export const typeWithCdp = (element: HTMLElement, text: string, append = false) => send({ kind: 'type', element: '', text, append }, element)
export const pressWithCdp = (key: 'Enter' | 'Escape' | 'ArrowDown', element?: HTMLElement) => send({ kind: 'key', key, ...(element ? { element: '' } : {}) }, element)
export const clickPointWithCdp = (x: number, y: number) => send({ kind: 'click-point', x, y })
