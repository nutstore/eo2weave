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
let adapterCatalogGeneration = 0

export function installAdapterCatalog(provider: NonNullable<typeof adapterCatalog>): void {
  // A new provider means a refreshed route set (package install/update/
  // remove). Every in-flight discovery run that snapshotted the previous
  // catalog loses its freshness guarantee at this instant — the generation
  // check below makes them abandon their commits.
  adapterCatalog = provider
  adapterCatalogGeneration++
}

function currentCatalogGeneration(): number {
  return adapterCatalogGeneration
}

/**
 * Current-catalog revalidation for the invoke path: returns the catalog's
 * tool list for the tab (null when no catalog is installed). Callers use it
 * to re-check, at execution time, that a registry entry marked adapter-owned
 * still has a live adapter route behind it.
 */
export async function currentAdapterCatalogForTab(tabId: number): Promise<WebMCPToolMeta[] | null> {
  if (!adapterCatalog) return null
  return adapterCatalog(tabId)
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
      // Catalog generation captured BEFORE the first snapshot: if a catalog
      // refresh (installAdapterCatalog) happens while this run is in flight,
      // the check before each commit below fails and the run's stale
      // adapter snapshot is never written back into the registry (a stale
      // snapshot would register tools whose adapter routes the newer
      // catalog already withdrew).
      const catalogGeneration = currentCatalogGeneration()
      const tabs = await chrome.tabs.query(typeof windowId === 'number' ? { windowId } : {})
      const snapshots = await Promise.allSettled(tabs.map(async tab => {
        const origin = parseOrigin(tab.url || '')
        const hostname = parseHostname(tab.url || '')
        if (!tab.id || !origin || !hostname) return null
        const adapters = await adapterCatalog!(tab.id)
        const current = await chrome.tabs.get(tab.id)
        // URL check only — an EMPTY catalog must still fall through: when a
        // tab previously carried adapter-served tools and the catalog now
        // lists none, the empty snapshot reaches registerTab's adapter-merge
        // branch so marked names stop being advertised (an early return here
        // left stale adapter-owned names in the registry with no route
        // behind them).
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
        const adapterNames = new Set(adapters.map(tool => tool.name))
        const adapterOwnedNames = new Set<string>()
        const tools = new Map<string, WebMCPToolMeta>()
        // Unmarked names are page-owned → keep them verbatim. MARKED names
        // ride only while the catalog serves them — a marked name the
        // catalog dropped stays OUT of the snapshot so registerTab's merge
        // reconciles it away (never advertise an adapter tool with no route).
        // An UNMARKED name the catalog no longer serves is deliberately
        // preserved: it cannot be told apart from a page tool by name alone
        // (a page may register any raw name, including builtin-qualified
        // ones — see the forge-prevention test), and the strict provenance
        // gate in localizedToolDescription already keeps such rows
        // untranslated.
        for (const tool of freshEntry?.tools || []) {
          if (!tool.adapterOwned || adapterNames.has(tool.name)) tools.set(tool.name, tool)
        }
        // Catalog-served names ALWAYS take the adapter's object (displacing
        // any colliding page-reported object under the same raw name), and
        // every one is marked adapter-owned. Invocation routes any name the
        // current catalog serves through the adapter FIRST (invoke.ts tries
        // the adapter before the page relay), so the advertised
        // description/schema must be the adapter's: keeping the PAGE's
        // object here would make the authorization prompt describe a
        // different action than the one that actually executes. The
        // persisted entry still keeps the page's colliding object (it must
        // survive a later catalog drop unharmed — see the same-name test),
        // so the discovery response below re-applies the catalog object on
        // the live copy for these names. A stale pre-marker adapter object
        // occupying a served name is migrated onto the CURRENT catalog
        // metadata by the same overwrite.
        for (const tool of adapters) {
          tools.set(tool.name, tool)
          adapterOwnedNames.add(tool.name)
        }
        return { tabId: tab.id, origin, hostname, tabTitle: tab.title || '',
          tabUrl: tab.url!, windowId: tab.windowId, apiMode: 'documentModelContext' as const,
          // ALWAYS attach the list, even when empty: registerTab uses its
          // PRESENCE to discriminate an adapter merge (reconcile names the
          // catalog no longer serves) from a page report (never strip
          // adapter-owned tools).
          tools: [...tools.values()], updatedAt: Date.now(),
          adapterOwnedNames: [...adapterOwnedNames],
          // Transient — consumed by the post-registerTab response marking
          // below, never passed to registerTab's persisted shape.
          adapterNames: new Set(adapters.map(tool => tool.name)),
          // Name → catalog object, so the response can re-apply the
          // ADAPTER's metadata over the persisted page-reported colliding
          // object (the advertised action must match the adapter route).
          adapterByTool: new Map(adapters.map(tool => [tool.name, tool])) }
      }))
      for (const snapshot of snapshots) {
        if (snapshot.status !== 'fulfilled' || !snapshot.value) continue
        // Stale-snapshot guard (Sourcery round-5): a catalog refresh that
        // landed while this run was awaiting its snapshots invalidates every
        // adapter snapshot taken before it. Committing one would register
        // adapter tools whose routes the newer catalog already withdrew —
        // exactly the "stale discovery restores removed tools" race. Skip
        // the commit; the next discovery run against the refreshed catalog
        // rebuilds and reconciles correctly.
        if (currentCatalogGeneration() !== catalogGeneration) break
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
        // Null/garbage live read: registerTab reconciled the entry away (its
        // merged toolset was empty) — respect that removal instead of
        // resurrecting the stale pre-write snapshot.
        if (!liveEntry || !Array.isArray(liveEntry.tools)) {
          // The removal must also leave THIS response: the tab's earlier
          // entry still sits in `registryEntries` (snapshotted before the
          // write), and leaving it would keep advertising tools whose
          // adapter routes are gone. Drop the stale entry from the response
          // set (Sourcery round-5: "Removed tools remain advertised").
          const staleIndex = registryEntries.findIndex(entry => entry.tabId === snapshot.value!.tabId)
          if (staleIndex >= 0) registryEntries.splice(staleIndex, 1)
          continue
        }
        // adapterServed marking is keyed on the catalog list THIS run
        // snapshotted — and it stays valid only while that snapshot is the
        // CURRENT one. A catalog refresh between the snapshot and this
        // marking means a dropped route's name would be advertised with the
        // old adapter description and a trusted-provenance flag, letting a
        // colliding page tool execute under the adapter's previously
        // trusted description once invokeAdapter returns null and the page
        // relay is used as fallback. Never mark from a stale snapshot.
        const catalogIsCurrent = currentCatalogGeneration() === catalogGeneration
        const markedEntry = {
          ...liveEntry,
          // Two per-name adjustments on THIS tab's copy, keyed on the
          // current catalog list:
          // 1. adapterServed is the response's provenance flag — every
          //    catalog-served name on this tab routes through the adapter,
          //    so it must carry the flag (previously guarded by a marker
          //    cross-check that only mattered while the merge could leave a
          //    page object under a served name).
          // 2. The catalog's own object overrides the live copy's stored
          //    metadata: registerTab deliberately keeps a page-reported
          //    colliding object in the PERSISTED entry (it must survive a
          //    later catalog drop), but the ADVERTISED action for a served
          //    name is the adapter's — the authorization prompt is built
          //    from this copy, and invocation routes the name through the
          //    adapter first (invoke.ts). Without this, the prompt would
          //    describe the page's colliding action while the adapter's
          //    action executes.
          tools: liveEntry.tools.map((tool) => {
            if (!catalogIsCurrent || !snapshot.value!.adapterNames.has(tool.name)) return tool
            const adapterTool = snapshot.value!.adapterByTool.get(tool.name)
            return {
              ...(adapterTool ?? tool),
              adapterServed: true,
            }
          }),
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
