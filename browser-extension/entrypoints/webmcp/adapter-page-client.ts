import { ADAPTER_PAGE_MARKER, ADAPTER_TIMEOUT_MS, type AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'

/** Independent request IDs permit reentrant Web host calls while a page call waits. */
export function invokeAdapterFromPage(tool: AdapterDescriptor, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const send = (kind: string) => window.postMessage({ [ADAPTER_PAGE_MARKER]: true, kind, requestId, routeId: tool.routeId, args }, location.origin)
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      window.removeEventListener('message', receive)
      window.removeEventListener('pagehide', detach)
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () => { send('cancel'); finish(new Error('Adapter execution canceled')) }
    // A full navigation destroys the caller, not the service-worker workflow.
    const detach = () => finish(new Error('Adapter caller document unloaded; workflow continues'))
    const receive = (event: MessageEvent) => {
      const data = event.data
      if (event.source !== window || data?.[ADAPTER_PAGE_MARKER] !== true || data.kind !== 'result' || data.requestId !== requestId) return
      finish(data.response?.ok ? undefined : Object.assign(new Error(data.response?.error?.message || 'Adapter execution failed'), data.response?.error), data.response?.value)
    }
    const timer = setTimeout(() => { send('cancel'); finish(new Error('Adapter execution timed out')) }, ADAPTER_TIMEOUT_MS + 1_000)
    signal.addEventListener('abort', abort, { once: true })
    window.addEventListener('pagehide', detach, { once: true })
    window.addEventListener('message', receive)
    send('invoke')
  })
}
