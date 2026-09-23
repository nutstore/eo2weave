/**
 * useGatewayLogin — reusable hook for LLM Gateway (坚果云 AI) Device Code Flow.
 *
 * Extracted from ProviderManager.tsx so that WelcomeScreen and other entry
 * points can trigger login without navigating to Settings.
 *
 * On success:
 * - Persists access_token to api-key-store
 * - Updates settings.hasApiKey → UI reacts (input enables, etc.)
 * - Fetches & registers model list
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  performDeviceCodeFlow,
  type AuthState,
} from '@/agent/providers/llm-gateway-auth'
import {
  getLLMGatewayBaseURL,
  getLLMGatewayClientId,
  getLLMGatewayApiKeyProviderKey,
  updateGatewayModels,
  isLLMGatewayConfigured,
  LLM_GATEWAY_PROVIDER_TYPE,
} from '@/agent/providers/llm-gateway-provider'
import { useSettingsStore } from '@/store/settings.store'
import { useT } from '@/i18n'

export interface UseGatewayLoginResult {
  /** Current auth flow state — null when idle */
  authState: AuthState | null
  /** Whether a login flow is in progress */
  isRunning: boolean
  /** Trigger the Device Code Flow. Returns true on success. */
  login: () => Promise<boolean>
  /** Reset auth state to idle */
  reset: () => void
}

export function useGatewayLogin(): UseGatewayLoginResult {
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const mountedRef = useRef(true)
  const t = useT()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const login = useCallback(async (): Promise<boolean> => {
    const baseURL = getLLMGatewayBaseURL()
    const clientId = getLLMGatewayClientId()

    if (!clientId) {
      setAuthState({
        status: 'error',
        error: t('welcome.gateway.clientIdMissing'),
      })
      return false
    }

    setIsRunning(true)
    try {
      console.log('[useGatewayLogin] starting device code flow...')
      const tokens = await performDeviceCodeFlow(baseURL, clientId, (state) => {
        if (mountedRef.current) {
          setAuthState(state)
        }
      })
      console.log('[useGatewayLogin] got tokens, saving...')

      // Save access_token as the "API key" for this provider
      const keyId = getLLMGatewayApiKeyProviderKey()
      const { saveApiKey } = await import('@/security/api-key-store')
      await saveApiKey(keyId, tokens.access_token)
      useSettingsStore.getState().invalidateApiKeyCache(keyId)
      console.log('[useGatewayLogin] token saved, fetching models...')

      // Fetch and register model list FIRST (need models before we can select one)
      const models = await updateGatewayModels(tokens.access_token)
      console.log('[useGatewayLogin] models fetched:', models.length)

      // Switch active provider to llm-gateway and pick the first available model
      useSettingsStore.getState().setProviderType(LLM_GATEWAY_PROVIDER_TYPE)
      if (models.length > 0) {
        useSettingsStore.getState().setModelName(models[0].id)
      }

      // Seed the curated default pin (deepseek-v4.1-flash) for first-time
      // gateway users — same first-save seeding as ProviderManager, so the
      // top-bar switcher works without manual pinning. Intersection with the
      // live catalog skips an out-of-curation default.
      if ((useSettingsStore.getState().pinnedModelsByProvider[LLM_GATEWAY_PROVIDER_TYPE]?.length ?? 0) === 0) {
        const { getDefaultPinnedModels } = await import('@/agent/providers/default-models')
        const defaults = getDefaultPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, models.map((m) => m.id))
        if (defaults.length > 0) {
          useSettingsStore.getState().setPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, defaults)
          useSettingsStore.getState().markPinnedModelsSeen(LLM_GATEWAY_PROVIDER_TYPE, defaults)
        }
      }

      // Sync global hasApiKey so UI reacts immediately (must come AFTER provider/model set)
      useSettingsStore.getState().setHasApiKey(true)

      // Trigger UI refresh so provider dropdowns etc. update
      useSettingsStore.getState().triggerProviderRefresh()
      console.log('[useGatewayLogin] login complete, returning true')

      if (mountedRef.current) {
        setAuthState({ status: 'success' })
        setIsRunning(false)
      }
      return true
    } catch (e) {
      console.error('[useGatewayLogin] FAILED:', e)
      if (mountedRef.current) {
        setAuthState({
          status: 'error',
          error: (e as Error).message || t('welcome.gateway.authFailedFallback'),
        })
        setIsRunning(false)
      }
      return false
    }
  }, [])

  const reset = useCallback(() => {
    setAuthState(null)
    setIsRunning(false)
  }, [])

  return {
    authState,
    isRunning,
    login,
    reset,
  }
}

export { isLLMGatewayConfigured }
