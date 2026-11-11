/**
 * LLM Gateway Provider Registration
 *
 * Registers "坚果云 AI" as a built-in LLM provider that uses
 * Device Code Flow for authentication (no manual API key needed).
 *
 * The provider automatically:
 * - Manages token lifecycle (acquire, refresh, persist)
 * - Prompts user with Device Code Flow on first use
 * - Refreshes tokens transparently
 *
 * Environment variables:
 * - NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL: Gateway base URL (default: https://ai.jianguoyun.com)
 * - NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID: Device client ID (required for auth)
 *
 * Region gate: the gateway is a domestic (CN build) service only — see
 * lib/deploy-region.ts. On international builds getGatewayClientId() always
 * returns '', which hides every entry point (welcome card, settings card,
 * model lists, startup registration) through isLLMGatewayConfigured().
 */

import { ENABLE_LLM_GATEWAY } from '@/lib/deploy-region'
import type { LLMProviderConfig, LLMProviderType, ModelInfo, ProviderCatalogStatus, ProviderMeta } from '@/agent/providers/types'
import { getModelsForProvider, getProviderCatalogStatus, getProviderConfig, registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
import { fetchGatewayModels, fetchRateLimits, forceRefreshAccessToken, getGatewayAuthSessionGeneration, getGatewayCredentialStatus, getValidAccessToken, invalidateGatewayAccessToken, onGatewayTokensPurged, refreshAccessTokenWithStatus, type RateLimitsResponse } from './llm-gateway-auth'
import { getModelContextWindow } from './model-store'
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

// ── Provider Identity ──

export const LLM_GATEWAY_PROVIDER_TYPE: LLMProviderType = 'llm-gateway'

/**
 * The api-key-store key holding the gateway access_token. Single source of
 * truth lives in llm-gateway-auth.ts (the auth layer needs to purge dead
 * tokens without importing this module); re-exported here for convenience.
 */

// ── Configuration ──

function getGatewayBaseURL(): string {
  return process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL || 'https://ai.jianguoyun.com'
}

function getGatewayClientId(): string {
  // CN-only service: never expose the gateway on international builds, even
  // if the client-id env var is present in the wrong build pipeline. All
  // gateway entry points consult this via isLLMGatewayConfigured().
  if (!ENABLE_LLM_GATEWAY) return ''
  return process.env.NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID || ''
}

/** Check if LLM Gateway is configured (has client_id) */
export function isLLMGatewayConfigured(): boolean {
  return !!getGatewayClientId()
}

/** Get the gateway base URL */
export function getLLMGatewayBaseURL(): string {
  return getGatewayBaseURL()
}

/** Get the gateway client_id */
export function getLLMGatewayClientId(): string {
  return getGatewayClientId()
}

// ── Provider Registration ──

const GATEWAY_META: ProviderMeta = {
  category: 'chinese',
  displayName: 'Nutstore AI',
  models: [], // populated dynamically via updateGatewayModels()
  // Registered-but-loading must be distinguishable from failed (#188):
  // without this the switcher derives 'failed' from the empty list during
  // startup discovery and treats the gateway as unverified while it is
  // merely restoring its session.
  catalogStatus: 'loading',
}

// Shared ordering for startup, settings-card, switcher and login registrations.
let catalogRefreshVersion = 0

export function beginGatewayCatalogRefresh(): number {
  return ++catalogRefreshVersion
}

export function isGatewayCatalogRefreshCurrent(version: number): boolean {
  return version === catalogRefreshVersion
}

// The credential layer purges the token pair on an expiry without importing
// this module (that would cycle auth → provider → auth). Listen for the purge
// and record the outage here: the provider STAYS registered with a 'failed'
// catalog, so the last usable model list remains on screen and Retry /
// re-login stay reachable (#224 — only explicit logout removes it).
// 'missing' is an explicit logout: the auth layer unregisters the provider
// itself and this listener stays silent.
onGatewayTokensPurged((finalStatus) => {
  if (finalStatus === 'missing') return
  markGatewayCatalogFailed()
})

/**
 * Register LLM Gateway as a dynamic provider.
 * Called on app startup if NEXT_PUBLIC_JIANGUOYUN_AI_CLIENT_ID is set.
 * Model list starts empty and is filled once we have a valid token.
 */
export function registerLLMGatewayProvider(): void {
  if (!isLLMGatewayConfigured()) return

  const baseURL = getGatewayBaseURL()

  const config: Omit<LLMProviderConfig, 'apiKey'> = {
    baseURL: `${baseURL}/v1`,
    modelName: '',
    headers: {},
    apiMode: 'chat-completions',
  }

  registerDynamicProvider(LLM_GATEWAY_PROVIDER_TYPE, config, GATEWAY_META)
}

/**
 * Fetch models from gateway /v1/models and re-register the provider
 * with the updated model list. Call after obtaining a valid access token.
 *
 * Empty and failed gateway catalogs cannot prove that previously seen
 * models were delisted, so both retain the last usable list.
 */
export async function prepareGatewayModels(
  accessToken: string,
  signal?: AbortSignal,
  recoverRejectedToken = false,
  onAuthGenerationChange?: (generation: number) => void,
  expectedAuthGeneration = getGatewayAuthSessionGeneration(),
): Promise<{ models: ModelInfo[]; status: ProviderCatalogStatus; authGeneration?: number; reauthRequired?: boolean }> {
  const baseURL = getGatewayBaseURL()
  if (expectedAuthGeneration !== getGatewayAuthSessionGeneration()) {
    return { models: [], status: 'failed', authGeneration: expectedAuthGeneration }
  }
  let authGeneration = getGatewayAuthSessionGeneration()
  let result = await fetchGatewayModels(baseURL, accessToken, signal)
  if (recoverRejectedToken && result.authRejected && authGeneration === getGatewayAuthSessionGeneration()) {
    const refreshed = await refreshAccessTokenWithStatus(baseURL, getGatewayClientId(), signal)
    if (refreshed.status === 'success') {
      authGeneration = getGatewayAuthSessionGeneration()
      onAuthGenerationChange?.(authGeneration)
      result = await fetchGatewayModels(baseURL, refreshed.accessToken, signal)
      if (result.authRejected) {
        await invalidateGatewayAccessToken(refreshed.accessToken)
        return { models: [], status: 'failed', authGeneration, reauthRequired: true }
      }
    } else if (refreshed.status === 'expired' || refreshed.status === 'missing') {
      return { models: [], status: 'failed', authGeneration, reauthRequired: true }
    }
  }
  signal?.throwIfAborted()

  return {
    models: result.models.map((m) => ({
      id: m.id,
      name: m.name,
      capabilities: ['code', 'writing', 'reasoning'] as const,
      // Resolve contextWindow dynamically so MiniMax-m3 (1M), glm-5.2 (1M),
      // gpt-4o (128K), etc. each show their real value instead of a flat 200K.
      contextWindow: getModelContextWindow(LLM_GATEWAY_PROVIDER_TYPE, m.id),
    })),
    // Preserve the successful-empty outcome separately from a fetch failure.
    // Neither outcome proves that previously seen models were delisted.
    status: result.status,
    authGeneration,
  }
}

/**
 * Apply the outcome of a credential resolution that produced NO usable token.
 *
 * The three non-ok states are NOT interchangeable and each needs a different
 * write (they all looked like `null` before `resolveGatewayDispatchCredential`):
 *
 * - `'temporary'` — transient (refresh in flight, network blip, storage
 *   hiccup). No evidence of an outage: a catalog this context already has
 *   must NOT be demoted, or the switcher warns over a working model list and
 *   the banner comes back on every boot/reconcile.
 * - `'expired'` — the catalog cannot load until the user re-authenticates, so
 *   the provider must stay visible with a 'failed' catalog (the switcher's
 *   Retry and the settings card's re-login are the recovery route). Note the
 *   resolver has ALREADY purged the token pair, so `hasStoredTokens()` reads
 *   false here — branch on the verdict, never on the stored state.
 * - `'missing'` — never signed in: registering anyway leaves a provider whose
 *   catalog can never load in every future app context.
 */
export function applyGatewayCredentialOutcome(
  kind: 'temporary' | 'expired' | 'missing',
  refreshVersion?: number,
): void {
  if (refreshVersion !== undefined && !isGatewayCatalogRefreshCurrent(refreshVersion)) {
    // Newer catalog work owns the registry: never write over ITS catalog.
    // A token-less boot still owes the user a recovery route, so an absent
    // provider is registered as 'failed' (never the default 'loading', which
    // the switcher hides) — without claiming a refresh version of its own.
    if (!getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)) ensureGatewayCatalogFailed()
    return
  }
  if (kind === 'temporary') {
    // Transient (refresh in flight, network blip, storage hiccup): no
    // evidence of an outage, so a catalog that already answered ('ready' or
    // an authoritative 'empty') must NOT be demoted. 'loading' with nothing
    // behind it carries no information, and there 'failed' is the only state
    // that puts the switcher's Retry on screen.
    const status = getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)
    if (status === 'ready' || status === 'empty') return
    ensureGatewayCatalogFailed()
    return
  }
  // 'expired' AND 'missing': the catalog cannot load until the user acts
  // (re-login, or a first sign-in). Registering the outage is what surfaces
  // Retry / re-login; REMOVING the provider is reserved for explicit logout
  // (#224) — an expired or never-signed-in session must stay visible.
  ensureGatewayCatalogFailed()
}

