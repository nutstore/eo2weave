import type { WebMCPApiMode, WebMCPDiscoverResponse, WebMCPDiscoveredTool } from './types'
import { buildWebMCPGroupKey } from './group-key'
import { buildToolsetSignature } from './toolset-signature'
import { buildSafeFullName } from './tool-name'
import { runWebMCPPageProbe } from './page-api'
import {
  entriesToDiscoveredTools,
  getRegistryEntries,
  getRegistrySilentTabs,
  registerTab,
} from './registry'

type RouteEntry = {
  tabId: number
  hostname: string
  groupKey: string
  toolName: string
  fullToolName: string
  toolsetSignature: string
  seenAt: number
}

type DiscoveredTabInfo = {
  tabId: number
  hostname: string
  toolsetSignature: string
  groupKey: string
  toolNames: string[]
  seenAt: number
}

const recentRouteByToolAndGroup = new Map<string, RouteEntry>()
const recentTabsByGroup = new Map<string, DiscoveredTabInfo[]>()

// Legacy probe timeout — only used for registry-silent tabs (opened
// before the extension (re)loaded, no static content script inside).
const TAB_SCAN_TIMEOUT_MS = 5000

function buildRouteKey(groupKey: string, fullToolName: string): string {
  return `${groupKey}\u0000${fullToolName}`
}

function rememberGroupTab(info: DiscoveredTabInfo) {
  const existing = recentTabsByGroup.get(info.groupKey) || []
  const next = [
    info,
    ...existing.filter((entry) => entry.tabId !== info.tabId),
  ]
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, 20)
  recentTabsByGroup.set(info.groupKey, next)
}

function rememberRoute(route: RouteEntry) {
  recentRouteByToolAndGroup.set(buildRouteKey(route.groupKey, route.fullToolName), route)
}

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
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname || null
  } catch {
    return null
  }
}

function normalizeInputSchema(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema === 'string') {
    try {
      const parsed = JSON.parse(inputSchema)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      return { type: 'object', properties: {} }
    }
  }

  if (inputSchema && typeof inputSchema === 'object') {
    return inputSchema as Record<string, unknown>
  }

  return { type: 'object', properties: {} }
}

function isSupportedTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } {
  return typeof tab.id === 'number' && typeof tab.url === 'string' && !!parseHostname(tab.url)
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

export function getRecentRoute(groupKey: string, fullToolName: string): RouteEntry | null {
  return recentRouteByToolAndGroup.get(buildRouteKey(groupKey, fullToolName)) || null
}

export function getRecentTabsForGroup(groupKey: string): DiscoveredTabInfo[] {
  return recentTabsByGroup.get(groupKey) || []
}

export function rememberSuccessfulInvocation(route: {
  tabId: number
  hostname: string
  groupKey: string
  toolName: string
  fullToolName: string
  toolsetSignature: string
}): void {
  const seenAt = Date.now()
  rememberRoute({ ...route, seenAt })
  rememberGroupTab({
    tabId: route.tabId,
    hostname: route.hostname,
    toolsetSignature: route.toolsetSignature,
    groupKey: route.groupKey,
    toolNames: [route.toolName],
    seenAt,
  })
}

export async function getTabGroupInfo(tabId: number): Promise<DiscoveredTabInfo | null> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!isSupportedTab(tab)) return null
    const hostname = parseHostname(tab.url)
    if (!hostname) return null

    // Registry first: authoritative, fresh, no page execution needed.
    const registryEntries = await getRegistryEntries()
    const registryMatch = registryEntries.find((entry) => entry.tabId === tabId)
    if (registryMatch && registryMatch.hostname === hostname) {
      return {
        tabId,
        hostname,
        toolsetSignature: registryMatch.toolsetSignature,
        groupKey: registryMatch.groupKey,
        toolNames: registryMatch.tools.map((tool) => tool.name),
        seenAt: registryMatch.updatedAt,
      }
    }

    // Legacy fallback: one-shot probe (registry-silent tab).
    const result = await discoverToolsInTab(tabId)
    if (!result.ok || !result.tools || result.tools.length === 0) return null
    const normalizedTools = result.tools.map((tool) => ({
      name: String(tool.name),
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }))
    const toolsetSignature = buildToolsetSignature(normalizedTools)
    return {
      tabId,
      hostname,
      toolsetSignature,
      groupKey: buildWebMCPGroupKey(hostname, toolsetSignature),
      toolNames: normalizedTools.map((tool) => tool.name),
      seenAt: Date.now(),
    }
  } catch {
    return null
  }
}

/**
 * One-shot probe of registry-silent tabs — pages opened before the
 * extension (re)load carry no static content script. Successful
 * probes are fed INTO the registry so they persist for later reads.
 */
async function fallbackScanRegistrySilentTabs(windowId?: number): Promise<void> {
  const silentTabs = await getRegistrySilentTabs()
  const scoped =
    typeof windowId === 'number'
      ? silentTabs.filter((tab) => tab.windowId === windowId)
      : silentTabs

  const probes = await Promise.allSettled(
    scoped.map(async ({ tabId }) => {
      const tab = await chrome.tabs.get(tabId)
      const hostname = parseHostname(tab.url || '')
      if (!hostname) return null
      const result = await discoverToolsInTab(tabId)
      if (!result.ok || !result.tools) return null
      return { tab, hostname, result }
    }),
  )

  for (const settled of probes) {
    if (settled.status !== 'fulfilled') continue
    const entry = settled.value
    if (!entry) continue
    const { tab, hostname, result } = entry
    try {
      await registerTab({
        tabId: tab.id!,
        hostname,
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

export async function discoverWebMCPToolsInCurrentWindow(windowId?: number): Promise<WebMCPDiscoverResponse> {
  try {
    // Feed legacy tabs (pre-extension-load) into the registry first.
    await fallbackScanRegistrySilentTabs(windowId)

    const registryEntries =
      typeof windowId === 'number'
        ? (await getRegistryEntries()).filter((entry) => entry.windowId === windowId)
        : await getRegistryEntries()

    const discoveredAt = Date.now()
    const rawTools = entriesToDiscoveredTools(registryEntries)
    // Dedup: the same site (groupKey) opened in N tabs reports identical
    // tools N times — surface each tool ONCE in the flat list so the model
    // doesn't see phantom duplicates. Invoke routing below still learns
    // every tab via rememberGroupTab/rememberRoute for fallback dispatch.
    const seenKeys = new Set<string>()
    const tools = rawTools.filter((t) => {
      const key = `${t.groupKey ?? t.hostname}::${t.fullName ?? t.name}`
      if (seenKeys.has(key)) return false
      seenKeys.add(key)
      return true
    })
    const discoveredTabs = new Set(registryEntries.map((entry) => entry.tabId))

    // Refresh the invoke route cache from registry data (consumed by
    // invoke.ts pickTargetTabId when no cached route exists yet).
    for (const entry of registryEntries) {
      rememberGroupTab({
        tabId: entry.tabId,
        hostname: entry.hostname,
        toolsetSignature: entry.toolsetSignature,
        groupKey: entry.groupKey,
        toolNames: entry.tools.map((tool) => tool.name),
        seenAt: entry.updatedAt,
      })
      for (const tool of entry.tools) {
        rememberRoute({
          tabId: entry.tabId,
          hostname: entry.hostname,
          groupKey: entry.groupKey,
          toolName: tool.name,
          fullToolName: buildSafeFullName(entry.hostname, tool.name),
          toolsetSignature: entry.toolsetSignature,
          seenAt: entry.updatedAt,
        })
      }
    }

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
