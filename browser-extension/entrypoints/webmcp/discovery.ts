import type { WebMCPApiMode, WebMCPDiscoverResponse, WebMCPToolMeta } from './types'
import { runWebMCPPageProbe } from './page-api'
import {
  entriesToDiscoveredTools,
  getRegistryEntries,
  getRegistrySilentTabs,
  registerTab,
} from './registry'

// SW adapter descriptors remain discoverable even before destination proxies mount.
let adapterCatalog: ((tabId: number) => Promise<WebMCPToolMeta[]>) | undefined
export function installAdapterCatalog(provider: NonNullable<typeof adapterCatalog>): void {
  adapterCatalog = provider
}

// Legacy probe timeout — only used for registry-silent tabs (opened
// before the extension (re)loaded, no static content script inside).
const TAB_SCAN_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tab scan timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export function parseHostname(url: string): string | null {
  return parseOrigin(url) ? new URL(url).hostname || null : null
}

export function parseOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.origin || null
  } catch {
    return null
  }
}

export async function discoverToolsInTab(tabId: number): Promise<{
  ok: boolean
  mode?: WebMCPApiMode
  tools?: Array<{
    name: string
    description?: string
    inputSchema?: unknown
    annotations?: {
      readOnlyHint?: boolean
      untrustedContentHint?: boolean
    }
  }>
  error?: string
}> {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [{ type: 'discover' }],
        func: runWebMCPPageProbe,
      }),
      TAB_SCAN_TIMEOUT_MS,
    )

    return (results?.[0]?.result as any) || { ok: true, tools: [] }
  } catch (error: any) {
    return { ok: false, error: typeof error?.message === 'string' ? error.message : String(error) }
  }
}

/**
 * One-shot probe of registry-silent tabs — pages opened before the
 * extension (re)load carry no static content script. Successful
 * probes are fed INTO the registry so they persist for later reads.
 */
async function fallbackScanRegistrySilentTabs(windowId?: number, force = false): Promise<void> {
  const silentTabs = force
    ? (await chrome.tabs.query(typeof windowId === 'number' ? { windowId } : {}))
      .filter(tab => typeof tab.id === 'number' && parseOrigin(tab.url || ''))
      .map(tab => ({ tabId: tab.id!, windowId: tab.windowId }))
    : await getRegistrySilentTabs()
  const scoped =
    typeof windowId === 'number'
      ? silentTabs.filter((tab) => tab.windowId === windowId)
      : silentTabs

  const probes = await Promise.allSettled(
    scoped.map(async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId)
      const hostname = parseHostname(tab.url || '')
      const origin = parseOrigin(tab.url || '')
      if (!hostname || !origin) return null
      const result = await discoverToolsInTab(tabId)
      if (!result.ok || !result.tools) return null
      if ((await chrome.tabs.get(tabId)).url !== tab.url) return null
      return { tab, hostname, origin, result }
    }),
  )

  for (const settled of probes) {
    if (settled.status !== 'fulfilled') continue
    const entry = settled.value
    if (!entry) continue
    const { tab, hostname, origin, result } = entry
    try {
      await registerTab({
        tabId: tab.id!,
        hostname,
        origin,
        tabTitle: tab.title || '',
        tabUrl: tab.url || '',
        windowId: tab.windowId,
        apiMode: result.mode,
        tools: (result.tools ?? []).map((tool) => ({
          name: String(tool.name),
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      })
    } catch {
      // registration is best-effort; discovery still proceeds
    }
  }
}

export async function discoverWebMCPToolsInCurrentWindow(windowId?: number, force = false): Promise<WebMCPDiscoverResponse> {
  try {
    // Feed legacy tabs (pre-extension-load) into the registry first.
    await fallbackScanRegistrySilentTabs(windowId, force)

    const registryEntries =
      typeof windowId === 'number'
        ? (await getRegistryEntries()).filter((entry) => entry.windowId === windowId)
        : await getRegistryEntries()

    if (adapterCatalog) {
      const tabs = await chrome.tabs.query(typeof windowId === 'number' ? { windowId } : {})
      const snapshots = await Promise.allSettled(tabs.map(async tab => {
        const origin = parseOrigin(tab.url || '')
        const hostname = parseHostname(tab.url || '')
        if (!tab.id || !origin || !hostname) return null
        const adapters = await adapterCatalog!(tab.id)
        const current = await chrome.tabs.get(tab.id)
        if (current.url !== tab.url || !adapters.length) return null
        // Re-read the LIVE registry entry for this tab: the `registryEntries`
        // array was snapshotted before the adapter await above, and a page
        // may have reported a changed toolset (WEBMCP_TAB_REPORT) while we
        // were in flight. Merging onto the stale entry would clobber the
        // newer page report — the registry is the source of truth, so merge
        // onto the fresh entry instead (adapter wins same-name collisions).
        const freshEntries = await getRegistryEntries()
        const existing = freshEntries.find(entry => entry.tabId === tab.id)
        const tools = new Map((existing?.tools || []).map(tool => [tool.name, tool]))
        for (const tool of adapters) tools.set(tool.name, tool)
        return { tabId: tab.id, origin, hostname, tabTitle: tab.title || '',
          tabUrl: tab.url!, windowId: tab.windowId, apiMode: 'documentModelContext' as const,
          tools: [...tools.values()], updatedAt: Date.now(),
          // Transient — consumed by the post-registerTab marking below, never
          // passed to registerTab's persisted shape.
          adapterNames: new Set(adapters.map(tool => tool.name)) }
      }))
      for (const snapshot of snapshots) {
        if (snapshot.status !== 'fulfilled' || !snapshot.value) continue
        await registerTab(snapshot.value)
        // Mark adapter-served tools on the IN-MEMORY copy only, AFTER the
        // persisted registry write above — the persisted registry must never
        // store this flag because the WEBMCP_TAB_REPORT path feeds
        // page-controlled tools through it (sanitizeTool strips the flag from
        // raw reports; only this merge sets it programmatically).
        snapshot.value.tools = snapshot.value.tools.map((tool) =>
          snapshot.value!.adapterNames.has(tool.name) ? { ...tool, adapterServed: true } : tool
        )
        // Reflect the merge into the local registryEntries array for the
        // discovery response below. snapshot.value.tools was merged onto the
        // FRESH registry entry (re-read after the adapter await), so any
        // mid-await page report is preserved; a tab that was previously
        // silent and only reported mid-await simply gets pushed here.
        const index = registryEntries.findIndex(entry => entry.tabId === snapshot.value!.tabId)
        if (index < 0) registryEntries.push(snapshot.value)
        else registryEntries[index] = snapshot.value
      }
    }

    const discoveredAt = Date.now()
    // Return every tab instance. Consumers group by origin + raw tool name
    // for presentation, while retaining tabId as the runtime target.
    const tools = entriesToDiscoveredTools(registryEntries)
    const discoveredTabs = new Set(registryEntries.map((entry) => entry.tabId))

    return {
      ok: true,
      tools,
      scannedTabs: registryEntries.length,
      discoveredTabs: discoveredTabs.size,
      discoveredAt,
    }
  } catch (error: any) {
    return {
      ok: false,
      tools: [],
      scannedTabs: 0,
      discoveredTabs: 0,
      discoveredAt: Date.now(),
      error: typeof error?.message === 'string' ? error.message : String(error),
    }
  }
}
