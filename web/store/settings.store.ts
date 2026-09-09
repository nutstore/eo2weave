/**
 * Settings store - manages LLM configuration and user preferences.
 *
 * Important: hasApiKey is NOT persisted because it's derived from SQLite.
 * Always check the actual database value to ensure consistency.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { LLMProviderType } from '@/agent/providers/types'
import {
  isCustomProviderType,
  isPotentiallyDynamicProviderType,
  registerDynamicProvider,
  unregisterDynamicProvider,
  getProviderConfig,
} from '@/agent/providers/types'
import { getModelContextWindow } from '@/agent/providers/model-store'
import type { ExtendedThinkingLevel } from '@/agent/llm/pi-ai-custom-openai-fetch'
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

/**
 * Chinese-brand providers whose display name should be locale-aware:
 * zh keeps the original Chinese brand; other locales use the company's
 * pinyin/English brand — NOT the separate international services (e.g.
 * Zhipu's overseas arm "Z.ai" is a different service from open.bigmodel.cn).
 */
const PROVIDER_NAME_I18N_KEYS: Partial<Record<string, string>> = {
  glm: 'settings.providerNames.glm',
  'glm-coding': 'settings.providerNames.glmCoding',
  'minimax-cn': 'settings.providerNames.minimaxChina',
  qwen: 'settings.providerNames.qwen',
  'volcengine-coding': 'settings.providerNames.volcengineCoding',
  // gateway handled separately below
  'llm-gateway': 'settings.gateway.name',
}

/** Resolve a provider display name; falls back to the static meta name. */
function localizedProviderDisplayName(providerType: string, fallback: string): string {
  const key = PROVIDER_NAME_I18N_KEYS[providerType]
  if (!key) return fallback
  const translated = translateStatic(useI18nStore.getState().locale, key)
  return translated !== key ? translated : fallback
}

// Cache for hasApiKey to avoid repeated database queries
// This is a soft cache that can be invalidated
const apiKeyCache = new Map<string, boolean>()
const apiKeyCachePromise: Map<string, Promise<boolean>> = new Map()

/** API mode for custom providers: chat completions vs OpenAI responses API */
export type CustomApiMode = 'chat-completions' | 'responses'

export interface CustomProviderConfig {
  id: string
  name: string
  baseUrl: string
  models: string[]
  /** Which API endpoint format to use. Defaults to 'chat-completions' */
  apiMode: CustomApiMode
  createdAt: number
  updatedAt: number
}

interface EffectiveProviderConfig {
  apiKeyProviderKey: string
  baseUrl: string
  modelName: string
}

/** Per-workspace model override */
export interface WorkspaceModelOverride {
  providerType: LLMProviderType
  modelName: string
  // activeCustomProviderId removed — providerType IS the custom provider id now
}

interface SettingsState {
  // LLM settings
  providerType: LLMProviderType
  modelName: string
  customBaseUrl: string
  // Persisted custom provider configs — used to re-register on app load
  customProviders: CustomProviderConfig[]
  temperature: number
  maxTokens: number
  maxIterations: number
  enableThinking: boolean
  thinkingLevel: ExtendedThinkingLevel

  // 实验性功能 (Experimental features, disabled by default)
  enableBatchSpawn: boolean
  enableWebMCP: boolean
  agentLoopNotifications: {
    enabled: boolean
    onlyWhenHidden: boolean
  }

  // Snapshot retention (per-workspace, which is per-project in our
  // 1:1:1 model). When a workspace accumulates more than
  // `snapshotHighWatermark` snapshots, the next
  // `createApprovedSnapshotForPaths` call prunes them down to
  // `snapshotLowWatermark`. Persisted for future Settings UI. The
  // authoritative source lives in `app_settings`; this Zustand copy is
  // a UI convenience and is loaded on hydration.
  snapshotHighWatermark: number
  snapshotLowWatermark: number

  // API key status - NOT persisted, derived from SQLite
  // Use getHasApiKey() or checkHasApiKey() to get the current value
  hasApiKey: boolean
  /**
   * True once `checkHasApiKey()` has completed at least once (regardless of
   * result). UI components that gate on `!hasApiKey` should also gate on
   * `hasApiKeyLoaded` to avoid flashing the "no API key" state during the
   * initial async check (which defaults `hasApiKey` to `false`).
   */
  hasApiKeyLoaded: boolean

