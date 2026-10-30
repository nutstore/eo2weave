/**
 * LLM Gateway Device Code Flow Authentication
 *
 * Implements the device code flow for llm_gateway_service,
 * enabling browser-based OAuth login for CLI/desktop environments.
 *
 * @see https://gitea.jianguoyun.net.cn/huangqingming/llm_gateway_service
 */

import { t as translate } from '@creatorweave/i18n'
import { withGatewayCredentialLock } from '@/agent/providers/gateway-credential-lock'
import { saveApiKey as saveGatewayApiKey } from '@/security/api-key-store'
import { useI18nStore } from '@/i18n/store'

// ── Types ──

export interface GatewayEndpoints {
  /** Gateway base URL, e.g. "https://ai.jianguoyun.com" */
  baseURL: string
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  /** Recommended polling interval in seconds */
  interval: number
  /** Device session TTL in seconds */
  expires_in: number
}

export interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  /** Access token TTL in seconds */
  expires_in: number
  /**
   * Refresh token. The device-code login ALWAYS issues one, but
   * `/v1/auth/refresh` does NOT return it (confirmed by the backend:
   * the refresh token is issued once, lives 7 days, never rotates) —
   * so both fields are optional and only trusted when actually present.
   */
  refresh_token?: string
  /** Refresh token TTL in seconds — absent on /v1/auth/refresh responses. */
  refresh_expires_in?: number
}

export interface GatewayError {
  code: string
  message: string
  retriable: boolean
}

// ── Rate Limits ──

/**
 * A credit package: either the monthly quota or a purchased top-up pack.
 * The gateway bills in credits (积分) rather than currency.
 */
export interface CreditPackage {
  package_id: string
  /** "monthly" for the monthly quota, "payment" for top-up packs */
  source_type: string
  /** 包总额度（积分） */
  total_credit: number
  /** 已消耗额度（积分） */
  used_credit: number
  /** 剩余额度（积分） */
  remaining_credit: number
  /** 剩余百分比 (0–100) */
  remaining_percentage: number
  /**
   * ISO 8601 timestamp with timezone. For monthly packages this is the next
   * reset date (calendar month); for top-up packs this is the expiry date.
   * May be null when the gateway omits it.
   */
  expires_at: string | null
  /** e.g. "active" */
  status: string
}

/** Credit usage breakdown of `GET /v1/rate-limits`. */
export interface CreditUsage {
  /** 本月套餐（自然月刷新）；无月套餐时为 null */
  monthly: CreditPackage | null
  /** 已购充值积分包 */
  topup_packages: CreditPackage[]
}

/** Response of `GET /v1/rate-limits` (credit-based quota). */
export interface RateLimitsResponse {
  /** 用户标识 */
  uid: string
  /** 当前可用总积分（月套餐剩余 + 所有充值包剩余） */
  available_credit: number
  credit_usage: CreditUsage
}

// ── Token Persistence ──

const TOKEN_STORAGE_KEY = 'llm-gateway-tokens'

/**
 * Single source of truth for the api-key-store key holding the gateway
 * access_token (llm-gateway-provider.ts re-exports this). Lives HERE because
 * the auth layer must be able to purge a dead token without importing the
 * provider module (which statically imports this file — a dynamic import from
 * here would create a fragile cycle that silently breaks in test envs).
 */
export const LLM_GATEWAY_API_KEY_ID = '__llm_gateway_token__'

/**
 * SQLite-backed storage key for the refresh_token.
 *
 * access_token lives in the api-key-store under __llm_gateway_token__
 * (see llm-gateway-provider.ts). The refresh_token is persisted here so it
 * survives localStorage clearing — localStorage is volatile (browsers may
 * evict it, users may clear it, private mode discards it), while the
 * api-key-store is backed by SQLite in OPFS which is far more durable.
 *
 * We store a JSON blob containing refresh_token + expiry metadata so that on
 * restore we can reconstruct the full StoredTokens object.
 */
const REFRESH_TOKEN_DB_KEY = '__llm_gateway_refresh_token__'

/**
 * Public alias of `REFRESH_TOKEN_DB_KEY` for consumers that must exclude
 * gateway-owned keys from lists of "usable provider credentials" (e.g. the
 * AI-readiness probe): the refresh-token backup lives in the same
 * api-key-store as real provider keys, and counting it as one would let a
 * visitor skip login with no usable credential.
 */
export const LLM_GATEWAY_REFRESH_TOKEN_KEY_ID = REFRESH_TOKEN_DB_KEY

/**
 * Last credential status recorded by this module.
 *
 * The settings store holds the same value, but reading it back is async
 * (the store is loaded through a dynamic import), while callers such as
 * `fetchGatewayRateLimits` need the state of the token acquisition that
 * just failed — i.e. "expired" vs "never logged in" — to pick the right
 * message. This mirror keeps that read synchronous.
 */
