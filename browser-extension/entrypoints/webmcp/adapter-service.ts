import { failure, jsonText, type ExecutionResult, type JsonValue } from '@creatorweave/quickjs-runtime'
import { parseWorkflow, validatePackageSnapshot, type WebMCPPackage } from '@creatorweave/shared/webmcp-adapter'
import { ADAPTER_TIMEOUT_MS, ADAPTER_TRANSFER_BYTES, isRecord, type AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'
import { matchesToolUrl } from '@creatorweave/shared/webmcp-url'
import type { BrowserRequest } from '../../lib/bash-commands/browser/command'
import { executeAdapterWorkflow } from './adapter-runtime'

interface Route {
  descriptor: AdapterDescriptor
  source: string
  fingerprint: string
}

interface Execution {
  controller: AbortController
  route: Route
  tabId: number
  documentId: string
  url: string
  requestId: string
}

interface Dependencies {
  loadWasm(): Promise<WebAssembly.Module>
  readPackages(): Promise<WebMCPPackage[]>
  runBrowser(owner: string, request: BrowserRequest, signal: AbortSignal): Promise<unknown>
  changed(): void
}

/** Bound WASM loading as well as VM execution to explicit cancellation. */
function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Adapter execution canceled'), { code: 'JS_CANCELED' }))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/** Adapter catalog and execution are extension-owned and independent of CreatorWeave. */
export function createAdapterService(deps: Dependencies) {
  let routes: Route[] = []
  let routeSnapshot = ''
  const executions = new Map<string, Execution>()

  const withdraw = (retained: Set<Route>) => {
    for (const execution of executions.values()) {
      if (!retained.has(execution.route)) execution.controller.abort()
    }
  }
  const candidates = (url: string) =>
    routes.filter(route => matchesToolUrl(route.descriptor.urlRegex, url))
  const identity = (sender: chrome.runtime.MessageSender) => {
    if (typeof sender.tab?.id !== 'number' || !sender.documentId || sender.frameId !== 0 || !sender.url)
      throw new Error('Invalid adapter document')
    return { tabId: sender.tab.id, documentId: sender.documentId, url: sender.url }
  }
  const buildRoutes = (packages: WebMCPPackage[]): Route[] => {
    const previous = new Map(routes.map(route => [route.descriptor.name, route]))
    return packages.flatMap(pkg => pkg.manifest.tools.map(tool => {
      const name = `${pkg.manifest.id}.${tool.name}`
      const source = pkg.sources[tool.path]
      const inputSchema = parseWorkflow(source).contract.inputSchema as Record<string, unknown>
      const fingerprint = JSON.stringify([
        pkg.manifest.id,
        pkg.manifest.version,
        tool.path,
        tool.description,
        tool.urlRegex,
        source,
        inputSchema,
      ])
      const old = previous.get(name)
      if (old?.fingerprint === fingerprint) return old
      return {
        source,
        fingerprint,
        descriptor: {
          routeId: crypto.randomUUID(),
          name,
          description: tool.description,
          urlRegex: tool.urlRegex,
          inputSchema,
        },
      }
    }))
  }

  let catalogQueue = Promise.resolve()
  // Refreshes may race storage writes. Serialize them so an older snapshot
  // cannot resurrect routes after a newer mutation withdraws them.
  const catalogTask = (work: () => Promise<void>): Promise<void> => {
    const task = catalogQueue.catch(() => {}).then(work)
    catalogQueue = task
    return task
  }

  return {
    refresh(): Promise<void> {
      return catalogTask(async () => {
        try {
          const mounted = await deps.readPackages()
          const packages = validatePackageSnapshot(mounted.map(({ manifest, sources }) => ({ manifest, sources })))
          const next = buildRoutes(packages)
          if (JSON.stringify(next) === routeSnapshot) return
          const retained = new Set(next)
          withdraw(retained)
          routes = next
          routeSnapshot = JSON.stringify(next)
          deps.changed()
        } catch (error) {
          withdraw(new Set())
          if (routes.length !== 0 || routeSnapshot !== '[]') {
            routes = []
            routeSnapshot = '[]'
            deps.changed()
          }
          throw error
        }
      })
    },

    catalog(sender: chrome.runtime.MessageSender): AdapterDescriptor[] {
      const { url } = identity(sender)
      return candidates(url).map(route => route.descriptor)
    },

    async listForTab(tabId: number): Promise<AdapterDescriptor[]> {
      const tab = await chrome.tabs.get(tabId)
      return tab.url ? candidates(tab.url).map(route => route.descriptor) : []
    },

    /** Invocations remain in the SW when the initiating document navigates away. */
    async invokeForTab(
      tabId: number,
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ExecutionResult | null> {
      signal?.throwIfAborted()
      const tab = await chrome.tabs.get(tabId)
      if (!tab.url || !candidates(tab.url).some(route => route.descriptor.name === toolName)) return null
      const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.href })
      if (!frame?.documentId || frame.frameId !== 0 || typeof frame.result !== 'string')
        throw new Error('Adapter target document unavailable')
      const route = candidates(frame.result).find(item => item.descriptor.name === toolName)
      if (!route) return null
      return this.invoke({
        tab: { id: tabId } as chrome.tabs.Tab,
        frameId: 0,
        documentId: frame.documentId,
        url: frame.result,
      }, {
        requestId: crypto.randomUUID(),
        routeId: route.descriptor.routeId,
        args,
      }, signal)
    },

    cancel(sender: chrome.runtime.MessageSender, requestId: unknown) {
      const { tabId, documentId } = identity(sender)
      for (const execution of executions.values()) {
        if (execution.tabId === tabId && execution.documentId === documentId && execution.requestId === requestId)
          execution.controller.abort()
      }
    },

    async invoke(
      sender: chrome.runtime.MessageSender,
      message: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ExecutionResult> {
      let executionId: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      try {
        signal?.throwIfAborted()
        const target = identity(sender)
        if (typeof message.requestId !== 'string' || message.requestId.length > 128 || !isRecord(message.args))
          throw new Error('Invalid adapter request')
        jsonText(message.args, ADAPTER_TRANSFER_BYTES)
        const route = candidates(target.url).find(item => item.descriptor.routeId === message.routeId)
        if (!route) throw new Error('Adapter registration is stale or unavailable')

        executionId = crypto.randomUUID()
        const controller = new AbortController()
        abort = () => controller.abort(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        executions.set(executionId, { ...target, route, controller, requestId: message.requestId })
        timer = setTimeout(() => controller.abort(), ADAPTER_TIMEOUT_MS)
        const wasm = await abortable(deps.loadWasm, controller.signal)
        controller.signal.throwIfAborted()

        return await executeAdapterWorkflow(
          wasm,
          route.source,
          message.args as JsonValue,
          async (request, browserSignal) => {
            const value = await deps.runBrowser(executionId!, request, browserSignal)
            return JSON.parse(jsonText(value, ADAPTER_TRANSFER_BYTES)) as JsonValue
          },
          controller.signal,
          { tabId: target.tabId, url: target.url },
        )
      } catch (error) {
        return { ok: false, error: failure(error) }
      } finally {
        if (abort) signal?.removeEventListener('abort', abort)
        clearTimeout(timer)
        if (executionId) {
          executions.get(executionId)?.controller.abort()
          executions.delete(executionId)
        }
      }
    },
  }
}
