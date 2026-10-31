// ============================================================
// WebMCP tab registry — background-side, event-fed snapshot
// of which tabs currently expose which WebMCP tools.
//
// Replaces scan-on-demand as the primary discovery source:
// static content scripts (webmcp-injected.content.ts MAIN world
// + webmcp.content.ts ISOLATED relay) push `ready`/`snapshot`
// reports at page load and on every toolset change, so the
// popup/web app read an always-fresh cache instead of waiting
// for a full-window tab scan (the old 5s-per-tab probe).
//
// Fallback: tabs opened before the extension (re)loaded have no
// content script. `webmcp_discover_tools` merges registry data
// with a legacy chrome.scripting probe of registry-silent tabs
// (see discovery.ts fallbackForRegistrySilentTabs).
//
// Persistence: chrome.storage.session (survives service-worker
// restarts, cleared on browser restart). Disabled hosts stay in
// storage.local via authorization.ts.
// ============================================================

import type { WebMCPApiMode, WebMCPDiscoveredTool, WebMCPToolMeta } from './types'
import { buildSafeFullName } from './tool-name'
import { WEBMCP_REGISTRY_UPDATED_TYPE } from './relay-protocol'

// Local copy of discovery.ts parsers' URL check to avoid a
// registry ↔ discovery import cycle (discovery imports this module
// for the legacy fallback path).
function parseSupportedUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

export interface WebMCPRegisteredTabEntry {
  tabId: number
  /** Browser-verified from sender.tab (page content cannot forge it). */
  hostname: string
  /** Canonical origin from the browser-verified tab URL. */
  origin: string
  tabTitle: string
  tabUrl: string
  windowId?: number
  apiMode: WebMCPApiMode
  tools: WebMCPToolMeta[]
  updatedAt: number
}

const STORAGE_KEY = 'webmcp_tab_registry'
const SEEN_STORAGE_KEY = 'webmcp_tab_registry_seen'
const MAX_ENTRIES = 60

/** In-memory mirror; storage.session is the durability layer. */
let entries = new Map<number, WebMCPRegisteredTabEntry>()
/** Tabs whose static content script has reported at least once — including
 * tool-less pages. Distinguishes "reported, no tools" (skip legacy probe)
 * from "never reported" (tab predates extension load → probe fallback). */
let seenTabs = new Set<number>()
let hydrated = false
let hydrationPromise: Promise<void> | null = null

async function hydrate(): Promise<void> {
  if (hydrated) return
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    try {
      const result = await chrome.storage.session.get([STORAGE_KEY, SEEN_STORAGE_KEY])
      const raw = result?.[STORAGE_KEY]
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const entry = sanitizeEntry(item, item?.tabId)
          if (entry) {
            entries.set(entry.tabId, entry)
            seenTabs.add(entry.tabId)
          }
        }
      }
      const seenRaw = result?.[SEEN_STORAGE_KEY]
      if (Array.isArray(seenRaw)) {
        for (const tabId of seenRaw) {
          if (typeof tabId === 'number') seenTabs.add(tabId)
        }
      }
    } catch {
      // storage.session unavailable (old Chrome) — registry stays memory-only
    }
    hydrated = true
  })()
  return hydrationPromise
}

function sanitizeTool(raw: unknown): WebMCPToolMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const tool = raw as Record<string, unknown>
  if (typeof tool.name !== 'string' || tool.name.trim().length === 0) return null

  let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
  if (typeof tool.inputSchema === 'string') {
    try {
      const parsed = JSON.parse(tool.inputSchema)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inputSchema = parsed as Record<string, unknown>
      }
    } catch {
      // keep default empty schema
    }
  } else if (tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)) {
    inputSchema = tool.inputSchema as Record<string, unknown>
  }

  const annotations =
    tool.annotations && typeof tool.annotations === 'object'
      ? {
          readOnlyHint: !!(tool.annotations as Record<string, unknown>).readOnlyHint,
          untrustedContentHint: !!(tool.annotations as Record<string, unknown>).untrustedContentHint,
        }
      : undefined

  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema,
    annotations,
  }
}

/**
 * Internal-only marker reader: the service-worker adapter catalog (not the
 * page) owns this tool name on this tab. The flag is written only through
 * RegisterTabInput.adapterOwnedNames (discovery.ts merge) and survives
 * storage.session hydration via the marker rebuild in sanitizeEntry — a
 * hostile page cannot set it because sanitizeTool whitelists tool fields.
 */
function isAdapterOwned(raw: unknown): boolean {
  return !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>).adapterOwned === true)
}

