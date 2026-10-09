import { failure, jsonText, type ExecutionResult, type JsonValue } from '@creatorweave/quickjs-runtime'
import { parseWorkflow, validatePackageSnapshot } from '@creatorweave/shared/webmcp-adapter'
import { ADAPTER_HOST_PORT, ADAPTER_TIMEOUT_MS, ADAPTER_TRANSFER_BYTES, isRecord, type AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import { executeAdapterWorkflow } from './adapter-runtime'

interface Route { descriptor: AdapterDescriptor; source: string }
interface Host {
  port: chrome.runtime.Port
  workspaceId: string
  sessionId: string
  targetTabId: number | null
  toolNames: string[]
  routes: Route[]
  snapshot: string
}
interface Execution {
  controller: AbortController
  host: Host
  route: Route
  tabId: number
  documentId: string
  url: string
  requestId: string
}
interface Dependencies {
  loadWasm(): Promise<WebAssembly.Module>
  trusted(sender: chrome.runtime.MessageSender): boolean
  resolveBinding(senderUrl: string, binding: unknown): Promise<number | null>
  changed(): void
}

/** Bound WASM loading as well as VM execution to explicit cancellation. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Adapter execution canceled'), { code: 'JS_CANCELED' }))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

/** All authority and source code live in the SW. No page-provided code is evaluated. */
export function createAdapterService(deps: Dependencies) {
  const hosts = new Set<Host>()
  const executions = new Map<string, Execution>()
  const replies = new Map<string, { host: Host; settle: (value: ExecutionResult) => void }>()
  const cancelHost = (host: Host) => {
    hosts.delete(host)
    for (const execution of executions.values()) if (execution.host === host) execution.controller.abort()
    deps.changed()
  }
  const send = (host: Host, message: unknown) => {
    try { host.port.postMessage(message) } catch { cancelHost(host) }
  }
  const invokeHost = (host: Host, executionId: string, toolName: string, args: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
    signal.throwIfAborted()
    if (!hosts.has(host) || !host.toolNames.includes(toolName)) throw new Error('Tool host unavailable')
    const callId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const settle = (result: ExecutionResult) => {
        replies.delete(callId)
        signal.removeEventListener('abort', abort)
        if (result.ok) resolve(result.value)
        else reject(Object.assign(new Error(result.error.message), result.error))
      }
      const abort = () => {
        send(host, { kind: 'cancel', executionId, callId })
        settle({ ok: false, error: { code: 'JS_CANCELED', message: 'Adapter host call canceled' } })
      }
      replies.set(callId, { host, settle })
      signal.addEventListener('abort', abort, { once: true })
      send(host, { kind: 'invoke', executionId, callId, toolName, args, workspaceId: host.workspaceId })
    })
  }
  const candidates = (tabId: number, url: string) => {
    const routes = [...hosts].flatMap(host => host.targetTabId !== null && host.targetTabId !== tabId ? [] :
      host.routes.filter(route => matchesToolUrl(route.descriptor.urlRegex, url)).map(route => ({ host, route })))
    // A bound side panel wins over unbound hosts. Otherwise ambiguity is unavailable,
    // never resolved by whichever workspace happened to publish last.
    const names = new Set(routes.map(item => item.route.descriptor.name))
    return [...names].flatMap(name => {
      const matching = routes.filter(item => item.route.descriptor.name === name)
      const bound = matching.filter(item => item.host.targetTabId === tabId)
      const selected = bound.length ? bound : matching
      return selected.length === 1 ? selected : []
    })
  }
  const identity = (sender: chrome.runtime.MessageSender) => {
    if (typeof sender.tab?.id !== 'number' || !sender.documentId || sender.frameId !== 0 || !sender.url) throw new Error('Invalid adapter document')
    return { tabId: sender.tab.id, documentId: sender.documentId, url: sender.url }
  }
  return {
    connect(port: chrome.runtime.Port) {
      if (port.name !== ADAPTER_HOST_PORT) return
      if (!port.sender || !deps.trusted(port.sender)) { port.disconnect(); return }
      let host: Host | undefined
      let closed = false
      let queue = Promise.resolve()
      port.onDisconnect.addListener(() => { closed = true; if (host) cancelHost(host) })
      port.onMessage.addListener((message: unknown) => {
        if (!isRecord(message) || closed) return
        // Replies must not queue behind requests; workflows can call their own waiting host.
        if (message.kind === 'reply' && typeof message.callId === 'string') {
          const pending = replies.get(message.callId)
          if (!pending || pending.host !== host) return
          try {
            jsonText(message.result, ADAPTER_TRANSFER_BYTES)
            const result = message.result
            if (!isRecord(result) || (result.ok !== true && result.ok !== false) ||
              (result.ok === false && (!isRecord(result.error) || typeof result.error.message !== 'string' || typeof result.error.code !== 'string'))) throw new Error('Invalid tool reply')
            pending.settle(result as unknown as ExecutionResult)
          } catch (error) { pending.settle({ ok: false, error: failure(error) }) }
          return
        }
        if (message.kind === 'ping') { port.postMessage({ kind: 'pong' }); return }
        if (message.kind !== 'publish') return
        queue = queue.then(async () => {
          jsonText(message, ADAPTER_TRANSFER_BYTES)
          if (typeof message.workspaceId !== 'string' || !message.workspaceId || typeof message.sessionId !== 'string' || !message.sessionId ||
            !Array.isArray(message.toolNames) || message.toolNames.length > 1000 || !message.toolNames.every(name => typeof name === 'string' && name.length < 256)) throw new Error('Invalid adapter host')
          const packages = validatePackageSnapshot(message.packages)
          const targetTabId = message.binding == null ? null : await deps.resolveBinding(port.sender!.url || '', message.binding)
          if (message.binding != null && targetTabId === null) throw new Error('Invalid host target binding')
          if (closed) return
          if (host && (host.workspaceId !== message.workspaceId || host.sessionId !== message.sessionId || host.targetTabId !== targetTabId)) throw new Error('Host binding is immutable; reconnect after switching workspace')
          if (!host) {
            host = { port, workspaceId: message.workspaceId, sessionId: message.sessionId, targetTabId, toolNames: [], routes: [], snapshot: '' }
            hosts.add(host)
          }
          host.toolNames = message.toolNames as string[]
          const snapshot = JSON.stringify(packages)
          if (snapshot !== host.snapshot) {
            for (const execution of executions.values()) if (execution.host === host) execution.controller.abort()
            host.routes = packages.flatMap(pkg => pkg.manifest.tools.map(tool => ({
              source: pkg.sources[tool.path],
              descriptor: { routeId: crypto.randomUUID(), name: `${pkg.manifest.id}.${tool.name}`, description: tool.description, urlRegex: tool.urlRegex,
                inputSchema: parseWorkflow(pkg.sources[tool.path]).contract.inputSchema as Record<string, unknown> },
            })))
            host.snapshot = snapshot
            deps.changed()
          }
          send(host, { kind: 'published', requestId: message.requestId })
        }).catch(error => {
          try { port.postMessage({ kind: 'error', requestId: message.requestId, error: failure(error) }) } finally {
            closed = true
            if (host) cancelHost(host)
            port.disconnect()
          }
        })
      })
    },
    catalog(sender: chrome.runtime.MessageSender): AdapterDescriptor[] {
      const { tabId, url } = identity(sender)
      return candidates(tabId, url).map(item => item.route.descriptor)
    },
    cancel(sender: chrome.runtime.MessageSender, requestId: unknown) {
      const { tabId, documentId } = identity(sender)
      for (const execution of executions.values()) {
        if (execution.tabId === tabId && execution.documentId === documentId && execution.requestId === requestId) execution.controller.abort()
      }
    },
    async invoke(sender: chrome.runtime.MessageSender, message: Record<string, unknown>): Promise<ExecutionResult> {
      let executionId: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const target = identity(sender)
        if (typeof message.requestId !== 'string' || message.requestId.length > 128 || !isRecord(message.args)) throw new Error('Invalid adapter request')
        jsonText(message.args, ADAPTER_TRANSFER_BYTES)
        const selected = candidates(target.tabId, target.url).find(item => item.route.descriptor.routeId === message.routeId)
        if (!selected) throw new Error('Adapter registration is stale, ambiguous or unavailable')
        const { host, route } = selected
        if (executions.size >= 8) throw new Error('Adapter concurrency limit exceeded')
        executionId = crypto.randomUUID()
        const controller = new AbortController()
        executions.set(executionId, { ...target, host, route, controller, requestId: message.requestId })
        timer = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS)
        const wasm = await abortable(deps.loadWasm, controller.signal)
        controller.signal.throwIfAborted()
        return await executeAdapterWorkflow(wasm, route.source, message.args as JsonValue, [...host.toolNames], async ([name, args], signal) => {
          signal.throwIfAborted()
          if (!isRecord(args) || typeof name !== 'string') throw new Error('Tool arguments must be an object')
          return invokeHost(host, executionId!, name, args as JsonValue, signal)
        }, controller.signal, { tabId: target.tabId, url: target.url })
      } catch (error) { return { ok: false, error: failure(error) } }
      finally {
        clearTimeout(timer)
        if (executionId) {
          const execution = executions.get(executionId)
          execution?.controller.abort()
          if (execution) send(execution.host, { kind: 'end', executionId })
          executions.delete(executionId)
        }
      }
    },
  }
}
