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
 *     → { applicable, package?, enabled?, consentToken? }
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
  /**
   * One-time, extension-issued proof of consent minted while the package was
   * disabled. Echoed back on enable; the background verifies and consumes it.
   */
  consentToken?: string
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
  error?: string
  /**
   * One-time, extension-issued proof of consent (present only while the
   * package is still disabled). Must be echoed back on enable.
   */
  consentToken?: string
}

const DISMISS_STORAGE_KEY_PREFIX = 'cw_webmcp_package_prompt_dismissed_v1'
/** "Not now" cooldown: re-prompt after 1 day, not on every panel open. */
export const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000

/**
 * One storage key PER PACKAGE (`<prefix>.<packageId>` → timestamp). A shared
 * map key would make two side-panel instances dismissing different packages
 * race on read-modify-write and drop each other's cooldown; per-key writes
 * are independent and cannot clobber a sibling dismissal.
 */
function dismissKeyFor(packageId: string): string {
  return `${DISMISS_STORAGE_KEY_PREFIX}.${packageId}`
}

function readDismissedAt(packageId: string): number | null {
  try {
    const raw = localStorage.getItem(dismissKeyFor(packageId))
    if (!raw) return null
    const ts = Number(JSON.parse(raw) as unknown)
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}

/** True when the user said "not now" for this package within the cooldown window. */
export function isPackagePromptDismissed(packageId: string): boolean {
  const dismissedAt = readDismissedAt(packageId)
  if (dismissedAt === null) return false
  return Date.now() - dismissedAt < DISMISS_COOLDOWN_MS
}

/** Record a "not now" answer for the package (1-day cooldown). */
export function dismissPackagePrompt(packageId: string): void {
  try {
    localStorage.setItem(dismissKeyFor(packageId), JSON.stringify(Date.now()))
  } catch {
    // localStorage unavailable (quota / privacy mode) — cooldown silently
    // degrades to "prompt may reappear next session". Never fatal.
  }
}

/** Test seam: clear all dismissal records. */
export function resetPackagePromptDismissals(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(`${DISMISS_STORAGE_KEY_PREFIX}.`)) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // localStorage unavailable — nothing to reset, and tests stub it anyway.
  }
}

interface AgentWebPackageOptInBridge {
  webMCPPackageOptInStatus?: (binding: string) => Promise<PackageOptInStatus>
}

/** Structured enable outcome — never reduce a background error to `false`. */
export interface PackageOptInEnableResult {
  ok: boolean
  /** Structured reason when ok is false (background errorCode or client-side). */
  errorCode?: string
  /** Human-readable background error message when available. */
  error?: string
  /** False when the package was enabled but the bound tab reload failed. */
  reloaded?: boolean
}

const ENABLE_TIMEOUT_MS = 8000
/** Probe budget: covers cold service-worker starts without stalling startup. */
const PROBE_TIMEOUT_MS = 4000

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
 * nice-to-have and must not disturb side-panel startup. Transient failures
 * (timeout / bridge error) return a reason so callers can retry; only the
 * terminal "nothing to offer" outcomes report `retryable: false`.
 */
export async function getPendingPackagePrompt(): Promise<
  | (PackageOptInStatus & { applicable: true; package: PackageOptInInfo; enabled: false })
  | { applicable: false; retryable: boolean }
  | null
