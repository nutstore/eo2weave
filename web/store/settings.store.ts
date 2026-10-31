/**
 * Settings store - manages LLM configuration and user preferences.
 *
 * Important: hasApiKey is NOT persisted because it's derived from SQLite.
 * Always check the actual database value to ensure consistency.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { LLMProviderType } from '@/agent/providers/types'
import {
  isCustomProviderType,
  isPotentiallyDynamicProviderType,
  registerDynamicProvider,
  unregisterDynamicProvider,
  getProviderConfig,
  getDynamicProviderIds,
} from '@/agent/providers/types'
import { getModelContextWindow } from '@/agent/providers/model-store'
import type { ExtendedThinkingLevel } from '@/agent/llm/pi-ai-custom-openai-fetch'
import {
  resolveDefaultModelSelection,
  type AvailableProviderLike,
  type ModelCredentialStatus,
  type ModelSelectionResolution,
} from '@/store/model-selection'
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

/**
 * Shape of persisted overrides from BEFORE the activeCustomProviderId removal.
 * onRehydrateStorage migrates these forward: the legacy field becomes
 * providerType and is deleted from the persisted record.
 */
interface ModelOverrideWithLegacyCustom extends WorkspaceModelOverride {
  activeCustomProviderId?: string
}

interface SettingsState {
  // LLM settings
  providerType: LLMProviderType
  modelName: string
  customBaseUrl: string
  // Persisted custom provider configs — used to re-register on app load
  customProviders: CustomProviderConfig[]
  /**
   * Sampling temperature forwarded into every main-loop LLM request
   * (Settings → Advanced). Note: pi-ai strips temperature from the request
   * on the Anthropic thinking path, which is expected behavior.
   */
  temperature: number
  /**
   * @deprecated UI display only. The effective output cap is determined by the
   * model (pi-ai catalog maxTokens / 64K fallback); this persisted value is no
   * longer consumed by the agent loop. Kept (with its setter removed) so old
   * persisted states rehydrate without migration.
   */
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
  /** Catalog/credential state used to keep model selection and sending distinct. */
  modelCredentialStatus: ModelCredentialStatus
  /**
   * Last credential-state write that FAILED (purge/storage unavailable).
   * `null` when the latest write succeeded. The settings card renders this
   * as a transient "state may be stale — retry" hint instead of trusting
   * `modelCredentialStatus`, which may not reflect the stores.
   */
  modelCredentialStatusError: string | null

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

  /**
   * "Seen" bookkeeping for stale-pinned detection: per provider, the pinned
   * model ids that were CONFIRMED present in an authoritative model list at
   * least once. A pinned id that (a) is in this set but (b) is missing from
   * the current authoritative list is stale (likely delisted upstream).
   * Manually-typed models never enter this set, so they are never flagged.
   * Persisted alongside `pinnedModelsByProvider`.
   */
  pinnedSeenByProvider: Record<string, string[]>

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
  setModelCredentialStatus: (status: ModelCredentialStatus) => void
  setModelCredentialStatusError: (message: string | null) => void
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
  ensureValidModelSelection: (
    providers: ReadonlyArray<AvailableProviderLike>,
    options?: { preserveExpiredCredential?: boolean },
  ) => ModelSelectionResolution