/** Register the provider if this context has none, then record the outage. */
function ensureGatewayCatalogFailed(): void {
  if (!getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)) registerLLMGatewayProvider()
  markGatewayCatalogFailed()
}

/**
 * Record that the gateway catalog cannot load until the user acts again,
 * keeping whatever model list is already registered for display.
 *
 * Deliberately does NOT claim a new catalog refresh version: this is not a
 * fetch outcome, and a refresh owned by newer work must not be invalidated by
 * a purge that happened before it (review: "Newer catalog is erased by
 * purge"). It also never resurrects a provider that was never registered.
 *
 * Called from the token-purge listener, i.e. synchronously inside the purge's
 * critical section — no catalog commit can interleave between the verdict and
 * this write (review: "Working catalog shows outage").
 */
export function markGatewayCatalogFailed(): void {
  if (!getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE)) return
  commitGatewayCatalog(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE), 'failed')
}

/**
 * Whether an outcome resolved by a boot is still that boot's to write.
 *
 * `resolveGatewayDispatchCredential` PURGES the stored pair on an 'expired'
 * verdict, and `clearStoredTokens` bumps the auth session generation itself —
 * that bump belongs to this boot and must not swallow the write. Any other
 * generation move (a login/logout in another context) supersedes it.
 */
export function isGatewayCredentialOutcomeCurrent(
  resolvedGeneration: number,
  currentGeneration: number,
  kind: 'temporary' | 'expired' | 'missing',
): boolean {
  if (currentGeneration === resolvedGeneration) return true
  return kind === 'expired' && currentGeneration === resolvedGeneration + 1
}

