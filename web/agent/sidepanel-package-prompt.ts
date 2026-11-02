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
   * Human-readable package name. Present only on legacy-protocol payloads
   * (pre-#102 extensions report `recipe.displayName`); the modal keys its
   * visuals off `id`, so this stays informational.
   */
  displayName?: string
  /**
   * Package-WIDE tool count across all origins (the enable activates every
   * tool of the package, including ones not matching the current tab URL).
   * Used for the consent copy; `tools` above lists only the tools matching
   * the bound tab's current URL.
   */
  totalTools?: number
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
  /** Package-wide tool count across all origins (consent disclosure). */
  totalTools?: number
  /**
   * Bounded list of OTHER builtin packages hosting the same tab (best
   * candidate first, excluding the primary package). Used when the primary
   * candidate is within its dismissal cooldown so a dismissed package does
   * not shadow its siblings. Absent on older extension builds.
   */
  alternatives?: PackageOptInInfo[]
  /**
   * True when this status came from the LEGACY (pre-#102) recipe protocol
   * (`window.__agentWeb.recipeCheckStatus`) rather than the new bridge
   * `getPendingPackagePrompt`. Legacy payloads carry no consent token, so
   * the confirm path must call `recipeEnable(binding, recipeId)` instead of
   * the consent-token enable (protocol-level analog of grace mode).
   */
  legacy?: boolean
}

/**
 * The pre-#102 extension surface (shipped 1.1.7, store rollout pending).
 * Types mirror the legacy injected.content relay verbatim — the web app
 * never sends anything the old extension would not recognize.
 */
interface AgentWebLegacyRecipeBridge {
  recipeCheckStatus?: (binding: string) => Promise<LegacyRecipeStatus>
  recipeEnable?: (
    binding: string,
    recipeId: string,
  ) => Promise<{ ok?: boolean; error?: string; errorCode?: string; reloaded?: boolean }>
}

/** Legacy (pre-#102) recipe status payload, as sent by the 1.1.7 background. */
export interface LegacyRecipeStatus {
  ok?: boolean
  applicable: boolean
  recipe?: {
    id: string
    displayName: string
    description: string
    glyph: string
    hostname: string
    toolCount: number
  }
  enabled?: boolean
  errorCode?: string
  error?: string
}

/**
 * Per-session verdict on which opt-in protocol the installed extension
 * speaks, so repeated probes do not double-try both paths on every poll
 * (AppBootstrap re-probes on a 60s late-bound interval + bounded startup
 * retries). `null` = not yet determined (first probe tries new → legacy).
 */
type ProtocolSupport = 'new' | 'legacy-only' | 'none'
let protocolSupport: ProtocolSupport | null = null

/**
 * In-flight legacy enables, keyed by binding + recipe id. The legacy bridge
 * call cannot be cancelled, so a retry after a client-side TIMEOUT would
 * start a SECOND enable while the first may still commit (two storage
 * writes, two tab reloads). Tracking the pending bridge call lets a retry
 * await the SAME call — and its REAL outcome — instead of firing a
 * duplicate (finding: "Timed-out enable can be retried concurrently" /
 * "Retries trigger duplicate enables"). The binding is part of the key so a
 * different bound tab never inherits another tab's result (finding: "Wrong
 * tab reports enable success").
 *
 * Only UNSETTLED calls are tracked: a settled outcome is never replayed to
 * a later attempt (a stale success would report an enable that no longer
 * holds, and a stale failure would block a legitimate retry).
 */
const pendingLegacyEnables = new Map<string, Promise<PackageOptInEnableResult>>()