function sanitizeEntry(raw: unknown, tabId: unknown): WebMCPRegisteredTabEntry | null {
  if (!raw || typeof raw !== 'object') return null
  if (typeof tabId !== 'number') return null
  const item = raw as Record<string, unknown>
  if (typeof item.hostname !== 'string' || item.hostname.length === 0) return null

  // adapterOwned is a SW-internal bookkeeping field: keep it across the
  // in-memory roundtrip through storage.session, but rebuild it from the
  // stored marker rather than trusting the page-controlled payload —
  // sanitizeTool (above) whitelists fields, so a page cannot set it.
  const adapterOwnedNames = Array.isArray(item.tools)
    ? new Set(
        item.tools
          .filter((tool: unknown) => isAdapterOwned(tool))
          .map((tool: unknown) => (tool as Record<string, unknown>).name as string),
      )
    : new Set<string>()

  const tools = Array.isArray(item.tools)
    ? (item.tools.map(sanitizeTool).filter(Boolean) as WebMCPToolMeta[])
        .map((tool) =>
          adapterOwnedNames.has(tool.name) ? { ...tool, adapterOwned: true } : tool,
        )
    : []
  if (tools.length === 0) return null

  const hostname = item.hostname
  const tabUrl = typeof item.tabUrl === 'string' ? item.tabUrl : ''
  const parsedUrl = parseSupportedUrl(tabUrl)
  if (!parsedUrl || parsedUrl.hostname !== hostname) return null
  const now = Date.now()

  return {
    tabId,
    hostname,
    origin: parsedUrl.origin,
    tabTitle: typeof item.tabTitle === 'string' ? item.tabTitle : '',
    tabUrl,
    windowId: typeof item.windowId === 'number' ? item.windowId : undefined,
    apiMode:
      typeof item.apiMode === 'string' && item.apiMode.length > 0
        ? (item.apiMode as WebMCPApiMode)
        : 'documentModelContext',
    tools,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : now,
  }
}

async function persist(): Promise<void> {
  try {
    const all = [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES)
    await chrome.storage.session.set({
      [STORAGE_KEY]: all,
      [SEEN_STORAGE_KEY]: [...seenTabs].slice(-200),
    })
  } catch {
    // memory-only registry still works for this SW lifetime
  }
}

function notifyRegistryUpdated(): void {
  // Runtime broadcast: popup (if open) re-reads the snapshot and re-renders
  // incrementally. Pages ignore this message — their bridge surfaces stay
  // request/response (they re-query on demand).
  try {
    chrome.runtime.sendMessage({ type: WEBMCP_REGISTRY_UPDATED_TYPE }).catch(() => {})
  } catch {
    // no receivers — fine
  }
}

export interface RegisterTabInput {
  tabId: number
  hostname: string
  origin: string
  tabTitle: string
  tabUrl: string
  windowId?: number
  apiMode?: WebMCPApiMode
  tools: Array<{
    name: string
    description?: string
    inputSchema?: unknown
    annotations?: {
      readOnlyHint?: boolean
      untrustedContentHint?: boolean
    }
  }>
  /**
   * SW-internal: names of tools owned by the extension adapter catalog.
   * Only the adapter merge in discovery.ts passes this; the page-facing
   * WEBMCP_TAB_REPORT path (background.ts) never does, and sanitizeTool's
   * field whitelist drops any adapterOwned key a page smuggles into its
   * tool objects — so the marker cannot be forged.
   */
  adapterOwnedNames?: string[]
}

/**
 * Record/replace a tab's tool snapshot. Empty toolsets REMOVE the tab
 * (a page that unregistered all tools no longer exists for discovery).
 */
