import { ADAPTER_HOST_MARKER, ADAPTER_HOST_PORT, isRecord } from '@creatorweave/shared/webmcp-adapter-protocol'

/** Content-script transport only. The SW verifies the port's real sender origin. */
export function installAdapterHostRelay() {
  let port: chrome.runtime.Port | undefined
  let sessionId: string | undefined
  const post = (id: string, message: unknown) => window.postMessage({ [ADAPTER_HOST_MARKER]: true, direction: 'to-web', sessionId: id, message }, location.origin)
  window.addEventListener('message', event => {
    const data = event.data
    if (event.source !== window || data?.[ADAPTER_HOST_MARKER] !== true || data.direction !== 'to-extension' || typeof data.sessionId !== 'string' || !isRecord(data.message)) return
    const message = data.message
    if (message.kind === 'close') {
      if (sessionId === data.sessionId) { port?.disconnect(); port = undefined; sessionId = undefined }
      return
    }
    if (message.kind === 'publish' && sessionId !== data.sessionId) {
      port?.disconnect()
      sessionId = data.sessionId
      const id = sessionId!
      const connection = chrome.runtime.connect({ name: ADAPTER_HOST_PORT })
      port = connection
      connection.onMessage.addListener(reply => post(id, reply))
      connection.onDisconnect.addListener(() => {
        if (port === connection) { port = undefined; sessionId = undefined }
        post(id, { kind: 'disconnected' })
      })
    }
    if (!port || sessionId !== data.sessionId) return
    try { port.postMessage(message) } catch {
      port = undefined
      sessionId = undefined
      post(data.sessionId, { kind: 'disconnected' })
    }
  })
  window.addEventListener('pagehide', () => { port?.disconnect(); port = undefined; sessionId = undefined })
}