/** Test seam: forget the per-session protocol verdict. */
export function resetPackagePromptProtocolCache(): void {
  protocolSupport = null
  pendingLegacyEnables.clear()
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

/**
 * In-memory fallback: suppresses re-prompting within the current session.
 * Stores the DISMISSAL TIMESTAMP (not just the id): a side panel left open
 * for days must not keep suppressing a package whose 1-day cooldown has
 * expired (finding: "Dismissal lasts beyond one day") — the fallback obeys
 * the same cooldown-age rule as the persisted record.
 */
const sessionDismissals = new Map<string, number>()

/** True when the user said "not now" for this package within the cooldown window. */
export function isPackagePromptDismissed(packageId: string): boolean {
  const dismissedAt = sessionDismissals.get(packageId)
  if (dismissedAt !== undefined) {
    if (Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return true
    // Expired: drop it so the map cannot grow unbounded across long sessions.
    sessionDismissals.delete(packageId)
  }
  const persistedAt = readDismissedAt(packageId)
  if (persistedAt === null) return false
  return Date.now() - persistedAt < DISMISS_COOLDOWN_MS
}

/** Record a "not now" answer for the package (1-day cooldown). */
export function dismissPackagePrompt(packageId: string): void {
  // Session fallback recorded BEFORE the storage attempt: when localStorage
  // is unavailable (quota / privacy mode / thrown write), the in-memory
  // record still suppresses the prompt for this panel session, so a "not
  // now" is never immediately followed by the same modal again.
  sessionDismissals.set(packageId, Date.now())
  try {
    localStorage.setItem(dismissKeyFor(packageId), JSON.stringify(Date.now()))
  } catch {
    // localStorage unavailable — the session fallback above covers the
    // current session; the cooldown simply degrades across sessions.
  }
}

/** Test seam: clear all dismissal records (storage AND in-memory fallback). */
export function resetPackagePromptDismissals(): void {
  sessionDismissals.clear()
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
 * Two protocols are tried, in order (issue #113):
 *   1. NEW (#102): bridge `webMCPPackageOptInStatus` (consent-token flow)
 *   2. LEGACY (1.1.7): `window.__agentWeb.recipeCheckStatus`, mapped onto
 *      the same status shape (`legacy: true`; the confirm path then calls
 *      `recipeEnable` without a consent token — the old protocol's grace)
 *
 * Which protocol speaks is cached per session (see `protocolSupport`) so a
 * legacy-only extension is not re-probed with the new bridge (and vice
 * versa) on every startup retry / 60s late-bound poll. When NEITHER is
 * available (plain web, no extension) the result is a silent `null` — this
 * prompt is a nice-to-have and must never throw or log an error.
 *
 * Transient failures (timeout / bridge error / STATUS_FAILED) return a
 * reason so callers can retry (findings: "Transient probe errors hide
 * prompt" / "Transient status failures hide the prompt" — a transient
 * tab/storage/catalog error must not suppress the prompt for the whole
 * session); only the terminal "nothing to offer" outcomes report
 * `retryable: false`. A dismissed best candidate is retried against its
 * non-dismissed siblings before giving up.
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

  const agentWeb = (
    globalThis as { __agentWeb?: AgentWebPackageOptInBridge & AgentWebLegacyRecipeBridge }
  ).__agentWeb
  const legacyProbe = () => probeLegacyProtocol(binding, agentWeb?.recipeCheckStatus)

  // A cached 'new' verdict skips the legacy path entirely; 'legacy-only'
  // and 'none' skip the new-protocol probe. 'none' stays SOFT: the bridge
  // can appear at any time (slow extension handshake, late injection) and
  // AppBootstrap keeps polling — re-derive when a surface shows up.
  // 'legacy-only' is sticky for the session: a real pre-#102 bridge never
  // exposes the new method, and extension updates reload the page anyway.
  if (protocolSupport === 'none') {
    if (!agentWeb?.webMCPPackageOptInStatus && !agentWeb?.recipeCheckStatus) return null
    protocolSupport = null // a bridge showed up after the first probe — re-decide
  } else if (protocolSupport === 'legacy-only') {
    return legacyProbe()
  }

  if (agentWeb?.webMCPPackageOptInStatus) {
    const outcome = await probeNewProtocol(binding, agentWeb.webMCPPackageOptInStatus)
    if (outcome.verdict !== 'legacy') {
      // The new bridge ANSWERED (success or a structured failure it
      // understands — only extensions that speak the protocol produce
      // these): cache it.
      if (protocolSupport === null) protocolSupport = 'new'
      return outcome.result
    }
    // The new probe could not be answered AT ALL (call rejected, timed out,
    // or the relay's structured unknown-message rejection) — ambiguous
    // between an old extension and a new one with a sleeping service
    // worker. Try legacy right away, but only commit the session cache to
    // 'legacy-only' when the legacy surface DEFINITIVELY answers (a legacy
    // transient failure must keep the cache undetermined, or a recovering
    // new extension would be locked out of its own protocol for the whole
    // session).
    const legacy = await legacyProbe()
    const legacyAnsweredDefinitively =
      !!agentWeb.recipeCheckStatus && !(legacy !== null && 'retryable' in legacy && legacy.retryable)
    // Guarded assignment: an overlapping probe may have established 'new'
    // while this call awaited — never downgrade a working new bridge.
    if (legacyAnsweredDefinitively && protocolSupport !== 'new') protocolSupport = 'legacy-only'
    // Another overlapping probe may have established the NEW protocol while
    // this fallback awaited. Returning the legacy result now would replace
    // the new-protocol prompt with a tokenless legacy one (finding: "Stale
    // probe returns legacy prompt"): discard it and re-probe the new
    // protocol instead.
    if (protocolSupport === 'new') {
      const recheck = await probeNewProtocol(binding, agentWeb.webMCPPackageOptInStatus!)
      return recheck.result
    }
    // null from a REAL legacy probe is a legitimate terminal answer
    // (dismissed / no matching recipe) — only an entirely missing legacy
    // surface substitutes the new probe's retryable outcome.
    if (agentWeb.recipeCheckStatus) return legacy
    return legacy ?? { applicable: false, retryable: true }
  }

  // No new bridge method at all: an old extension (or no extension) —
  // decide the session verdict from the legacy surface alone. The verdict
  // is committed only AFTER the legacy probe answers definitively: a
  // transient legacy failure must not lock the session to legacy-only and
  // hide a new-protocol bridge that appears later (finding: "Recovered
  // prompts stay hidden").
  if (!agentWeb?.recipeCheckStatus) {
    if (protocolSupport === null) {
      protocolSupport = 'none'
      // eslint-disable-next-line no-console
      console.info(
        '[SidePanelPackagePrompt] skip: extension bridge unavailable (no opt-in protocol; plain web or pre-1.1.7 extension)',
      )
    }
    return null
  }
  const legacy = await legacyProbe()
  const legacyAnsweredDefinitively =
    !(legacy !== null && 'retryable' in legacy && legacy.retryable)
  if (legacyAnsweredDefinitively && protocolSupport !== 'new') protocolSupport = 'legacy-only'
  return legacy
}

interface NewProtocolOutcome {
  /** 'legacy' = the new bridge rejected the probe → try the old protocol. */
  verdict: 'done' | 'legacy'
  result:
    | (PackageOptInStatus & { applicable: true; package: PackageOptInInfo; enabled: false })
    | { applicable: false; retryable: boolean }
    | null
}

/**
 * Probe the NEW (#102) bridge method. Maps every terminal outcome onto the
 * prompt shapes above; a probe the bridge could not answer AT ALL yields
 * verdict 'legacy' so the caller falls back to the 1.1.7 protocol:
 *   - the call rejects (pre-#102 injected bridge without the method),
 *   - the 4s race times out (1.1.7's background drops the unknown message
 *     type on the floor — no reply ever comes), or
 *   - the relay answers `UNAUTHORIZED_MESSAGE_TYPE` (1.1.7's content-script
 *     allow-list resolves unknown types with a structured {ok:false}
 *     instead of rejecting — finding: "Legacy fallback is skipped").
 * A timeout is ambiguous with a sleeping service worker on a NEW extension,
 * but falling back once is harmless: the legacy probe resolves null on a
 * new extension (no recipe match / no method) and the caller's retry
 * budget re-probes the new protocol afterwards.
 */
async function probeNewProtocol(
  binding: string,
  probe: (binding: string) => Promise<PackageOptInStatus>,
): Promise<NewProtocolOutcome> {
  let status: PackageOptInStatus | null = null
  let timedOut = false
  try {
    // Bounded wait: side-panel startup must never hang on this probe. The
    // bridge itself has a 35s timeout; 4s covers cold service-worker starts
    // without stalling the modal long when the extension is half-dead.
    status = await Promise.race([
      probe(binding),
      new Promise<null>(resolve => {
        setTimeout(() => {
          timedOut = true
          resolve(null)
        }, PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return { verdict: 'legacy', result: { applicable: false, retryable: true } }
  }
  if (!status || status.ok === false) {
    // The relay-level unknown-message rejection is how a pre-#102 extension
    // says "I don't speak this protocol" — fall back to the legacy probe.
    const relayRejectedType = status?.errorCode === 'UNAUTHORIZED_MESSAGE_TYPE'
    if (relayRejectedType || timedOut || status === null) {
      return { verdict: 'legacy', result: { applicable: false, retryable: true } }
    }
    // eslint-disable-next-line no-console
    console.warn('[SidePanelPackagePrompt] skip: bridge returned failure', {
      status,
      hint: 'UNAUTHORIZED_TARGET = binding/trusted-origin check failed in background',
    })
    // Structural bridge answers (bad binding, bad origin) cannot heal —
    // retrying them is pointless. STATUS_FAILED covers transient tab/
    // storage/catalog errors inside the background probe, so it stays
    // retryable (bounded by the caller's retry budget).
    return {
      verdict: 'done',
      result: {
        applicable: false,
        retryable: status?.errorCode === 'STATUS_FAILED',
      },
    }
  }
  if (!status.applicable || !status.package || typeof status.package.id !== 'string') {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: no package matches bound tab URL', { status })
    return { verdict: 'done', result: null }
  }
  if (status.enabled || status.package.activation === 'enabled') {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: package already enabled', status.package.id)
    return { verdict: 'done', result: null }
  }
  if (!isPackagePromptDismissed(status.package.id)) {
    return { verdict: 'done', result: toPrompt(status) }
  }
  // The best candidate is in its dismissal cooldown. Other builtin packages
  // may host the same tab — offer the best NON-dismissed sibling (finding:
  // "Dismissal hides other package prompts") from the status payload's
  // bounded `alternatives` list instead of hiding every prompt for the site.
  const alternatives = Array.isArray(status.alternatives) ? status.alternatives : []
  for (const alternative of alternatives) {
    if (!alternative || typeof alternative.id !== 'string') continue
    if (isPackagePromptDismissed(alternative.id)) continue
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] best candidate dismissed; offering sibling', alternative.id)
    return {
      verdict: 'done',
      result: {
        applicable: true,
        package: {
          ...alternative,
          // The sibling's OWN consent token (finding: "Sibling consent cannot
          // complete"): the extension mints one per disabled alternative, bound
          // to the sibling's package id. The status-level token belongs to the
          // dismissed primary and must NOT be reused; older extension builds
          // send no per-sibling token at all (undefined) and rely on the grace
          // path until the fleet updates.
          consentToken:
            typeof alternative.consentToken === 'string' && alternative.consentToken !== ''
              ? alternative.consentToken
              : undefined,
          totalTools: typeof alternative.totalTools === 'number' ? alternative.totalTools : undefined,
        },
        enabled: false,
        ok: true,
      },
    }
  }
  // eslint-disable-next-line no-console
  console.info('[SidePanelPackagePrompt] skip: within dismissal cooldown', status.package.id)
  return { verdict: 'done', result: null }
}

/**
 * Probe the LEGACY (pre-#102) recipe protocol (`recipeCheckStatus`, shipped
 * in 1.1.7) and map the old payload onto the new modal's status shape:
 * package.id = recipe.id, displayName/description/toolCount straight over,
 * `enabled` passthrough; `applicable` means the same thing on both
 * protocols.
 *
 * Return contract:
 *  - a prompt shape when a matching, disabled, non-dismissed recipe exists,
 *  - `{ applicable: false, retryable: true }` for a TRANSIENT failure (the
 *    probe timed out, the bridge rejected, or the background reported a
 *    transient error) — the caller retries it, and it must NOT be cached
 *    as a definitive protocol verdict,
 *  - `null` for a terminal "nothing to offer" answer (no matching recipe,
 *    already enabled, dismissed) or a structural failure
 *    (`UNAUTHORIZED_TARGET` — a bad binding/origin cannot heal).
 *
 * Never throws — ordinary web sessions (no extension at all) stay clean.
 */
async function probeLegacyProtocol(
  binding: string,
  checkStatus?: (binding: string) => Promise<LegacyRecipeStatus>,
): Promise<
  | (PackageOptInStatus & { applicable: true; package: PackageOptInInfo; enabled: false })
  | { applicable: false; retryable: boolean }
  | null
> {
  if (!checkStatus) return null
  let status: LegacyRecipeStatus | null = null
  try {
    status = await Promise.race([
      checkStatus(binding),
      new Promise<null>(resolve => {
        setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    // Old bridge broke mid-probe: keep it retryable (the caller's bounded
    // backoff will re-probe) without ever throwing into startup.
    return { applicable: false, retryable: true }
  }
  if (!status || status.ok === false) {
    // eslint-disable-next-line no-console
    console.warn('[SidePanelPackagePrompt] skip: legacy bridge returned failure/timeout', { status })
    // A legacy timeout (null) or a transient background error is NOT a
    // definitive "nothing to offer" answer: returning null here would let
    // the caller cache the 'legacy-only' verdict and skip a new-protocol
    // bridge that may have recovered. Stay retryable instead (finding:
    // "Transient failures hide the prompt"). A structural failure
    // (UNAUTHORIZED_TARGET — bad binding/origin) cannot heal and stays
    // terminal, mirroring the new-protocol semantics.
    const structural = status?.errorCode === 'UNAUTHORIZED_TARGET'
    return structural ? null : { applicable: false, retryable: true }
  }
  const recipe = status.recipe
  if (!status.applicable || !recipe || typeof recipe.id !== 'string') {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: no legacy recipe matches bound tab URL', { status })
    return null
  }
  if (status.enabled) {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: legacy recipe already enabled', recipe.id)
    return null
  }
  if (isPackagePromptDismissed(recipe.id)) {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] skip: within dismissal cooldown (legacy)', recipe.id)
    return null
  }
  // eslint-disable-next-line no-console
  console.info('[SidePanelPackagePrompt] showing opt-in modal from legacy probe for', recipe.id)
  return {
    applicable: true,
    enabled: false,
    ok: true,
    legacy: true,
    package: {
      // The old recipe ids ARE the new package ids (world.jmail.messages,
      // …) — the modal's icon map and dismissal keys work unchanged.
      id: recipe.id,
      description: typeof recipe.description === 'string' ? recipe.description : '',
      hostname: typeof recipe.hostname === 'string' ? recipe.hostname : '',
      // The legacy protocol has no per-origin activation split; a recipe is
      // either enabled or not (mirrored above).
      activation: 'disabled',
      // The legacy payload has NO per-tool list — only the count. The modal
      // hides the tool list when empty and falls back to the summary copy.
      tools: [],
      displayName: recipe.displayName,
      totalTools:
        typeof recipe.toolCount === 'number' && Number.isFinite(recipe.toolCount)
          ? recipe.toolCount
          : undefined,
      // No consentToken: the legacy enable path is tokenless by design.
    },
  }
}

/** Wrap a status payload into the prompt shape the modal consumes. */
function toPrompt(
  status: PackageOptInStatus,
): (PackageOptInStatus & { applicable: true; package: PackageOptInInfo; enabled: false }) | null {
  if (!status.package) return null
  // Attach the status-level consent token and package-wide tool count to the
  // payload the modal consumes (token echoed back on enable; totalTools
  // drives the multi-origin consent disclosure).
  const packageInfo: PackageOptInInfo = {
    ...status.package,
    consentToken: typeof status.consentToken === 'string' ? status.consentToken : undefined,
    totalTools: typeof status.totalTools === 'number' ? status.totalTools : undefined,
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

/**
 * Legacy (pre-#102) enable flow, used when the prompt status carries the
 * `legacy` flag: the old extension only speaks
 * `recipeEnable(binding, recipeId)` — there is NO consent token (the old
 * protocol predates token minting; its binding/tab re-validation in the
 * background is the protocol-level analog of grace mode). The bridge
 * reloads the upstream tab itself and reports `reloaded`, mirrored onto
 * the same `PackageOptInEnableResult` the new flow returns so the modal's
 * toast/retry logic stays identical.
 *
 * `onSettledLate` mirrors the new-protocol flow: when the client-side
 * timeout fires but the bridge call lands afterwards, its REAL outcome is
 * forwarded so the modal can correct the picture instead of staying on
 * stale timeout guidance (finding: "Late results leave modal stale").
 */
export async function enableLegacyRecipeAndReload(
  recipeId: string,
  onSettledLate?: (result: PackageOptInEnableResult) => void,
): Promise<PackageOptInEnableResult> {
  const { getSidePanelBindingId } = await import('@/agent/workspace-assistant-context')
  const binding = getSidePanelBindingId()
  if (!binding) return { ok: false, errorCode: 'NO_BINDING' }

  const agentWeb = (
    globalThis as { __agentWeb?: AgentWebPackageOptInBridge & AgentWebLegacyRecipeBridge }
  ).__agentWeb
  if (!agentWeb?.recipeEnable) return { ok: false, errorCode: 'BRIDGE_UNAVAILABLE' }

  // A previous enable for THIS binding + recipe is still in flight (the
  // client-side timeout fired but the bridge call kept running): await THAT
  // call instead of starting a duplicate enable + reload (two storage
  // writes, two tab reloads). The binding is part of the key: a different
  // bound tab is a different enable (finding: "Wrong tab reports enable
  // success"). The wait is bounded by the same budget so a bridge that
  // never settles cannot wedge the prompt.
  const key = `${binding}:${recipeId}`
  const existing = pendingLegacyEnables.get(key)
  if (existing) {
    // eslint-disable-next-line no-console
    console.info('[SidePanelPackagePrompt] legacy enable already in flight; awaiting it', { recipeId })
    const raced = await Promise.race([
      existing,
      new Promise<null>(resolve => {
        setTimeout(() => resolve(null), ENABLE_TIMEOUT_MS)
      }),
    ])
    if (raced) return raced
    // The in-flight call is STILL running: report the timeout and let the
    // late outcome reach the modal through the callback.
    void existing.then(result => onSettledLate?.(result))
    return { ok: false, errorCode: 'TIMEOUT' }
  }

  // The bridge promise is the unit of concurrency control: the client-side
  // timeout only bounds the WAIT, never the call itself. A SYNCHRONOUS
  // throw from the bridge method (not a rejected promise) must be caught
  // here — otherwise it escapes into the modal, which never clears its
  // submitting state (finding: "Enable dialog stays submitting").
  let bridgeCall: Promise<PackageOptInEnableResult>
  try {
    bridgeCall = agentWeb.recipeEnable(binding, recipeId).then(
      raw => ({
        ok: raw?.ok === true,
        errorCode: raw?.ok === true ? undefined : (raw?.errorCode ?? 'ENABLE_FAILED'),
        error: raw?.error,
        reloaded: raw?.reloaded,
      }),
      (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[SidePanelPackagePrompt] legacy enable bridge call failed:', err, { recipeId })
        return {
          ok: false,
          errorCode: 'ENABLE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        }
      },
    )
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error('[SidePanelPackagePrompt] legacy enable bridge threw synchronously:', err, { recipeId })
    return {
      ok: false,
      errorCode: 'ENABLE_FAILED',
      error: err instanceof Error ? err.message : String(err),
    }
  }
  // Track the call until it SETTLES — never delete an unresolved call
  // (a retry must not start a second enable that could double-commit and
  // reload the tab twice: finding "Retries trigger duplicate enables").
  // A settled call is dropped immediately: replaying its outcome to a
  // later attempt would report a stale success or block a retry
  // (findings "Re-enabling reports stale success" / "Failed enables block
  // immediate retry").
  pendingLegacyEnables.set(key, bridgeCall)
  void bridgeCall.finally(() => {
    if (pendingLegacyEnables.get(key) === bridgeCall) pendingLegacyEnables.delete(key)
  })

  const timedOut = Symbol('timeout')
  const outcome = await Promise.race([
    bridgeCall,
    new Promise<typeof timedOut>(resolve => {
      setTimeout(() => resolve(timedOut), ENABLE_TIMEOUT_MS)
    }),
  ])
  if (outcome === timedOut) {
    // The bridge call is still running: forward its real outcome to the
    // modal when it lands.
    void bridgeCall.then(result => onSettledLate?.(result))
    return { ok: false, errorCode: 'TIMEOUT' }
  }
  return outcome
}
