/**
 * useGatewayLogin — reusable hook for LLM Gateway (坚果云 AI) Device Code Flow.
 *
 * Extracted from ProviderManager.tsx so that WelcomeScreen and other entry
 * points can trigger login without navigating to Settings.
 *
 * The save/model/credential sequence lives in the shared non-hook body
 * (`applyGatewayLoginTokens` in @/lib/gateway-login) so this hook and the
 * gateway-relogin store (credential-expired error card) stay behaviorally
 * identical.
 *
 * On success:
 * - Persists access_token to api-key-store
 * - Updates settings.hasApiKey → UI reacts (input enables, etc.)
 * - Fetches & registers model list
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  performDeviceCodeFlow,
  persistDeviceLoginTokens,
  type AuthState,
} from '@/agent/providers/llm-gateway-auth'
import {
  applyGatewayLoginTokens,
  getLLMGatewayBaseURL,
  getLLMGatewayClientId,
} from '@/lib/gateway-login'
import { useSettingsStore } from '@/store/settings.store'
import { useT } from '@/i18n'
import { isLLMGatewayConfigured } from '@/agent/providers/llm-gateway-provider'

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
  const attemptRef = useRef<AbortController | null>(null)
  const t = useT()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      attemptRef.current?.abort()
    }
  }, [])

  const login = useCallback(async (): Promise<boolean> => {
    attemptRef.current?.abort()
    const attempt = new AbortController()
    attemptRef.current = attempt
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
        if (mountedRef.current && !attempt.signal.aborted) {
          setAuthState(state)
        }
      }, attempt.signal)
      attempt.signal.throwIfAborted()
      console.log('[useGatewayLogin] got tokens, saving...')

      await applyGatewayLoginTokens(tokens.access_token, {
        signal: attempt.signal,
        onCommit: () => persistDeviceLoginTokens(tokens, clientId, baseURL),
      })
      console.log('[useGatewayLogin] login complete, returning true')

      if (mountedRef.current && attemptRef.current === attempt) {
        setAuthState({ status: 'success' })
        setIsRunning(false)
      }
      return true
    } catch (e) {
      if (attempt.signal.aborted || attemptRef.current !== attempt) return false
      console.error('[useGatewayLogin] FAILED:', e)
      const errorCode = (e as Error & { code?: string }).code
      // Only gateway-issued terminal codes prove stored credentials are bad.
      // Local device-flow failures now use their own code (device_flow_timeout)
      // and never reach this branch as 'expired_token'.
      const credentialInvalid = errorCode === 'invalid_grant' || errorCode === 'expired_token'
      if (credentialInvalid) {
        useSettingsStore.getState().setModelCredentialStatus('expired')
      }
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
    attemptRef.current?.abort()
    attemptRef.current = null
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
