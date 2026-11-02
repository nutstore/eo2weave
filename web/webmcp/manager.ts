import { getWebMCPBridge } from './bridge-client'
import { dedupeDiscoveredInstances } from './catalog-normalizer'
import { useWebMCPStore } from './store'
import type { WebMCPRegisteredTool } from './types'
import { useSettingsStore } from '@/store/settings.store'
import { getSidePanelBindingId, isSidePanelMode } from '@/agent/workspace-assistant-context'

const DISCOVERY_TTL_MS = 8000

let lastDiscoveryAt = 0
let discoveryInFlight: Promise<WebMCPRegisteredTool[]> | null = null
let discoveryGeneration = 0

/** Detach a stalled discovery so a later request can start a new scan. */
export function expireWebMCPDiscovery(): void {
  discoveryGeneration += 1
  discoveryInFlight = null
  lastDiscoveryAt = 0
}

function isExtensionContextInvalidatedError(error: unknown): boolean {
  if (typeof error !== 'string') return false
  return error.toLowerCase().includes('extension context invalidated')
}

/**
 * Sync extension-side authorization state into the store mirror.
 * Called after discovery — the tools' hostEnabled annotations
 * (attached by the extension background) are the source of truth; the web
 * app's localStorage copy is read-only from now on.
 */
function syncAuthorizationFromTools(tools: Array<{ hostname: string; hostEnabled?: boolean }>): void {
  const enabledByHost: Record<string, boolean> = {}
  for (const tool of tools) {
    const host = tool.hostname.trim().toLowerCase()
    if (host && typeof tool.hostEnabled === 'boolean') enabledByHost[host] = tool.hostEnabled
  }
  useWebMCPStore.getState().setAuthorizationMirror(enabledByHost)
}

/**
 * Discover WebMCP tools from browser tabs and cache them in the store.
 * This is called by the agent loop to keep the catalog fresh.
 * Tool registration is handled by the unified external-tool bridge (search_tools/call_tool).
 */
async function discoverAndCacheTools(force = false): Promise<WebMCPRegisteredTool[]> {
  const now = Date.now()
  const store = useWebMCPStore.getState()
  const cached = store.getAllTools()
  if (!force && cached.length > 0 && now - lastDiscoveryAt < DISCOVERY_TTL_MS) {
    return cached
  }

  if (discoveryInFlight) return discoveryInFlight

  const generation = ++discoveryGeneration
  const discovery = (async () => {
    const bridge = getWebMCPBridge()
    if (!bridge) {
      if (cached.length > 0) {
        console.warn('[WebMCP] Discovery skipped: bridge unavailable; keeping last catalog')
      }
      lastDiscoveryAt = 0
      return useWebMCPStore.getState().getAllTools()
    }

    const response = await bridge.webMCPDiscover({
      force,
      ...(isSidePanelMode() && getSidePanelBindingId()
        ? { binding: getSidePanelBindingId()! }
        : {}),
    })
    if (generation !== discoveryGeneration || !useSettingsStore.getState().enableWebMCP) {
      return useWebMCPStore.getState().getAllTools()
    }
    if (!response.ok) {
      console.warn('[WebMCP] Discovery failed:', response.error || 'unknown error')
      if (isExtensionContextInvalidatedError(response.error)) {
        useWebMCPStore.getState().clearCatalog()
        lastDiscoveryAt = 0
        return []
      }
      return useWebMCPStore.getState().getAllTools()
    }

    const tools = dedupeDiscoveredInstances(response.tools || []).sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    )
    syncAuthorizationFromTools(tools)
    useWebMCPStore.getState().setDiscoveredTools(tools, response.discoveredAt || Date.now())
    lastDiscoveryAt = Date.now()
    return useWebMCPStore.getState().getAllTools()
  })()
  let tracked!: Promise<WebMCPRegisteredTool[]>
  tracked = discovery.finally(() => {
    if (discoveryInFlight === tracked) discoveryInFlight = null
  })
  discoveryInFlight = tracked

  return tracked
}

/** Discover and cache WebMCP tools without registering any tools. */
export async function discoverWebMCPCatalog(force = false): Promise<WebMCPRegisteredTool[]> {
  if (!useSettingsStore.getState().enableWebMCP) {
    expireWebMCPDiscovery()
    useWebMCPStore.getState().clearCatalog()
    return []
  }
  return discoverAndCacheTools(force)
}

/** Refresh WebMCP catalog (force re-discovery). Returns AUTHORIZED tools. */
export async function refreshWebMCPCatalog(): Promise<WebMCPRegisteredTool[]> {
  // The settings page and callers treat this count as "tools you can use",
  // so filter to tools from authorized hosts. Discovery itself still
  // caches the full catalog — authorization is enforced by the extension
  // invoke gate and mirrored here via annotations.
  // A forced refresh must not reuse a request that began before the caller
  // observed a route miss. Wait for that request, then start a new discovery.
  const earlierDiscovery = discoveryInFlight
  const earlierGeneration = discoveryGeneration
  if (earlierDiscovery && useSettingsStore.getState().enableWebMCP) {
    try {
      await earlierDiscovery
    } catch {
      // A fresh request may recover from the earlier failure.
    }
  }
  if (earlierGeneration !== discoveryGeneration || !useSettingsStore.getState().enableWebMCP) {
    return useWebMCPStore.getState().getEnabledTools()
  }
  await discoverWebMCPCatalog(true)
  return useWebMCPStore.getState().getEnabledTools()
}

// NOTE: host authorization toggles were removed from the web app.
// The extension popup is the only management surface; the extension-side
// store is the single source of truth, mirrored into the web store via
// discovery annotations (syncAuthorizationFromTools).

export async function applyWebMCPGlobalToggle(
  enabled: boolean,
): Promise<number> {
  useSettingsStore.getState().setEnableWebMCP(enabled)
  if (!enabled) {
    expireWebMCPDiscovery()
    useWebMCPStore.getState().clearCatalog()
    return 0
  }
  const tools = await discoverAndCacheTools(true)
  return tools.length
}