let lastCredentialStatus: 'unknown' | 'valid' | 'expired' | 'missing' = 'unknown'

/** Keep the settings UI's credential state aligned with background auth checks. */
function setCredentialStatus(status: 'valid' | 'expired' | 'missing'): void {
  lastCredentialStatus = status
  void import('@/store/settings.store')
    .then(({ useSettingsStore }) => useSettingsStore.getState().setModelCredentialStatus(status))
    .catch(() => {
      // Auth must remain usable even when the settings store is unavailable.
    })
}

/**
 * Set the credential status INSIDE the credential lock's critical section.
 *
 * `logoutGateway` and the expired-token wipe use this instead of calling
 * `setCredentialStatus` after `clearStoredTokens()` resolves: between the
 * lock releasing and the post-hoc status write, a concurrent login can
 * commit new credentials — and the stale status write would then report
 * "logged out"/"expired" over fresh valid credentials.
 */
async function setCredentialStatusLocked(
  status: 'valid' | 'expired' | 'missing',
): Promise<void> {
  lastCredentialStatus = status
  try {
    const { useSettingsStore } = await import('@/store/settings.store')
    useSettingsStore.getState().setModelCredentialStatus(status)
  } catch {
    // Auth must remain usable even when the settings store is unavailable.
  }
}

/**
 * The credential status as of the last token operation performed by this
 * module. `'unknown'` means no token operation has run in this session yet.
 */
export function getGatewayCredentialStatus(): 'unknown' | 'valid' | 'expired' | 'missing' {
  return lastCredentialStatus
}

export type RefreshResult =
  | { status: 'success'; accessToken: string }
  | { status: 'expired'; error?: unknown }
  | { status: 'temporary_error'; error?: unknown }
  | { status: 'missing' }

export interface StoredTokens {
  access_token: string
  refresh_token: string
  /** Timestamp (ms) when the access_token expires */
  access_expires_at: number
  /** Timestamp (ms) when the refresh_token expires */
  refresh_expires_at: number
  /** The client_id used to obtain these tokens */
  client_id: string
  /** The gateway base URL */
  base_url: string
}

/**
 * Load tokens. Tries localStorage first (fast synchronous cache), then falls
 * back to SQLite api-key-store to recover the refresh_token when localStorage
 * has been cleared.
 *
 * This function is async because the SQLite fallback requires async I/O.
 * Callers that previously used the sync version must be updated to await.
 */
function loadStoredTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StoredTokens
  } catch {
    return null
  }
}

/**
 * Async variant: tries localStorage first, then recovers from SQLite.
 * Used by the token-refresh path where we need maximum durability.
 */
async function loadStoredTokensWithFallback(): Promise<StoredTokens | null> {
  // Fast path: localStorage hit
  const cached = loadStoredTokens()
  if (cached) return cached

  // Slow path: recover from SQLite api-key-store
  try {
    const { loadApiKey } = await import('@/security/api-key-store')
    const raw = await loadApiKey(REFRESH_TOKEN_DB_KEY)
    if (!raw) return null
    const recovered = JSON.parse(raw) as Partial<StoredTokens>
    if (!recovered.refresh_token || !recovered.refresh_expires_at) return null
    // Freshness check: SQLite is written fire-and-forget AFTER localStorage,
    // so a failed/gapped write can leave a PREVIOUS generation behind
    // (e.g. an already-rotated-out or already-expired refresh token).
    // Restoring a dead token would guarantee invalid_grant on the next
    // refresh — refuse instead and let the caller report the expired state.
    if (
      typeof recovered.refresh_expires_at !== 'number' ||
      !Number.isFinite(recovered.refresh_expires_at) ||
      recovered.refresh_expires_at <= Date.now()
    ) {
      console.warn(
        '[llm-gateway] SQLite fallback: stored refresh token is expired or malformed — not restoring'
      )
      return null
    }
    // The BACKUP READ itself must sit inside the credential lock: a logout
    // that purges both stores between our read (outside the lock) and the
    // restore write (inside it) would be silently undone — the logged-out
    // session would come back to life with the pre-logout credential. The
    // lock serializes read → re-check → restore against clearStoredTokens.
    return await withGatewayCredentialLock(async () => {
      // A newer login may have committed while we waited for the lock.
      const current = loadStoredTokens()
      if (current) return current
      // Re-read the backup under the lock too: a logout may have purged the
      // SQLite row after our pre-lock read captured it.
      const { loadApiKey } = await import('@/security/api-key-store')
      const fresh = await loadApiKey(REFRESH_TOKEN_DB_KEY)
      if (!fresh) return null
      let freshRecovered: Partial<StoredTokens>
      try {
        freshRecovered = JSON.parse(fresh) as Partial<StoredTokens>
      } catch {
        return null
      }
      if (!freshRecovered.refresh_token || !freshRecovered.refresh_expires_at) return null
      if (
        typeof freshRecovered.refresh_expires_at !== 'number' ||
        !Number.isFinite(freshRecovered.refresh_expires_at) ||
        freshRecovered.refresh_expires_at <= Date.now()
      ) {
        return null
      }
      const freshRestored: StoredTokens = {
        access_token: freshRecovered.access_token || '',
        refresh_token: freshRecovered.refresh_token,
        access_expires_at: freshRecovered.access_expires_at || 0,
        refresh_expires_at: freshRecovered.refresh_expires_at,
        client_id: freshRecovered.client_id || '',
        base_url: freshRecovered.base_url || '',
      }
      try {
        localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(freshRestored))
      } catch {
        // A disabled/full localStorage does not prevent this request from
        // using the recovered pair in memory.
      }
      return freshRestored
    })
  } catch {
    return null
  }
}