  // Per-workspace model overrides
  modelOverridesByWorkspace: Record<string, WorkspaceModelOverride>

  // Last used model per provider (for restoring on switch-back)
  lastUsedModelByProvider: Partial<Record<LLMProviderType, string>>

  // Image generation model (persisted)
  imageGenModel: string
  // Image generation aspect ratio (persisted), e.g. "1:1", "16:9"
  imageGenAspectRatio: string

  // Pinned (user-selected) models per provider — subset of full model list
  pinnedModelsByProvider: Record<string, string[]>

  // Actions
  setProviderType: (type: LLMProviderType) => void
  setModelName: (name: string) => void
  setCustomBaseUrl: (url: string) => void
  createCustomProvider: (input: { name: string; baseUrl: string; apiMode?: CustomApiMode }) => boolean
  updateCustomProvider: (
    providerId: string,
    patch: { name?: string; baseUrl?: string }
  ) => boolean
  removeCustomProvider: (providerId: string) => void
  addCustomProviderModel: (providerId: string, model: string) => boolean
  removeCustomProviderModel: (providerId: string, model: string) => void
  setCustomProviderApiMode: (providerId: string, apiMode: import('@/store/settings.store').CustomApiMode) => void
  setTemperature: (temp: number) => void
  setMaxTokens: (tokens: number) => void
  setMaxIterations: (iterations: number) => void
  setEnableThinking: (v: boolean) => void
  setThinkingLevel: (v: ExtendedThinkingLevel) => void
  setImageGenModel: (v: string) => void
  setImageGenAspectRatio: (v: string) => void
  setEnableBatchSpawn: (v: boolean) => void
  setEnableWebMCP: (v: boolean) => void
  setSnapshotHighWatermark: (n: number) => void
  setSnapshotLowWatermark: (n: number) => void
  setHasApiKey: (has: boolean) => void
  setAgentLoopNotificationsEnabled: (enabled: boolean) => void
  setAgentLoopNotificationsOnlyWhenHidden: (onlyWhenHidden: boolean) => void
  getEffectiveProviderConfig: () => EffectiveProviderConfig | null

  /**
   * Check if API key exists for current provider
   * This queries the database directly, bypassing the cached state.
   *
   * Pass `{ flush: true }` to bypass the "dynamic provider still
   * registering" defer — the caller has already attempted registration
   * and wants a definitive answer (typically "no key"). Without this flag,
   * the check defers (returns without setting `hasApiKeyLoaded`) when the
   * configured provider is one of the async-registered dynamic providers
   * (see `isPotentiallyDynamicProviderType`).
   */
  checkHasApiKey: (options?: { flush?: boolean }) => Promise<boolean>

  /**
   * Invalidate the API key cache for a provider
   * Call this after saving/deleting an API key
   */
  invalidateApiKeyCache: (provider?: string) => void

  /**
   * Save current model selection to a specific workspace
   */
  saveModelOverrideForWorkspace: (workspaceId: string) => void

  /**
   * Restore model selection from a workspace override (or fallback to defaults)
   */
  syncModelForWorkspace: (workspaceId: string | null) => void

  /**
   * Switch provider and model atomically (used by quick-switcher)
   */
  switchProviderAndModel: (providerType: LLMProviderType, modelName: string) => void

  /**
   * Get all providers that have a saved API key
   */
  getAvailableProviders: () => Promise<Array<{
    providerType: LLMProviderType
    displayName: string
    models: Array<{ id: string; name: string }>
    providerKey: string
  }>>

  /**
   * Restore dynamic providers from persisted customProviders on app load
   */
  _restoreDynamicProviders: () => void

  // Pinned models actions
  pinModel: (providerType: LLMProviderType, modelId: string) => void
  unpinModel: (providerType: LLMProviderType, modelId: string) => void
  setPinnedModels: (providerType: LLMProviderType, modelIds: string[]) => void

  /**
   * Runtime version counter — incremented when provider/model list changes
   * (API key saved, model pinned/unpinned, custom provider removed).
   * UI components watch this to decide when to refresh their provider lists.
   */
  _providerRefreshVersion: number
  triggerProviderRefresh: () => void
}

/**
 * Persist snapshot retention watermarks to SQLite's `app_settings` table.
 *
 * Called as fire-and-forget from the synchronous Zustand setters — a SQLite
 * write failure must not block the UI update. We use a dynamic import to
 * avoid a hard cycle (settings.store → fs-overlay.repository; repository
 * never imports settings.store today, but keeping the import lazy also
 * shortens the initial bundle).
 */
