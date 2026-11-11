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
  prepareGatewayModels,
  registerGatewayModels,
  unregisterLLMGatewayProvider,
  LLM_GATEWAY_PROVIDER_TYPE,
} from '@/agent/providers/llm-gateway-provider'
import { useSettingsStore } from '@/store/settings.store'
import { withGatewayCredentialLock } from '@/agent/providers/gateway-credential-lock'
import { getLastLogoutTimestamp } from '@/agent/providers/llm-gateway-auth'

/**
 * Hard deadline for post-approval model discovery. A gateway that accepts the
 * device-code approval but never answers `/v1/models` must not leave an
 * APPROVED login hung before the credential commit — the user already did
 * their part, so the login proceeds best-effort (empty model list; models
 * refresh later via triggerProviderRefresh). Deliberately generous: this
 * guards against a stalled endpoint, not slow network on a healthy one.
 */
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

export { MODEL_DISCOVERY_TIMEOUT_MS }

/**
 * Run the model discovery under a hard deadline that ALSO aborts the
 * discovery request itself.
 *
 * The deadline previously only rejected the RACE: the caller moved on to
 * the credential commit while `prepareGatewayModels` kept awaiting a hung
 * fetch forever, and with no caller-supplied signal (the direct-login
 * path) nothing would ever cancel it — the request and its resources
 * stayed outstanding (Sourcery round 8, "Timed-out discovery keeps
 * running").
 *
 * `start` receives the signal the discovery must use: an INTERNAL
 * AbortController's signal, chained onto the caller's signal when one
 * exists (so a caller cancellation still cancels the fetch). Expiry
 * aborts the internal controller — the fetch settles instead of leaking.
 * Aborting the internal controller never touches the caller's own signal,
 * so `signal?.throwIfAborted()` still sees only genuine caller
 * cancellations.
 */
function withDiscoveryDeadline<T>(
  start: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const internalController = new AbortController()
  const onOuterAbort = () => internalController.abort(signal?.reason)
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      internalController.abort(new Error('model discovery timed out'))
      reject(new Error('model discovery timed out'))
    }, MODEL_DISCOVERY_TIMEOUT_MS)
  })
  const discovery = start(internalController.signal)
  return Promise.race([
    discovery.finally(cleanup),
    deadline.finally(cleanup),
  ])
}

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
  /**
   * Synchronous token-pair commit, called only after every cancellable step.
   */
  onCommit?: () => void
  /**
   * When the login ATTEMPT started (before the device-code approval wait),
   * supplied by the caller. The logout-supersedes commit guard compares the
   * cross-tab logout marker against this timestamp: a logout committed after
   * the attempt began must win over the pending login. Callers that ran
   * `performDeviceCodeFlow` themselves MUST pass the timestamp taken BEFORE
   * that call — `applyGatewayLoginTokens` itself only observes the attempt
   * after approval completed, which can be minutes later, and a logout in
   * between would otherwise predate the guard's timestamp. Defaults to
   * "now" for direct (already-approved) callers.
   */
  attemptStartedAt?: number
}

export async function applyGatewayLoginTokens(
  accessToken: string,
  options: GatewayLoginApplyOptions = {},
): Promise<GatewayLoginResult> {
  return applyGatewayLoginTokensInner(accessToken, options)
}