function saveStoredTokens(tokens: StoredTokens): void {
  bumpAuthSessionGeneration()
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens))
  // Also persist refresh_token to SQLite for durability across localStorage clears.
  // The backup write may run after a newer login. Serialize and verify its
  // source pair so an older background write cannot replace that backup.
  void withGatewayCredentialLock(async () => {
    const current = loadStoredTokens()
    if (!current || JSON.stringify(current) !== JSON.stringify(tokens)) return
    await persistRefreshTokenToSQLite(tokens)
  }).catch((e) => {
    console.warn('[llm-gateway] persist refresh_token to SQLite failed:', e)
  })
}

/**
 * Persist refresh_token + metadata to SQLite api-key-store.
 * This survives localStorage clearing (browser eviction, user clear, private mode).
 */
async function persistRefreshTokenToSQLite(tokens: StoredTokens): Promise<void> {
  const { saveApiKey } = await import('@/security/api-key-store')
  // Store a compact JSON blob with refresh_token + expiry info
  const blob = JSON.stringify({
    refresh_token: tokens.refresh_token,
    refresh_expires_at: tokens.refresh_expires_at,
    access_token: tokens.access_token,
    access_expires_at: tokens.access_expires_at,
    client_id: tokens.client_id,
    base_url: tokens.base_url,
  })
  await saveApiKey(REFRESH_TOKEN_DB_KEY, blob)
}

/**
 * Check if an error indicates the refresh_token is definitively invalid
 * (revoked, expired, etc.) — as opposed to a transient network error.
 */
function isTokenInvalidError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const err = e as Error & { code?: string; status?: number }
  // OAuth2 standard: invalid_grant means refresh_token is revoked or expired.
  if (err.code === 'invalid_grant') return true
  // HTTP 400/401 from the refresh endpoint means the token is bad
  // (network errors throw TypeError, not our Error-with-status objects)
  if (typeof err.status === 'number' && (err.status === 400 || err.status === 401)) return true
  return false
}

async function clearStoredTokens(
  expectedRefreshToken?: string,
  finalStatus?: 'expired' | 'missing',
): Promise<boolean> {
  return withGatewayCredentialLock(async () => {
    const current = loadStoredTokens()
    if (expectedRefreshToken && current?.refresh_token !== expectedRefreshToken) return false
    bumpAuthSessionGeneration()
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    // Purge both SQLite-side credentials before releasing the lock, so a
    // later login cannot have its new access key deleted by this logout.
    try {
      const { deleteApiKey } = await import('@/security/api-key-store')
      await deleteApiKey(REFRESH_TOKEN_DB_KEY)
      // The api-key-store also holds the stale access_token under the
      // provider key. The settings card derives its logged-in badge from
      // that key alone — leaving it behind shows "Logged in" UI with a
      // logout button while every request 401s (user-reported bug).
      await deleteApiKey(LLM_GATEWAY_API_KEY_ID)
    } catch (e) {
      // Diagnostic log on purpose — a silent failure here would re-create
      // the "logged-in badge on a dead session" state with no way to debug.
      console.warn('[llm-gateway] failed to purge stored credentials:', e)
    }
    // The status write is part of the same critical section as the purge:
    // a login committing between the purge and a post-lock status write
    // would be reported "logged out"/"expired" over fresh valid credentials.
    if (finalStatus) await setCredentialStatusLocked(finalStatus)
    return true
  })
}

