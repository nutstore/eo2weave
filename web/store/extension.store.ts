/**
 * Extension Store — manages browser extension detection state and install guide UI.
 *
 * Persists: banner dismissed timestamp, install guide step progress.
 * Also handles auto-registration of the codex-oauth LLM provider when
 * the browser extension is installed and authorized.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isWebBridgeAvailable } from '@/agent/tools/web-bridge.tool'
import { EXTENSION_LATEST_VERSION } from '@/app-build'
import { isMobileDeviceForExtension, type GuideMethod } from '@/lib/extension-distribution'
import {
  registerDynamicProvider,
  unregisterDynamicProvider,
} from '@/agent/providers/types'

export type ExtensionStatus = 'checking' | 'installed' | 'not_installed' | 'error'
export type ExtensionInstallType = 'admin' | 'development' | 'normal' | 'sideload' | 'other' | 'unknown'
export type ExtensionDistribution =
  | 'chrome_web_store'
  | 'edge_addons'
  | 'self_hosted'
  | 'manual'
  | 'enterprise'
  | 'development'
  | 'unknown'

export interface ExtensionMetadata {
  version: string
  extensionId: string | null
  installType: ExtensionInstallType
  distribution: ExtensionDistribution
}

const BANNER_DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const OUTDATED_BANNER_DISMISS_DURATION_MS = 3 * 24 * 60 * 60 * 1000 // 3 days

/** The provider ID used for Codex OAuth */
const CODEX_OAUTH_PROVIDER_ID = 'codex-oauth'

/**
 * In-flight mutex for `ensureCodexRegistered`. App.tsx runs `checkStatus`
 * on a 5s interval and each tick kicks off an ensure. Without this mutex,
 * two concurrent ticks can both pass the `codexOAuthRegistered` early-return
 * check, both call `registerCodexOAuthProvider`, and both fire a
 * `checkHasApiKey({flush:true})` — duplicate provider registration + repeated
 * DB-adjacent work. Reuse the same in-flight promise for all callers.
 */
let codexRegisterPromise: Promise<void> | null = null
let extensionMetadataPromise: Promise<ExtensionMetadata | null> | null = null

/** Virtual API key for codex-oauth (real token is in the extension) */
export const CODEX_OAUTH_API_KEY = '__codex_oauth_extension_bridge__'

/** Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0
    const nb = pb[i] || 0
    if (na < nb) return -1
    if (na > nb) return 1
  }
  return 0
}

/** Minimal view of the extension bridge used by this store. */
interface ExtensionWebBridge {
  getVersion?: () => Promise<{
    ok?: boolean
    version?: string
    extensionId?: string
    installType?: string
    distribution?: string
  }>
  codexGetStatus?: () => Promise<{
    ok?: boolean
    data?: {
      authorized?: boolean
      models?: Array<{ id: string; name: string; contextWindow?: number; capabilities?: string[] }>
    }
  }>
}

function getWebBridge(): ExtensionWebBridge | undefined {
  return (window as unknown as { __agentWeb?: ExtensionWebBridge }).__agentWeb
}

const INSTALL_TYPES = new Set<ExtensionInstallType>([
  'admin',
  'development',
  'normal',
  'sideload',
  'other',
  'unknown',
])
const DISTRIBUTIONS = new Set<ExtensionDistribution>([
  'chrome_web_store',
  'edge_addons',
  'self_hosted',
  'manual',
  'enterprise',
  'development',
  'unknown',
])

function normalizeExtensionMetadata(resp: Awaited<ReturnType<NonNullable<ExtensionWebBridge['getVersion']>>>): ExtensionMetadata | null {
  if (!resp?.ok || typeof resp.version !== 'string' || !resp.version) return null
  const installType = INSTALL_TYPES.has(resp.installType as ExtensionInstallType)
    ? resp.installType as ExtensionInstallType
    : 'unknown'
  const distribution = DISTRIBUTIONS.has(resp.distribution as ExtensionDistribution)
    ? resp.distribution as ExtensionDistribution
    : installType === 'sideload'
      ? 'manual'
      : installType === 'admin'
        ? 'enterprise'
        : installType === 'development'
          ? 'development'
          : 'unknown'
  return {
    version: resp.version,
    extensionId: typeof resp.extensionId === 'string' && resp.extensionId ? resp.extensionId : null,
    installType,
    distribution,
  }
}

