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
import { getModelsForProvider } from '@/agent/providers/types'
import { fetchModelsForProvider } from '@/agent/providers/model-fetcher'
import {
  getCachedModels,
  getCachedModelsResult,
  setCachedModels,
  isCacheStale,
} from '@/agent/providers/model-store'

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

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const doFetch = useCallback(
    async (apiKey?: string, baseUrl?: string) => {
      if (mountedRef.current) setLoading(true)
      if (mountedRef.current) setError(null)

      try {
        const result = await fetchModelsForProvider(providerType, { apiKey, baseUrl })
        setCachedModels(providerType, result, providerKey)

        if (mountedRef.current) {
          setModels(result.models)
          setSource(result.source)
          setDynamicCount(result.source === 'dynamic' ? result.models.length : 0)
          if (result.error) setError(result.error)
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          // Don't overwrite existing dynamic data on failure
          if (source !== 'dynamic') {
            setModels(getModelsForProvider(providerType))
            setSource('static')
          }
          setDynamicCount(0)
        }
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    },
    [providerType, providerKey, source]
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
    // Only auto-fetch when we have credentials for non-custom providers
    // (fetchModelsForProvider already handles the keyless-custom case).
    const key = providerKey ?? undefined
    if (!key && providerType !== 'custom') return
    void doFetch(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerType, providerKey])

  return {
    models,
    source,
    loading,
    error,
    refresh: doFetch,
    dynamicCount,
  }
}