/**
 * Detect (and purge) a stale access_token shadow left behind in the
 * api-key-store.
 *
 * The shadow (LLM_GATEWAY_API_KEY_ID) is written on every successful login
 * and is the key the settings card's "Logged in" badge is derived from. When
 * a session dies, the token pair is purged — but the shadow can survive
 * (e.g. only the localStorage copy was lost, or purging one key failed).
 * The card would then show "Logged in" + "Log out" while every gateway call
 * reports "not logged in" (user-reported bug).
 *
 * Returns true when a shadow was found — i.e. the user HAD logged in and the
 * session died ('expired') — and false when there was never a session
 * ('missing').
 */
async function purgeStaleAccessTokenShadow(): Promise<boolean> {
  try {
    return await withGatewayCredentialLock(async () => {
      if (loadStoredTokens()) return false
      const { loadApiKey, deleteApiKey } = await import('@/security/api-key-store')
      const shadow = await loadApiKey(LLM_GATEWAY_API_KEY_ID)
      // A new session can appear during the key-store read. Do not delete
      // its access shadow when the earlier no-token observation is stale.
      if (!shadow || loadStoredTokens()) return false
      await deleteApiKey(LLM_GATEWAY_API_KEY_ID)
      return true
    })
  } catch (e) {
    // Diagnostic log on purpose — a silent failure here would keep the
    // "logged-in badge on a dead session" state with no way to debug.
    console.warn('[llm-gateway] failed to inspect the access_token shadow:', e)
    return false
  }
}

//
// NOTE: clearStoredTokens() purges both SQLite keys (refresh-token backup +
// the access_token shadow) through a single dynamic import — see the comment
// inside it. purgeStaleAccessTokenShadow() is the narrow counterpart for the
// case where the token pair is ALREADY gone but the shadow survived.
//
// ── API Calls ──

async function gatewayFetch<T>(
  baseURL: string,
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${baseURL}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (res.ok) {
    return res.json() as Promise<T>
  }

  // Try to parse error body
  let errorBody: GatewayError | null = null
  try {
    errorBody = await res.json()
  } catch {
    // ignore
  }

  const err = new Error(
    errorBody?.message || `LLM Gateway error: ${res.status} ${res.statusText}`
  ) as Error & { code?: string; status?: number; retriable?: boolean }
  err.code = errorBody?.code || 'unknown'
  err.status = res.status
  err.retriable = errorBody?.retriable ?? false
  throw err
}

// ── Device Code Flow ──

/**
 * Step 1: Create a device authorization session
 */
export async function createDeviceSession(
  baseURL: string,
  clientId: string,
  signal?: AbortSignal,
): Promise<DeviceCodeResponse> {
  return gatewayFetch<DeviceCodeResponse>(baseURL, '/v1/auth/device/code', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId }),
    signal,
  })
}

/**
 * Step 2: Open browser for user authorization
 */
