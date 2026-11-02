/**
 * Gateway Re-login Store — singleton bridge for the credential-expired
 * error card (issue #75).
 *
 * When an llm-gateway request dies with [GATEWAY_CREDENTIALS_EXPIRED], the
 * error card offers a "Re-login" button. The button must work from a memoized
 * presentation component without prop-threading, so the whole flow lives in
 * this module-level zustand store (useYoloModeStore pattern):
 *
 *   start(onSuccess?) → runs the Device Code Flow (same sequence as
 *   useGatewayLogin.login via the shared applyGatewayLoginTokens body) →
 *   phase 'success' → invokes the registered success callback (which
 *   regenerates the failed turn) → reset().
 *
 * DeviceCodeFlowDialog is mounted once at a stable root (AppBootstrap) and
 * reads phase/authState from here — no dialog props on the banner.
 */

import { create } from 'zustand'
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
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

/** Translate a conversation.error key using the current locale. */
function tr(key: string): string {
  return translateStatic(useI18nStore.getState().locale, key)
}

export type GatewayReloginPhase = 'idle' | 'running' | 'success' | 'error'

interface GatewayReloginState {
  phase: GatewayReloginPhase
  /** Mirror of the device-code flow state — drives DeviceCodeFlowDialog. */
  authState: AuthState | null
  /** Localized/display error message when phase === 'error'. */
  error: string | null

  /**
   * Start the re-login flow. `onSuccess` fires once after tokens are applied
   * (the caller registers the regenerate of the failed turn); the dialog
   * closes and the store resets afterwards.
   */
  start: (onSuccess?: () => void) => Promise<boolean>
  /** Close the dialog / reset to idle (dialog close button, cancel). */
  reset: () => void
}

/** Guards concurrent start() calls (double-click on the banner button). */
let running = false

export const useGatewayReloginStore = create<GatewayReloginState>()((set) => ({
  phase: 'idle',
  authState: null,
  error: null,

  start: async (onSuccess) => {
    if (running) return false
    running = true
    set({ phase: 'running', authState: { status: 'requesting' }, error: null })

    const baseURL = getLLMGatewayBaseURL()
    const clientId = getLLMGatewayClientId()
    if (!clientId) {
      running = false
      set({
        phase: 'error',
        authState: { status: 'error', error: tr('conversation.error.gatewayClientIdMissing') },
        error: tr('conversation.error.gatewayClientIdMissing'),
      })
      return false
    }

    try {
      // Capture the attempt start BEFORE approval: approval can take
      // minutes, and a logout during it must invalidate this attempt.
      const attemptStartedAt = Date.now()
      const tokens = await performDeviceCodeFlow(baseURL, clientId, (state) => {
        set({ authState: state })
      })

      await applyGatewayLoginTokens(tokens.access_token, {
        attemptStartedAt,
        onCommit: () => persistDeviceLoginTokens(tokens, clientId, baseURL),
      })

      set({ phase: 'success', authState: { status: 'success' } })
      running = false
      // Fire the caller's post-login action (regenerate the failed turn)
      // before resetting so the flag survives a synchronous dialog unmount.
      try {
        onSuccess?.()
      } catch (callbackError) {
        console.error('[gateway-relogin] success callback failed:', callbackError)
      }
      set({ phase: 'idle', authState: null })
      return true
    } catch (e) {
      console.error('[gateway-relogin] FAILED:', e)
      const message = (e as Error).message || tr('conversation.error.gatewayLoginFailed')
      const errorCode = (e as Error & { code?: string }).code
      // Only gateway-issued terminal codes prove stored credentials are bad
      // (same distinction useGatewayLogin makes).
      if (errorCode === 'invalid_grant' || errorCode === 'expired_token') {
        const { useSettingsStore } = await import('@/store/settings.store')
        useSettingsStore.getState().setModelCredentialStatus('expired')
      }
      running = false
      set({ phase: 'error', authState: { status: 'error', error: message }, error: message })
      return false
    }
  },

  reset: () => {
    if (running) return // a flow in flight owns the state; ignore stray closes
    running = false
    set({ phase: 'idle', authState: null, error: null })
  },
}))
