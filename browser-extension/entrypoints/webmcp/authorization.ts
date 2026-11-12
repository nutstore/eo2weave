/**
 * WebMCP per-host authorization — extension-side authoritative store.
 *
 * The web app's Settings → WebMCP host list (WebMCPHostList.tsx) shows
 * per-host switches, but that state lives in the web app's localStorage,
 * which the extension cannot read. Before this module, toggling a host
 * off only filtered the tool catalog on the web side — the extension's
 * invoke path enforced nothing.
 *
 * This module makes authorization real at the extension layer:
 *   - Persisted in chrome.storage.local: { [hostname]: boolean }
 *   - Missing entry = enabled (default-allow, opt-out per host)
 *   - invokeWebMCPTool checks before executing anything in a tab
 *   - The popup host list reads/writes this state directly
 *   - Discover responses carry per-host enabled flags so the web app
 *     can render an aligned view
 *
 * This matches the privacy policy wording: per-site authorization that
 * can be revoked at any time.
 */

import type { WebMCPDiscoveryDiagnostics } from '@creatorweave/shared/webmcp-diagnostics'

const STORAGE_KEY = 'webmcp_host_authorization'

export interface WebMCPHostAuthorizationMap {
  /** hostname (lowercase) → enabled */
  [hostname: string]: boolean
}

export interface WebMCPHostAuthorizationSnapshot {
  map: WebMCPHostAuthorizationMap
  loadedAt: number
}

/** In-memory cache; storage.local is the source of truth. */
let cached: WebMCPHostAuthorizationMap | null = null
const listeners = new Set<(map: WebMCPHostAuthorizationMap) => void>()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeMap(raw: unknown): WebMCPHostAuthorizationMap {
  if (!isPlainObject(raw)) return {}
  const out: WebMCPHostAuthorizationMap = {}
  for (const [key, value] of Object.entries(raw)) {
    const hostname = key.trim().toLowerCase()
    if (!hostname) continue
    if (typeof value !== 'boolean') continue
    out[hostname] = value
  }
  return out
}

async function loadFromStorage(): Promise<WebMCPHostAuthorizationMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const raw = result?.[STORAGE_KEY]
      resolve(sanitizeMap(raw))
    })
  })
}

async function persistMap(map: WebMCPHostAuthorizationMap): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: map }, () => resolve())
  })
}

function notifyListeners(map: WebMCPHostAuthorizationMap): void {
  for (const listener of listeners) {
    try {
      listener(map)
    } catch {
      // listener errors must not break the notify loop
    }
  }
}

/** Ensure the in-memory cache is fresh (loaded at least once). */
async function ensureLoaded(force = false): Promise<WebMCPHostAuthorizationMap> {
  if (cached !== null && !force) return cached
  const map = await loadFromStorage()
  cached = map
  return map
}

export async function getHostAuthorizationMap(): Promise<WebMCPHostAuthorizationMap> {
  return ensureLoaded()
}

export function isHostEnabledSync(map: WebMCPHostAuthorizationMap, hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return false
  return map[normalized] !== false
}

export async function isHostEnabled(hostname: string): Promise<boolean> {
  const map = await ensureLoaded()
  return isHostEnabledSync(map, hostname)
}

export async function setHostEnabled(hostname: string, enabled: boolean): Promise<WebMCPHostAuthorizationMap> {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) throw new Error('hostname is required')
  const map = await ensureLoaded()
  const next: WebMCPHostAuthorizationMap = { ...map, [normalized]: enabled }
  cached = next
  await persistMap(next)
  notifyListeners(next)
  return next
}

/**
 * Attach the per-host enabled flag to a discover response so clients
 * (web app, popup) render one consistent authorization truth.
 */
export function annotateToolsWithHostAuthorization<
  T extends { hostname: string }
>(tools: T[], map: WebMCPHostAuthorizationMap): Array<T & { hostEnabled: boolean }> {
  return tools.map((tool) => ({
    ...tool,
    hostEnabled: isHostEnabledSync(map, tool.hostname),
  }))
}

/** Diagnostics must respect the same site opt-out as the tool list. */
export function filterDiagnosticsByHostAuthorization(
  diagnostics: WebMCPDiscoveryDiagnostics,
  map: WebMCPHostAuthorizationMap,
): WebMCPDiscoveryDiagnostics {
  return {
    ...diagnostics,
    tabs: diagnostics.tabs.filter(tab => isHostEnabledSync(map, new URL(tab.url).hostname)),
  }
}

/** Subscribe to authorization changes (popup live-refresh). */
export function onAuthorizationChanged(
  listener: (map: WebMCPHostAuthorizationMap) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Build the authorization error payload used by invoke when a host is
 * disabled. Kept here so the error shape stays consistent across call sites.
 */
export function hostDisabledError(hostname: string): {
  ok: false
  errorCode: 'HOST_DISABLED'
  error: string
} {
  return {
    ok: false,
    errorCode: 'HOST_DISABLED' as const,
    error: `WebMCP tools from ${hostname} are disabled. Enable the host in the extension popup to invoke its tools.`,
  }
}

// storage change listener keeps popup/background views consistent
// when multiple contexts write (e.g. popup + web app relay).
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const hostChange = changes[STORAGE_KEY]
    if (hostChange) {
      cached = sanitizeMap(hostChange.newValue)
      notifyListeners(cached)
    }
  })
}