export function openAuthorizationPage(verificationUri: string, userCode?: string): void {
  // If the server already includes user_code in the verification_uri,
  // don't append it again (would cause double ?user_code=... leading to
  // a malformed URL like ?user_code=XXX%3Fuser_code%3DXXX).
  const alreadyHasUserCode = verificationUri.includes('user_code=')
  const url = userCode && !alreadyHasUserCode
    ? appendQueryParam(verificationUri, 'user_code', userCode)
    : verificationUri
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Append a query parameter to a URL, using ? or & as appropriate.
 */
function appendQueryParam(uri: string, key: string, value: string): string {
  const separator = uri.includes('?') ? '&' : '?'
  return `${uri}${separator}${key}=${encodeURIComponent(value)}`
}

/**
 * Step 3: Poll for device token (returns null while pending)
 */
export async function pollDeviceToken(
  baseURL: string,
  deviceCode: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<TokenResponse | null> {
  try {
    const res = await fetch(`${baseURL}/v1/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
      signal,
    })

    if (res.status === 200) {
      return res.json() as Promise<TokenResponse>
    }

    if (res.status === 202) {
      // authorization_pending — still waiting
      return null
    }

    const body = await res.json().catch(() => ({ code: 'unknown', message: res.statusText }))

    if (body.code === 'slow_down') {
      // Need to slow down polling
      const err = new Error('Polling too fast') as Error & { code: string; retriable: boolean }
      err.code = 'slow_down'
      err.retriable = true
      throw err
    }

    if (body.code === 'authorization_pending') {
      return null
    }

    // Terminal errors (access_denied, expired_token, invalid_grant, etc.)
    const err = new Error(
      body.message || `Device auth failed: ${res.status}`
    ) as Error & { code: string; retriable: boolean }
    err.code = body.code || 'unknown'
    err.retriable = body.retriable ?? false
    throw err
  } catch (e) {
    // Re-throw our own errors
    if (e && typeof e === 'object' && 'code' in e) throw e
    // Network errors
    const err = new Error(
      `Network error: ${(e as Error).message}`
    ) as Error & { code: string; retriable: boolean }
    err.code = 'network_error'
    err.retriable = true
    throw err
  }
}

/**
 * Step 4: Cancel a device authorization session
 */
export async function cancelDeviceSession(
  baseURL: string,
  deviceCode: string
): Promise<void> {
  await gatewayFetch(baseURL, '/v1/auth/device/cancel', {
    method: 'POST',
    body: JSON.stringify({ device_code: deviceCode }),
  })
}

// ── Token Refresh ──

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(
  baseURL: string,
  refreshToken: string
): Promise<TokenResponse> {
  return gatewayFetch<TokenResponse>(baseURL, '/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
}

/**
 * Update the API key store with a new access token.
 * Call after refresh to ensure the next LLM request uses the new token.
 */
export async function persistAccessTokenToKeyStore(accessToken: string): Promise<void> {
  // Keep this auth-layer write independent from the provider module. The
  // provider re-exports this auth module, so importing it here creates a
  // fragile cycle.
  await saveGatewayApiKey(LLM_GATEWAY_API_KEY_ID, accessToken)
}

/**
 * Bound any promise with a hard deadline so a stalled key-store write (or
 * SQLite read) cannot hold the origin-wide credential lock forever — every
 * later login/refresh/logout queues behind it and never completes.
 *
 * The deadline is deliberately generous (10s): the goal is deadlock
 * protection, not fast failure. On expiry the underlying write MAY still
 * complete later; callers treat the timeout as "nonessential write failed"
 * and keep the in-memory/localStorage state authoritative.
 */
export async function withKeyStoreDeadline<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('key store write timed out')), 10_000)
  })
  try {
    return await Promise.race([p, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── High-Level Auth Functions ──

export interface AuthState {
  status: 'idle' | 'requesting' | 'waiting' | 'polling' | 'success' | 'error'
  userCode?: string
  verificationUri?: string
  error?: string
}

type AuthStateListener = (state: AuthState) => void

/** Commit a validated device-code token pair after all cancellable work. */
export function persistDeviceLoginTokens(
  tokens: TokenResponse,
  clientId: string,
  baseURL: string,
): void {
  if (!tokens.refresh_token || typeof tokens.refresh_expires_in !== 'number') {
    throw new Error('Device login returned an incomplete token pair.')
  }
  const now = Date.now()
  saveStoredTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_expires_at: now + tokens.expires_in * 1000,
    refresh_expires_at: now + tokens.refresh_expires_in * 1000,
    client_id: clientId,
    base_url: baseURL,
  })
  setCredentialStatus('valid')
}

/**
 * Perform the complete Device Code Flow:
 * 1. Create device session
 * 2. Open browser for user
 * 3. Poll until authorized
 * 4. Return the token pair for the caller's serialized credential commit
 *
 * @returns The access token on success
 */
export async function performDeviceCodeFlow(
  baseURL: string,
  clientId: string,
  onStateChange?: AuthStateListener,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const emit = (state: AuthState) => onStateChange?.(state)

  // Step 1: Create device session
  emit({ status: 'requesting' })
  const session = await createDeviceSession(baseURL, clientId, signal)
  signal?.throwIfAborted()

  emit({
    status: 'waiting',
    userCode: session.user_code,
    verificationUri: session.verification_uri,
  })

  // Step 2: Open browser
  openAuthorizationPage(session.verification_uri, session.user_code)

  // Step 3: Poll
  emit({ status: 'polling', userCode: session.user_code, verificationUri: session.verification_uri })

  const startTime = Date.now()
  const expiresMs = session.expires_in * 1000
  let interval = session.interval * 1000
  let slowDownCount = 0

  while (Date.now() - startTime < expiresMs) {
    await sleep(interval)
    signal?.throwIfAborted()

    try {
      const tokens = await pollDeviceToken(baseURL, session.device_code, session.user_code, signal)
      signal?.throwIfAborted()
      if (tokens) {
        // Success! Save tokens. The device-code login ALWAYS issues the
        // refresh token (unlike /v1/auth/refresh) — but guard anyway so a
        // malformed response can't write NaN/undefined into storage.
        const refreshExpiresIn = tokens.refresh_expires_in
        if (
          !tokens.access_token ||
          !tokens.refresh_token ||
          typeof refreshExpiresIn !== 'number' ||
          !Number.isFinite(refreshExpiresIn) ||
          refreshExpiresIn <= 0 ||
          typeof tokens.expires_in !== 'number' ||
          !Number.isFinite(tokens.expires_in) ||
          tokens.expires_in <= 0
        ) {
          const err = new Error(
            translate(useI18nStore.getState().locale, 'conversation.error.gatewayTokenSetMalformed')
          ) as Error & {
            code: string
            retriable: boolean
          }
          err.code = 'network_error'
          err.retriable = false
          throw err
        }
        // The caller commits the pair with the access key under the shared
        // credential lock after its other cancellable work is complete.
        return tokens
      }
      // Still pending, continue polling
      slowDownCount = 0
    } catch (e) {
      signal?.throwIfAborted()
      const err = e as Error & { code?: string; retriable?: boolean }

      if (err.code === 'slow_down') {
        // Increase interval by 5 seconds
        slowDownCount++
        interval = (session.interval + slowDownCount * 5) * 1000
        continue
      }

      if (err.retriable) {
        continue
      }

      // Terminal error
      emit({ status: 'error', error: err.message })
      throw err
    }
  }

  // Expired — the LOCAL polling session timed out. This is NOT evidence that
  // stored gateway credentials are invalid (the user may simply have been
  // slow entering the code), so it must not share the 'expired_token' code
  // the gateway uses for revoked/invalid credentials.
  const err = new Error(
    translate(useI18nStore.getState().locale, 'conversation.error.gatewayDeviceFlowTimeout')
  ) as Error & { code: string }
  err.code = 'device_flow_timeout'
  emit({ status: 'error', error: err.message })
  throw err
}

/**
 * Force-refresh the access token, bypassing the local expiry check.
 *
 * Use this when the gateway has already rejected the current access token
 * (e.g. HTTP 401 "gateway token expired"). In that situation the server is
 * the source of truth — the local `access_expires_at` timestamp may still
 * be in the future (clock skew, early revocation, etc.), so we must NOT
 * trust it and must unconditionally call `/v1/auth/refresh`.
 *
 * Returns the new access token, or null when there is no stored refresh
 * token or the refresh call fails.
 */
export function refreshAccessTokenWithStatus(
  baseURL: string,
  clientId: string
): Promise<RefreshResult> {
  const generation = authSessionGeneration
  // Reuse the in-flight refresh only within the same credential session — a
  // logout or new login invalidates the result the promise will resolve with.
  if (refreshInFlight && generation === (refreshInFlight as InFlightRefresh).generation) {
    return refreshInFlight
  }
  const request = refreshAccessTokenWithStatusImpl(baseURL, clientId)
  const tracked: InFlightRefresh = Object.assign(request, { generation })
  refreshInFlight = tracked
  // Clear on settle via then(onFulfilled, onRejected): unlike finally(), this
  // observes the rejection so no floating rejected promise is left unhandled.
  void request.then(
    () => {
      if (refreshInFlight === tracked) refreshInFlight = null
    },
    () => {
      if (refreshInFlight === tracked) refreshInFlight = null
    },
  )
  return tracked
}

interface InFlightRefresh extends Promise<RefreshResult> {
  generation: number
}

let refreshInFlight: Promise<RefreshResult> | null = null

/**
 * Session generation — bumped on every credential-set change (new login via
 * saveStoredTokens, logout/clear via clearStoredTokens). Async work started
 * under one generation must not write under a newer one: a late shadow save
 * after logout would resurrect cleared credentials, and an in-flight refresh
 * for a replaced session must not overwrite the new token pair.
 */
let authSessionGeneration = 0

/** Invalidate async work belonging to the previous credential set. */
function bumpAuthSessionGeneration(): void {
  authSessionGeneration++
}

async function refreshAccessTokenWithStatusImpl(
  baseURL: string,
  clientId: string
): Promise<RefreshResult> {
  // Snapshot BEFORE the first await — logout/login during the refresh window
  // is detected by comparing against this value after each await boundary.
  const generation = authSessionGeneration
  // Use the async fallback loader — recovers refresh_token from SQLite
  // when localStorage has been cleared (browser eviction, user clear, etc.)
  const stored = await loadStoredTokensWithFallback()
  if (!stored) {
    console.warn('[llm-gateway] forceRefresh: no stored tokens (localStorage + SQLite both empty)')
    // The token pair is gone, but the api-key-store may still hold the
    // access_token shadow of an earlier session. That means the session DIED
    // (the user had logged in), not that they never logged in — report
    // 'expired' and purge the shadow so the settings card offers a re-login
    // instead of a logout.
    const hadSession = await purgeStaleAccessTokenShadow()
    setCredentialStatus(hadSession ? 'expired' : 'missing')
    return hadSession ? { status: 'expired' } : { status: 'missing' }
  }

  // Remember which refresh token this request used: ownership of the stored
  // credential is checked before any clear below.
  const requestRefreshToken = stored.refresh_token

  // Refresh token must still be alive
  const now = Date.now()
  if (stored.refresh_expires_at <= now) {
    console.warn('[llm-gateway] forceRefresh: refresh_token expired', {
      refresh_expires_at: new Date(stored.refresh_expires_at).toISOString(),
      now: new Date(now).toISOString(),
    })
    if (!await clearStoredTokens(requestRefreshToken)) {
      return { status: 'temporary_error', error: new Error('session changed during refresh') }
    }
    setCredentialStatus('expired')
    return { status: 'expired' }
  }

  console.warn('[llm-gateway] forceRefresh: calling /v1/auth/refresh ...')

  try {
    const tokens = await refreshAccessToken(baseURL, stored.refresh_token)

    // Schema validation (defensive — the backend contract says the refresh
    // endpoint returns only access_token/expires_in/token_type, but a broken
    // gateway could omit the access token or send a zero/negative TTL).
    // Persisting such a response would corrupt the stored pair, so treat it
    // as a transient gateway problem instead.
    const expiresIn = tokens.expires_in
    if (
      !tokens.access_token ||
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      console.warn('[llm-gateway] forceRefresh: malformed refresh response — treating as temporary error', {
        hasAccessToken: !!tokens.access_token,
        expires_in: expiresIn,
      })
      return { status: 'temporary_error', error: new Error('malformed refresh response') }
    }

    // The session changed while the refresh request was in flight (logout or
    // new login) — the response belongs to a dead session. Discard it without
    // touching storage: writing it would clobber the newer credential set.
    if (authSessionGeneration !== generation) {
      console.warn('[llm-gateway] refresh completed after session change; discarding result')
      return { status: 'temporary_error', error: new Error('session changed during refresh') }
    }
    const completedAt = Date.now()
    // /v1/auth/refresh does NOT return a refresh_token (confirmed by backend:
    // the refresh token is issued once at device-code login, lives 7 days,
    // never rotates). Preserve the stored refresh_token / refresh_expires_at —
    // the 7-day clock keeps ticking from LOGIN, not from this refresh. Honor
    // a refresh_token in the response only if the backend ever starts
    // rotating (defensive forward-compatibility).
    const responseRefreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token
      ? tokens.refresh_token
      : null
    const responseRefreshExpiresIn =
      typeof tokens.refresh_expires_in === 'number' &&
      Number.isFinite(tokens.refresh_expires_in) &&
      tokens.refresh_expires_in > 0
        ? tokens.refresh_expires_in
        : null
    return await withGatewayCredentialLock(async (): Promise<RefreshResult> => {
      // The generation is tab-local; compare the shared refresh-token identity
      // under the same lock used by every device-login commit.
      const current = loadStoredTokens()
      if (authSessionGeneration !== generation || current?.refresh_token !== requestRefreshToken) {
        return { status: 'temporary_error', error: new Error('session changed during refresh') }
      }
      saveStoredTokens({
        access_token: tokens.access_token,
        refresh_token: responseRefreshToken ?? stored.refresh_token,
        access_expires_at: completedAt + expiresIn * 1000,
        refresh_expires_at: responseRefreshExpiresIn !== null
          ? completedAt + responseRefreshExpiresIn * 1000
          : stored.refresh_expires_at,
        client_id: clientId,
        base_url: baseURL,
      })
      // Keep the access shadow write within the same cross-tab commit, but
      // bound it: a stalled key-store write must not hold the credential
      // lock forever (later commits/logout queue behind it indefinitely).
      // The shadow is a display/cache convenience — localStorage and the
      // SQLite refresh-token backup remain authoritative.
      try {
        await withKeyStoreDeadline(persistAccessTokenToKeyStore(tokens.access_token))
      } catch (error) {
        console.warn('[llm-gateway] persist refreshed access token shadow failed:', error)
      }
      setCredentialStatus('valid')
      return { status: 'success', accessToken: tokens.access_token }
    })
  } catch (e) {
    // Only clear tokens if the refresh_token is definitively invalid.
    // Network errors (TypeError), 5xx, etc. should NOT wipe tokens —
    // they are transient and the user shouldn't have to re-login.
    if (isTokenInvalidError(e)) {
      // Ownership check: another context (a second tab, another device's
      // logout, a concurrent new login) may have already replaced or cleared
      // the stored refresh token while our request was in flight. Only the
      // owner of the CURRENT stored value may wipe the shared stores —
      // otherwise we would erase a credential that no longer belongs to the
      // failed request. A non-owner drops just the local in-memory session
      // state; the shared stores keep the newer credential.
      const current = loadStoredTokens()
      if (current && current.refresh_token !== requestRefreshToken) {
        console.warn(
          '[llm-gateway] forceRefresh: stored refresh token changed during refresh; clearing local session state only'
        )
        bumpAuthSessionGeneration()
        setCredentialStatus('expired')
        return { status: 'expired', error: e }
      }
      console.warn('[llm-gateway] forceRefresh: token invalid, clearing stored tokens', e)
      // The refresh_token is dead, so the login is unrecoverable.
      // clearStoredTokens() also purges the api-key-store access_token
      // shadow (the key the settings card's logged-in badge derives from),
      // so the UI falls back to the logged-out state with a login button.
      if (!await clearStoredTokens(requestRefreshToken)) {
        return { status: 'temporary_error', error: new Error('session changed during refresh') }
      }
      setCredentialStatus('expired')
      return { status: 'expired', error: e }
    } else {
      console.warn('[llm-gateway] forceRefresh: transient error, keeping stored tokens', e)
      return { status: 'temporary_error', error: e }
    }
  }
}

/** Backwards-compatible token-only refresh API. */
export async function forceRefreshAccessToken(
  baseURL: string,
  clientId: string
): Promise<string | null> {
  const result = await refreshAccessTokenWithStatus(baseURL, clientId)
  return result.status === 'success' ? result.accessToken : null
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no tokens are stored or refresh fails.
 */
export async function getValidAccessToken(
  baseURL: string,
  clientId: string
): Promise<string | null> {
  // Use the async fallback loader — recovers refresh_token from SQLite
  // when localStorage has been cleared
  const stored = await loadStoredTokensWithFallback()
  if (!stored) {
    // The token pair is gone, but the api-key-store may still hold the
    // access_token shadow of an earlier session. That means the session DIED
    // (the user had logged in), not that they never logged in — report
    // 'expired' and purge the shadow so the settings card offers a re-login
    // instead of a logout.
    const hadSession = await purgeStaleAccessTokenShadow()
    setCredentialStatus(hadSession ? 'expired' : 'missing')
    return null
  }

  const now = Date.now()

  // If access token is still valid (with 60s buffer), return it
  if (stored.access_expires_at > now + 60_000) {
    setCredentialStatus('valid')
    return stored.access_token
  }

  // Try to refresh. Same 60s buffer as the refresh-token liveness check below
  // (and the force path's unconditional refresh): a marginally-alive refresh
  // token must still be ATTEMPTED — the gateway, not the local clock, is the
  // authority on whether the credential is usable.
  if (stored.refresh_expires_at > now) {
    const result = await refreshAccessTokenWithStatus(baseURL, clientId)
    if (result.status === 'success') return result.accessToken
    return null
  }

  // Both tokens expired — the status write happens inside the purge's
  // critical section so a concurrent login cannot be mislabeled.
  if (await clearStoredTokens(stored.refresh_token, 'expired')) return null
  // The purge was a no-op (another context already cleared or replaced the
  // credential). The stored token we read is stale either way.
  return null
}

/**
 * Check if we have any stored tokens (even if expired)
 */
export function hasStoredTokens(): boolean {
  return loadStoredTokens() !== null
}

/**
 * Check if we have a currently valid access token
 */
export function hasValidAccessToken(): boolean {
  const stored = loadStoredTokens()
  if (!stored) return false
  return stored.access_expires_at > Date.now() + 60_000
}

/**
 * Logout — clear all stored tokens.
 *
 * clearStoredTokens() also purges the api-key-store access_token shadow
 * (the key the settings card's logged-in badge is derived from).
 */
export async function logoutGateway(): Promise<void> {
  // 'missing' is written inside the same lock-held critical section as the
  // purge: a new login committing right after the purge would otherwise be
  // relabeled "missing" by this post-lock write.
  await clearStoredTokens(undefined, 'missing')
}

/**
 * Fetch available models from the gateway
 */
export async function fetchGatewayModels(
  baseURL: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${baseURL}/v1/models`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  if (!res.ok) return []

  const data = await res.json()
  if (!data?.data || !Array.isArray(data.data)) return []

  return data.data.map(
    (m: { id?: string; name?: string }) => ({
      id: m.id || '',
      name: m.name || m.id || '',
    })
  )
}

/**
 * Fetch rate-limit / quota status from the gateway.
 *
 * GET /v1/rate-limits with Authorization: Bearer <access_token>.
 *
 * The response structure is gateway-defined and not yet documented in the
 * device-code-flow integration doc (only the endpoint path is listed in §3.7).
 * This function returns the raw JSON so callers can inspect the actual shape.
 *
 * @throws Error with `.status` set to the HTTP status code on non-2xx
 *   (401 when the access token is expired, 403 when rate-limited, etc.)
 */
export async function fetchRateLimits(
  baseURL: string,
  accessToken: string
): Promise<RateLimitsResponse> {
  const res = await fetch(`${baseURL}/v1/rate-limits`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = new Error(
      `fetchRateLimits failed: ${res.status} ${res.statusText}`
    ) as Error & { status?: number }
    err.status = res.status
    // Attach response body for easier debugging
    try {
      const body = await res.text()
      if (body) {
        err.message = `${err.message} — ${body}`
      }
    } catch {
      // ignore body read failure
    }
    throw err
  }

  return res.json()
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