> {
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
  let timedOut = false
  try {
    // Bounded wait: side-panel startup must never hang on this probe. The
    // bridge itself has a 35s timeout; 4s covers cold service-worker starts
    // without stalling the modal long when the extension is half-dead.
    status = await Promise.race([
      agentWeb.webMCPPackageOptInStatus(binding),
      new Promise<null>(resolve => {
        setTimeout(() => {
          timedOut = true
          resolve(null)
        }, PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return { applicable: false, retryable: true }
  }
  if (!status || status.ok === false) {
    // eslint-disable-next-line no-console
    console.warn('[SidePanelPackagePrompt] skip: bridge returned failure/timeout', {
      status,
      hint: 'UNAUTHORIZED_TARGET = binding/trusted-origin check failed in background; null = 4s probe timeout',
    })
    // The bridge-level {ok:false} answers are structural (bad binding, bad
    // origin) — retrying cannot fix them. A timeout CAN recover once the
    // service worker wakes up, so that case stays retryable.
    return { applicable: false, retryable: timedOut || status === null }
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

  // Attach the status-level consent token to the package payload the modal
  // consumes, so the enable call can echo it back to the background.
  const packageInfo: PackageOptInInfo = {
    ...status.package,
    consentToken: typeof status.consentToken === 'string' ? status.consentToken : undefined,
  }
  return { applicable: true, package: packageInfo, enabled: false }
}

/**
 * One-shot enable flow behind the modal's primary button: enable the package
 * extension-side AND reload the upstream page so its tools register (the
 * adapter proxies are injected by a static content script, so a config change
 * alone cannot reach pages loaded before the extension install/update).
 *
 * The 8s timeout is implemented with Promise.race + abort-style bookkeeping:
 * whichever side loses keeps running, so the loser's result is forwarded
 * through `onSettledLate` instead of being dropped. Without this, a slow
 * enable that eventually succeeds would still show the user an error toast
 * and record a dismissal while the package flips on in the background.
 */
export async function enablePackageAndReload(
  packageId: string,
  consentToken: string,
  onSettledLate?: (result: PackageOptInEnableResult) => void,
): Promise<PackageOptInEnableResult> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) return { ok: false, errorCode: 'NO_BINDING' }

  const agentWeb = (
    globalThis as {
      __agentWeb?: AgentWebPackageOptInBridge & {
        webMCPPackageOptInEnable?: (
          binding: string,
          packageId: string,
          consentToken: string,
        ) => Promise<{ ok?: boolean; error?: string; errorCode?: string; reloaded?: boolean }>
      }
    }
  ).__agentWeb
  if (!agentWeb?.webMCPPackageOptInEnable) {
    return { ok: false, errorCode: 'BRIDGE_UNAVAILABLE' }
  }

  const toResult = (raw: {
    ok?: boolean
    error?: string
    errorCode?: string
    reloaded?: boolean
  } | undefined): PackageOptInEnableResult => ({
    ok: raw?.ok === true,
    errorCode: raw?.errorCode ?? (raw?.ok === true ? undefined : 'ENABLE_FAILED'),
    error: raw?.error,
    reloaded: raw?.reloaded,
  })

  let winner: 'bridge' | 'timeout' | null = null
  try {
    const result = await new Promise<PackageOptInEnableResult>(resolve => {
      // ONE bridge call, shared by both racers — the timeout branch must
      // observe the SAME pending promise, not fire a second enable.
      const enable = agentWeb.webMCPPackageOptInEnable
      const bridgeCall = enable!.call(agentWeb, binding, packageId, consentToken)
      const timer = setTimeout(() => {
        if (winner) return
        winner = 'timeout'
        resolve({ ok: false, errorCode: 'TIMEOUT' })
        // The bridge call keeps running; forward its real outcome when it
        // lands so the caller can correct the UI instead of silently
        // enabling behind a dismissal.
        bridgeCall
          .then(late => {
            if (winner !== 'timeout') return
            onSettledLate?.(toResult(late))
          })
          .catch((err: unknown) => {
            if (winner !== 'timeout') return
            onSettledLate?.({
              ok: false,
              errorCode: 'ENABLE_FAILED',
              error: err instanceof Error ? err.message : String(err),
            })
          })
      }, ENABLE_TIMEOUT_MS)
      bridgeCall
        .then(late => {
          if (winner) return
          winner = 'bridge'
          clearTimeout(timer)
          resolve(toResult(late))
        })
        .catch((err: unknown) => {
          if (winner) return
          winner = 'bridge'
          clearTimeout(timer)
          // Unexpected bridge failures must keep their cause for diagnosis.
          // eslint-disable-next-line no-console
          console.error('[SidePanelPackagePrompt] enable bridge call failed:', err, {
            packageId,
            binding,
          })
          resolve({
            ok: false,
            errorCode: 'ENABLE_FAILED',
            error: err instanceof Error ? err.message : String(err),
          })
        })
    })
    return result
  } catch (err: unknown) {
    // Unreachable in practice (the promise never rejects) but kept as a
    // belt-and-braces guard so the flow can never throw into the modal.
    // eslint-disable-next-line no-console
    console.error('[SidePanelPackagePrompt] enable flow crashed:', err, { packageId })
    return {
      ok: false,
      errorCode: 'ENABLE_FAILED',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