  /**
   * Get all providers that have a saved API key
   */
  getAvailableProviders: () => Promise<Array<{
    providerType: LLMProviderType
    displayName: string
    models: Array<{ id: string; name: string }>
    providerKey: string
    catalogStatus?: 'loading' | 'ready' | 'empty' | 'failed'
    /** Authoritative model ids for this provider (registry / static list),
     *  NOT the pinned-derived display list. Pins missing from here are stale. */
    authoritativeIds: string[]
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
   * Record that the given pinned ids were seen in an authoritative model
   * list (extension `codexGetStatus` response, /models cache, static
   * registry, …). Call after obtaining a trusted list for a provider.
   * Internal bookkeeping — does not bump `_providerRefreshVersion`.
   */
  markPinnedModelsSeen: (providerType: string, modelIds: string[]) => void
  /**
   * Pinned ids for a provider that were seen before but are missing from
   * the given authoritative list → stale (likely delisted upstream).
   */
  getStalePinnedModels: (providerType: string, availableIds: string[]) => string[]
  /**
   * Remove the given ids from a provider's pinned list (and its seen
   * bookkeeping). Returns the ids actually removed.
   */
  removePinnedModels: (providerType: string, modelIds: string[]) => string[]

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

// ── Cross-tab settings sync — module state ──────────────────────────────────
// These MUST be declared BEFORE the persisted store below. Zustand rehydrates
// synchronously from localStorage during create(), so the rehydrate callback
// (setupCrossTabSettingsSync) and the migration write-back (the storage
// wrapper's suppression check) run while this module is still initializing.
// Declared after the store, both hit a TDZ ReferenceError that zustand's
// hydration .catch() swallows silently — the storage listener never registers
// and migrated v<4 state is never written back.
let crossTabSyncInstalled = false
let suppressPersistWrites = 0
// ── Lamport write-order stamp ───────────────────────────────────────────────
// Every persisted snapshot embeds a (revision, writerId) pair. The revision
// is a LAMPORT CLOCK, not a per-tab counter: a tab merges any revision it
// sees (own write or applied peer snapshot) into its clock before bumping,
// so concurrent writers no longer produce incomparable equal counters that
// each tab rejects as "stale" — the classic divergence bug a plain local
// counter has. The writer id breaks the tie two tabs can still hit at the
// same clock value (both bumped from the same merged revision around the
// same time): the HIGHER id owns the slot in EVERY tab, giving a total
// order without any shared coordinator. Unlike StorageEvent.timeStamp —
// which measures when the RECEIVING tab dispatched the event and says
// nothing about which peer wrote first — this pair travels inside the
// payload, so ordering decisions are made from the writers' own stamps.
const TAB_WRITER_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `tab-${crypto.randomUUID()}`
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`
let lastSeenRevision = 0
let lastSeenWriterId = TAB_WRITER_ID

/** Stamp a LOCAL write: merge the clock, then bump under our writer id. */
function recordLocalWrite(): { revision: number; writerId: string } {
  lastSeenRevision += 1
  lastSeenWriterId = TAB_WRITER_ID
  return { revision: lastSeenRevision, writerId: TAB_WRITER_ID }
}

/** True when an incoming snapshot must NOT be applied over what we have. */
function isStaleIncomingSnapshot(incomingRevision: number, incomingWriterId: string | null): boolean {
  if (incomingRevision !== lastSeenRevision) return incomingRevision < lastSeenRevision
  // Clock tie: the higher writer id wins. A legacy peer (older deploy)
  // carries no id — the tiebreak is impossible, so treat it as stale
  // instead of guessing; its next legitimate write re-orders the clock.
  if (incomingWriterId == null) return true
  return incomingWriterId <= lastSeenWriterId
}

/** Merge an APPLIED snapshot into the clock (Lamport receive rule). */
function recordAppliedSnapshot(revision: number, writerId: string | null): void {
  lastSeenRevision = Math.max(lastSeenRevision, revision)
  if (writerId != null) lastSeenWriterId = writerId
}

// ── Three-way merge base (per peer writer, in-memory only) ──────────────────
// Whole-snapshot LWW loses non-conflicting work: two tabs that start from the
// same snapshot and edit DIFFERENT settings concurrently produce snapshots
// where each writer changed only its own field, yet the higher-ordered
// snapshot replaces the entire state and reverts the other tab's edit. For
// every peer writer we remember the last snapshot PROCESSED from it (the
// base) — purely in memory, nothing extra persisted. A newer snapshot from a
// writer we hold a base for is merged field-wise:
//   base     = last processed snapshot from that writer
//   current  = this tab's in-memory state
//   incoming = the arriving snapshot
// A field is taken from incoming only when the PEER changed it relative to
// base; fields the peer did not touch keep the current (possibly locally
// edited) value. A field both sides changed (conflict) resolves to incoming —
// the writer that ordered later wins, the same outcome whole-snapshot LWW
// would give the conflicting field. No base (first snapshot from a writer, or
// a legacy revisionless peer carrying no id) falls back to the previous
// whole-snapshot apply.
const peerBaseSnapshots = new Map<string, Record<string, unknown>>()

/**
 * Merge `incoming` over `current` using `base` (the last snapshot processed
 * from this writer). Returns the merged record; write-order metadata always
 * rides with the incoming snapshot.
 */
function mergeSnapshotOverCurrent(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current }
  // A field present in the base but gone from the incoming snapshot was
  // removed by the peer (the persisted projection is fixed, so this is
  // defensive — it does not occur with today's partialize shape).
  for (const key of Object.keys(base)) {
    if (!isSyncMetadataKey(key)) continue
    if (!(key in incoming)) delete merged[key]
  }
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (!isSyncMetadataKey(key)) {
      merged[key] = incomingValue
      continue
    }
    // Peer did not touch this field relative to base — keep the current
    // (possibly locally edited) value instead of the peer's stale copy.
    if (base[key] === incomingValue) continue
    // Peer changed it, or both sides did (conflict): incoming wins.
    merged[key] = incomingValue
  }
  return merged
}

// StorageEvent.timeStamp watermark for revisionless snapshots only (peers on
// an older deploy). Receiving-tab timing cannot order writes across tabs,
// so this is a weak fallback — but two revisionless snapshots delivered out
// of order must still not let the older one revert the newer.
let lastRevisionlessEventTimestamp = 0

/** Persist schema version — must match the persist config's `version` below. */
const SETTINGS_PERSIST_VERSION = 4

/** True when persist middleware writes to storage are currently suppressed. */
function persistWritesSuppressed(): boolean {
  return suppressPersistWrites > 0
}

export const useSettingsStore = create<SettingsState, [['zustand/persist', unknown]]>(
  persist<SettingsState, [], [], PersistedSettingsState>(
    (set, get) => ({
      providerType: '' as LLMProviderType,
      modelName: '',
      customBaseUrl: '',
      customProviders: [],
      temperature: 0.7,
      maxTokens: 4096,
      maxIterations: 20,
      // First-run defaults (v4): thinking ON at 'high'. Existing installs keep
      // their persisted values — the persist migrate (version < 4) restores
      // whatever was stored, so these defaults only apply to fresh installs.
      enableThinking: true,
      thinkingLevel: 'medium' as ExtendedThinkingLevel,
      enableBatchSpawn: false,
      enableWebMCP: true,
      snapshotHighWatermark: 100,
      snapshotLowWatermark: 50,
      hasApiKey: false,
      hasApiKeyLoaded: false,
      modelCredentialStatus: 'unknown',
      modelCredentialStatusError: null,
      modelOverridesByWorkspace: {},
      lastUsedModelByProvider: {},
      imageGenModel: 'google/gemini-2.5-flash-image',
      imageGenAspectRatio: '1:1',
      pinnedModelsByProvider: {},
      pinnedSeenByProvider: {},
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
      setModelCredentialStatus: (modelCredentialStatus) => set({ modelCredentialStatus }),
      setModelCredentialStatusError: (modelCredentialStatusError) =>
        set({ modelCredentialStatusError }),
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
        // The up-front `++apiKeyCheckEpoch` epoch guard is gone: it let a
        // deduplicated same-provider caller (one that reused the in-flight
        // promise cache) bump the epoch, stale-out the in-flight lookup's
        // write guard, and leave `hasApiKey` unwritten after the promise
        // resolved (#84 review round 3). Every lookup now writes its result
        // when it resolves — but the write is GUARDED by the provider it
        // was started for: a cross-provider switch can leave the previous
        // provider's lookup in flight, and its late result must not
        // overwrite the active provider's status (see the guard inside the
        // promise below). Same-provider deduplicated callers still get
        // their write because the effective key is unchanged when the
        // shared promise resolves.
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
        // STILL sync the reactive state (#84 review round 3): the module-level
        // cache outlives store resets (tests, hot reloads), so a cache-hit
        // caller that skipped the write would leave `hasApiKey` false while
        // lookups answer true — onboarding and sends read the stale state.
        if (apiKeyCache.has(providerKey)) {
          const cached = apiKeyCache.get(providerKey)!
          set({ hasApiKey: cached, hasApiKeyLoaded: true })
          return cached
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

            // Update the reactive state — but ONLY if the provider this
            // lookup was started for is still active. A cross-provider
            // switch can leave this lookup in flight; its late result must
            // not clobber the new provider's status (unlike the removed
            // epoch guard, this never drops a CURRENT provider's write, so
            // deduplicated same-provider lookups still land their result).
            const after = get()
            const afterKey = after.getEffectiveProviderConfig()?.apiKeyProviderKey
            if (afterKey === providerKey) {
              // Mark loaded in the same set() so subscribers see a
              // consistent (hasApiKey, hasApiKeyLoaded) pair.
              set({ hasApiKey: hasKey, hasApiKeyLoaded: true })
            }

            return hasKey
          } catch (error) {
            console.error('[SettingsStore] Failed to check API key:', error)
            // Even on error, mark as loaded — otherwise the UI would stay
            // in the "loading" state forever. Same provider guard as the
            // success path above.
            const after = get()
            const afterKey = after.getEffectiveProviderConfig()?.apiKeyProviderKey
            if (afterKey === providerKey) {
              set({ hasApiKey: false, hasApiKeyLoaded: true })
            }

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
          // The expired/unauthorized credential flag describes the PREVIOUS
          // provider's gateway auth (#84 review): restoring a workspace
          // pinned to a DIFFERENT provider must clear it, or the restored
          // (valid) selection stays marked unusable and the switcher keeps
          // showing a re-login warning. Restoring within the same provider
          // keeps the flag — that model hits the same credential.
          const credentialStillApplies = override.providerType === state.providerType
          if (
            !credentialStillApplies &&
            (state.modelCredentialStatus === 'expired' ||
              state.modelCredentialStatus === 'unauthorized')
          ) {
            updates.modelCredentialStatus = 'unknown' as const
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
        // The expired-credential flag describes the PREVIOUS provider's
        // gateway auth (#84 review): switching to a different provider must
        // clear it, or noUsableModel marks the new valid selection unusable.
        // Switching WITHIN llm-gateway keeps it — the new model hits the
        // same expired credential.
        const credentialStillApplies = newProviderType === state.providerType
        const updates: Partial<SettingsState> = {
          providerType: newProviderType,
          modelName: newModelName,
          ...(credentialStillApplies ||
            (state.modelCredentialStatus !== 'expired' &&
              state.modelCredentialStatus !== 'unauthorized')
            ? {}
            : { modelCredentialStatus: 'unknown' as const }),
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

      ensureValidModelSelection: (providers, options = {}) => {
        const state = get()
        const resolution = resolveDefaultModelSelection(providers, {
          providerType: state.providerType,
          modelName: state.modelName,
        })

        // An expired gateway credential is an auth problem, not a model
        // problem. Keep the user's choice so a successful re-login resumes it.
        if (options.preserveExpiredCredential && state.modelCredentialStatus === 'expired') {
          return {
            action: 'keep',
            providerType: state.providerType,
            modelName: state.modelName,
            reason: 'current-valid',
          }
        }

        if (resolution.action !== 'switch') return resolution
        const current = get()
        set({
          providerType: resolution.providerType as LLMProviderType,
          modelName: resolution.modelName,
          lastUsedModelByProvider: {
            ...current.lastUsedModelByProvider,
            [resolution.providerType as LLMProviderType]: resolution.modelName,
          },
          ...(isCustomProviderType(resolution.providerType)
            ? {
                customBaseUrl: current.customProviders.find((provider) => provider.id === resolution.providerType)?.baseUrl ?? current.customBaseUrl,
              }
            : {}),
        })
        return resolution
      },

      getAvailableProviders: async () => {
        const { loadApiKey } = await import('@/security/api-key-store')
        const { PROVIDER_META, getModelsForProvider } = await import('@/agent/providers/types')
        const { getCachedModels } = await import('@/agent/providers/model-store')
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
          authoritativeIds: string[]
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
            const models = pinned && pinned.length > 0
              ? pinned
                  .map((id) => {
                    const found = allModels.find((m) => m.id === id)
                    return found ? { id: found.id, name: found.name } : { id, name: id }
                  })
              : allModels.map((m) => ({ id: m.id, name: m.name }))

            // Authoritative list = static registry + dynamic /models cache,
            // merged the same way ProviderManager's allModels does. A
            // static-only list here wrongly flags pins for models the
            // provider added after this app build was released (e.g.
            // glm-5.3-flash): the settings page sees them via the /models
            // cache while this path flags them as delisted.
            // Try both cache keys because useDynamicModels stores under
            // (providerType, providerKey) and providerKey === providerType
            // for built-in providers.
            const dynamic = [
              ...(getCachedModels(providerType, providerType) ?? []),
              ...(getCachedModels(providerType) ?? []),
            ]
            const staticIds = new Set(allModels.map((m) => m.id.toLowerCase()))
            const authoritativeIds = [
              ...allModels.map((m) => m.id),
              ...dynamic
                .map((m) => m.id)
                .filter((id) => !staticIds.has(id.toLowerCase())),
            ]

            // Merged list is authoritative for seen bookkeeping (a pinned id
            // that's absent from static + dynamic lists is effectively delisted).
            get().markPinnedModelsSeen(providerType, authoritativeIds)

            results.push({
              providerType,
              displayName: localizedProviderDisplayName(providerType, meta.displayName),
              models,
              providerKey: providerType,
              authoritativeIds,
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
            const models = pinned && pinned.length > 0
              ? pinned.map((id) => ({ id, name: id }))
              : cp.models.map((m) => ({ id: m, name: m }))

            results.push({
              providerType: cp.id,
              displayName: cp.name,
              models,
              providerKey: cp.id,
              authoritativeIds: cp.models,
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
            const models = pinned && pinned.length > 0
              ? pinned.map((pid) => {
                  const found = allModels.find((m) => m.id === pid)
                  return found ? { id: found.id, name: found.name } : { id: pid, name: pid }
                })
              : allModels.map((m) => ({ id: m.id, name: m.name }))

            // Dynamic registry list is authoritative (e.g. codex-oauth models
            // registered from the extension response).
            get().markPinnedModelsSeen(id, allModels.map((m) => m.id))

            results.push({
              providerType: id,
              displayName: meta?.displayName || id,
              models,
              providerKey: id,
              authoritativeIds: allModels.map((m) => m.id),
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
              const models = pinned && pinned.length > 0
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
                authoritativeIds: allModels.map((m) => m.id),
              })
            }
          } catch { /* ignore */ }
        }

        // Auto-remove stale pins (pinned + previously confirmed available +
        // absent from the authoritative list → delisted upstream). Runs on
        // every provider-list load and is idempotent. Guards:
        // - An EMPTY authoritativeIds (registry not loaded yet / gateway
        //   before login) is not authoritative — skip, never wipe pins.
        // - Keep the currently selected model even if stale: the user is on
        //   it, and the topbar already flags it (currentModelDelistedTooltip).
        const current = get()
        for (const r of results) {
          if (r.authoritativeIds.length === 0) continue
          const staleIds = current.getStalePinnedModels(r.providerType, r.authoritativeIds)
          if (staleIds.length === 0) continue
          const keep = r.providerType === current.providerType ? new Set([current.modelName]) : new Set<string>()
          const toRemove = staleIds.filter((id) => !keep.has(id))
          if (toRemove.length === 0) continue
          get().removePinnedModels(r.providerType, toRemove)
          console.info(
            `[settings] auto-removed delisted pinned models (${r.providerType}): ${toRemove.join(', ')}`,
          )
          // Hide them from this response too, so the UI never renders a pin
          // that was just auto-removed (no flash between refreshes).
          r.models = r.models.filter((m) => !toRemove.includes(m.id))
        }

        // Reconcile only after every provider source has been collected. This
        // prevents an early provider from winning while a later provider is
        // still being restored.
        const reconciliationProviders: AvailableProviderLike[] = results.map((result) => ({
          providerType: result.providerType,
          models: result.models,
          authoritativeIds: result.authoritativeIds,
          catalogStatus: result.authoritativeIds.length > 0 || result.models.length > 0 ? 'ready' : 'empty',
        }))
        get().ensureValidModelSelection(reconciliationProviders, {
          preserveExpiredCredential: get().modelCredentialStatus === 'expired',
        })

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

      markPinnedModelsSeen: (providerType, modelIds) => {
        const state = get()
        const pinned = state.pinnedModelsByProvider[providerType]
        if (!pinned || pinned.length === 0) return
        const seen = new Set(state.pinnedSeenByProvider[providerType] || [])
        let changed = false
        for (const id of modelIds) {
          // Only track ids that are actually pinned — the seen set exists to
          // answer "was this pin ever confirmed available?".
          if (pinned.includes(id) && !seen.has(id)) {
            seen.add(id)
            changed = true
          }
        }
        if (!changed) return
        // Prune seen entries whose pins were already removed by the user, so
        // the bookkeeping doesn't grow unbounded. Internal only — no refresh bump.
        const prunedSeen = [...seen].filter((id) => pinned.includes(id))
        set({
          pinnedSeenByProvider: {
            ...state.pinnedSeenByProvider,
            [providerType]: prunedSeen,
          },
        })
      },

      getStalePinnedModels: (providerType, availableIds) => {
        const state = get()
        const pinned = state.pinnedModelsByProvider[providerType] || []
        const seen = new Set(state.pinnedSeenByProvider[providerType] || [])
        const available = new Set(availableIds)
        return pinned.filter((id) => seen.has(id) && !available.has(id))
      },

      removePinnedModels: (providerType, modelIds) => {
        const state = get()
        const ids = new Set(modelIds)
        const current = state.pinnedModelsByProvider[providerType] || []
        const kept = current.filter((id) => !ids.has(id))
        if (kept.length === current.length) return []
        const seen = state.pinnedSeenByProvider[providerType] || []
        set({
          pinnedModelsByProvider: {
            ...state.pinnedModelsByProvider,
            [providerType]: kept,
          },
          pinnedSeenByProvider: {
            ...state.pinnedSeenByProvider,
            [providerType]: seen.filter((id) => !ids.has(id)),
          },
          _providerRefreshVersion: state._providerRefreshVersion + 1,
        })
        return current.filter((id) => ids.has(id))
      },
    }),
    {
      name: 'bfosa-settings',
      version: SETTINGS_PERSIST_VERSION,
      // The cross-tab storage handler applies incoming snapshots with
      // setState while persist writes are suppressed: the snapshot is
      // already IN storage (the storage event just delivered it), so the
      // middleware write would only echo it back — and in a two-writer race
      // that echo can land an older queued snapshot over a newer one.
      // While suppression is active, setItem is a no-op; read paths and the
      // in-memory state are untouched.
      storage: (() => {
        // Server-side import safety: without `window` the getter would return
        // undefined and createJSONStorage would wrap it anyway (it only
        // returns undefined if the getter THROWS). persist would then call
        // getItem on undefined during hydration and crash module init.
        // Returning an empty in-memory Storage keeps the import harmless in
        // non-browser environments; the app itself is client-only.
        if (typeof window === 'undefined') {
          const emptyStorage: Storage = {
            length: 0,
            clear: () => undefined,
            getItem: () => null,
            key: () => null,
            removeItem: () => undefined,
            setItem: () => undefined,
          }
          return createJSONStorage<PersistedSettingsState>(() => emptyStorage)
        }
        const base = createJSONStorage<PersistedSettingsState>(() => window.localStorage)
        if (!base) return base
        return {
          ...base,
          setItem: (name, value) => {
            if (persistWritesSuppressed()) return
            // Embed the Lamport write-order stamp IN the payload before
            // the write lands. Peers (and this tab's own storage handler)
            // order snapshots by this (revision, writerId) pair instead of
            // StorageEvent.timeStamp, which reflects receiving-tab timing
            // and cannot order writes from two different tabs.
            try {
              const raw = typeof value === 'string' ? value : JSON.stringify(value)
              const parsed = JSON.parse(raw) as { state?: Record<string, unknown> } | null
              if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
                const stamp = recordLocalWrite()
                parsed.state.__settingsWriteRevision = stamp.revision
                parsed.state.__settingsWriterId = stamp.writerId
                window.localStorage.setItem(name, JSON.stringify(parsed))
                return
              }
            } catch {
              // Never block a persist write because the envelope shape was
              // unexpected — the cross-tab handler tolerates missing revisions.
            }
            return base.setItem(name, value)
          },
        }
      })(),
      // Migrate older persisted states forward. v1 state doesn't have
      // agentLoopNotifications — backfill defaults on load.
      // v3 drops enableSchedules: schedules became a first-class feature
      // (always on), so the legacy opt-out flag is stripped from storage.
      // v4 flips the first-run default of enableThinking/thinkingLevel to
      // true/'high'. Any state that reached the migrate path already existed
      // in storage, so the persisted enableThinking (even explicit false) is
      // kept verbatim — only fresh installs (no stored state) get the new
      // defaults.
      migrate: (persistedState: unknown, version: number): PersistedSettingsState => {
        if (!persistedState || typeof persistedState !== 'object') {
          return {} as PersistedSettingsState
        }
        let next = persistedState as Record<string, unknown>
        if (version < 2) {
          next = {
            ...next,
            agentLoopNotifications: {
              enabled: true,
              onlyWhenHidden: true,
            },
          }
        }
        if (version < 3) {
          delete next.enableSchedules
        }
        return next as unknown as PersistedSettingsState
      },
      // Don't persist hasApiKey - it's derived from SQLite
      partialize: (state): PersistedSettingsState => ({
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
        pinnedSeenByProvider: state.pinnedSeenByProvider,
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
            const o = overrides[wsId] as ModelOverrideWithLegacyCustom
            if ((o.providerType as string) === 'custom' && o.activeCustomProviderId) {
              o.providerType = o.activeCustomProviderId
              delete o.activeCustomProviderId
            }
          }
          // Register all custom providers into dynamic registry
          for (const cp of state.customProviders) {
            registerCustomAsDynamic(cp)
          }
          setupCrossTabSettingsSync()
        }
      },
    }
  )
)

// ── Cross-tab settings sync ─────────────────────────────────────────────────
// Without this, a STALE tab persists its full settings snapshot over another
// tab's newer write: two tabs open, tab A turns thinking off, tab B (still
// holding enableThinking:true in memory) later changes any other setting —
// its persist write silently reverts A's enableThinking:false. The storage
// event (fires in every tab EXCEPT the writer) rehydrates the changed keys
// from the freshly-written snapshot before this tab's own next write, so
// each tab's subsequent persist carries the other tab's newer values.
//
// Two hazards this handler must avoid:
//
// 1. Re-persisting the incoming snapshot. useSettingsStore.setState() is
//    wrapped by the persist middleware — every call re-writes the whole
//    snapshot to localStorage. Applying an incoming snapshot through it
//    would echo it back to storage, and when two tabs write in quick
//    succession the receiving tab can re-persist an OLDER queued snapshot
//    over a newer one, reverting the newer write. Incoming snapshots are
//    therefore applied with persist writes suppressed (the store's storage
//    wrapper is a no-op while suppressed) — the state lands in memory only;
//    storage already holds exactly what we just read.
//
// 2. Out-of-order application. Two writers can fire two storage events in
//    this tab in an order where we must never let the older snapshot
//    replace the newer one; every persisted write embeds a Lamport
//    (revision, writerId) stamp IN the payload and a snapshot that is not
//    newer under that total order is dropped (StorageEvent.timeStamp
//    reflects receiving-tab timing and cannot order peer writes; a plain
//    per-tab counter cannot order CONCURRENT writers — the clock merge +
//    id tiebreak can). A snapshot whose values already match the in-memory
//    state is skipped entirely — that also keeps identical re-broadcasts
//    from churning the provider registry.
//
// If the incoming snapshot changes customProviders, the dynamic provider
// registry is re-synced here (register new/updated entries, unregister
// removed ones) — the same registerCustomAsDynamic path the local edit
// actions use — otherwise a provider added in another tab stays unusable
// in this one.

/**
 * Shape written to localStorage: the partialize() projection of
 * SettingsState (hasApiKey & other runtime-only fields are excluded).
 * Kept in sync with the partialize() body below.
 */
interface PersistedSettingsState {
  providerType: LLMProviderType
  modelName: string
  customBaseUrl: string
  customProviders: CustomProviderConfig[]
  temperature: number
  maxTokens: number
  maxIterations: number
  enableThinking: boolean
  thinkingLevel: ExtendedThinkingLevel
  enableBatchSpawn: boolean
  enableWebMCP: boolean
  snapshotHighWatermark: number
  snapshotLowWatermark: number
  modelOverridesByWorkspace: Record<string, WorkspaceModelOverride>
  lastUsedModelByProvider: Partial<Record<LLMProviderType, string>>
  imageGenModel: string
  imageGenAspectRatio: string
  pinnedModelsByProvider: Record<string, string[]>
  pinnedSeenByProvider: Record<string, string[]>
  agentLoopNotifications: { enabled: boolean; onlyWhenHidden: boolean }
}

function shallowEqualRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a).filter(isSyncMetadataKey)
  const bKeys = Object.keys(b).filter(isSyncMetadataKey)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false
  }
  return true
}

/** Internal write-order metadata — never user settings, never compared as such. */
function isSyncMetadataKey(key: string): boolean {
  return key !== '__settingsWriteRevision' && key !== '__settingsWriterId'
}

/**
 * Sync the dynamic provider registry with an incoming customProviders list:
 * register (or re-register) every provider present in the snapshot and
 * unregister ones that disappeared. Uses the same registration path as the
 * local add/update/remove actions.
 */
function syncDynamicRegistryWithSnapshot(incoming: CustomProviderConfig[]): void {
  const incomingIds = new Set(incoming.map((cp) => cp.id))
  for (const cp of incoming) {
    registerCustomAsDynamic(cp)
  }
  for (const id of getDynamicProviderIds()) {
    if (!incomingIds.has(id)) {
      unregisterDynamicProvider(id)
    }
  }
}

/**
 * Re-serialize the current in-memory state over whatever is in shared
 * localStorage. Used when an incoming storage event must NOT be applied
 * (old-schema peer write) but has already REPLACED the shared snapshot with
 * stale values: without the repair, a reload rehydrates the stale snapshot
 * and older settings silently come back ("newer settings disappear after
 * reload"). The write goes through the persist wrapper's revision stamping
 * so the repaired snapshot wins the write-order race against the stale
 * peer tab's next queued write too.
 */
function restoreCurrentSnapshotToStorage(): void {
  try {
    const current = useSettingsStore.getState() as unknown as Record<string, unknown>
    const snapshot: Record<string, unknown> = {}
    const persistedShape: PersistedSettingsState = {
      providerType: current.providerType as PersistedSettingsState['providerType'],
      modelName: current.modelName as string,
      customBaseUrl: current.customBaseUrl as string,
      customProviders: current.customProviders as CustomProviderConfig[],
      temperature: current.temperature as number,
      maxTokens: current.maxTokens as number,
      maxIterations: current.maxIterations as number,
      enableThinking: current.enableThinking as boolean,
      thinkingLevel: current.thinkingLevel as PersistedSettingsState['thinkingLevel'],
      enableBatchSpawn: current.enableBatchSpawn as boolean,
      enableWebMCP: current.enableWebMCP as boolean,
      snapshotHighWatermark: current.snapshotHighWatermark as number,
      snapshotLowWatermark: current.snapshotLowWatermark as number,
      modelOverridesByWorkspace: current.modelOverridesByWorkspace as PersistedSettingsState['modelOverridesByWorkspace'],
      lastUsedModelByProvider: current.lastUsedModelByProvider as PersistedSettingsState['lastUsedModelByProvider'],
      imageGenModel: current.imageGenModel as string,
      imageGenAspectRatio: current.imageGenAspectRatio as string,
      pinnedModelsByProvider: current.pinnedModelsByProvider as PersistedSettingsState['pinnedModelsByProvider'],
      pinnedSeenByProvider: current.pinnedSeenByProvider as PersistedSettingsState['pinnedSeenByProvider'],
      agentLoopNotifications: current.agentLoopNotifications as PersistedSettingsState['agentLoopNotifications'],
    }
    Object.assign(snapshot, persistedShape)
    // Route through the same storage wrapper the persist middleware uses so
    // the write is suppressed during apply windows and stamped with the
    // Lamport write-order stamp like every other write.
    if (typeof window !== 'undefined' && !persistWritesSuppressed()) {
      const stamp = recordLocalWrite()
      window.localStorage.setItem(
        'bfosa-settings',
        JSON.stringify({
          state: { ...snapshot, __settingsWriteRevision: stamp.revision, __settingsWriterId: stamp.writerId },
          version: SETTINGS_PERSIST_VERSION,
        }),
      )
    }
  } catch {
    // Best-effort repair; the next legitimate write re-persists anyway.
  }
}

function setupCrossTabSettingsSync(): void {
  if (crossTabSyncInstalled || typeof window === 'undefined') return
  crossTabSyncInstalled = true
  window.addEventListener('storage', (e) => {
    if (e.key !== 'bfosa-settings' || e.newValue == null) return
    // Parse ONCE — the schema-version guard, revision guard, and apply path
    // all read the same envelope.
    let parsed: { state?: Record<string, unknown>; version?: unknown } | null = null
    try {
      parsed = JSON.parse(e.newValue) as { state?: Record<string, unknown>; version?: unknown } | null
    } catch {
      // Malformed snapshot from an older version mid-migration — ignore; the
      // next legitimate write re-triggers this handler.
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    // Schema-version guard: an OLD tab (persist version < ours) holds a
    // pre-upgrade shape. Letting its snapshot overwrite our v4 state would
    // revert newer settings (including the thinking choice). Worse, the
    // v3 write has REPLACED the shared snapshot in localStorage with stale
    // values — a reload here would migrate those stale values back in and
    // silently resurrect old settings. So alongside skipping the event we
    // REPAIR storage: re-serialize our current (newer) state over the stale
    // snapshot the old tab just wrote.
    if (
      typeof parsed.version === 'number' &&
      parsed.version < SETTINGS_PERSIST_VERSION
    ) {
      restoreCurrentSnapshotToStorage()
      return
    }
    if (!parsed.state || typeof parsed.state !== 'object') return

    // Write-order guard: the (revision, writerId) Lamport stamp is embedded
    // in the payload by the WRITING tab's storage wrapper, so it orders peer
    // writes correctly even when StorageEvent delivery order/timing differs
    // per tab. The revision is a merged clock (not a per-tab counter), so
    // concurrent writers converge on a comparable order; the writer id
    // breaks clock ties. A snapshot that is not NEWER under that total
    // order is a queued arrival carrying pre-write state — drop it.
    const incomingRevision =
      typeof parsed.state.__settingsWriteRevision === 'number'
        ? (parsed.state.__settingsWriteRevision as number)
        : null
    const incomingWriterId =
      typeof parsed.state.__settingsWriterId === 'string'
        ? (parsed.state.__settingsWriterId as string)
        : null
    if (incomingRevision != null) {
      if (isStaleIncomingSnapshot(incomingRevision, incomingWriterId)) return
    }
    // Snapshot WITHOUT a revision (peer on an older deploy): fall back to
    // the legacy event-timeStamp ordering — weak, but better than nothing,
    // and a revisionless snapshot must not silently bypass the guard. The
    // watermark only defends against OTHER revisionless events: a revisioned
    // snapshot always applies (its revision scheme is incomparable with the
    // timestamp fallback and its embedded ordering is authoritative), while
    // two revisionless snapshots are ordered against each other so a late
    // delivery of the older one cannot revert the newer.
    if (incomingRevision == null) {
      if (e.timeStamp <= lastRevisionlessEventTimestamp) return
      lastRevisionlessEventTimestamp = e.timeStamp
    }

    // Lamport receive rule: merge the applied snapshot into the clock so
    // our NEXT local write orders after this peer write (the revision is
    // a merged clock, not a per-tab counter — that merge is what keeps
    // concurrent writers comparable). The applied writer id rides along
    // so a clock tie on the next concurrent write still resolves via the
    // higher-id-wins tiebreak instead of diverging.
    if (incomingRevision != null) {
      recordAppliedSnapshot(incomingRevision, incomingWriterId)
    }
    try {
      const incoming = parsed.state
      const current = useSettingsStore.getState() as unknown as Record<string, unknown>
      // Three-way merge: when we hold a base (the last snapshot this peer
      // writer produced), apply only the fields the peer changed relative to
      // that base — a whole-snapshot replace here would revert this tab's
      // concurrent edits to fields the peer did not touch. Without a base
      // (first snapshot from this writer, or a legacy revisionless peer)
      // fall back to the whole-snapshot apply, zustand persist's standard
      // semantics.
      let applied: Record<string, unknown> = incoming
      if (incomingWriterId != null && incomingWriterId !== TAB_WRITER_ID) {
        const base = peerBaseSnapshots.get(incomingWriterId)
        if (base) {
          applied = mergeSnapshotOverCurrent(base, incoming, current)
        }
      }
      // No-op guard: the (possibly merged) snapshot changes nothing —
      // skipping avoids a pointless re-render plus provider-registry churn.
      if (shallowEqualRecord(applied, current)) {
        return
      }
      // Re-read the persisted snapshot into memory. This mirrors zustand's
      // own rehydrate(): merge the persisted partial over current state.
      //
      // setState is wrapped by persist — suppress its storage write so the
      // snapshot is applied WITHOUT re-persisting it (storage already holds
      // exactly this snapshot; echoing it back is how an older queued
      // event could overwrite a newer write).
      const credentialsBefore = {
        providerType: useSettingsStore.getState().providerType,
        modelName: useSettingsStore.getState().modelName,
      }
      suppressPersistWrites++
      try {
        useSettingsStore.setState(applied as Partial<SettingsState>)
      } finally {
        suppressPersistWrites--
      }
      // This snapshot is now the merge base for this writer: the next one
      // diffs against what we processed here (the raw incoming snapshot, NOT
      // the merged result — this tab's own edits must not be attributed to
      // the peer).
      if (incomingWriterId != null && incomingWriterId !== TAB_WRITER_ID) {
        peerBaseSnapshots.set(incomingWriterId, { ...incoming })
      }
      // Keep the dynamic provider registry in step with the incoming
      // snapshot so cross-tab custom-provider edits are usable here.
      // Keep the dynamic provider registry in step with the APPLIED snapshot
      // (a merge may have dropped peer provider fields this writer never
      // touched) so cross-tab custom-provider edits are usable here.
      if (Array.isArray(applied.customProviders)) {
        syncDynamicRegistryWithSnapshot(applied.customProviders as CustomProviderConfig[])
      }
      // Runtime-only credential state is NOT part of the persisted snapshot,
      // so applying a peer's provider/model switch leaves this tab holding
      // the PREVIOUS provider's hasApiKey and modelCredentialStatus —
      // sendMessage then rejects sends against the now-active provider
      // (or sends with a stale key assumption). Re-evaluate when the APPLIED
      // snapshot switched provider or model (a merge can filter a peer's
      // untouched provider copy out — only a real switch counts), mirroring
      // what switchProviderAndModel does for a local switch.
      if (
        applied.providerType !== credentialsBefore.providerType ||
        applied.modelName !== credentialsBefore.modelName
      ) {
        const next = useSettingsStore.getState()
        // Invalidate by the EFFECTIVE credential key, not providerType:
        // getEffectiveProviderConfig derives `__llm_gateway_token__` for
        // llm-gateway, so deleting under the providerType would leave the
        // gateway's cached lookup in place and checkHasApiKey would reuse
        // the stale result.
        const effectiveKey = next.getEffectiveProviderConfig()?.apiKeyProviderKey ?? next.providerType
        apiKeyCache.delete(effectiveKey)
        apiKeyCachePromise.delete(effectiveKey)
        // The credential flag describes the PREVIOUS provider's auth; a
        // cross-provider switch must clear it (same rule as
        // switchProviderAndModel) or noUsableModel keeps marking the new,
        // valid selection unusable. This reset must land INSIDE the
        // suppression window: setState is wrapped by persist, and a write
        // outside the block would re-persist the whole (just-applied,
        // possibly already-superseded) snapshot over a newer peer write.
        suppressPersistWrites++
        try {
          if (applied.providerType !== credentialsBefore.providerType) {
            useSettingsStore.setState({ modelCredentialStatus: 'unknown' })
          }
        } finally {
          suppressPersistWrites--
        }
        void next.checkHasApiKey()
      }
    } catch {
      // Malformed state payload — ignore; the next legitimate write
      // re-triggers this handler.
    }
  })
}

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
