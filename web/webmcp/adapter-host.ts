import { ADAPTER_HOST_MARKER, ADAPTER_TIMEOUT_MS, ADAPTER_TRANSFER_BYTES, isRecord } from '@creatorweave/shared/webmcp-adapter-protocol'
import { failure, jsonText, type JsonValue } from '@creatorweave/quickjs-runtime'

export interface AdapterToolHost {
  workspaceId: string
  binding: string | null
  names(): string[]
  invoke(name: string, args: Record<string, unknown>, callId: string, signal: AbortSignal, executionId: string): Promise<JsonValue>
  end?(executionId: string): void
  close?(): void
}

/** Bidirectional transport: incoming tool calls run independently of publication RPCs. */
export function connectAdapterHost(host: AdapterToolHost, disconnected: () => void) {
  const sessionId = crypto.randomUUID()
  let closed = false
  const calls = new Map<string, { executionId: string; controller: AbortController }>()
  const publications = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const send = (message: unknown) => {
    if (closed) return
    jsonText(message, ADAPTER_TRANSFER_BYTES)
    window.postMessage({ [ADAPTER_HOST_MARKER]: true, direction: 'to-extension', sessionId, message }, location.origin)
  }
  const stop = () => {
    if (closed) return
    send({ kind: 'close' })
    closed = true
    clearInterval(heartbeat)
    window.removeEventListener('message', receive)
    window.removeEventListener('pagehide', stop)
    for (const call of calls.values()) call.controller.abort()
    for (const executionId of new Set([...calls.values()].map(call => call.executionId))) host.end?.(executionId)
    calls.clear()
    host.close?.()
    for (const pending of publications.values()) { clearTimeout(pending.timer); pending.reject(new Error('Adapter host disconnected')) }
    publications.clear()
  }
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window || data?.[ADAPTER_HOST_MARKER] !== true || data.direction !== 'to-web' || data.sessionId !== sessionId || !isRecord(data.message) || closed) return
    const message = data.message
    if (message.kind === 'disconnected' || message.kind === 'error') { stop(); disconnected(); return }
    if (message.kind === 'attached' && typeof message.requestId === 'string') {
      const pending = publications.get(message.requestId)
      if (pending) { clearTimeout(pending.timer); publications.delete(message.requestId); pending.resolve() }
      return
    }
    if (message.kind === 'cancel' && typeof message.callId === 'string') {
      calls.get(message.callId)?.controller.abort()
      return
    }
    if (message.kind === 'end') {
      for (const call of calls.values()) if (call.executionId === message.executionId) call.controller.abort()
      if (typeof message.executionId === 'string') host.end?.(message.executionId)
      return
    }
    if (message.kind !== 'invoke' || typeof message.callId !== 'string' || typeof message.executionId !== 'string') return
    const callId = message.callId
    if (calls.has(callId)) return
    const controller = new AbortController()
    calls.set(callId, { executionId: message.executionId, controller })
    const timer = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS)
    void (async () => {
      try {
        if (calls.size > 32 || message.workspaceId !== host.workspaceId || typeof message.toolName !== 'string' || !host.names().includes(message.toolName) || !isRecord(message.args)) throw new Error('Tool unavailable in this workspace host')
        jsonText(message.args, ADAPTER_TRANSFER_BYTES)
        const value = await host.invoke(message.toolName, message.args, callId, controller.signal, message.executionId as string)
        controller.signal.throwIfAborted()
        send({ kind: 'reply', callId, result: { ok: true, value } })
      } catch (error) {
        send({ kind: 'reply', callId, result: { ok: false, error: failure(error) } })
      } finally { clearTimeout(timer); calls.delete(callId) }
    })()
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', stop)
  const heartbeat = setInterval(() => send({ kind: 'ping' }), 20_000)
  return {
    stop,
    attach(): Promise<void> {
      if (closed) return Promise.reject(new Error('Adapter host disconnected'))
      const requestId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { publications.delete(requestId); reject(new Error('Adapter publication timed out')); stop(); disconnected() }, 10_000)
        publications.set(requestId, { resolve, reject, timer })
        try { send({ kind: 'attach', requestId, sessionId, workspaceId: host.workspaceId, binding: host.binding, toolNames: host.names() }) }
        catch (error) { clearTimeout(timer); publications.delete(requestId); reject(error) }
      })
    },
  }
}