/** Fetch extension metadata once for concurrent status checks. */
async function fetchExtensionMetadata(): Promise<ExtensionMetadata | null> {
  if (extensionMetadataPromise) return extensionMetadataPromise
  extensionMetadataPromise = (async () => {
    try {
      const bridge = getWebBridge()
      if (!bridge?.getVersion) return null
      return normalizeExtensionMetadata(await bridge.getVersion())
    } catch {
      return null
    } finally {
      extensionMetadataPromise = null
    }
  })()
  return extensionMetadataPromise
}

function supportsBundledVersionComparison(distribution: ExtensionDistribution): boolean {
  return distribution === 'self_hosted' || distribution === 'manual'
}

/**
 * Register the codex-oauth provider into the dynamic provider registry.
 * Accepts the live catalog returned by the extension.
 * Also persists a virtual API key so the standard provider pipeline works.
 *
 * Round-3 race fix (Sourcery): the registry notification now happens only
 * AFTER virtual-key persistence AND only while the extension is still
 * installed/authorized. If the extension disappears (or its auth is
 * revoked) during the `saveApiKey` await, `checkStatus` tears the provider
 * down but its `codexOAuthRegistered` early-return can skip the unregister
 * — so this function re-verifies before committing. Returns false when the
 * extension vanished mid-registration (caller must not set the registered
 * flag); true when the provider is registered.
 *
 * Round-4 fixes (Sourcery):
 *  - the `codexGetStatus` bridge request is bounded by a timeout so a
 *    wedged bridge cannot leave the in-flight `codexRegisterPromise`
 *    pending forever (later `ensureCodexRegistered` calls would reuse it
 *    and never retry);
 *  - liveness is re-verified AFTER the status await too — the extension
 *    can become unavailable while the status round-trip is in flight, and
 *    a stale provider must not be registered.
 */
const CODEX_STATUS_TIMEOUT_MS = 12_000

/**
 * Rejected by `withStatusTimeout` when the underlying bridge request does not
 * settle within `CODEX_STATUS_TIMEOUT_MS`. The postMessage-based bridge has no
 * cancellation mechanism (no AbortSignal crosses the `window.postMessage`
 * boundary), so the page cannot abort the outstanding request — the extension
 * side eventually settles it via its own timeout. We therefore abandon the
 * wrapper and back off instead of piling up retries.
 *
 * The wrapper timeout (12s) deliberately exceeds the extension side's own
 * bridge timeout (35s relay) AND the background's 10s models-fetch timeout so
 * a legitimately slow `codexGetStatus` — one whose catalog request is slow but
 * still completes — is never abandoned by the page; only a truly wedged
 * bridge (nothing settles at all) hits it.
 */
class CodexStatusTimeoutError extends Error {
  constructor() {
    super('codexGetStatus timed out')
    this.name = 'CodexStatusTimeoutError'
  }
}

function withStatusTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexStatusTimeoutError()), CODEX_STATUS_TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Consecutive-timeout backoff for `codexGetStatus` (Sourcery round 5). A
 * hung bridge request cannot be cancelled (see `CodexStatusTimeoutError`),
 * and App.tsx re-drives `ensureCodexRegistered` every 5s — without backoff a
 * permanently wedged bridge would accumulate one abandoned request per tick.
 * After N consecutive timeouts the next status query is delayed by the matching
 * step (5s → 10s → 20s, capped at 60s); any successful response resets the
 * streak. Module-level state on purpose — simple and shared by all callers.
 */
