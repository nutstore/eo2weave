import type { WebMCPApiMode, WebMCPDiscoverResponse, WebMCPToolMeta } from './types'
import { runWebMCPPageProbe } from './page-api'
import {
  entriesToDiscoveredTools,
  getFreshRegistryEntryForTab,
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
        // URL check only — an EMPTY catalog must still fall through: when a
        // tab previously carried adapter-served tools and the catalog now
        // lists none, ownership reconciliation below has to run so those
        // names stop being advertised (returning early here left stale
        // adapter-owned names in the registry with no route behind them).
        if (current.url !== tab.url) return null
        // Re-read the LIVE registry entry for this tab right before the
        // registerTab write: the `registryEntries` array was snapshotted
        // before the adapter await above, and a page may have reported a
        // changed toolset (WEBMCP_TAB_REPORT) while we were in flight. The
        // merge must run against the FRESHEST entry — merging onto the stale
        // snapshot would clobber the newer page report, and even the earlier
        // fresh re-read (before the per-tab awaits) can go stale because the
        // snapshot loop processes tabs sequentially with its own awaits.
        const freshEntry = await getFreshRegistryEntryForTab(tab.id)
        // Adapter ownership reconciliation: registry entries persist
        // page-reported tool names verbatim, so a previously adapter-served
        // name that the CURRENT catalog no longer lists (package update
        // removed/renamed the tool) must NOT keep riding the registry — it
        // would stay advertised with no route behind it. Names absent from
        // the current catalog are page-owned and survive unchanged; only
        // names this tab previously carried are reconciled (a name another
        // tab owns is not ours to remove).
        const adapterNames = new Set(adapters.map(tool => tool.name))
        const adapterOwnedNames = new Set<string>()
        const tools = new Map<string, WebMCPToolMeta>()
        for (const tool of freshEntry?.tools || []) {
          if (!tool.adapterOwned || adapterNames.has(tool.name)) tools.set(tool.name, tool)
        }
        // Legacy entries written before the ownership marker existed need no
        // name-based sweep: for every name the CURRENT catalog still serves,
        // the adapterOwnedNames list below re-marks the kept instance on the
        // persisted write, migrating the marker onto pre-marker entries. An
        // UNMARKED name the catalog no longer serves cannot be told apart
        // from a page tool by name alone (a page may register any raw name,
        // including builtin-qualified ones — see the forge-prevention test),
        // so it is preserved; the strict provenance gate in
        // localizedToolDescription already keeps such rows untranslated.
        // Merge order preserves the page tool on same-name collisions: insert
        // catalog tools at their name slot WITHOUT evicting what is already
        // there, and only mark names whose merged object is genuinely
        // adapter-owned. A page-reported object that won a collision must stay
        // OUT of adapterOwnedNames — otherwise a later catalog update that
        // drops the name would reconcile the page tool away with it. Route
        // truth is unaffected (the SW invokes the adapter before the page
        // relay for any name the current catalog serves), and the transient
        // adapterServed marking below still reflects that route.
        for (const tool of adapters) {
          const existing = tools.get(tool.name)
          if (!existing || existing.adapterOwned) {
            tools.set(tool.name, tool)
            adapterOwnedNames.add(tool.name)
          }
        }
        return { tabId: tab.id, origin, hostname, tabTitle: tab.title || '',
          tabUrl: tab.url!, windowId: tab.windowId, apiMode: 'documentModelContext' as const,
          // ALWAYS attach the list, even when empty: registerTab uses its
          // PRESENCE to discriminate an adapter merge (reconcile names the
          // catalog no longer serves) from a page report (never strip
          // adapter-owned tools).
          tools: [...tools.values()], updatedAt: Date.now(),
          adapterOwnedNames: [...adapterOwnedNames],
          // Transient — consumed by the post-registerTab marking below, never
          // passed to registerTab's persisted shape.
          adapterNames: new Set(adapters.map(tool => tool.name)) }
      }))
      for (const snapshot of snapshots) {
        if (snapshot.status !== 'fulfilled' || !snapshot.value) continue
        await registerTab(snapshot.value)
        // Reflect the merge into the discovery response below. The
        // authoritative data is the LIVE registry entry re-read AFTER
        // registerTab: registerTab merges against the live entry at write
        // time, so a WEBMCP_TAB_REPORT that landed after this tab's fresh
        // re-read is already merged into it — rebuilding from the pre-write
        // `snapshot.value` would drop that newer report from THIS response
        // (and from `registryEntries`, which it replaces) until the next
        // discovery run. The post-write adapterServed marking is reapplied on
        // the live copy (the persisted registry never stores the flag).
        const liveEntry = await getFreshRegistryEntryForTab(snapshot.value.tabId)
        // Null live read: registerTab reconciled the entry away (its merged
        // toolset was empty) — respect that removal instead of resurrecting
        // the stale pre-write snapshot.
        if (!liveEntry) continue
        const markedEntry = {
          ...liveEntry,
          tools: liveEntry.tools.map((tool) =>
            snapshot.value!.adapterNames.has(tool.name) && tool.adapterOwned
              ? { ...tool, adapterServed: true }
              : tool,
          ),
        }
        const index = registryEntries.findIndex(entry => entry.tabId === markedEntry.tabId)
        if (index < 0) registryEntries.push(markedEntry)
        else registryEntries[index] = markedEntry
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
