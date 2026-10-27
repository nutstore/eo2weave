/**
 * Dynamic Model Store
 *
 * Caches dynamically fetched model lists with persistence.
 * - Memory cache (Map) for fast access during a session
 * - localStorage for cross-session persistence (no expiry — always usable)
 * - Cache is only invalidated when API key changes
 *
 * Strategy: stale-while-revalidate
 *   Always show cached data immediately, silently refresh in background.
 */

import type { LLMProviderType, ModelInfo } from './types'
import { getModelsForProvider } from './types'
import type { FetchModelsResult } from './model-fetcher'
import { getOpenRouterContextWindow } from './openrouter-pricing'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CachedModels {
  models: ModelInfo[]
  source: 'dynamic' | 'static'
  fetchedAt: number
  error?: string
}

// ─── Config ────────────────────────────────────────────────────────────

/** localStorage key prefix */
const STORAGE_PREFIX = 'cw-models:'

/**
 * Cache freshness window. Stale entries are still served immediately
 * (stale-while-revalidate) so the UI never blocks, but callers can detect
 * staleness via `isCacheStale()` / `getCachedModelsResult()` and re-fetch
 * in the background.
 */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

// ─── Cache storage ───────────────────────────────────────────────────────────

const memoryCache = new Map<string, CachedModels>()

/**
 * Test-only escape hatch: `setCachedModels` seeds BOTH this memory cache and
 * localStorage, so a test fixture that only removes the localStorage key still
 * leaks the memory entry into later tests in the same module environment.
 */
export function __clearMemoryCacheForTests(providerType: string): void {
  for (const key of [...memoryCache.keys()]) {
    if (key === providerType || key.startsWith(`${providerType}:`)) memoryCache.delete(key)
  }
}

function getCacheKey(
  providerType: LLMProviderType,
  providerKey?: string
): string {
  return providerKey ? `${providerType}:${providerKey}` : providerType
}

function getStorageKey(cacheKey: string): string {
  return `${STORAGE_PREFIX}${cacheKey}`
}

// ─── localStorage helpers ────────────────────────────────────────────────────

function readFromDisk(cacheKey: string): CachedModels | null {
  try {
    const raw = localStorage.getItem(getStorageKey(cacheKey))
    if (!raw) return null
    return JSON.parse(raw) as CachedModels
  } catch {
    return null
  }
}

function writeToDisk(cacheKey: string, data: CachedModels): void {
  try {
    localStorage.setItem(getStorageKey(cacheKey), JSON.stringify(data))
  } catch {
    // localStorage full or unavailable — silently degrade to memory-only
  }
}

// ─── Change Listeners ───────────────────────────────────────────────────────

/** Listeners called when the model cache is updated */
const listeners = new Set<() => void>()