const CODEX_STATUS_BACKOFF_STEPS_MS = [5_000, 10_000, 20_000]
const CODEX_STATUS_BACKOFF_CAP_MS = 60_000
let codexStatusTimeoutStreak = 0
let codexStatusNextAttemptAt = 0

function noteCodexStatusTimeout(): void {
  const step = CODEX_STATUS_BACKOFF_STEPS_MS[
    Math.min(codexStatusTimeoutStreak, CODEX_STATUS_BACKOFF_STEPS_MS.length - 1)
  ] ?? CODEX_STATUS_BACKOFF_CAP_MS
  codexStatusTimeoutStreak++
  codexStatusNextAttemptAt = Date.now() + Math.min(step, CODEX_STATUS_BACKOFF_CAP_MS)
}

function noteCodexStatusSuccess(): void {
  codexStatusTimeoutStreak = 0
  codexStatusNextAttemptAt = 0
}

/** True while a status query is deferred by the consecutive-timeout backoff. */
function isCodexStatusBackedOff(): boolean {
  return Date.now() < codexStatusNextAttemptAt
}

async function registerCodexOAuthProvider(
  statusResp: NonNullable<Awaited<ReturnType<NonNullable<ExtensionWebBridge['codexGetStatus']>>>>,
): Promise<boolean> {
  const extensionModels = statusResp.data?.models || []
  const models = extensionModels.map(m => ({
    id: m.id,
    name: m.name,
    capabilities: (m.capabilities || ['code', 'reasoning']) as ['code', 'reasoning'],
    contextWindow: m.contextWindow || 200000,
  }))

  // Recommended-model priority: the extension's catalog order is server-side
  // and NOT user-facing ordering. Reorder so GPT-6 Luna leads, falling back to
  // GPT-5.6 Luna when the 6 isn't in the catalog yet — the "models[0] is
  // auto-selected when the user has no explicit default" convention (see
  // WelcomeScreen auto-advance + setPinnedModels flow) makes list order the
  // de-facto recommendation for international users.
  const RECOMMENDED_FIRST = ['gpt-6-luna', 'gpt-5.6-luna']
  models.sort((a, b) => {
    const ai = RECOMMENDED_FIRST.indexOf(a.id)
    const bi = RECOMMENDED_FIRST.indexOf(b.id)
    return (ai === -1 ? RECOMMENDED_FIRST.length : ai) - (bi === -1 ? RECOMMENDED_FIRST.length : bi)
  })

  // Persist through the initialization gate: extension detection starts before
  // the app's storage bootstrap has necessarily completed.
  try {
    const { saveApiKey } = await import('@/security/api-key-store')
    await saveApiKey(CODEX_OAUTH_PROVIDER_ID, CODEX_OAUTH_API_KEY)
  } catch (err) {
    console.warn('[extension.store] Failed to save codex-oauth virtual API key:', err)
  }

  // Extension disappeared (or auth revoked) during the await above: do NOT
  // complete the stale registration — leave the registry clean so the
  // persisted codex-oauth selection resolves as unregistered (#87) and the
  // next status tick offers the re-login guidance.
  //
  // (Sourcery round 5) The authorization check itself now happens in exactly
  // ONE place: `ensureCodexRegistered` performs the single `codexGetStatus`
  // round-trip and only calls this function when `resp.ok && authorized` held
  // at that instant. This function therefore does NOT re-query the bridge —
  // the previous internal second query widened the revocation TOCTOU window
  // to two full round-trips instead of shrinking it.
  if (!isWebBridgeAvailable()) {
    return false
  }
  // (Sourcery round 5) `isWebBridgeAvailable()` only proves the bridge exists
  // — the authorization snapshot can still be up to one round-trip stale.
  // Revocation during the `saveApiKey` await below is therefore unavoidable
  // (a revoked route can survive for one window), but it is bounded: the
  // periodic re-check in `ensureCodexRegistered` (finding 1) re-queries the
  // status on every App.tsx 5s tick and unregisters a revoked provider within
  // one interval.

  registerDynamicProvider(
    CODEX_OAUTH_PROVIDER_ID,
    {
      baseURL: 'https://chatgpt.com/backend-api/codex',
      modelName: models[0].id,
      headers: {},
      apiMode: 'responses',
    },
    {
      category: 'custom',
      displayName: 'Codex (Browser OAuth)',
      models,
    },
  )
  return true
}

