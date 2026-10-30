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
import {
  getLastLogoutTimestamp,
  withKeyStoreDeadline,
} from '@/agent/providers/llm-gateway-auth'

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

  // Record when THIS attempt started — BEFORE the device-code approval and
  // model-preparation awaits in the caller (approval can take minutes), so
  // a logout committed during any of those waits (in any tab) predates
  // this timestamp and invalidates the attempt in the commit guard below.
  // (Previously the timestamp was taken inside the credential lock, AFTER
  // those waits — a logout that happened meanwhile predated it and the
  // stale login resurrected the just-ended session.)
  const attemptStartedAt = Date.now()

  // Fetch models before the first persistent write (network work outside
  // the credential lock). A NETWORK failure here is treated as best-effort
  // (empty list — the credential commit still proceeds; models refresh
  // later via triggerProviderRefresh), because the visitor already approved
  // device authorization: making them repeat it because a models fetch
  // flaked is worse than a temporarily empty model list. Cancellation
  // (signal aborted) still propagates — an explicitly cancelled login must
  // not commit.
  let models: Awaited<ReturnType<typeof prepareGatewayModels>> = []
  try {
    models = await prepareGatewayModels(accessToken, signal)
  } catch (e) {
    if (signal?.aborted) signal.throwIfAborted()
    console.warn('[gateway-login] model discovery failed; committing login with an empty model list:', e)
  }
  signal?.throwIfAborted()

  // Keep the read, write and possible rollback in one cross-tab critical
  // section. A cancelled login must not restore over a newer tab's login.
  // (The logout-supersedes guard below compares against `attemptStartedAt`,
  // captured BEFORE the device-code approval / model preparation waits —
  // see the comment at the top of this function.)
  return withGatewayCredentialLock(async () => {
    signal?.throwIfAborted()
    // Logout-supersedes-pending-login: if the user logged out (any tab)
    // while this attempt was pending — device-code approval or model
    // preparation can take minutes — do not resurrect the session they
    // just ended. The last login wins, the last logout also wins.
    const lastLogout = getLastLogoutTimestamp()
    if (lastLogout !== null && lastLogout > attemptStartedAt) {
      console.warn(
        '[gateway-login] discarding login commit: a logout occurred after this attempt started',
      )
      throw new Error('session changed during login: logout superseded this attempt')
    }
    const settings = useSettingsStore.getState()
    // Re-check pins under the lock: a pin added between the pre-lock
    // snapshot and this commit must win over the computed defaults.
    let defaults: string[] = []
    if ((settings.pinnedModelsByProvider[LLM_GATEWAY_PROVIDER_TYPE]?.length ?? 0) === 0) {
      const { getDefaultPinnedModels } = await import('@/agent/providers/default-models')
      defaults = getDefaultPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, models.map((m) => m.id))
    }
    signal?.throwIfAborted()
    // Bound the key-store reads/writes: a stalled api-key-store op must not
    // hold the origin-wide credential lock forever (later logins, refreshes
    // and logouts all queue behind it). Each bounded op returns a `settled`
    // promise — ALL of them are awaited before this function returns, so a
    // timed-out write that lands late can never modify the credential state
    // after a newer login/logout has committed under this lock.
    const bounded = <T>(p: Promise<T>) => withKeyStoreDeadline(p)
    const pendingSettles: Array<Promise<void>> = []
    const runBounded = async <T>(p: Promise<T>): Promise<T> => {
      const { result, settled } = bounded(p)
      pendingSettles.push(settled)
      return result
    }
    const previousKey = await runBounded(loadApiKey(keyId))
    signal?.throwIfAborted()
    let committed = false
    try {
      await runBounded(saveApiKey(keyId, accessToken))
      signal?.throwIfAborted()
      // No awaits after this point: cancellation cannot interleave the token
      // pair, provider registration, and selected-provider settings commit.
      registerGatewayModels(models)
      onCommit?.()
      committed = true
      settings.invalidateApiKeyCache(keyId)
      // Selected model: the gateway's first served model. When discovery
      // failed (empty list) do NOT fall back to `settings.modelName` — that
      // id belongs to the PREVIOUSLY selected provider and would leave the
      // gateway login pointing at an unsupported model. The model registry
      // is refreshed in the background (triggerProviderRefresh below), and
      // the settings card re-registers the fetched catalog on its next
      // /models fetch; an empty modelName here marks the selection for
      // that re-resolution instead of pinning a wrong provider's model.
      settings.switchProviderAndModel(LLM_GATEWAY_PROVIDER_TYPE, models[0]?.id ?? '')
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
      // holding the lock shared by all gateway login attempts. Bounded the
      // same way as the forward path — a stalled key-store op must not hold
      // the lock forever during rollback either.
      if (!committed) {
        const current = await runBounded(loadApiKey(keyId))
        if (current === accessToken) {
          if (previousKey === null) await runBounded(deleteApiKey(keyId))
          else await runBounded(saveApiKey(keyId, previousKey))
        }
      }
      throw e
    } finally {
      // Hold the credential lock until every bounded key-store op has fully
      // settled — a write that exceeded its deadline but lands afterwards
      // must not modify credential state after a newer login/logout has
      // committed under this lock. The grace timeout inside
      // withKeyStoreDeadline guarantees this await cannot hang forever.
      await Promise.all(pendingSettles)
    }
  })
}

export { getLLMGatewayBaseURL, getLLMGatewayClientId }