async function applyGatewayLoginTokensInner(
  accessToken: string,
  { signal, onCommit, attemptStartedAt }: GatewayLoginApplyOptions,
): Promise<GatewayLoginResult> {
  signal?.throwIfAborted()

  // The attempt timestamp: the caller's pre-approval capture when supplied
  // (device-code approval can take minutes — a logout during that wait must
  // invalidate the attempt), else "now" (direct callers without a pending
  // approval window). The commit guard below re-checks the cross-tab logout
  // marker against it under the credential lock.
  const effectiveAttemptStartedAt = attemptStartedAt ?? Date.now()

  // Fetch models before the first persistent write (network work outside
  // the credential lock). A NETWORK failure here is treated as best-effort
  // (empty list — the credential commit still proceeds; models refresh
  // later via triggerProviderRefresh), because the visitor already approved
  // device authorization: making them repeat it because a models fetch
  // flaked is worse than a temporarily empty model list. The deadline below
  // extends the same best-effort contract to a gateway that approves the
  // login but never answers `/v1/models`: without it `prepareGatewayModels`
  // never settles and the approved login hangs before the credential
  // commit (Sourcery: "Approved login can hang"). Cancellation (signal
  // aborted) still propagates — an explicitly cancelled login must not
  // commit.
  //
  // The catalog STATUS is carried alongside the list: a failed discovery
  // must NOT be committed as an AUTHORITATIVE empty catalog, or the store
  // would later conclude that every pinned model was delisted and switch
  // the user's selection away from a provider that is merely unreachable
  // (#146). An authoritative empty catalog (the gateway answered and
  // serves no models) is committed as such.
  let discovery: Awaited<ReturnType<typeof prepareGatewayModels>> = {
    models: [],
    status: 'failed',
  }
  try {
    discovery = await withDiscoveryDeadline(
      (discoverySignal) => prepareGatewayModels(accessToken, discoverySignal),
      signal,
    )
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
    if (lastLogout !== null && lastLogout > effectiveAttemptStartedAt) {
      console.warn(
        '[gateway-login] discarding login commit: a logout occurred after this attempt started',
      )
      throw new Error('session changed during login: logout superseded this attempt')
    }
    const settings = useSettingsStore.getState()
    // The curated default is resolved UNCONDITIONALLY: it drives the model
    // SELECTION for every login, fresh or returning. The guarded `defaults`
    // below drives only the pin-SEEDING writes — seeding must never clobber
    // a returning user's own favorites.
    const { getDefaultPinnedModels } = await import('@/agent/providers/default-models')
    const curatedCandidates = getDefaultPinnedModels(
      LLM_GATEWAY_PROVIDER_TYPE,
      discovery.models.map((m) => m.id),
    )
    // Re-check pins under the lock: a pin added between the pre-lock
    // snapshot and this commit must win over the computed defaults.
    let defaults: string[] = []
    if ((settings.pinnedModelsByProvider[LLM_GATEWAY_PROVIDER_TYPE]?.length ?? 0) === 0) {
      defaults = curatedCandidates
    }
    signal?.throwIfAborted()
    {
      // No awaits after this point: cancellation cannot interleave provider
      // registration and the selected-provider settings commit. The token pair
      // itself is persisted by the device flow before we get here.
      // A new login may belong to another account. Its failed discovery
      // must never inherit the previous account's in-memory model list.
      unregisterLLMGatewayProvider()
      registerGatewayModels(discovery.models, discovery.status)
      onCommit?.()
      // Selected model: the curated value default when it is served
      // (deepseek-v4.1-flash per DEFAULT_PINNED_MODELS), falling back to the
      // gateway's first served model. Picking discovery.models[0] outright
      // made the default ride on the gateway's catalog ordering — the
      // provider lists deepseek-v4-pro first, so every fresh login landed on
      // the pro tier instead of the curated value pick. When discovery
      // failed (empty list) do NOT fall back to `settings.modelName` — that
      // id belongs to the PREVIOUSLY selected provider and would leave the
      // gateway login pointing at an unsupported model. The model registry
      // is refreshed in the background (triggerProviderRefresh below), and
      // the settings card re-registers the fetched catalog on its next
      // /models fetch; an empty modelName here marks the selection for
      // that re-resolution instead of pinning a wrong provider's model.
      const servedIds = new Set(discovery.models.map((m) => m.id))
      const selectedModel =
        curatedCandidates.find((id) => servedIds.has(id)) ?? discovery.models[0]?.id ?? ''
      settings.switchProviderAndModel(LLM_GATEWAY_PROVIDER_TYPE, selectedModel)
      if (defaults.length > 0) {
        settings.setPinnedModels(LLM_GATEWAY_PROVIDER_TYPE, defaults)
        settings.markPinnedModelsSeen(LLM_GATEWAY_PROVIDER_TYPE, defaults)
      }

      settings.setHasApiKey(true)
      settings.setModelCredentialStatus('valid')
      settings.triggerProviderRefresh()
      return { ok: true, accessToken, models: discovery.models }
    }
  })
}

export { getLLMGatewayBaseURL, getLLMGatewayClientId }