function unregisterCodexOAuthProvider() {
  unregisterDynamicProvider(CODEX_OAUTH_PROVIDER_ID)
}

interface ExtensionState {
  // --- Runtime state (not persisted) ---
  status: ExtensionStatus
  lastCheckAt: number | null
  /** Whether the codex-oauth provider is currently registered */
  codexOAuthRegistered: boolean
  /** Installed extension version, or null if not installed/unknown */
  extensionVersion: string | null
  /** Runtime extension identity and install-channel metadata. */
  extensionId: string | null
  extensionInstallType: ExtensionInstallType
  extensionDistribution: ExtensionDistribution
  /** Whether the installed extension is older than the latest */
  outdated: boolean
  /**
   * Whether the installed extension is NEWER than the latest version known
   * to this web build (e.g. the store auto-updated ahead of the web app, or
   * the web app deploy lags behind). The extension keeps working normally —
   * this only affects the informational banner.
   */
  newerThanWeb: boolean

  // --- Persisted state ---
  bannerDismissedAt: number | null
  installGuideStep: number
  installGuideOpen: boolean
  /** Which install method the user picked in the guide (null = still on the choice step) */
  guideMethod: GuideMethod | null
  /** When the outdated banner was last dismissed */
  outdatedBannerDismissedAt: number | null

  // --- Actions ---
  checkStatus: () => ExtensionStatus
  /**
   * Ensure the codex-oauth provider is registered before checking API keys.
   * Must be awaited before checkHasApiKey() so getProviderConfig('codex-oauth')
   * returns a valid config instead of null.
   * No-op if extension is not installed or not authorized.
   */
  ensureCodexRegistered: () => Promise<void>
  dismissBanner: () => void
  shouldShowBanner: () => boolean
  shouldShowOutdatedBanner: () => boolean
  dismissOutdatedBanner: () => void
  /** Whether the informational "extension newer than web" banner should show */
  openInstallGuide: () => void
  closeInstallGuide: () => void
  goToStep: (step: number) => void
  /** Record the user's install-method choice (step 1) and enter its flow */
  pickGuideMethod: (method: GuideMethod) => void
  resetInstallGuide: () => void
  setStatus: (status: ExtensionStatus) => void
}