/** Register a previously fetched model list without another async boundary. */
export function registerGatewayModels(
  modelInfos: ModelInfo[],
  status: ProviderCatalogStatus = modelInfos.length > 0 ? 'ready' : 'failed',
  refreshVersion?: number,
): void {
  if (refreshVersion !== undefined && !isGatewayCatalogRefreshCurrent(refreshVersion)) return
  if (refreshVersion === undefined) catalogRefreshVersion++
  // Failed and successful-empty responses cannot establish which previously
  // seen models disappeared. Keep the last usable list for display, while
  // recording the actual outcome for retry and reconciliation.
  const models = status === 'failed' || status === 'empty'
    ? getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)
    : modelInfos
  commitGatewayCatalog(models, status)
}

function commitGatewayCatalog(models: ModelInfo[], status: ProviderCatalogStatus): void {
  const baseURL_str = getGatewayBaseURL()
  const config: Omit<LLMProviderConfig, 'apiKey'> = {
    baseURL: `${baseURL_str}/v1`,
    modelName: models[0]?.id || '',
    headers: {},
    apiMode: 'chat-completions',
  }

  const meta: ProviderMeta = {
    ...GATEWAY_META,
    models,
    catalogStatus: status,
  }

  registerDynamicProvider(LLM_GATEWAY_PROVIDER_TYPE, config, meta)
}

/** Seed the cache from an older success only while no newer usable list exists. */
export function retainSupersededGatewayModels(models: ModelInfo[], authGeneration: number): void {
  if (authGeneration !== getGatewayAuthSessionGeneration() || models.length === 0) return
  if (getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).length > 0) return
  if (getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE) === 'ready') return
  // The newer refresh still owns availability. Older data only fills the
  // otherwise empty cache and cannot make it authoritative.
  commitGatewayCatalog(models, getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE) === 'empty' ? 'empty' : 'failed')
}

/**
 * Hard deadline shared by every post-token /v1/models discovery path (login,
 * the gateway settings card and the startup restore). A gateway that accepts
 * the credential but never answers `/v1/models` must not hang the caller —
 * each path degrades best-effort on expiry instead.
 */
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