async function persistSnapshotWatermarksToDb(
  high: number,
  low: number,
): Promise<void> {
  try {
    const { getFSOverlayRepository } = await import(
      '@/sqlite/repositories/fs-overlay.repository'
    )
    await getFSOverlayRepository().setSnapshotWatermarks(high, low)
  } catch (err) {
    // Don't surface to UI — the user already saw their input reflected in
    // the local Zustand copy. The next successful write (or app restart
    // with onRehydrateStorage hydration) will reconcile.
    console.warn(
      '[SettingsStore] Failed to persist snapshot watermarks to app_settings; will retry on next set:',
      err,
    )
  }
}

/**
 * Read snapshot watermarks from `app_settings` and merge into the Zustand
 * state. Called once on app boot, after rehydration, so cross-device
 * values (or values set by another tab) override the localStorage copy.
 *
 * Safe to call before the SQLite worker is ready — errors are swallowed
 * and we fall back to the defaults.
 */
export async function hydrateSnapshotWatermarksFromDb(): Promise<void> {
  try {
    const { getFSOverlayRepository } = await import(
      '@/sqlite/repositories/fs-overlay.repository'
    )
    const wm = await getFSOverlayRepository().getSnapshotWatermarks()
    const defaults = { high: 100, low: 50 }
    // Only override when DB values differ from the localStorage defaults —
    // otherwise the user's localStorage copy (typed in offline) wins.
    if (wm.high !== defaults.high || wm.low !== defaults.low) {
      useSettingsStore.setState({
        snapshotHighWatermark: wm.high,
        snapshotLowWatermark: wm.low,
      })
    }
  } catch (err) {
    console.warn(
      '[SettingsStore] hydrateSnapshotWatermarksFromDb failed; using Zustand defaults:',
      err,
    )
  }
}