export const useExtensionStore = create<ExtensionState>()(
  persist(
    (set, get) => ({
      // Runtime state
      status: 'checking' as ExtensionStatus,
      lastCheckAt: null as number | null,
      codexOAuthRegistered: false,
      extensionVersion: null as string | null,
      extensionId: null as string | null,
      extensionInstallType: 'unknown' as ExtensionInstallType,
      extensionDistribution: 'unknown' as ExtensionDistribution,
      outdated: false,
      newerThanWeb: false,

      // Persisted state
      bannerDismissedAt: null as number | null,
      installGuideStep: 1,
      installGuideOpen: false,
      guideMethod: null as GuideMethod | null,
      outdatedBannerDismissedAt: null as number | null,

      // Actions
      checkStatus: () => {
        let newStatus: ExtensionStatus
        try {
          newStatus = isWebBridgeAvailable() ? 'installed' : 'not_installed'
        } catch {
          newStatus = 'error'
        }

        // Only trigger re-render if status actually changed
        if (get().status !== newStatus) {
          set({ status: newStatus, lastCheckAt: Date.now() })
        }

        // Fire-and-forget: register codex-oauth + check version when extension is installed
        if (newStatus === 'installed') {
          get().ensureCodexRegistered().catch(() => {})
          // Store listings update independently. Until a channel-specific
          // published version exists, only manual/self-hosted installs can be
          // compared with the bundled ZIP version from this web build.
          fetchExtensionMetadata().then((metadata) => {
            if (!metadata) return
            const latestVersion = EXTENSION_LATEST_VERSION
            const comparable = supportsBundledVersionComparison(metadata.distribution)
            const cmp = comparable ? compareVersions(metadata.version, latestVersion) : 0
            set({
              extensionVersion: metadata.version,
              extensionId: metadata.extensionId,
              extensionInstallType: metadata.installType,
              extensionDistribution: metadata.distribution,
              outdated: comparable && latestVersion !== '0.0.0' && cmp < 0,
              newerThanWeb: comparable && latestVersion !== '0.0.0' && cmp > 0,
            })
          }).catch(() => {})
        } else {
          // Extension not installed or in error state. If we previously had
          // codex registered, tear it down. Either way, flush any deferred
          // checkHasApiKey so the UI doesn't sit in the loading state
          // forever waiting for codex to register.
          if (get().codexOAuthRegistered) {
            unregisterCodexOAuthProvider()
            set({
              codexOAuthRegistered: false,
              extensionVersion: null,
              extensionId: null,
              extensionInstallType: 'unknown',
              extensionDistribution: 'unknown',
              outdated: false,
              newerThanWeb: false,
            })
          } else if (get().extensionVersion !== null) {
            // Codex never registered but extension metadata may linger from an
            // earlier tick (e.g. the extension was disabled mid-session).
            set({
              extensionVersion: null,
              extensionId: null,
              extensionInstallType: 'unknown',
              extensionDistribution: 'unknown',
              outdated: false,
              newerThanWeb: false,
            })
          }
          // Flush deferred checkHasApiKey — the caller is asking "definitively,
          // is there a codex API key or not?" and we've done our best to find
          // out (no extension = no codex).
          void import('@/store/settings.store').then(({ useSettingsStore }) => {
            void useSettingsStore
              .getState()
              .checkHasApiKey({ flush: true })
              .catch(() => {})
          }).catch(() => {})
        }

        return newStatus
      },

      ensureCodexRegistered: async () => {
        // Serialize concurrent calls. App.tsx drives this on a 5s interval
        // so without this mutex two ticks can both pass the early-return
        // check below and double-register the provider. Reuse the in-flight
        // promise for all callers — `finally` clears it for the next tick.
        if (codexRegisterPromise) return codexRegisterPromise

        // The clear MUST be a `.finally()` chain, not a `finally` block inside
        // the async body: the backoff early-return completes the body with no
        // awaits, so an in-body `finally` would run synchronously BEFORE the
        // `codexRegisterPromise = ...` assignment below lands — the settled
        // promise would then be stored into the mutex and wedge every later
        // caller. `.finally()` always defers the clear to a microtask, after
        // the assignment.
        const run = async () => {
          // (Sourcery round 5, finding 3) A bridge request that never
          // settles cannot be cancelled — the postMessage bridge exposes no
          // AbortSignal, so the timed-out request is abandoned (the
          // extension side eventually settles it via its own timeout).
          // Back off instead of issuing a fresh request on every 5s tick.
          if (isCodexStatusBackedOff()) {
            // Return WITHOUT issuing a request; the `.finally()` chain below clears
            // the shared in-flight promise so later ticks can re-evaluate
            // the backoff window.
            return
          }
          // Already registered — (Sourcery round 5, finding 1) the OAuth
          // grant can be revoked at any moment, so "registered" can no
          // longer skip the status query: re-check authorization on every
          // tick and unregister a revoked provider. Still best-effort: a
          // timeout keeps the current registration (the extension may just
          // be wedged) but arms the backoff.
          if (get().codexOAuthRegistered) {
            const bridge = getWebBridge()
            if (bridge?.codexGetStatus) {
              try {
                const resp = await withStatusTimeout(bridge.codexGetStatus())
                noteCodexStatusSuccess()
                if (!resp?.ok || !resp.data?.authorized) {
                  unregisterCodexOAuthProvider()
                  set({ codexOAuthRegistered: false })
                }
              } catch (err) {
                // Only a genuine timeout leaves an abandoned request behind —
                // a promptly-rejected bridge error must not extend the backoff.
                if (err instanceof CodexStatusTimeoutError) {
                  noteCodexStatusTimeout()
                }
              }
            }
            try {
              const { useSettingsStore } = await import('@/store/settings.store')
              await useSettingsStore.getState().checkHasApiKey({ flush: true }).catch(() => {})
            } catch {
              // Best-effort flush — failure here doesn't block registration.
            }
            return
          }

          const bridge = getWebBridge()
          if (!bridge?.codexGetStatus) {
            // Bridge not ready (extension page might still be initializing).
            // Flush with `flush: true` so the deferred checkHasApiKey doesn't
            // hang forever — caller can re-trigger later if needed.
            try {
              const { useSettingsStore } = await import('@/store/settings.store')
              await useSettingsStore.getState().checkHasApiKey({ flush: true })
            } catch {
              // Best-effort flush.
            }
            return
          }

          try {
            // Round 4: bound this round-trip too — a wedged bridge here
            // would otherwise hold `codexRegisterPromise` open forever and
            // stall every later ensureCodexRegistered tick.
            const resp = await withStatusTimeout(bridge.codexGetStatus())
            noteCodexStatusSuccess()
            if (resp?.ok && resp.data?.authorized && Array.isArray(resp.data.models) && resp.data.models.length > 0 && !get().codexOAuthRegistered) {
              // (Sourcery round 5, finding 2) Single source of truth for the
              // authorization snapshot: `resp` above is the ONLY status
              // query — `registerCodexOAuthProvider` consumes it instead of
              // re-querying, so the revocation TOCTOU window is one
              // round-trip, not two.
              const registered = await registerCodexOAuthProvider(resp)
              // (Sourcery round 3) If the extension vanished during the
              // registration awaits, the provider was NOT re-registered —
              // do not flip the flag; the next status tick will surface
              // the not-authorized branch and offer re-login guidance.
              if (!registered) {
                try {
                  const { useSettingsStore } = await import('@/store/settings.store')
                  await useSettingsStore.getState().checkHasApiKey({ flush: true })
                } catch {
                  // Best-effort flush.
                }
                return
              }
              set({ codexOAuthRegistered: true })
              // Auto-pin codex models if none pinned yet + refresh provider list
              try {
                const { useSettingsStore } = await import('@/store/settings.store')
                const settings = useSettingsStore.getState()
                const modelIds = (resp.data.models || []).map((m) => m.id)
                const existing = settings.pinnedModelsByProvider['codex-oauth']
                if (!existing || existing.length === 0) {
                  if (modelIds.length > 0) {
                    settings.setPinnedModels('codex-oauth', modelIds)
                  }
                }
                // The extension response IS the authoritative list — record
                // which pins were confirmed present so pins that disappear
                // from a future response can be flagged as stale/delisted.
                if (modelIds.length > 0) {
                  settings.markPinnedModelsSeen('codex-oauth', modelIds)
                }
                useSettingsStore.getState().triggerProviderRefresh()
              } catch {
                // Pinning + provider refresh are best-effort.
              }
              // Re-check API key now that the provider is registered.
              // No `{ flush: true }` needed here — by this point the provider
              // IS registered, so the check can proceed normally.
              try {
                const { useSettingsStore } = await import('@/store/settings.store')
                useSettingsStore.getState().invalidateApiKeyCache('codex-oauth')
                await useSettingsStore.getState().checkHasApiKey()
              } catch {
                // Cache invalidation / re-check is best-effort.
              }
            } else if (resp?.ok && resp.data?.authorized) {
              // Catalog is temporarily unavailable; keep the existing provider
              // and retry on the next status check without inventing models.
              if (!get().codexOAuthRegistered) {
                try {
                  const { useSettingsStore } = await import('@/store/settings.store')
                  await useSettingsStore.getState().checkHasApiKey({ flush: true })
                } catch {
                  // Best-effort flush.
                }
              }
            } else {
              // Not authorized, or auth revoked. Flush any deferred
              // checkHasApiKey so the UI doesn't stay in loading state.
              if (get().codexOAuthRegistered) {
                unregisterCodexOAuthProvider()
                set({ codexOAuthRegistered: false })
              }
              try {
                const { useSettingsStore } = await import('@/store/settings.store')
                await useSettingsStore.getState().checkHasApiKey({ flush: true })
              } catch {
                // Best-effort flush.
              }
            }
          } catch (err) {
            // Only a genuine timeout leaves an abandoned request behind —
            // arm the consecutive-timeout backoff for it. A promptly-rejected
            // bridge error leaves no bridge-side work, so it must retry on the
            // next tick WITHOUT extending the backoff.
            if (err instanceof CodexStatusTimeoutError) {
              noteCodexStatusTimeout()
            }
            // Flush the deferred check so the UI doesn't hang.
            try {
              const { useSettingsStore } = await import('@/store/settings.store')
              await useSettingsStore.getState().checkHasApiKey({ flush: true })
            } catch {
              // Best-effort flush.
            }
          }
        }
        codexRegisterPromise = run().finally(() => {
          codexRegisterPromise = null
        })
        return codexRegisterPromise
      },

      dismissBanner: () => {
        set({ bannerDismissedAt: Date.now() })
      },

      shouldShowBanner: () => {
        const { status, bannerDismissedAt } = get()
        // Mobile browsers cannot install extensions — never nag there.
        if (isMobileDeviceForExtension()) return false
        if (status === 'installed') return false
        if (status === 'checking') return false
        if (bannerDismissedAt) {
          const elapsed = Date.now() - bannerDismissedAt
          if (elapsed < BANNER_DISMISS_DURATION_MS) return false
        }
        return true
      },

      openInstallGuide: () => {
        // Mobile devices can't install extensions; the guide only shows a
        // "desktop only" notice there (see ExtensionInstallGuide).
        if (isMobileDeviceForExtension()) return
        set({ installGuideOpen: true })
      },

      closeInstallGuide: () => {
        set({ installGuideOpen: false })
      },

      goToStep: (step: number) => {
        // Going back to the choice step clears the method so the flow
        // re-branches cleanly on the next pick instead of keeping a stale one.
        if (step <= 1) set({ guideMethod: null })
        set({ installGuideStep: step })
      },

      pickGuideMethod: (method) => {
        set({ guideMethod: method, installGuideStep: 2 })
      },

      resetInstallGuide: () => {
        set({ installGuideStep: 1, installGuideOpen: false, guideMethod: null })
      },

      shouldShowOutdatedBanner: () => {
        const { status, outdated, outdatedBannerDismissedAt } = get()
        if (status !== 'installed' || !outdated) return false
        if (outdatedBannerDismissedAt) {
          const elapsed = Date.now() - outdatedBannerDismissedAt
          if (elapsed < OUTDATED_BANNER_DISMISS_DURATION_MS) return false
        }
        return true
      },

      dismissOutdatedBanner: () => {
        set({ outdatedBannerDismissedAt: Date.now() })
      },

      setStatus: (status: ExtensionStatus) => {
        set({ status })
      },
    }),
    {
      name: 'creatorweave-extension-store',
      // Only persist these fields (guideMethod kept so a page reload
      // mid-guide re-enters the same flow instead of losing the choice)
      partialize: (state) => ({
        bannerDismissedAt: state.bannerDismissedAt,
        installGuideStep: state.installGuideStep,
        guideMethod: state.guideMethod,
        outdatedBannerDismissedAt: state.outdatedBannerDismissedAt,
      }),
    },
  ),
)
