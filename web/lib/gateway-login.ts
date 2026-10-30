/**
 * Shared login body for the LLM Gateway (坚果云 AI) Device Code Flow.
 *
 * Extracted from useGatewayLogin so both the hook and the gateway-relogin
 * store (credential-expired error card) run the EXACT same sequence:
 * persist the token → fetch/register models → atomically switch
 * provider/model → seed curated pins → sync credential state.
 *
 * Non-hook by design: zustand stores and plain async callers must not need
 * React to run a login.
 */

import {
  getLLMGatewayBaseURL,
  getLLMGatewayClientId,
  getLLMGatewayApiKeyProviderKey,
  prepareGatewayModels,
  registerGatewayModels,
  LLM_GATEWAY_PROVIDER_TYPE,
} from '@/agent/providers/llm-gateway-provider'
import { useSettingsStore } from '@/store/settings.store'
import { withGatewayCredentialLock } from '@/agent/providers/gateway-credential-lock'

export interface GatewayLoginResult {
  ok: boolean
  /** The access token on success (null otherwise). */
  accessToken: string | null
  models: Array<{ id: string; name: string }>
}

/**
 * Options for the shared login commit. The hook uses `onCommit` to persist
 * the device token pair in the same synchronous phase as provider settings.
 */
export interface GatewayLoginApplyOptions {
  signal?: AbortSignal
  /** Synchronous token-pair commit, called only after every cancellable step. */
  onCommit?: () => void
}

export async function applyGatewayLoginTokens(
  accessToken: string,
  options: GatewayLoginApplyOptions = {},
): Promise<GatewayLoginResult> {
  return applyGatewayLoginTokensInner(accessToken, options)
}

async function applyGatewayLoginTokensInner(
  accessToken: string,
  { signal, onCommit }: GatewayLoginApplyOptions,
): Promise<GatewayLoginResult> {
  const keyId = getLLMGatewayApiKeyProviderKey()
  const { saveApiKey, loadApiKey, deleteApiKey } = await import('@/security/api-key-store')
  signal?.throwIfAborted()

  // Fetch and prepare everything before the first persistent write.
  const models = await prepareGatewayModels(accessToken, signal)
  signal?.throwIfAborted()
  const settings = useSettingsStore.getState()
  let defaults: string[] = []
  if ((settings.pinnedModelsByProvider[LLM_GATEWAY_PROVIDER_TYPE]?.length ?? 0) === 0) {
    const { getDefaultPinnedModels } = await import('@/agent/providers/default-models')
    signal?.throwIfAborted()
    defaults = getDefaultPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, models.map((m) => m.id))
  }

  // Keep the read, write and possible rollback in one cross-tab critical
  // section. A cancelled login must not restore over a newer tab's login.
  return withGatewayCredentialLock(async () => {
    signal?.throwIfAborted()
    const previousKey = await loadApiKey(keyId)
    signal?.throwIfAborted()
    let committed = false
    try {
      await saveApiKey(keyId, accessToken)
      signal?.throwIfAborted()
      // No awaits after this point: cancellation cannot interleave the token
      // pair, provider registration, and selected-provider settings commit.
      registerGatewayModels(models)
      onCommit?.()
      committed = true
      settings.invalidateApiKeyCache(keyId)
      settings.switchProviderAndModel(
        LLM_GATEWAY_PROVIDER_TYPE,
        models[0]?.id ?? settings.modelName,
      )

      if (defaults.length > 0) {
        settings.setPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, defaults)
        settings.markPinnedModelsSeen(LLM_GATEWAY_PROVIDER_TYPE, defaults)
      }

      settings.setHasApiKey(true)
      settings.setModelCredentialStatus('valid')
      settings.triggerProviderRefresh()
      return { ok: true, accessToken, models }
    } catch (e) {
      // The aborted write may have committed. Roll back only while still
      // holding the lock shared by all gateway login attempts.
      if (!committed) {
        const current = await loadApiKey(keyId)
        if (current === accessToken) {
          if (previousKey === null) await deleteApiKey(keyId)
          else await saveApiKey(keyId, previousKey)
        }
      }
      throw e
    }
  })
}

export { getLLMGatewayBaseURL, getLLMGatewayClientId }