/** Register a listener to be called when models are updated */
export function onModelsUpdated(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Notify all registered listeners */
function notifyModelsUpdated(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.error('[model-store] Listener error:', err)
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get cached models for a provider.
 * Checks memory first, then localStorage. Never expires by time.
 */
export function getCachedModels(
  providerType: LLMProviderType,
  providerKey?: string
): ModelInfo[] | null {
  const key = getCacheKey(providerType, providerKey)

  // 1. Memory (fast)
  const mem = memoryCache.get(key)
  if (mem) return mem.models

  // 2. localStorage (persistent)
  const disk = readFromDisk(key)
  if (disk) {
    // Promote to memory
    memoryCache.set(key, disk)
    return disk.models
  }

  return null
}

/**
 * Get full cached result including metadata (source, fetchedAt, error).
 */
export function getCachedModelsResult(
  providerType: LLMProviderType,
  providerKey?: string
): CachedModels | null {
  const key = getCacheKey(providerType, providerKey)

  const mem = memoryCache.get(key)
  if (mem) return mem

  const disk = readFromDisk(key)
  if (disk) {
    memoryCache.set(key, disk)
    return disk
  }

  return null
}

/**
 * Whether a cached entry is older than MODELS_CACHE_TTL_MS.
 * Missing entry counts as stale (nothing cached = needs fetch).
 */
export function isCacheStale(providerType: LLMProviderType, providerKey?: string): boolean {
  const entry = getCachedModelsResult(providerType, providerKey)
  if (!entry) return true
  return Date.now() - entry.fetchedAt > MODELS_CACHE_TTL_MS
}

/**
 * Store fetched models in both memory and localStorage.
 * Only persists dynamic (API-fetched) results.
 */
export function setCachedModels(
  providerType: LLMProviderType,
  result: FetchModelsResult,
  providerKey?: string
): void {
  if (result.source !== 'dynamic') return

  const key = getCacheKey(providerType, providerKey)
  const entry: CachedModels = {
    models: result.models,
    source: result.source,
    fetchedAt: result.fetchedAt,
    error: result.error,
  }

  memoryCache.set(key, entry)
  writeToDisk(key, entry)

  // Notify listeners that models have been updated
  // (e.g. image gen tool may need to register/unregister)
  notifyModelsUpdated()
}

/**
 * Merge the static skeleton catalog with dynamic /models results for one
 * provider, applying the channel-aware precedence rules:
 *
 * - Rich API data (any entry with `metadataFromApi`) is authoritative: the
 *   API list IS the catalog. Skeleton ids it does not list are dropped
 *   (renamed/removed provider-side); listed ids are merged — API metadata
 *   wins, static capability tags are unioned in since `input_modalities`
 *   only covers vision.
 * - Without authoritative data, the skeleton fills gaps and dynamic entries
 *   are appended (previous behavior).
 *
 * Pure function; extracted from ProviderManager so the precedence rules are
 * unit-testable without rendering the settings UI.
 */
export function mergeModelLists(
  providerType: LLMProviderType,
  dynamicModels: ModelInfo[],
  options: { isCustom: boolean; customModelIds?: string[] }
): ModelInfo[] {
  const seen = new Set<string>()
  const result: ModelInfo[] = []

  if (options.isCustom) {
    // Start with configured model IDs (bare bones — no contextWindow info)
    for (const id of options.customModelIds ?? []) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push({
          id,
          name: id,
          capabilities: ['code'] as const,
          contextWindow: getModelContextWindow(providerType, id),
        })
      }
    }

    // Overlay dynamic models on top — they carry API-provided context_length
    // from the fetch. Enrich with API data but keep the registry contextWindow
    // as a floor when the API response omitted context_window.
    for (const dm of dynamicModels) {
      const existingIdx = result.findIndex((m) => m.id === dm.id)
      if (existingIdx >= 0) {
        const registered = result[existingIdx]
        result[existingIdx] = dm.contextWindow != null ? dm : { ...dm, contextWindow: registered.contextWindow }
      } else if (!seen.has(dm.id)) {
        seen.add(dm.id)
        result.push(dm)
      }
    }

    return result
  }

  // Dynamic models (from /models API) FIRST — they carry authoritative
  // provider metadata (name, context_window, input_modalities/vision).
  for (const m of dynamicModels) {
    if (!seen.has(m.id)) {
      seen.add(m.id)
      result.push(m)
    }
  }

  // Static skeleton second: only fills gaps when there is NO authoritative
  // API data. When the dynamic list carries provider metadata
  // (metadataFromApi), the API list IS the model catalog: skeleton ids the
  // API does not list are dropped (renamed/removed provider-side), and
  // listed ids are merged — API metadata wins, static capability tags are
  // unioned in since input_modalities only covers vision.
  //
  // Product note: this treats a filtered /models response (one-api/new-api
  // gateways expose a key-scoped subset) as authoritative too. Accepted:
  // showing a stale "supported" model is worse than hiding a still-working
  // one, and the user can re-add any hidden id via "add model".
  const apiListed = dynamicModels.some((m) => m.metadataFromApi)
    ? new Set(dynamicModels.map((m) => m.id))
    : null
  const staticModels = getModelsForProvider(providerType)
  for (const m of staticModels) {
    if (apiListed && !apiListed.has(m.id)) continue
    const existingIdx = result.findIndex((r) => r.id === m.id)
    if (existingIdx >= 0) {
      const apiEntry = result[existingIdx]
      result[existingIdx] = {
        ...apiEntry,
        capabilities: Array.from(new Set([...apiEntry.capabilities, ...m.capabilities])),
      }
    } else if (!apiListed && !seen.has(m.id)) {
      seen.add(m.id)
      result.push(m)
    }
  }

  return result
}

/**
 * Look up a single model's cached ModelInfo entry (case-insensitive id match)
 * from the dynamic model cache. Returns the API-parsed entry (which may carry
 * `inputModalities`, `metadataFromApi`, etc.) or null when not cached.
 */
export function findCachedModelInfo(
  providerType: LLMProviderType,
  modelId: string,
  providerKey?: string
): ModelInfo | null {
  const keysToTry: Array<{ pt: LLMProviderType; pk?: string }> = [
    { pt: providerType, pk: providerKey },
    { pt: providerType },
  ]
  if (providerKey !== providerType) {
    keysToTry.push({ pt: providerType, pk: providerType })
  }
  const lowerModelId = modelId.toLowerCase()
  for (const { pt, pk } of keysToTry) {
    const models = getCachedModels(pt, pk)
    if (!models) continue
    const hit = models.find((m) => m.id.toLowerCase() === lowerModelId)
    if (hit) return hit
  }
  return null
}

