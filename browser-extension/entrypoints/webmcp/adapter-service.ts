import { failure, jsonText, type ExecutionResult, type JsonValue } from '@creatorweave/quickjs-runtime'
import { parseWorkflow, validatePackageSnapshot, type WebMCPPackage } from '@creatorweave/shared/webmcp-adapter'
import { ADAPTER_HOST_PORT, ADAPTER_TIMEOUT_MS, ADAPTER_TRANSFER_BYTES, isRecord, type AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import { executeAdapterWorkflow } from './adapter-runtime'

interface Route { descriptor: AdapterDescriptor; source: string; rootUri?: string }
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
  readPackages(): Promise<Array<WebMCPPackage & {rootUri?: string}>>
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
  const readPackages = async () => {
    const mounted = await deps.readPackages()
    const packages = validatePackageSnapshot(mounted.map(({manifest, sources}) => ({manifest, sources})))
    return packages.map((pkg, index) => {
      const rootUri = mounted[index].rootUri
      if (rootUri !== undefined && rootUri !== `vfs://external/builtin-webmcp/${pkg.manifest.id}/` && rootUri !== `vfs://external/webmcp/${pkg.manifest.id}/`)
        throw new Error('Invalid package VFS root')
      return { ...pkg, rootUri }
    })
  }
  const updateRoutes = (host: Host, packages: Array<WebMCPPackage & {rootUri?: string}>) => {
    const snapshot = JSON.stringify(packages)
    if (snapshot === host.snapshot) return
    const previous = new Map(host.routes.map(route => [route.descriptor.name, route]))
    const routes = packages.flatMap(pkg => pkg.manifest.tools.map(tool => {
      const name = `${pkg.manifest.id}.${tool.name}`
      const source = pkg.sources[tool.path]
      const old = previous.get(name)
      if (old && old.source === source && old.rootUri === pkg.rootUri && old.descriptor.description === tool.description && old.descriptor.urlRegex === tool.urlRegex) return old
      return {
        source, rootUri: pkg.rootUri,
        descriptor: { routeId: crypto.randomUUID(), name, description: tool.description, urlRegex: tool.urlRegex,
          inputSchema: parseWorkflow(source).contract.inputSchema as Record<string, unknown> },
      }
    }))
    const retained = new Set(routes)
    for (const execution of executions.values())
      if (execution.host === host && !retained.has(execution.route)) execution.controller.abort()
    host.routes = routes
    host.snapshot = snapshot
    deps.changed()
  }
  let catalogQueue = Promise.resolve()
  // Attachment and refresh must share ordering: a slow attachment snapshot
  // must never resurrect routes withdrawn by a newer storage mutation.
  const catalogTask = (work: () => Promise<void>): Promise<void> => {
    const task = catalogQueue.catch(() => {}).then(work)
    catalogQueue = task
    return task
  }
  return {
    refresh(): Promise<void> {
      return catalogTask(async () => {
        try {
          const packages = await readPackages()
          for (const host of hosts) updateRoutes(host, packages)
        } catch (error) {
          for (const host of hosts) updateRoutes(host, [])
          throw error
        }
      })
    },
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
        if (message.kind !== 'attach') return
        queue = queue.then(() => catalogTask(async () => {
          jsonText(message, ADAPTER_TRANSFER_BYTES)
          if (typeof message.workspaceId !== 'string' || !message.workspaceId || typeof message.sessionId !== 'string' || !message.sessionId ||
            !Array.isArray(message.toolNames) || message.toolNames.length > 1000 || !message.toolNames.every(name => typeof name === 'string' && name.length < 256)) throw new Error('Invalid adapter host')
          const packages = await readPackages()
          const targetTabId = message.binding == null ? null : await deps.resolveBinding(port.sender!.url || '', message.binding)
          if (message.binding != null && targetTabId === null) throw new Error('Invalid host target binding')
          if (closed) return
          if (host && (host.workspaceId !== message.workspaceId || host.sessionId !== message.sessionId || host.targetTabId !== targetTabId)) throw new Error('Host binding is immutable; reconnect after switching workspace')
          if (!host) {
            host = { port, workspaceId: message.workspaceId, sessionId: message.sessionId, targetTabId, toolNames: [], routes: [], snapshot: '' }
            hosts.add(host)
          }
          host.toolNames = message.toolNames as string[]
          updateRoutes(host, packages)
          send(host, { kind: 'attached', requestId: message.requestId })
        })).catch(error => {
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
    /** Workspace invokes stay in the SW when navigation unloads the page proxy.
     * The caller has already passed normal WebMCP routing/authorization gates.
     * Obtain identity from Chrome, never from caller-provided URLs or document IDs.
     */
    async invokeForTab(tabId: number, toolName: string, args: Record<string, unknown>): Promise<ExecutionResult | null> {
      const tab = await chrome.tabs.get(tabId)
      if (!tab.url || !candidates(tabId, tab.url).some(item => item.route.descriptor.name === toolName)) return null
      const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href })
      if (!frame?.documentId || frame.frameId !== 0 || typeof frame.result !== 'string') throw new Error('Adapter target document unavailable')
      const route = candidates(tabId, frame.result).find(item => item.route.descriptor.name === toolName)
      if (!route) return null
      return this.invoke({ tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, documentId: frame.documentId, url: frame.result }, {
        requestId: crypto.randomUUID(), routeId: route.route.descriptor.routeId, args,
      })
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
        }, controller.signal, { tabId: target.tabId, url: target.url }, route.rootUri)
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
