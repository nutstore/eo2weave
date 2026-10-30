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

// Serialize credential commits and their possible rollback in this tab.
// Cross-tab, the rollback below is a content compare-and-swap: it restores
// the previous key ONLY while the store still holds THIS attempt's token,
// so a newer credential saved by another tab is never overwritten.
let applicationTail: Promise<unknown> = Promise.resolve()

export async function applyGatewayLoginTokens(
  accessToken: string,
  options: GatewayLoginApplyOptions = {},
): Promise<GatewayLoginResult> {
  const previous = applicationTail.catch(() => {})
  let release!: () => void
  const slot = new Promise<void>((resolve) => { release = resolve })
  applicationTail = previous.then(() => slot)
  await previous
  try {
    return await applyGatewayLoginTokensInner(accessToken, options)
  } finally {
    release()
  }
}

async function applyGatewayLoginTokensInner(
  accessToken: string,
  { signal, onCommit }: GatewayLoginApplyOptions,
): Promise<GatewayLoginResult> {
  const keyId = getLLMGatewayApiKeyProviderKey()
  const { saveApiKey, loadApiKey, deleteApiKey } = await import('@/security/api-key-store')
  signal?.throwIfAborted()
  const previousKey = await loadApiKey(keyId)
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

  let committed = false
  try {
    signal?.throwIfAborted()
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
    // An abort during the async key-store write may arrive after it commits.
    // Restore only if the store STILL holds THIS attempt's token (a CAS on
    // content): another tab's login may have saved a newer credential after
    // our write — overwriting it with our older key would leave that tab
    // reporting success while its token pair and saved credential disagree.
    if (!committed) {
      const current = await loadApiKey(keyId)
      if (current === accessToken) {
        if (previousKey === null) await deleteApiKey(keyId)
        else await saveApiKey(keyId, previousKey)
      }
    }
    throw e
  }
}

export { getLLMGatewayBaseURL, getLLMGatewayClientId }
