/**
 * Side-panel package opt-in prompt — decision logic (issue #100).
 *
 * When EO2Weave runs as the browser extension's side panel, the bound
 * upstream tab may host a builtin WebMCP package (jmail.world, douban, …):
 * opt-in tool packs that expose MCP tools on sites which don't ship native
 * WebMCP. Builtin packages default to `activation: 'disabled'`, and the only
 * enable entry points are the extension's management page and the popup —
 * both buried. Users opening the side panel on a supported site hit a dead
 * end: no tools, no guidance.
 *
 * This module asks the extension (via the page bridge
 * `window.__agentWeb.webMCPPackageOptInStatus`) whether the BOUND upstream
 * tab hosts a DISABLED builtin package:
 *
 *   side panel (web app)
 *     → window.__agentWeb.webMCPPackageOptInStatus(binding)  [MAIN world]
 *     → content.ts (ISOLATED relay)                          [postMessage]
 *     → background: resolveBoundSidePanelTab + package catalog
 *     → { applicable, package?, enabled? }
 *
 * The enable state lives extension-side (chrome.storage.local) — the web app
 * never persists "enabled" itself; it only records a local dismissal
 * cooldown so a "not now" answer does not nag on every side-panel open.
 * Dismissal lives in localStorage (per browser profile, per package id) and
 * is deliberately NOT synced anywhere.
 */

export interface PackageOptInToolInfo {
  name: string
  description: string
  readOnly: boolean
}

export interface PackageOptInInfo {
  id: string
  description: string
  hostname: string
  activation: 'enabled' | 'disabled'
  tools: PackageOptInToolInfo[]
}

export interface PackageOptInStatus {
  /** Bridge reachable AND a builtin package exists for the bound tab. */
  applicable: boolean
  package?: PackageOptInInfo
  /** The package is already enabled extension-side. */
  enabled?: boolean
  /** Bridge-level failure flag ({ok:false} from the background handlers). */
  ok?: boolean
  /** Structured failure (bridge unavailable, unauthorized binding, …). */
  errorCode?: string
}

const DISMISS_STORAGE_KEY = 'cw_webmcp_package_prompt_dismissed_v1'
/** "Not now" cooldown: re-prompt after 1 day, not on every panel open. */
export const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000

function readDismissedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts
    }
    return out
  } catch {
    return {}
  }
}

/** True when the user said "not now" for this package within the cooldown window. */
export function isPackagePromptDismissed(packageId: string): boolean {
  const dismissedAt = readDismissedMap()[packageId]
  if (typeof dismissedAt !== 'number') return false
  return Date.now() - dismissedAt < DISMISS_COOLDOWN_MS
}

/** Record a "not now" answer for the package (1-day cooldown). */
export function dismissPackagePrompt(packageId: string): void {
  try {
    const map = readDismissedMap()
    map[packageId] = Date.now()
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage unavailable (quota / privacy mode) — cooldown silently
    // degrades to "prompt may reappear next session". Never fatal.
  }
}

/** Test seam: clear all dismissal records. */
export function resetPackagePromptDismissals(): void {
  try {
    localStorage.removeItem(DISMISS_STORAGE_KEY)
  } catch {
    // localStorage unavailable — nothing to reset, and tests stub it anyway.
  }
}

interface AgentWebPackageOptInBridge {
  webMCPPackageOptInStatus?: (binding: string) => Promise<PackageOptInStatus>
}

/**
 * Ask the extension whether the bound upstream tab hosts a DISABLED builtin
 * package worth prompting for. Resolves `null` when:
 *   - not in side-panel mode (no binding id)
 *   - the extension bridge is missing (no plugin / ordinary tab)
 *   - no package matches the tab's current URL (nothing to offer)
 *   - the package is already enabled
 *   - the user dismissed the prompt within the cooldown window
 *
 * Bridge failures resolve `null` as well (never throw) — this prompt is a
 * nice-to-have and must not disturb side-panel startup.
 */
export async function getPendingPackagePrompt(): Promise<PackageOptInStatus | null> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: no side-panel binding (not side-panel mode)')
    return null
  }

  const agentWeb = (globalThis as { __agentWeb?: AgentWebPackageOptInBridge }).__agentWeb
  if (!agentWeb?.webMCPPackageOptInStatus) {
    // eslint-disable-next-line no-console
    console.warn('[SidePanelPackagePrompt] skip: extension bridge unavailable', {
      hasAgentWeb: !!agentWeb,
      hasStatus: !!agentWeb?.webMCPPackageOptInStatus,
      hint: 'Extension needs a rebuild/update (package opt-in bridge added 2026-10-28)',
    })
    return null
  }

  let status: PackageOptInStatus | null = null
  try {
    // Bounded wait: side-panel startup must never hang on this probe. The
    // bridge itself has a 35s timeout; 4s covers cold service-worker starts
    // without stalling the modal long when the extension is half-dead.
    status = await Promise.race([
      agentWeb.webMCPPackageOptInStatus(binding),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 4000)),
    ])
  } catch {
    return null
  }
  if (!status || status.ok === false) {
    // eslint-disable-next-line no-console
    console.warn('[SidePanelPackagePrompt] skip: bridge returned failure/timeout', {
      status,
      hint: 'UNAUTHORIZED_TARGET = binding/trusted-origin check failed in background; null = 4s probe timeout',
    })
    return null
  }
  if (!status.applicable || !status.package || typeof status.package.id !== 'string') {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: no package matches bound tab URL', { status })
    return null
  }
  if (status.enabled || status.package.activation === 'enabled') {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: package already enabled', status.package.id)
    return null
  }
  if (isPackagePromptDismissed(status.package.id)) {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: within dismissal cooldown', status.package.id)
    return null
  }

  return { applicable: true, package: status.package, enabled: false }
}

/**
 * One-shot enable flow behind the modal's primary button: enable the package
 * extension-side AND reload the upstream page so its tools register (the
 * adapter proxies are injected by a static content script, so a config change
 * alone cannot reach pages loaded before the extension install/update).
 * Returns the bridge's ok flag.
 */
export async function enablePackageAndReload(packageId: string): Promise<boolean> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) return false

  const agentWeb = (
    globalThis as {
      __agentWeb?: AgentWebPackageOptInBridge & {
        webMCPPackageOptInEnable?: (
          binding: string,
          packageId: string,
        ) => Promise<{ ok?: boolean; error?: string }>
      }
    }
  ).__agentWeb
  if (!agentWeb?.webMCPPackageOptInEnable) return false

  try {
    const result = await Promise.race([
      agentWeb.webMCPPackageOptInEnable(binding, packageId),
      new Promise<{ ok: false }>(resolve => setTimeout(() => resolve({ ok: false }), 8000)),
    ])
    return result?.ok === true
  } catch {
    return false
  }
}
