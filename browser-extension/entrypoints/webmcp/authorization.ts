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

const STORAGE_KEY = 'webmcp_host_authorization'
const GROUP_STORAGE_KEY = 'webmcp_group_authorization'

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
let cachedGroups: WebMCPHostAuthorizationMap | null = null
let loadedAt = 0
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

async function loadGroupsFromStorage(): Promise<WebMCPHostAuthorizationMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(GROUP_STORAGE_KEY, (result) => {
      const raw = result?.[GROUP_STORAGE_KEY]
      resolve(sanitizeMap(raw))
    })
  })
}

async function persistMap(map: WebMCPHostAuthorizationMap, storageKey: string = STORAGE_KEY): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [storageKey]: map }, () => resolve())
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
  loadedAt = Date.now()
  return map
}

async function ensureGroupsLoaded(force = false): Promise<WebMCPHostAuthorizationMap> {
  if (cachedGroups !== null && !force) return cachedGroups
  const map = await loadGroupsFromStorage()
  cachedGroups = map
  return map
}

export async function getHostAuthorizationMap(): Promise<WebMCPHostAuthorizationMap> {
  return ensureLoaded()
}

export async function getGroupAuthorizationMap(): Promise<WebMCPHostAuthorizationMap> {
  return ensureGroupsLoaded()
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

export async function isGroupEnabled(groupKey: string): Promise<boolean> {
  const map = await ensureGroupsLoaded()
  const normalized = groupKey.trim()
  if (!normalized) return false
  return map[normalized] !== false
}

export async function setHostEnabled(hostname: string, enabled: boolean): Promise<WebMCPHostAuthorizationMap> {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) throw new Error('hostname is required')
  const map = await ensureLoaded()
  const next: WebMCPHostAuthorizationMap = { ...map, [normalized]: enabled }
  cached = next
  loadedAt = Date.now()
  await persistMap(next)
  notifyListeners(next)
  return next
}

export async function setGroupEnabled(groupKey: string, enabled: boolean): Promise<WebMCPHostAuthorizationMap> {
  const normalized = groupKey.trim()
  if (!normalized) throw new Error('groupKey is required')
  const map = await ensureGroupsLoaded()
  const next: WebMCPHostAuthorizationMap = { ...map, [normalized]: enabled }
  cachedGroups = next
  await persistMap(next, GROUP_STORAGE_KEY)
  notifyListeners(next)
  return next
}

/**
 * Attach per-host + per-group enabled flags to a discover response.
 * Returns a new array of tools annotated with `hostEnabled` /
 * `groupEnabled` so clients (web app, popup) render one consistent truth.
 */
export function annotateToolsWithHostAuthorization<
  T extends { hostname: string; groupKey?: string }
>(tools: T[], map: WebMCPHostAuthorizationMap, groupMap?: WebMCPHostAuthorizationMap): Array<T & { hostEnabled: boolean; groupEnabled?: boolean }> {
  return tools.map((tool) => ({
    ...tool,
    hostEnabled: isHostEnabledSync(map, tool.hostname),
    ...(tool.groupKey && groupMap
      ? { groupEnabled: isGroupEnabledSync(groupMap, tool.groupKey) }
      : {}),
  }))
}

function isGroupEnabledSync(map: WebMCPHostAuthorizationMap, groupKey: string): boolean {
  const normalized = groupKey.trim()
  if (!normalized) return false
  return map[normalized] !== false
}

/** Subscribe to authorization changes (popup live-refresh). */
export function onAuthorizationChanged(
  listener: (map: WebMCPHostAuthorizationMap) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Build the authorization error payload used by invoke when a host or
 * group is disabled. Kept here so the error shape stays consistent
 * across call sites.
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

export function groupDisabledError(groupKey: string): {
  ok: false
  errorCode: 'GROUP_DISABLED'
  error: string
} {
  return {
    ok: false,
    errorCode: 'GROUP_DISABLED' as const,
    error: `This WebMCP tool group (${groupKey}) is disabled. Enable the group in the extension popup to invoke its tools.`,
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
      loadedAt = Date.now()
      notifyListeners(cached)
    }
    const groupChange = changes[GROUP_STORAGE_KEY]
    if (groupChange) {
      cachedGroups = sanitizeMap(groupChange.newValue)
      notifyListeners(cachedGroups)
    }
  })
}