/**
 * Look up context window for a single model ID.
 *
 * Predicate (highest priority first):
 * 1. API-provided value from dynamic model cache (model-store)
 * 2. Static PROVIDER_META entry
 * 3. Sensible default (128000)
 *
 * This is the single source of truth for context window resolution.
 * All UI code should use this instead of hardcoding 128000.
 */
export function getModelContextWindow(
  providerType: LLMProviderType,
  modelId: string,
  providerKey?: string
): number {
  // 1. Dynamic cache (API-provided context_length from OpenRouter etc.)
  //    Try multiple cache keys because useDynamicModels may store under
  //    (providerType, providerType) while callers may look up with just providerType.
  const keysToTry: Array<{ pt: LLMProviderType; pk?: string }> = [
    { pt: providerType, pk: providerKey },
    { pt: providerType }, // key without providerKey suffix
  ]
  // Also try (providerType, providerType) if providerKey is different or absent
  if (providerKey !== providerType) {
    keysToTry.push({ pt: providerType, pk: providerType })
  }

  const seenIds = new Set<string>()
  const merged: ModelInfo[] = []
  for (const { pt, pk } of keysToTry) {
    const models = getCachedModels(pt, pk)
    if (!models) continue
    for (const m of models) {
      const key = m.id.toLowerCase()
      if (seenIds.has(key)) continue
      seenIds.add(key)
      merged.push(m)
    }
  }

  // Lowercase the modelId once for case-insensitive matching.
  // Dynamic /models endpoints and OpenRouter ids may differ in casing
  // (e.g. "Minimax/MiniMax-m3" vs "minimax/minimax-m3").
  const lowerModelId = modelId.toLowerCase()

  const cached = merged.find((m) => m.id.toLowerCase() === lowerModelId)
  if (cached && cached.contextWindow != null && cached.contextWindow > 0) return cached.contextWindow

  // 2. Static registry — the provider's OWN declared models take priority
  //    over third-party public data. Covers PROVIDER_META and dynamically
  //    registered providers (e.g. codex-oauth, whose models come from the
  //    browser extension with explicit contextWindow values like 258000).
  //    OpenRouter's public snapshot (step 3) reports the *API* max context
  //    (e.g. 1.05M for gpt-5.6-terra), which is NOT what Codex OAuth sessions
  //    actually expose — so a provider's own value must win.
  //    For built-in providers whose static entries omit contextWindow
  //    (e.g. OpenAI's gpt-4o), this step yields undefined → falls through.
  const staticModels = getModelsForProvider(providerType)
  const fromStatic = staticModels.find(
    (m) => m.id.toLowerCase() === lowerModelId
  )?.contextWindow
  if (fromStatic !== undefined && fromStatic > 0) return fromStatic

  // 3. OpenRouter public model data — universal fallback for models whose
  //    own provider declares no context_length (neither via /models cache
  //    nor via static registry). Pure static lookup from bundled JSON snapshot.
  const orCtx = getOpenRouterContextWindow(modelId)
  if (orCtx != null && orCtx > 0) return orCtx

  // 4. Default fallback
  return 128000
}

/**
 * Look up per-token USD pricing for a single model ID from the dynamic cache.
 * Returns null if the model has no pricing info published by the provider
 * (e.g. OpenAI, Anthropic, or any provider whose /models endpoint omits it).
 *
 * Fields are per-token USD strings; multiply by 1_000_000 to get USD/1M.
 */
export function getModelPricing(
  providerType: LLMProviderType,
  modelId: string,
  providerKey?: string
): ModelInfo['pricing'] | null {
  // Same multi-key lookup strategy as getModelContextWindow, so callers
  // can pass just providerType (or providerKey) and find the entry.
  const keysToTry: Array<{ pt: LLMProviderType; pk?: string }> = [
    { pt: providerType, pk: providerKey },
    { pt: providerType },
  ]
  if (providerKey !== providerType) {
    keysToTry.push({ pt: providerType, pk: providerType })
  }

  const seenIds = new Set<string>()
  for (const { pt, pk } of keysToTry) {
    const models = getCachedModels(pt, pk)
    if (!models) continue
    for (const m of models) {
      const key = m.id.toLowerCase()
      if (seenIds.has(key)) continue
      seenIds.add(key)
      if (key === modelId.toLowerCase() && m.pricing) return m.pricing
    }
  }
  return null
}
