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
import type { GuideMethod } from '@/lib/extension-distribution'
import {
  registerDynamicProvider,
  unregisterDynamicProvider,
} from '@/agent/providers/types'

export type ExtensionStatus = 'checking' | 'installed' | 'not_installed' | 'error'

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

/** Virtual API key for codex-oauth (real token is in the extension) */
export const CODEX_OAUTH_API_KEY = '__codex_oauth_extension_bridge__'

/** Default models for Codex OAuth (fallback if extension doesn't return models) */
const CODEX_OAUTH_FALLBACK_MODELS = [
  { id: 'gpt-5.4', name: 'GPT-5.4', capabilities: ['code', 'reasoning', 'vision'] as const, contextWindow: 1000000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', capabilities: ['code', 'reasoning', 'vision'] as const, contextWindow: 400000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', capabilities: ['code', 'reasoning', 'vision'] as const, contextWindow: 1000000 },
]

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

/** Fetch installed extension version via the bridge API. */
async function fetchInstalledVersion(): Promise<string | null> {
  try {
    const bridge = (window as any).__agentWeb
    if (!bridge?.getVersion) return null
    const resp = await bridge.getVersion()
    return resp?.ok && resp?.version ? resp.version : null
  } catch {
    return null
  }
}

/**
 * Register the codex-oauth provider into the dynamic provider registry.
 * Accepts models from the extension response; falls back to defaults if not provided.
 * Also persists a virtual API key so the standard provider pipeline works.
 */
async function registerCodexOAuthProvider(extensionModels?: Array<{ id: string; name: string; contextWindow?: number; capabilities?: string[] }>) {
  const models = (extensionModels && extensionModels.length > 0 ? extensionModels : CODEX_OAUTH_FALLBACK_MODELS).map(m => ({
    id: m.id,
    name: m.name,
    capabilities: (m.capabilities || ['code', 'reasoning']) as ['code', 'reasoning'],
    contextWindow: m.contextWindow || 200000,
  }))

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

  // Persist through the initialization gate: extension detection starts before
  // the app's storage bootstrap has necessarily completed.
  try {
    const { saveApiKey } = await import('@/security/api-key-store')
    await saveApiKey(CODEX_OAUTH_PROVIDER_ID, CODEX_OAUTH_API_KEY)
  } catch (err) {
    console.warn('[extension.store] Failed to save codex-oauth virtual API key:', err)
  }
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
  /** When the "extension newer than web" banner was last dismissed */
  newerBannerDismissedAt: number | null

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
  shouldShowNewerBanner: () => boolean
  dismissNewerBanner: () => void
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
      outdated: false,
      newerThanWeb: false,

      // Persisted state
      bannerDismissedAt: null as number | null,
      installGuideStep: 1,
      installGuideOpen: false,
      guideMethod: null as GuideMethod | null,
      outdatedBannerDismissedAt: null as number | null,
      newerBannerDismissedAt: null as number | null,

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
          // Fetch version and compare with latest
          fetchInstalledVersion().then((version) => {
            if (!version) return
            const latestVersion = EXTENSION_LATEST_VERSION
            const cmp = compareVersions(version, latestVersion)
            set({
              extensionVersion: version,
              outdated: cmp < 0,
              newerThanWeb: latestVersion !== '0.0.0' && cmp > 0,
            })
          }).catch(() => {})
        } else {
          // Extension not installed or in error state. If we previously had
          // codex registered, tear it down. Either way, flush any deferred
          // checkHasApiKey so the UI doesn't sit in the loading state
          // forever waiting for codex to register.
          if (get().codexOAuthRegistered) {
            unregisterCodexOAuthProvider()
            set({ codexOAuthRegistered: false, extensionVersion: null, outdated: false, newerThanWeb: false })
          } else if (get().extensionVersion !== null) {
            // Codex never registered but version state may linger from an
            // earlier tick (e.g. the extension was disabled mid-session).
            set({ extensionVersion: null, outdated: false, newerThanWeb: false })
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

        codexRegisterPromise = (async () => {
          try {
            // Already registered — still flush checkHasApiKey in case a prior
            // deferred call is waiting.
            if (get().codexOAuthRegistered) {
              try {
                const { useSettingsStore } = await import('@/store/settings.store')
                await useSettingsStore.getState().checkHasApiKey().catch(() => {})
              } catch {
                // Best-effort flush — failure here doesn't block registration.
              }
              return
            }

            const bridge = (window as any).__agentWeb
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
              const resp = await bridge.codexGetStatus()
              if (resp?.ok && resp.data?.authorized && !get().codexOAuthRegistered) {
                await registerCodexOAuthProvider(resp.data.models)
                set({ codexOAuthRegistered: true })
                // Auto-pin codex models if none pinned yet + refresh provider list
                try {
                  const { useSettingsStore } = await import('@/store/settings.store')
                  const settings = useSettingsStore.getState()
                  const modelIds = (resp.data.models || []).map((m: any) => m.id as string)
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
            } catch {
              // Bridge error (extension may not support codex, or auth flow
              // not yet ready). Flush the deferred check so the UI doesn't hang.
              try {
                const { useSettingsStore } = await import('@/store/settings.store')
                await useSettingsStore.getState().checkHasApiKey({ flush: true })
              } catch {
                // Best-effort flush.
              }
            }
          } finally {
            codexRegisterPromise = null
          }
        })()
        return codexRegisterPromise
      },

      dismissBanner: () => {
        set({ bannerDismissedAt: Date.now() })
      },

      shouldShowBanner: () => {
        const { status, bannerDismissedAt } = get()
        if (status === 'installed') return false
        if (status === 'checking') return false
        if (bannerDismissedAt) {
          const elapsed = Date.now() - bannerDismissedAt
          if (elapsed < BANNER_DISMISS_DURATION_MS) return false
        }
        return true
      },

      openInstallGuide: () => {
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

      shouldShowNewerBanner: () => {
        const { status, newerThanWeb, newerBannerDismissedAt } = get()
        if (status !== 'installed' || !newerThanWeb) return false
        if (newerBannerDismissedAt) {
          const elapsed = Date.now() - newerBannerDismissedAt
          if (elapsed < OUTDATED_BANNER_DISMISS_DURATION_MS) return false
        }
        return true
      },

      dismissNewerBanner: () => {
        set({ newerBannerDismissedAt: Date.now() })
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
        newerBannerDismissedAt: state.newerBannerDismissedAt,
      }),
    },
  ),
)