export async function registerTab(input: RegisterTabInput): Promise<void> {
  await hydrate()
  seenTabs.add(input.tabId)

  const previous = entries.get(input.tabId)
  // Caller discrimination: the adapter merge (discovery.ts) ALWAYS passes
  // adapterOwnedNames — even when the reconciled set is empty — while the
  // page relay (WEBMCP_TAB_REPORT, legacy probe) never does. The merge
  // semantics below depend on this.
  const isAdapterMerge = Array.isArray(input.adapterOwnedNames)

  if (input.tools.length === 0) {
    if (isAdapterMerge) {
      // The adapter merge reconciled every name away (or the tab never had
      // tools): remove the entry — keeping it would advertise names the
      // current catalog no longer serves.
      if (entries.delete(input.tabId)) {
        await persist()
        notifyRegistryUpdated()
      } else {
        await persist() // still record "seen" even if nothing to remove
      }
      return
    }
    // Page-reported empty toolset: adapter-owned tools did not go anywhere —
    // the SW adapter catalog still serves them — so an empty page report must
    // not strip them. Keep exactly those; without any, remove the tab (a page
    // that unregistered all tools no longer exists for discovery beyond the
    // adapter tools it does not own).
    const surviving = (previous?.tools ?? []).filter((tool) => tool.adapterOwned)
    if (previous && surviving.length > 0) {
      entries.set(input.tabId, {
        ...previous,
        hostname: input.hostname,
        origin: input.origin,
        tabTitle: input.tabTitle,
        tabUrl: input.tabUrl,
        windowId: input.windowId ?? previous.windowId,
        apiMode: input.apiMode || previous.apiMode,
        tools: surviving,
        updatedAt: Date.now(),
      })
      await persist()
      notifyRegistryUpdated()
      return
    }
    if (entries.delete(input.tabId)) {
      await persist()
      notifyRegistryUpdated()
    } else {
      await persist() // still record "seen" even if nothing to remove
    }
    return
  }

  const tools = input.tools
    .map((tool) => sanitizeTool(tool))
    .filter(Boolean) as WebMCPToolMeta[]
  if (tools.length === 0) return

  // Carry the SW-internal ownership marker past the field-whitelisting
  // sanitizer. The marker comes ONLY from the caller-controlled
  // adapterOwnedNames list (the adapter merge in discovery.ts); the page
  // relay never passes it, and a forged adapterOwned key inside a page's
  // tool objects is dropped by sanitizeTool's whitelist above.
  const ownedNames = new Set(input.adapterOwnedNames ?? [])
  if (ownedNames.size > 0) {
    for (const tool of tools) {
      if (ownedNames.has(tool.name)) tool.adapterOwned = true
    }
  }

  // Merge with the LIVE entry (`previous`, read above) instead of replacing
  // it. registerTab is the serialization point for both writers, so
  // `previous` is fresher than any snapshot the caller built before its own
  // awaits — merging here closes the read-to-write races on both paths:
  const merged: WebMCPToolMeta[] = [...tools]
  if (previous) {
    const incomingNames = new Set(tools.map((tool) => tool.name))
    for (const tool of previous.tools) {
      if (incomingNames.has(tool.name)) {
        // The incoming report/snapshot wins same-name collisions (it carries
        // the current adapter version or the page's latest report).
        continue
      }
      if (tool.adapterOwned) {
        if (isAdapterMerge) {
          // Adapter-owned name the current snapshot no longer carries: the
          // catalog stopped serving it → reconcile it away (never keep
          // advertising an adapter tool without a route behind it).
          continue
        }
        // Page report: the adapter still owns this name (a page report must
        // not strip adapter-owned tools) → keep it marked.
        merged.push(tool)
        continue
      }
      if (isAdapterMerge) {
        // Page-owned name absent from the adapter snapshot: a WEBMCP_TAB_REPORT
        // landed between the merge's fresh re-read and this write — it is
        // NEWER than the snapshot → keep it (it must not vanish from
        // discovery).
        merged.push(tool)
      }
      // Page-report path without a marker: the page's report is the
      // authoritative FULL toolset — a live page tool it no longer lists was
      // removed by the page → drop it.
    }
  }

  const entry: WebMCPRegisteredTabEntry = {
    tabId: input.tabId,
    hostname: input.hostname,
    origin: input.origin,
    tabTitle: input.tabTitle,
    tabUrl: input.tabUrl,
    windowId: input.windowId,
    apiMode: input.apiMode || 'documentModelContext',
    tools: merged,
    updatedAt: Date.now(),
  }

  // Suppress no-op churn: identical toolset + still-live tab → keep entry,
  // only refresh timestamps if metadata changed (title/url).
  const unchanged =
    previous &&
    previous.origin === entry.origin &&
    JSON.stringify(previous.tools) === JSON.stringify(entry.tools) &&
    previous.apiMode === entry.apiMode &&
    previous.tabTitle === entry.tabTitle &&
    previous.tabUrl === entry.tabUrl
  if (unchanged) {
    previous.updatedAt = entry.updatedAt
    return
  }

  entries.set(input.tabId, entry)
  await persist()
  notifyRegistryUpdated()
}

export async function unregisterTab(tabId: number): Promise<void> {
  await hydrate()
  seenTabs.delete(tabId)
  if (entries.delete(tabId)) {
    await persist()
    notifyRegistryUpdated()
  }
}