export async function updateGatewayModels(accessToken: string, expectedAuthGeneration = getGatewayAuthSessionGeneration()): Promise<ModelInfo[]> {
  // Startup restore (AppBootstrap awaits this before isStorageReady) and any
  // other caller must not hang forever on a gateway that accepts the saved
  // token but never answers /v1/models. Bound the discovery with the SAME
  // deadline the login and gateway-card paths use, and degrade best-effort:
  // on expiry register a FAILED (unknown) catalog — never an authoritative
  // empty one — so consumers keep deferring until a later refresh succeeds
  // (Sourcery: "Startup discovery can hang").
  if (expectedAuthGeneration !== getGatewayAuthSessionGeneration()) return getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)
  const sessionGeneration = expectedAuthGeneration
  let activeGeneration = sessionGeneration
  const refreshVersion = beginGatewayCatalogRefresh()
  try {
    const { models, status, authGeneration, reauthRequired } = await prepareGatewayModels(
      accessToken,
      AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
      true,
      (generation) => { activeGeneration = generation },
      expectedAuthGeneration,
    )
    if (reauthRequired) {
      clearGatewayCatalogForReauth(refreshVersion)
      return []
    }
    if ((authGeneration ?? sessionGeneration) === getGatewayAuthSessionGeneration() && isGatewayCatalogRefreshCurrent(refreshVersion)) {
      registerGatewayModels(models, status, refreshVersion)
    } else if (status === 'ready' && !isGatewayCatalogRefreshCurrent(refreshVersion)) {
      retainSupersededGatewayModels(models, authGeneration ?? sessionGeneration)
    }
  } catch (error) {
    if (activeGeneration === getGatewayAuthSessionGeneration() && isGatewayCatalogRefreshCurrent(refreshVersion)) {
      registerGatewayModels([], 'failed', refreshVersion)
    }
    throw error
  }
  return getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)
}

/** Clear cached models only when this refresh still owns a dead session. */
export function clearGatewayCatalogForReauth(refreshVersion: number): void {
  if (isGatewayCatalogRefreshCurrent(refreshVersion) && getGatewayCredentialStatus() !== 'valid') {
    unregisterLLMGatewayProvider()
  }
}

/**
 * Unregister LLM Gateway provider (for cleanup).
 */
export function unregisterLLMGatewayProvider(): void {
  unregisterDynamicProvider(LLM_GATEWAY_PROVIDER_TYPE)
}

/**
 * Check if LLM Gateway is the current active provider
 */
export function isLLMGatewayActive(providerType: LLMProviderType): boolean {
  return providerType === LLM_GATEWAY_PROVIDER_TYPE
}



/**
 * Fetch rate-limit / quota status from the gateway with automatic token
 * management.
 *
 * Acquires a valid access token (refreshing if needed), calls
 * `GET /v1/rate-limits`, and retries once on HTTP 401 after a force-refresh.
 *
 * Requires the user to be logged in (have stored gateway tokens).
 *
 * @returns The raw gateway response — structure is gateway-defined.
 * @throws Error when not logged in, or when the request fails after retry.
 */
export async function fetchGatewayRateLimits(): Promise<RateLimitsResponse> {
  const baseURL = getGatewayBaseURL()
  const clientId = getGatewayClientId()

  let token = await getValidAccessToken(baseURL, clientId)
  if (!token) {
    // Locale-aware error (zh: 坚果云 AI / others: Nutstore AI).
    // "expired" and "never logged in" need different recovery steps, so the
    // message must match the credential state the auth layer just recorded.
    const locale = useI18nStore.getState().locale
    const expired = getGatewayCredentialStatus() === 'expired'
    const key = expired
      ? 'settings.gateway.tokenInvalidLoginExpired'
      : 'settings.gateway.notLoggedInError'
    const msg = translateStatic(locale, key)
    throw new Error(
      msg !== key
        ? msg
        : expired
          ? 'Nutstore AI login has expired. Please log in again.'
          : 'Not logged in to Nutstore AI. Please log in first.'
    )
  }

  try {
    return await fetchRateLimits(baseURL, token)
  } catch (e) {
    // 401 → access token rejected by gateway; force-refresh and retry once
    const status = (e as Error & { status?: number }).status
    if (status === 401) {
      console.warn('[llm-gateway] rate-limits: 401, force-refreshing token...')
      token = await forceRefreshAccessToken(baseURL, clientId)
      if (!token) {
        // Localized actionable message — a bare hardcoded zh string here
        // leaked raw Chinese into other locales' error paths.
        const locale = useI18nStore.getState().locale
        const msg = translateStatic(locale, 'settings.gateway.tokenInvalidLoginExpired')
        throw new Error(
          msg !== 'settings.gateway.tokenInvalidLoginExpired'
            ? msg
            : 'Nutstore AI login has expired. Please log in again.'
        )
      }
      return await fetchRateLimits(baseURL, token)
    }
    throw e
  }
}

// Re-export auth functions for convenience
export {
  performDeviceCodeFlow,
  getValidAccessToken,
  getGatewayAuthSessionGeneration,
  hasStoredTokens,
  hasValidAccessToken,
  logoutGateway,
  fetchGatewayModels,
  fetchRateLimits,
  forceRefreshAccessToken,
  type AuthState,
  type TokenResponse,
  type RateLimitsResponse,
} from './llm-gateway-auth'
