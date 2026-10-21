import { BrowserError } from '../../lib/bash-commands/browser/errors'
import { discoverToolsInTab, parseHostname } from './discovery'
import { executeWebMCPToolInTab } from './invoke'
import { isHostEnabled, isGroupEnabled } from './authorization'
import { buildToolsetSignature } from './toolset-signature'
import { buildWebMCPGroupKey } from './group-key'
import type { AdapterDescriptor } from '@creatorweave/shared/webmcp-adapter-protocol'
import type { WebMCPToolMeta } from './types'

export interface TabWebMCPTool extends WebMCPToolMeta {
  source: 'page' | 'adapter'
}

export interface TabWebMCPCatalog {
  tabId: number
  url: string
  hostname: string
  groupKey: string
  tools: TabWebMCPTool[]
  pageProbeError?: string
}

export interface TabWebMCPApi {
  listForTab(tabId: number, signal?: AbortSignal): Promise<TabWebMCPCatalog>
  invokeForTab(tabId: number, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<TabWebMCPResult>
}

export interface TabWebMCPResult {
  tabId: number
  url: string
  name: string
  source: TabWebMCPTool['source']
  result: unknown
}

function fail(code: string, message: string): never {
  throw new BrowserError(message, { code })
}

/** Race only the caller's wait. Native page tools may still finish after cancel. */
export function waitForWebMCP<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('WebMCP request canceled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Live, exact-tab discovery. Never expands a request to other tabs or hosts. */
export function createTabWebMCPApi(adapters: { listForTab(tabId: number): Promise<AdapterDescriptor[]> }): TabWebMCPApi {
  const checkHost = async (tabId: number) => {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) fail('INVALID_TAB', 'Expected a positive Chrome tab ID')
    const tab = await chrome.tabs.get(tabId)
    const hostname = parseHostname(tab.url || '')
    if (!hostname) fail('UNSUPPORTED_URL', 'WebMCP requires an HTTP(S) tab')
    if (!await isHostEnabled(hostname)) fail('HOST_DISABLED', `WebMCP is disabled for ${hostname}`)
    return { url: tab.url!, hostname }
  }
  const listForTab = async (tabId: number, signal?: AbortSignal): Promise<TabWebMCPCatalog> => {
    signal?.throwIfAborted()
    const { url, hostname } = await checkHost(tabId)
    signal?.throwIfAborted()
    const [page, descriptors] = await waitForWebMCP(Promise.all([
      discoverToolsInTab(tabId), adapters.listForTab(tabId),
    ]), signal)
    const tools = new Map<string, TabWebMCPTool>()
    for (const tool of page.tools ?? []) tools.set(tool.name, {
      name: tool.name, description: tool.description ?? '', annotations: tool.annotations,
      inputSchema: typeof tool.inputSchema === 'object' && tool.inputSchema !== null && !Array.isArray(tool.inputSchema)
        ? tool.inputSchema as Record<string, unknown> : { type: 'object', properties: {} },
      source: 'page',
    })
    const pageGroupKey = buildWebMCPGroupKey(hostname, buildToolsetSignature([...tools.values()]))
    // The SW catalog wins over a page proxy, including its schema and execution route.
    for (const tool of descriptors) tools.set(tool.name, {
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema, source: 'adapter',
    })
    const current = await checkHost(tabId)
    if (current.url !== url) fail('PAGE_CHANGED', 'The tab navigated during WebMCP discovery; list tools again')
    const groupKey = buildWebMCPGroupKey(hostname, buildToolsetSignature([...tools.values()]))
    // Also respect the page-only group when adapter proxies have not appeared yet.
    if (!await isGroupEnabled(groupKey) || !await isGroupEnabled(pageGroupKey))
      fail('GROUP_DISABLED', `WebMCP is disabled for this tool group: ${groupKey}`)
    signal?.throwIfAborted()
    return { tabId, url, hostname, groupKey, tools: [...tools.values()],
      ...(!page.ok ? { pageProbeError: page.error || 'Page WebMCP discovery failed' } : {}) }
  }
  return {
    listForTab,
    async invokeForTab(tabId, name, args, signal) {
      if (!name || typeof name !== 'string') fail('INVALID_TOOL_NAME', 'Expected an exact WebMCP tool name')
      if (!args || typeof args !== 'object' || Array.isArray(args)) fail('INVALID_ARGUMENTS', 'WebMCP arguments must be a JSON object')
      const catalog = await listForTab(tabId, signal)
      const tool = catalog.tools.find(tool => tool.name === name)
      if (!tool && catalog.pageProbeError) fail('DISCOVERY_FAILED', catalog.pageProbeError)
      if (!tool) fail('TOOL_NOT_FOUND', `Tool not found in tab ${tabId}: ${name}`)
      const current = await checkHost(tabId)
      if (current.url !== catalog.url) fail('PAGE_CHANGED', 'The tab navigated before WebMCP execution; list tools again')
      signal?.throwIfAborted()
      const response = await waitForWebMCP(executeWebMCPToolInTab(tabId, name, args, signal, tool.source === 'adapter'), signal)
      if (!response.ok) fail(response.errorCode || 'INVOKE_FAILED', response.error || 'WebMCP execution failed')
      return { tabId, url: catalog.url, name, source: tool.source, result: response.result ?? null }
    },
  }
}
