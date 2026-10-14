/**
 * useDynamicModels - React hook for fetching and caching dynamic model lists.
 *
 * Strategy: stale-while-revalidate
 * - Has cache (memory or localStorage)? Show it immediately
 * - No cache? Show static list, then fetch in background
 * - Refresh button: force re-fetch, always fresh
 * - Cache never expires — same provider, same models
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { LLMProviderType, ModelInfo } from '@/agent/providers/types'
import {
  getModelsForProvider,
  getProviderConfig,
  isCustomProviderType,
} from '@/agent/providers/types'
import { fetchModelsForProvider } from '@/agent/providers/model-fetcher'
import { loadApiKey } from '@/security/api-key-store'
import {
  getCachedModels,
  getCachedModelsResult,
  setCachedModels,
  isCacheStale,
} from '@/agent/providers/model-store'

/**
 * In-memory negative cache: after a failed fetch, suppress the automatic
 * stale-while-revalidate retry for a short window so an offline session
 * doesn't fire a doomed request on every mount. Manual refresh
 * (`refresh()`) always bypasses it.
 */
const FAILED_FETCH_RETRY_MS = 5 * 60 * 1000
const failedFetchAt = new Map<string, number>()

interface DynamicModelsState {
  /** Current model list */
  models: ModelInfo[]
  /** Whether these models came from API or static fallback */
  source: 'dynamic' | 'static'
  /** Whether a fetch is in progress */
  loading: boolean
  /** Last error message if fetch failed */
  error: string | null
  /** Manually trigger a refresh */
  refresh: (apiKey?: string, baseUrl?: string) => Promise<void>
  /** Number of models fetched dynamically */
  dynamicCount: number
}

export function useDynamicModels(
  providerType: LLMProviderType,
  providerKey?: string
): DynamicModelsState {
  // Initialize: cache → static
  const [models, setModels] = useState<ModelInfo[]>(() => {
    return getCachedModels(providerType, providerKey) || getModelsForProvider(providerType)
  })

  const [source, setSource] = useState<'dynamic' | 'static'>(() => {
    const result = getCachedModelsResult(providerType, providerKey)
    return result?.source === 'dynamic' ? 'dynamic' : 'static'
  })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dynamicCount, setDynamicCount] = useState(0)
  const mountedRef = useRef(true)
  const sourceRef = useRef(source)
  sourceRef.current = source

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const doFetch = useCallback(
    async (apiKey?: string, baseUrl?: string) => {
      if (mountedRef.current) setLoading(true)
      if (mountedRef.current) setError(null)

      const cacheKey = `${providerType}:${providerKey ?? ''}`
      try {
        const result = await fetchModelsForProvider(providerType, { apiKey, baseUrl })
        if (result.error) {
          failedFetchAt.set(cacheKey, Date.now())
        } else {
          failedFetchAt.delete(cacheKey)
        }
        setCachedModels(providerType, result, providerKey)

        if (mountedRef.current) {
          setModels(result.models)
          setSource(result.source)
          setDynamicCount(result.source === 'dynamic' ? result.models.length : 0)
          if (result.error) setError(result.error)
        }
      } catch (err) {
        failedFetchAt.set(cacheKey, Date.now())
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          // Don't overwrite existing dynamic data on failure
          if (sourceRef.current !== 'dynamic') {
            setModels(getModelsForProvider(providerType))
            setSource('static')
          }
          setDynamicCount(0)
        }
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    },
    [providerType, providerKey]
  )

  // When provider changes, load from cache or static
  useEffect(() => {
    const cached = getCachedModels(providerType, providerKey)
    const result = getCachedModelsResult(providerType, providerKey)

    if (cached) {
      setModels(cached)
      setSource(result?.source === 'dynamic' ? 'dynamic' : 'static')
      setDynamicCount(cached.length)
    } else {
      setModels(getModelsForProvider(providerType))
      setSource('static')
      setDynamicCount(0)
    }
    setError(null)
    setLoading(false)
  }, [providerType, providerKey])

  // Stale-while-revalidate: if a cached list is older than the TTL, silently
  // re-fetch in the background so metadata (names, modalities, context windows)
  // eventually catches up with provider-side changes. Cached data is still
  // shown immediately, so this never blocks the UI.
  useEffect(() => {
    if (!isCacheStale(providerType, providerKey)) return

    const cacheKey = `${providerType}:${providerKey ?? ''}`
    const failedAt = failedFetchAt.get(cacheKey)
    if (failedAt && Date.now() - failedAt < FAILED_FETCH_RETRY_MS) return

    let cancelled = false
    const refreshStaleCache = async () => {
      const isCustom = providerType === 'custom' || isCustomProviderType(providerType)
      let apiKey: string | null
      try {
        apiKey = await loadApiKey(providerKey ?? providerType)
      } catch (error) {
        failedFetchAt.set(cacheKey, Date.now())
        console.warn(`[use-dynamic-models] Failed to load API key for ${providerType}:`, error)
        return
      }
      if (cancelled || (!apiKey && !isCustom)) return

      const baseUrl = getProviderConfig(providerType)?.baseURL
      await doFetch(apiKey ?? undefined, baseUrl)
    }

    void refreshStaleCache()
    return () => {
      cancelled = true
    }
  }, [doFetch, providerType, providerKey])

  return {
    models,
    source,
    loading,
    error,
    refresh: doFetch,
    dynamicCount,
  }
}