/** Helper: register a CustomProviderConfig into the dynamic provider registry */
function registerCustomAsDynamic(cp: CustomProviderConfig) {
  registerDynamicProvider(
    cp.id,
    { baseURL: cp.baseUrl, modelName: cp.models[0] || '', headers: {}, apiMode: cp.apiMode || 'chat-completions' },
    {
      category: 'custom',
      displayName: cp.name,
      models: cp.models.map((m) => ({
        id: m,
        name: m,
        capabilities: ['code', 'writing'] as const,
        // Resolve contextWindow dynamically so each custom model shows
        // its real value (minimax-m3 → 1M, glm-5.2 → 1M, gpt-4o → 128K, etc.)
        // instead of a flat 128K default.
        contextWindow: getModelContextWindow(cp.id, m),
      })),
    },
  )
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      providerType: '' as LLMProviderType,
      modelName: '',
      customBaseUrl: '',
      customProviders: [],
      temperature: 0.7,
      maxTokens: 4096,
      maxIterations: 20,
      enableThinking: false,
      thinkingLevel: 'medium' as ExtendedThinkingLevel,
      enableBatchSpawn: false,
      enableWebMCP: true,
      snapshotHighWatermark: 100,
      snapshotLowWatermark: 50,
      hasApiKey: false,
      hasApiKeyLoaded: false,
      modelOverridesByWorkspace: {},
      lastUsedModelByProvider: {},
      imageGenModel: 'google/gemini-2.5-flash-image',
      imageGenAspectRatio: '1:1',
      pinnedModelsByProvider: {},
      agentLoopNotifications: {
        enabled: true,
        onlyWhenHidden: true,
      },
      _providerRefreshVersion: 0,

      triggerProviderRefresh: () => {
        set((s) => ({ _providerRefreshVersion: s._providerRefreshVersion + 1 }))
      },

      _restoreDynamicProviders: () => {
        const { customProviders } = get()
        for (const cp of customProviders) {
          registerCustomAsDynamic(cp)
        }
      },

      setProviderType: (providerType) => {
        set({ providerType })
      },
      setModelName: (modelName) => {
        const state = get()
        set({
          modelName,
          lastUsedModelByProvider: {
            ...state.lastUsedModelByProvider,
            [state.providerType]: modelName,
          },
        })
      },
      setCustomBaseUrl: (customBaseUrl) => set({ customBaseUrl }),

      createCustomProvider: ({ name, baseUrl, apiMode }) => {
        const trimmedName = name.trim()
        const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
        if (!trimmedName || !trimmedBaseUrl) return false

        const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const now = Date.now()
        const provider: CustomProviderConfig = {
          id,
          name: trimmedName,
          baseUrl: trimmedBaseUrl,
          models: [],
          apiMode: apiMode || 'chat-completions',
          createdAt: now,
          updatedAt: now,
        }

        // Register in dynamic provider registry
        registerCustomAsDynamic(provider)

        set((state) => ({
          customProviders: [provider, ...state.customProviders],
        }))
        return true
      },

      updateCustomProvider: (providerId, patch) => {
        const providers = get().customProviders
        const target = providers.find((provider) => provider.id === providerId)
        if (!target) return false

        const nextName = patch.name?.trim()
        const nextBaseUrl = patch.baseUrl?.trim().replace(/\/+$/, '')

        if (patch.name !== undefined && !nextName) return false
        if (patch.baseUrl !== undefined && !nextBaseUrl) return false

        set((state) => ({
          customProviders: state.customProviders.map((provider) => {
            if (provider.id !== providerId) return provider
            return {
              ...provider,
              name: nextName ?? provider.name,
              baseUrl: nextBaseUrl ?? provider.baseUrl,
              updatedAt: Date.now(),
            }
          }),
        }))

        // Re-register in dynamic registry
        const updated = get().customProviders.find((p) => p.id === providerId)
        if (updated) {
          registerCustomAsDynamic(updated)
        }

        // If currently active, sync state
        if (get().providerType === providerId) {
          const refreshed = get().customProviders.find((p) => p.id === providerId)
          if (refreshed) {
            set({
              customBaseUrl: refreshed.baseUrl,
            })
          }
        }

        return true
      },

      removeCustomProvider: (providerId) => {
        const existing = get().customProviders
        const remaining = existing.filter((provider) => provider.id !== providerId)
        const wasActive = get().providerType === providerId

        // Unregister from dynamic registry
        unregisterDynamicProvider(providerId)

        const updates: Partial<SettingsState> = {
          customProviders: remaining,
        }
        if (wasActive) {
          const fallback = remaining[0]
          if (fallback) {
            updates.providerType = fallback.id as LLMProviderType
            updates.customBaseUrl = fallback.baseUrl
            updates.modelName = fallback.models[0] || ''
          } else {
            // No custom providers left, clear selection
            updates.providerType = '' as LLMProviderType
            updates.customBaseUrl = ''
            updates.modelName = ''
          }
        }
        set(updates as SettingsState)

        apiKeyCache.delete(providerId)
        apiKeyCachePromise.delete(providerId)
      },

      addCustomProviderModel: (providerId, model) => {
        const trimmedModel = model.trim()
        if (!trimmedModel) return false
        const target = get().customProviders.find((provider) => provider.id === providerId)
        if (!target) return false
        if (target.models.includes(trimmedModel)) return true

        set((state) => ({
          customProviders: state.customProviders.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  models: [...provider.models, trimmedModel],
                  updatedAt: Date.now(),
                }
              : provider
          ),
        }))

        // Re-register in dynamic registry
        const updated = get().customProviders.find((p) => p.id === providerId)
        if (updated) {
          registerCustomAsDynamic(updated)
        }
        return true
      },

      removeCustomProviderModel: (providerId, model) => {
        const target = get().customProviders.find((provider) => provider.id === providerId)
        if (!target) return
        const nextModels = target.models.filter((item) => item !== model)
        if (nextModels.length === 0) return

        set((state) => ({
          customProviders: state.customProviders.map((provider) =>
            provider.id === providerId
              ? { ...provider, models: nextModels, updatedAt: Date.now() }
              : provider
          ),
        }))

        // Re-register in dynamic registry
        const updated = get().customProviders.find((p) => p.id === providerId)
        if (updated) {
          registerCustomAsDynamic(updated)
        }

        if (get().providerType === providerId && get().modelName === model) {
          set({ modelName: nextModels[0] })
        }
      },

      setCustomProviderApiMode: (providerId, apiMode) => {
        set((state) => ({
          customProviders: state.customProviders.map((provider) =>
            provider.id === providerId
              ? { ...provider, apiMode, updatedAt: Date.now() }
              : provider
          ),
        }))

        // Re-register in dynamic registry
        const updated = get().customProviders.find((p) => p.id === providerId)
        if (updated) {
          registerCustomAsDynamic(updated)
        }
      },

      setTemperature: (temperature) => set({ temperature }),
      setMaxTokens: (maxTokens) => set({ maxTokens }),
      setMaxIterations: (maxIterations) =>
        set({
          maxIterations:
            maxIterations === 0
              ? 0
              : Math.max(1, Math.min(100, Math.round(maxIterations))),
        }),
      setEnableThinking: (enableThinking) => set({ enableThinking }),
      setThinkingLevel: (thinkingLevel) => set({ thinkingLevel }),
      setImageGenModel: (imageGenModel) => set({ imageGenModel }),
      setImageGenAspectRatio: (imageGenAspectRatio) => set({ imageGenAspectRatio }),
      setEnableBatchSpawn: (enableBatchSpawn) => set({ enableBatchSpawn }),
      setEnableWebMCP: (enableWebMCP) => set({ enableWebMCP }),
      setSnapshotHighWatermark: (snapshotHighWatermark) => {
        const low = get().snapshotLowWatermark
        // Keep a strict gap: repository validation requires low < high.
        const nextHigh = Math.max(1, Math.floor(snapshotHighWatermark), low + 1)
        set({ snapshotHighWatermark: nextHigh })
        // Persist to app_settings so pruneProjectSnapshots sees the new value.
        // Fire-and-forget: SQLite write failure must not block UI updates.
        void persistSnapshotWatermarksToDb(nextHigh, low)
      },
      setSnapshotLowWatermark: (snapshotLowWatermark) => {
        const high = get().snapshotHighWatermark
        // Keep a strict gap while allowing zero retained history.
        const nextLow = Math.min(Math.max(0, Math.floor(snapshotLowWatermark)), high - 1)
        set({ snapshotLowWatermark: nextLow })
        // Persist to app_settings so pruneProjectSnapshots sees the new value.
        // Fire-and-forget: SQLite write failure must not block UI updates.
        void persistSnapshotWatermarksToDb(high, nextLow)
      },
      setHasApiKey: (hasApiKey) => set({ hasApiKey }),
      setAgentLoopNotificationsEnabled: (enabled) => {
        set((s) => ({ agentLoopNotifications: { ...s.agentLoopNotifications, enabled } }))
      },
      setAgentLoopNotificationsOnlyWhenHidden: (onlyWhenHidden) => {
        set((s) => ({
          agentLoopNotifications: { ...s.agentLoopNotifications, onlyWhenHidden },
        }))
      },

      getEffectiveProviderConfig: () => {
        const state = get()
        const config = getProviderConfig(state.providerType)
        if (!config) return null

        // llm-gateway uses a dedicated API key storage key
        const apiKeyProviderKey = state.providerType === 'llm-gateway'
          ? '__llm_gateway_token__'
          : state.providerType

        return {
          apiKeyProviderKey,
          baseUrl: config.baseURL,
          modelName: state.modelName || config.modelName,
        }
      },

      checkHasApiKey: async (options?: { flush?: boolean }) => {
        const state = get()
        const effective = state.getEffectiveProviderConfig()
        if (!effective) {
          // Provider config not available. If the configured provider is a
          // dynamic one that registers asynchronously (e.g. codex-oauth
          // waiting for extension auth, llm-gateway / custom-* still
          // registering), DON'T conclude "no API key" yet — wait for the
          // registration path to call this again. Otherwise the UI would
          // flash a false "setup" state before the registration completes.
          //
          // The `flush: true` escape hatch is for callers that have already
          // attempted registration (e.g. extension.store.checkStatus after
          // determining the extension isn't installed, App.tsx after
          // registerLLMGatewayProvider). They want a definitive answer even
          // if it's "no".
          if (
            isPotentiallyDynamicProviderType(state.providerType) &&
            !options?.flush
          ) {
            return false
          }
          set({ hasApiKey: false, hasApiKeyLoaded: true })
          return false
        }

        // Custom providers can run keyless (Ollama / LM Studio / llama.cpp at
        // localhost). A configured baseUrl is enough to be "usable" — don't
        // gate the UI on a missing API key for them.
        if (
          isCustomProviderType(state.providerType) &&
          effective.baseUrl
        ) {
          apiKeyCache.set(effective.apiKeyProviderKey, true)
          set({ hasApiKey: true, hasApiKeyLoaded: true })
          return true
        }

        const providerKey = effective.apiKeyProviderKey

        // Return cached value if available and not stale.
        // `hasApiKeyLoaded` was set during the initial population that
        // filled the cache, so we don't need to set it again here.
        if (apiKeyCache.has(providerKey)) {
          return apiKeyCache.get(providerKey)!
        }

        // Use promise cache to avoid concurrent queries
        if (apiKeyCachePromise.has(providerKey)) {
          return apiKeyCachePromise.get(providerKey)!
        }

        const promise = (async () => {
          try {
            const { loadApiKey } = await import('@/security/api-key-store')
            const key = await loadApiKey(providerKey)
            const hasKey = !!key
            apiKeyCache.set(providerKey, hasKey)

            // Update the reactive state. Mark loaded in the same set() so
            // subscribers see a consistent (hasApiKey, hasApiKeyLoaded) pair.
            set({ hasApiKey: hasKey, hasApiKeyLoaded: true })

            return hasKey
          } catch (error) {
            console.error('[SettingsStore] Failed to check API key:', error)
            // Even on error, mark as loaded — otherwise the UI would stay
            // in the "loading" state forever.
            set({ hasApiKey: false, hasApiKeyLoaded: true })

            // Schedule a delayed retry — the SQLite worker init race
            // (OPFS lock release, cold-start handshake) often self-resolves
            // within ~1-2s.  Without this retry, a single transient failure
            // would mark the user as "no key" for the entire session, even
            // though their saved key is fine — they would perceive it as
            // data loss.  Only retry if the user hasn't switched providers
            // in the meantime.
            const providerTypeAtError = state.providerType
            setTimeout(() => {
              const currentState = get()
              if (currentState.providerType !== providerTypeAtError) return
              void get().checkHasApiKey()
            }, 2000)

            return false
          } finally {
            apiKeyCachePromise.delete(providerKey)
          }
        })()

        apiKeyCachePromise.set(providerKey, promise)
        return promise
      },

      invalidateApiKeyCache: (provider) => {
        const currentProvider = provider || get().getEffectiveProviderConfig()?.apiKeyProviderKey
        if (!currentProvider) return
        apiKeyCache.delete(currentProvider)
        apiKeyCachePromise.delete(currentProvider)
      },

      saveModelOverrideForWorkspace: (workspaceId) => {
        const state = get()
        set({
          modelOverridesByWorkspace: {
            ...state.modelOverridesByWorkspace,
            [workspaceId]: {
              providerType: state.providerType,
              modelName: state.modelName,
            },
          },
        })
      },

      syncModelForWorkspace: (workspaceId) => {
        if (!workspaceId) return
        const state = get()
        const override = state.modelOverridesByWorkspace[workspaceId]
        if (override) {
          const updates: Partial<SettingsState> = {
            providerType: override.providerType,
            modelName: override.modelName,
          }
          // If it's a custom provider, also set baseUrl
          if (isCustomProviderType(override.providerType)) {
            const cp = state.customProviders.find((p) => p.id === override.providerType)
            if (cp) {
              updates.customBaseUrl = cp.baseUrl
            }
          }
          set(updates as SettingsState)
        }
      },

      switchProviderAndModel: (newProviderType, newModelName) => {
        const state = get()
        const updates: Partial<SettingsState> = {
          providerType: newProviderType,
          modelName: newModelName,
          lastUsedModelByProvider: {
            ...state.lastUsedModelByProvider,
            [newProviderType]: newModelName,
          },
        }
        if (isCustomProviderType(newProviderType)) {
          const cp = state.customProviders.find((p) => p.id === newProviderType)
          if (cp) {
            updates.customBaseUrl = cp.baseUrl
          }
        }
        set(updates as SettingsState)

        // hasApiKey tracks the ACTIVE provider's key — the user just switched
        // it, so re-evaluate. This is what lets a first-time user who saved a
        // key (while providerType was still empty) leave the onboarding
        // select-model step as soon as they pick their default model.
        apiKeyCache.delete(newProviderType)
        apiKeyCachePromise.delete(newProviderType)
        void get().checkHasApiKey()
      },

      getAvailableProviders: async () => {
        const { loadApiKey } = await import('@/security/api-key-store')
        const { PROVIDER_META, getModelsForProvider } = await import('@/agent/providers/types')
        let llmGatewayProviderKey: string | undefined
        try {
          const mod = await import('@/agent/providers/llm-gateway-provider')
          if (mod.isLLMGatewayConfigured()) {
            llmGatewayProviderKey = mod.LLM_GATEWAY_PROVIDER_TYPE
          }
        } catch { /* ignore */ }
        const state = get()
        const results: Array<{
          providerType: LLMProviderType
          displayName: string
          models: Array<{ id: string; name: string }>
          providerKey: string
        }> = []

        // Check built-in providers (parallel loadApiKey for performance)
        const builtInTypes = Object.keys(PROVIDER_META) as LLMProviderType[]
        const builtInKeys = await Promise.all(
          builtInTypes.map(async (type) => ({ type, key: await loadApiKey(type) }))
        )
        for (const { type, key } of builtInKeys) {
          const meta = PROVIDER_META[type]
          const providerType = type
          if (key) {
            // Use pinned models if available, otherwise fallback to all models
            const pinned = state.pinnedModelsByProvider[providerType]
            const allModels = getModelsForProvider(providerType)
            const models = pinned
              ? pinned
                  .map((id) => {
                    const found = allModels.find((m) => m.id === id)
                    return found ? { id: found.id, name: found.name } : { id, name: id }
                  })
              : allModels.map((m) => ({ id: m.id, name: m.name }))

            results.push({
              providerType,
              displayName: localizedProviderDisplayName(providerType, meta.displayName),
              models,
              providerKey: providerType,
            })
          }
        }

        // Check custom providers (parallel)
        const customKeys = await Promise.all(
          state.customProviders.map(async (cp) => ({ cp, key: await loadApiKey(cp.id) }))
        )
        for (const { cp, key } of customKeys) {
          if (key) {
            // Use pinned models if available, otherwise fallback to custom provider models
            const pinned = state.pinnedModelsByProvider[cp.id]
            const models = pinned
              ? pinned.map((id) => ({ id, name: id }))
              : cp.models.map((m) => ({ id: m, name: m }))

            results.push({
              providerType: cp.id,
              displayName: cp.name,
              models,
              providerKey: cp.id,
            })
          }
        }

        // Check dynamically registered providers (parallel)
        const { getDynamicProviderIds, getProviderMeta: getDynamicMeta } = await import('@/agent/providers/types')
        const dynamicIds = getDynamicProviderIds().filter(
          (id) => !results.some((r) => r.providerType === id) && id !== llmGatewayProviderKey
        )
        const dynamicKeys = await Promise.all(
          dynamicIds.map(async (id) => ({ id, key: await loadApiKey(id) }))
        )
        for (const { id, key } of dynamicKeys) {
          if (key) {
            const meta = getDynamicMeta(id)
            const pinned = state.pinnedModelsByProvider[id]
            const allModels = getModelsForProvider(id)
            const models = pinned
              ? pinned.map((pid) => {
                  const found = allModels.find((m) => m.id === pid)
                  return found ? { id: found.id, name: found.name } : { id: pid, name: pid }
                })
              : allModels.map((m) => ({ id: m.id, name: m.name }))

            results.push({
              providerType: id,
              displayName: meta?.displayName || id,
              models,
              providerKey: id,
            })
          }
        }

        // Handle llm-gateway separately (uses different API key storage)
        if (llmGatewayProviderKey) {
          try {
            const gwMod = await import('@/agent/providers/llm-gateway-provider')
            const gwKey = await loadApiKey(gwMod.getLLMGatewayApiKeyProviderKey())
            if (gwKey) {
              const gwMeta = getDynamicMeta(llmGatewayProviderKey)
              const pinned = state.pinnedModelsByProvider[llmGatewayProviderKey]
              const allModels = getModelsForProvider(llmGatewayProviderKey)
              const models = pinned
                ? pinned.map((pid) => {
                    const found = allModels.find((m) => m.id === pid)
                    return found ? { id: found.id, name: found.name } : { id: pid, name: pid }
                  })
                : allModels.map((m) => ({ id: m.id, name: m.name }))
              results.push({
                providerType: llmGatewayProviderKey,
                // Locale-aware provider name (zh: 坚果云 AI / others: Nutstore AI);
                // helper covers the llm-gateway -> settings.gateway.name mapping.
                displayName: localizedProviderDisplayName(llmGatewayProviderKey, gwMeta?.displayName || 'Nutstore AI'),
                models,
                providerKey: llmGatewayProviderKey,
              })
            }
          } catch { /* ignore */ }
        }

        return results
      },

      pinModel: (providerType, modelId) => {
        const state = get()
        const current = state.pinnedModelsByProvider[providerType] || []
        if (current.includes(modelId)) return
        set({
          pinnedModelsByProvider: {
            ...state.pinnedModelsByProvider,
            [providerType]: [...current, modelId],
          },
          _providerRefreshVersion: state._providerRefreshVersion + 1,
        })
      },

      unpinModel: (providerType, modelId) => {
        const state = get()
        const current = state.pinnedModelsByProvider[providerType] || []
        if (!current.includes(modelId)) return
        set({
          pinnedModelsByProvider: {
            ...state.pinnedModelsByProvider,
            [providerType]: current.filter((id) => id !== modelId),
          },
          _providerRefreshVersion: state._providerRefreshVersion + 1,
        })
      },

      setPinnedModels: (providerType, modelIds) => {
        const state = get()
        set({
          pinnedModelsByProvider: {
            ...state.pinnedModelsByProvider,
            [providerType]: modelIds,
          },
          _providerRefreshVersion: state._providerRefreshVersion + 1,
        })
      },
    }),
    {
      name: 'bfosa-settings',
      version: 2,
      // Migrate older persisted states forward. v1 state doesn't have
      // agentLoopNotifications — backfill defaults on load.
      migrate: (persistedState: any, version: number) => {
        if (!persistedState) return persistedState
        if (version < 2) {
          return {
            ...persistedState,
            agentLoopNotifications: {
              enabled: true,
              onlyWhenHidden: true,
            },
          }
        }
        return persistedState
      },
      // Don't persist hasApiKey - it's derived from SQLite
      partialize: (state) => ({
        providerType: state.providerType,
        modelName: state.modelName,
        customBaseUrl: state.customBaseUrl,
        customProviders: state.customProviders,
        temperature: state.temperature,
        maxTokens: state.maxTokens,
        maxIterations: state.maxIterations,
        enableThinking: state.enableThinking,
        thinkingLevel: state.thinkingLevel,
        enableBatchSpawn: state.enableBatchSpawn,
        enableWebMCP: state.enableWebMCP,
        snapshotHighWatermark: state.snapshotHighWatermark,
        snapshotLowWatermark: state.snapshotLowWatermark,
        modelOverridesByWorkspace: state.modelOverridesByWorkspace,
        lastUsedModelByProvider: state.lastUsedModelByProvider,
        imageGenModel: state.imageGenModel,
        imageGenAspectRatio: state.imageGenAspectRatio,
        pinnedModelsByProvider: state.pinnedModelsByProvider,
        agentLoopNotifications: state.agentLoopNotifications,
      }),
      // On rehydration, restore dynamic providers
      onRehydrateStorage: () => (state) => {
        if (state) {
          // Migrate old 'custom' providerType to the new dynamic system
          if ((state.providerType as string) === 'custom') {
            const first = state.customProviders[0]
            if (first) {
              state.providerType = first.id as LLMProviderType
              state.modelName = first.models[0] || ''
              state.customBaseUrl = first.baseUrl
            } else {
              state.providerType = '' as LLMProviderType
              state.modelName = ''
              state.customBaseUrl = ''
            }
          }
          // Migrate old activeCustomProviderId in workspace overrides
          const overrides = state.modelOverridesByWorkspace
          for (const wsId of Object.keys(overrides)) {
            const o = overrides[wsId]
            if ((o.providerType as string) === 'custom' && (o as any).activeCustomProviderId) {
              o.providerType = (o as any).activeCustomProviderId
              delete (o as any).activeCustomProviderId
            }
          }
          // Register all custom providers into dynamic registry
          for (const cp of state.customProviders) {
            registerCustomAsDynamic(cp)
          }
        }
      },
    }
  )
)

/**
 * Hook to get the real-time API key status
 * This ensures the value is always synced with the database
 */
export function useHasApiKey(): boolean {
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const checkHasApiKey = useSettingsStore((s) => s.checkHasApiKey)
  const providerType = useSettingsStore((s) => s.providerType)

  // Check on mount and when provider changes
  // Note: This is intentionally not tracking hasApiKey to avoid loops
  // The component will re-render when hasApiKey changes via setHasApiKey
  useEffect(() => {
    let mounted = true
    checkHasApiKey().then((hasKey) => {
      if (mounted) {
        useSettingsStore.getState().setHasApiKey(hasKey)
      }
    })
    return () => {
      mounted = false
    }
  }, [providerType, checkHasApiKey])

  return hasApiKey
}