export async function clearRegistry(): Promise<void> {
  await hydrate()
  entries.clear()
  seenTabs.clear()
  await persist()
  notifyRegistryUpdated()
}

/** Live tabs per current registry state (queried fresh so closed tabs drop out).
 *
 * Also drops GHOST entries: a tab that navigated away from its WebMCP host
 * (e.g. site → chrome:// page). The static content script no longer runs on
 * the new URL, so no empty-snapshot report ever arrives — without this
 * hostname check the stale entry would ride the still-alive tabId forever.
 */
export async function getRegistryEntries(): Promise<WebMCPRegisteredTabEntry[]> {
  await hydrate()
  let tabsById = new Map<number, chrome.tabs.Tab>()
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (typeof tab.id === 'number') tabsById.set(tab.id, tab)
    }
  } catch {
    // tabs API hiccup (rare) — fall back to raw entries
    return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  const alive: WebMCPRegisteredTabEntry[] = []
  let ghosts: number[] = []
  for (const entry of entries.values()) {
    const tab = tabsById.get(entry.tabId)
    if (!tab) continue // closed
    // Ghost check: tab must still be on the entry's hostname. A tab that
    // navigated elsewhere (or to an unsupported URL) loses its content
    // script and can never send the empty-snapshot deregistration.
    let tabHost: string | null = null
    try {
      tabHost = typeof tab.url === 'string' ? new URL(tab.url).hostname : null
    } catch {
      tabHost = null
    }
    if (!tabHost || tabHost !== entry.hostname) {
      ghosts.push(entry.tabId)
      continue
    }
    alive.push({
      ...entry,
      tabTitle: tab.title || entry.tabTitle,
      tabUrl: tab.url || entry.tabUrl,
      windowId: tab.windowId ?? entry.windowId,
    })
  }
  // Reap ghost entries so they don't resurface on the next read.
  if (ghosts.length > 0) {
    for (const tabId of ghosts) {
      entries.delete(tabId)
      seenTabs.delete(tabId)
    }
    await persist()
    notifyRegistryUpdated()
  }
  return alive.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Re-read a single tab's registry entry straight from the live in-memory
 * map. Unlike `getRegistryEntries()` this skips the whole-registry tab scan
 * and ghost reaping, so it is cheap enough to run per tab immediately before
 * the adapter merge's registerTab write — the point where a concurrently
 * reported WEBMCP_TAB_REPORT could otherwise be clobbered by a stale
 * snapshot.
 */
export async function getFreshRegistryEntryForTab(
  tabId: number,
): Promise<WebMCPRegisteredTabEntry | null> {
  await hydrate()
  return entries.get(tabId) ?? null
}

/** Expand registry entries into the discovered-tool shape consumers expect. */
export function entriesToDiscoveredTools(
  registryEntries: WebMCPRegisteredTabEntry[],
): WebMCPDiscoveredTool[] {
  const now = Date.now()
  const tools: WebMCPDiscoveredTool[] = []
  for (const entry of registryEntries) {
    for (const tool of entry.tools) {
      // adapterOwned is SW-internal bookkeeping — it must not leak into the
      // discovery output that the web app consumes. adapterServed, by
      // contrast, is legitimately set on this in-memory copy by the adapter
      // merge in discovery.ts (post-registerTab marking), so it passes
      // through untouched.
      const { adapterOwned: _owned, ...publicTool } = tool
      tools.push({
        ...publicTool,
        origin: entry.origin,
        hostname: entry.hostname,
        fullName: buildSafeFullName(entry.origin, tool.name),
        tabId: entry.tabId,
        tabTitle: entry.tabTitle,
        tabUrl: entry.tabUrl,
        discoveredAt: entry.updatedAt || now,
        apiMode: entry.apiMode,
      })
    }
  }
  return tools
}

/** Tab IDs of supported (http/https) tabs that never reported to the
 * registry. Tool-less pages report an empty snapshot once, so they are
 * NOT silent — only tabs without our static content script are. */
export async function getRegistrySilentTabs(): Promise<Array<{ tabId: number; windowId?: number }>> {
  await hydrate()
  try {
    const tabs = await chrome.tabs.query({})
    return tabs
      .filter(
        (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
          typeof tab.id === 'number' && typeof tab.url === 'string' && parseSupportedUrl(tab.url) !== null,
      )
      .filter((tab) => !seenTabs.has(tab.id))
      .map((tab) => ({ tabId: tab.id, windowId: tab.windowId }))
  } catch {
    return []
  }
}
