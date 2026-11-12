/**
 * Nutstore AI (坚果云 AI) — persisted provider id: `llm-gateway`
 *
 * Device Code Flow Authentication
 *
 * Implements the device code flow for llm_gateway_service,
 * enabling browser-based OAuth login for CLI/desktop environments.
 *
 * @see https://gitea.jianguoyun.net.cn/huangqingming/llm_gateway_service
 */

import { getGatewayDispatchCredentialKey, LLM_GATEWAY_REFRESH_TOKEN_KEY_ID } from '@/agent/providers/gateway-credential-alias'
import { credentialRegistry } from '@/agent/providers/credential-state'
import { t as translate } from '@creatorweave/i18n'
import {
  pendingKeyStoreOpIsFenced,
  trackPendingKeyStoreOp,
  withGatewayCredentialLock,
} from '@/agent/providers/gateway-credential-lock'
import { useI18nStore } from '@/i18n/store'
import { unregisterDynamicProvider, type ProviderCatalogStatus } from '@/agent/providers/types'

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

// ── Cross-tab session events (observer subscription) ─────────────────
//
// The storage listener below implements INVALIDATION only: it bumps the
// tab-local auth generation and unregisters the provider. It deliberately
// does NOT import the provider module (a static auth → provider import
// would create a fragile auth <-> provider import cycle), so
// re-adoption of the new session cannot live here. Instead the listener
// publishes a small typed event, and the observer-side reconciler
// (gateway-session-reconciler.ts, wired from the app lifecycle) subscribes
// and performs the re-adoption. Subscribers receive the RAW storage values:
// they must re-read the latest shared session rather than trusting the
// event payload (the event can be stale by the time the handler runs).

export type GatewaySessionEventType = 'identity-change' | 'access-refresh'

export interface GatewaySessionEvent {
  type: GatewaySessionEventType
  /**
   * Refresh-token identity BEFORE the change (null when the old value was
   * absent/unparseable). Raw from the storage event — informational only.
   */
  oldRefreshToken: string | null
  /** Refresh-token identity AFTER the change (null on logout). */
  newRefreshToken: string | null
  /**
   * The auth generation observed when the listener ran (after the bump for
   * identity changes). Observers fence their async work against
   * `getGatewayAuthSessionGeneration()`, not this value.
   */
  generation: number
}

type GatewaySessionListener = (event: GatewaySessionEvent) => void

const gatewaySessionListeners = new Set<GatewaySessionListener>()

/**
 * Subscribe to cross-tab gateway session events. Returns an unsubscribe
 * function. Emitted from this module's `storage` listener only — local
 * (same-tab) commits already reconcile their own state.
 */
export function subscribeToGatewaySessionEvents(
  listener: GatewaySessionListener,
): () => void {
  gatewaySessionListeners.add(listener)
  return () => {
    gatewaySessionListeners.delete(listener)
  }
}

function emitGatewaySessionEvent(event: GatewaySessionEvent): void {
  for (const listener of gatewaySessionListeners) {
    try {
      listener(event)
    } catch (e) {
      // A broken subscriber must not break the other subscribers or the
      // storage listener itself.
      console.warn('[llm-gateway] session event subscriber threw:', e)
    }
  }
}

// Another tab can replace or clear the session without touching this tab's
// registry. Drop its cached models before the next discovery can retain them.
// Two distinct cases:
//  - identity-change: the refresh token itself changed (login, account
//    replacement or logout). The cached session generation is invalidated
//    and the provider is unregistered; the reconciler re-adopts.
//  - access-refresh: the SAME refresh token with a fresher access token —
//    another tab refreshed under the documented non-rotating contract
//    (#172 finding 1). No generation bump and no unregistration: the session
//    identity did not change. The event lets a tab that had marked the
//    session expired reconcile against the now-valid shared credential.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_STORAGE_KEY) return
    const parse = (value: string | null): { refresh: string | null; accessChanged: boolean } => {
      if (!value) return { refresh: null, accessChanged: false }
      try {
        const parsed = JSON.parse(value) as Partial<StoredTokens>
        return {
          refresh: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
          accessChanged: true,
        }
      } catch {
        return { refresh: null, accessChanged: false }
      }
    }
    const oldParsed = parse(event.oldValue)
    const newParsed = parse(event.newValue)
    if (oldParsed.refresh !== newParsed.refresh) {
      bumpAuthSessionGeneration()
      // Do NOT unregister here: this event fires on ANY identity change,
      // including a write that has not settled, and the provider then stays
      // unregistered whenever the reconciler cannot resolve a session on its
      // first try (observed as "provider unavailable, sign in again" right
      // after the side panel opened). The reconciler owns that decision and
      // unregisters only on a CONFIRMED missing/expired verdict.
      //
      // The previous account's models must still not survive the swap, so
      // drop the catalog to 'loading' instead — a dynamic import keeps the
      // auth → provider direction out of the module graph.
      // Only when no reconciler owns the state in this tab: otherwise its
      // in-flight reconcile would race this clear and could overwrite a
      // freshly loaded catalog with 'loading'.
      void import('@/agent/providers/gateway-session-reconciler')
        .then(({ isGatewayReconcilerInstalled }) => {
          if (isGatewayReconcilerInstalled()) return
          return import('@/agent/providers/llm-gateway-provider').then(
            ({ registerGatewayModels }) => registerGatewayModels([], 'loading'),
          )
        })
        .catch(() => {})
      emitGatewaySessionEvent({
        type: 'identity-change',
        oldRefreshToken: oldParsed.refresh,
        newRefreshToken: newParsed.refresh,
        generation: getGatewayAuthSessionGeneration(),
      })
    } else if (oldParsed.accessChanged || newParsed.accessChanged) {
      // Same refresh identity, different serialized value: an access-only
      // refresh (or a metadata rewrite) in another tab.
      emitGatewaySessionEvent({
        type: 'access-refresh',
        oldRefreshToken: oldParsed.refresh,
        newRefreshToken: newParsed.refresh,
        generation: getGatewayAuthSessionGeneration(),
      })
    }
  })
}

/**
 * SQLite-backed storage key for the refresh_token.
 *
 * This record is the gateway's only durable credential state (#277): the
 * access_token lives in localStorage (volatile — browsers evict it, users
 * clear it, private mode discards it) and the refresh_token is persisted here
 * so a session survives that. It is also the tombstone that tells "session
 * died" apart from "never logged in".
 *
 * We store a JSON blob containing refresh_token + expiry metadata so that on
 * restore we can reconstruct the full StoredTokens object.
 */
const REFRESH_TOKEN_DB_KEY = LLM_GATEWAY_REFRESH_TOKEN_KEY_ID

/**
 * localStorage marker recording when the last logout purged credentials.
 * A device-code login that was APPROVED before this timestamp must not
 * commit afterwards (the user changed their mind — see gateway-login's
 * commit re-check).
 */
const LOGOUT_MARKER_KEY = '__llm_gateway_last_logout_at__'

/**
 * localStorage marker recording that this browser's gateway session DIED
 * (an expired purge committed), as opposed to the user never having logged
 * in or having logged out explicitly.
 *
 * `clearStoredTokens` deletes the SQLite refresh-token record — the record
 * `inspectPriorSession` used to distinguish "expired" from "missing"
 * (#282). The verdict therefore flipped within one session: right after the
 * failed refresh the UI said "session expired, log in again", and the next
 * read said "configure a provider". The marker makes the verdict
 * independent of the record: an expired purge sets it, an explicit logout
 * and any new credential commit (saveStoredTokens) clear it, so every later
 * read keeps reporting `expired` until the user acts.
 */
const EXPIRED_SESSION_MARKER_KEY = '__llm_gateway_expired_session__'

function markExpiredSession(): void {
  try {
    localStorage.setItem(EXPIRED_SESSION_MARKER_KEY, String(Date.now()))
  } catch {
    // Non-fatal: without the marker the next read degrades to the record
    // (already deleted) → 'missing'. Same failure class as the logout marker.
  }
}

function clearExpiredSessionMarker(): void {
  try {
    localStorage.removeItem(EXPIRED_SESSION_MARKER_KEY)
  } catch {
    // Non-fatal.
  }
}

function hasExpiredSessionMarker(): boolean {
  try {
    return localStorage.getItem(EXPIRED_SESSION_MARKER_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Read the last logout timestamp (null when never logged out / unreadable).
 */
export function getLastLogoutTimestamp(): number | null {
  try {
    const raw = localStorage.getItem(LOGOUT_MARKER_KEY)
    if (!raw) return null
    const ts = Number(raw)
    return Number.isFinite(ts) && ts > 0 ? ts : null
  } catch {
    return null
  }
}

/**
 * Public alias of `REFRESH_TOKEN_DB_KEY` for consumers that must exclude
 * gateway-owned keys from lists of "usable provider credentials" (e.g. the
 * AI-readiness probe): the refresh-token backup lives in the same
 * api-key-store as real provider keys, and counting it as one would let a
 * visitor skip login with no usable credential.
 */
export { LLM_GATEWAY_REFRESH_TOKEN_KEY_ID }

/**
 * Whether a status verdict produced under `generation` may still be applied.
 *
 * A resolution that spans awaits can outlive the credential set it inspected
 * (logout, or a new login in this tab or another one). The verdict's status
 * write must then be dropped rather than overwrite the newer session's state.
 */
export function isCredentialStatusCurrent(generation: number): boolean {
  return generation === authSessionGeneration
}

/**
 * Whether an access token a caller just validated is still the stored one.
 *
 * Dispatch gates use this instead of the coarse session generation: a
 * resolution that refreshed an expired token advances the generation itself
 * (saveStoredTokens), which is not a session change. What must block a
 * follow-up action is the stored credential being replaced or cleared by a
 * logout or a newer login (#180 review round 3).
 *
 * Reads through `loadStoredTokensWithFallback` so a credential recovered
 * from the SQLite backup (localStorage unavailable or gapped) counts as
 * current — the resolver may have validated exactly that recovered pair
 * (#214 Sourcery round 3). Storage READ FAILURES propagate: the caller
 * classifies them (same philosophy as the resolver — a storage error is
 * retryable, never proof of a stale credential).
 */
export async function isGatewayAccessTokenCurrent(accessToken: string): Promise<boolean> {
  const stored = await loadStoredTokensWithFallback()
  return typeof stored?.access_token === 'string' && stored.access_token === accessToken
}

/** Keep the settings UI's credential state aligned with background auth checks. */
function setCredentialStatus(
  status: 'valid' | 'expired' | 'missing',
  expectedGeneration?: number,
): void {
  // Ignore verdicts produced for a session superseded by login or logout.
  if (expectedGeneration !== undefined && !isCredentialStatusCurrent(expectedGeneration)) return
  credentialRegistry.commit('llm-gateway', { kind: status })
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
  credentialRegistry.commit('llm-gateway', { kind: status })
}

/**
 * The credential status as of the last token operation performed by this
 * module. `'unknown'` means no token operation has run in this session yet.
 */
export function getGatewayCredentialStatus(): 'unknown' | 'valid' | 'expired' | 'missing' {
  const { kind } = credentialRegistry.getState('llm-gateway')
  // `temporary` has no equivalent in this older API: report it as `unknown`,
  // which callers already treat as "no verdict yet" rather than "no key".
  return kind === 'temporary' ? 'unknown' : kind
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

/** Remove the unused access-token shadow left by older releases (#283). */
export async function cleanupLegacyGatewayCredential(): Promise<void> {
  const { deleteApiKey } = await import('@/security/api-key-store')
  await deleteApiKey(getGatewayDispatchCredentialKey())
}

/** Seed only locally provable gateway state before the first settings check. */
export async function seedGatewayCredentialState(): Promise<void> {
  const initial = credentialRegistry.getState('llm-gateway')
  if (initial.kind !== 'unknown' && initial.kind !== 'temporary') return
  const generation = getGatewayAuthSessionGeneration()
  const revision = credentialRegistry.getRevision('llm-gateway')
  const commit = (kind: 'valid' | 'expired' | 'missing' | 'temporary', error?: unknown) => {
    if (generation !== getGatewayAuthSessionGeneration() ||
        credentialRegistry.getRevision('llm-gateway') !== revision) return
    if (kind === 'temporary') {
      credentialRegistry.commit('llm-gateway', { kind, error })
    } else {
      setCredentialStatus(kind, generation)
    }
  }

  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<StoredTokens>
      if (typeof stored.access_token === 'string' && stored.access_token.trim() &&
          typeof stored.access_expires_at === 'number' && stored.access_expires_at > Date.now() + 60_000) {
        commit('valid')
      } else if (typeof stored.refresh_expires_at === 'number' && stored.refresh_expires_at <= Date.now()) {
        commit('expired')
      } else {
        // Access token expired, refresh token still live: the session is very
        // likely fine but only the server can confirm it. Commit `temporary`
        // rather than leave `unknown` — a live refresh token is not proof of a
        // valid session, but `unknown` keeps `hasApiKeyLoaded` false and the
        // UI in its loading state until the user happens to send something
        // (#281: neutral must never be permanent).
        commit('temporary')
      }
      return
    }
    if (localStorage.getItem(EXPIRED_SESSION_MARKER_KEY) !== null) {
      commit('expired')
      return
    }

    const { loadApiKey } = await import('@/security/api-key-store')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('gateway credential seed timed out')), 1800)
      })
      const backup = await Promise.race([loadApiKey(REFRESH_TOKEN_DB_KEY), timeout])
      if (!backup) {
        commit('missing')
        return
      }
      const stored = JSON.parse(backup) as Partial<StoredTokens>
      if (typeof stored.refresh_token !== 'string' || !stored.refresh_token ||
          typeof stored.refresh_expires_at !== 'number' || !Number.isFinite(stored.refresh_expires_at)) {
        throw new Error('invalid gateway refresh record')
      }
      if (stored.refresh_expires_at <= Date.now()) commit('expired')
      else commit('temporary')
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    commit('temporary', error)
  }
}

/** Thrown by loadStoredTokensWithFallback when storage reads FAIL — distinct from confirmed absence (#175 review). */
export class GatewayTokenStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super('gateway token store unavailable')
    this.name = 'GatewayTokenStoreUnavailableError'
    this.cause = cause
  }
}

/**
 * Async variant: tries localStorage first, then recovers from SQLite.
 * Used by the token-refresh path where we need maximum durability.
 *
 * Throws GatewayTokenStoreUnavailableError when a STORAGE READ FAILS — that
 * is not evidence the user never logged in, so callers must not collapse it
 * into the 'missing' branch (#175 review).
 */
async function loadStoredTokensWithFallback(): Promise<StoredTokens | null> {
  // Distinguish an inaccessible localStorage from a confirmed absent key.
  let cached: StoredTokens | null = null
  let localReadError: unknown
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (raw) {
      try { cached = JSON.parse(raw) as StoredTokens } catch { /* malformed record */ }
    }
  } catch (error) {
    localReadError = error
  }
  if (cached) return cached
  const absentOrUnavailable = (): null => {
    if (localReadError) throw new GatewayTokenStoreUnavailableError(localReadError)
    return null
  }

  // Slow path: recover from SQLite api-key-store
  let raw: string | null
  try {
    const { loadApiKey } = await import('@/security/api-key-store')
    raw = await loadApiKey(REFRESH_TOKEN_DB_KEY)
  } catch (e) {
    // SQLite read failure ≠ absence (#175 review): surface as a retryable
    // storage error instead of the confirmed-absent null.
    throw new GatewayTokenStoreUnavailableError(e)
  }
  if (!raw) {
    return absentOrUnavailable()
  }
  try {
    const recovered = JSON.parse(raw) as Partial<StoredTokens>
    if (!recovered.refresh_token || !recovered.refresh_expires_at) return absentOrUnavailable()
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
      return absentOrUnavailable()
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
      const { result: freshResult, settled: freshSettled } = withKeyStoreDeadline(
        loadApiKey(REFRESH_TOKEN_DB_KEY),
      )
      let fresh: string | null
      try {
        fresh = await freshResult
      } catch (e) {
        throw new GatewayTokenStoreUnavailableError(e)
      }
      // Hold the lock until the read settles (a deadline-expired read that
      // lands late must not race the restore write below).
      await freshSettled
      if (!fresh) {
        return absentOrUnavailable()
      }
      let freshRecovered: Partial<StoredTokens>
      try {
        freshRecovered = JSON.parse(fresh) as Partial<StoredTokens>
      } catch {
        return absentOrUnavailable()
      }
      if (!freshRecovered.refresh_token || !freshRecovered.refresh_expires_at) return absentOrUnavailable()
      if (
        typeof freshRecovered.refresh_expires_at !== 'number' ||
        !Number.isFinite(freshRecovered.refresh_expires_at) ||
        freshRecovered.refresh_expires_at <= Date.now()
      ) {
        return absentOrUnavailable()
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
  } catch (e) {
    if (e instanceof GatewayTokenStoreUnavailableError) throw e
    return absentOrUnavailable()
  }
}

function saveStoredTokens(tokens: StoredTokens): void {
  bumpAuthSessionGeneration()
  // A credential commit supersedes whatever killed the previous session:
  // clear the expired marker so a FUTURE expired purge (of this new pair)
  // is what the next read reports, not a stale one (#282).
  clearExpiredSessionMarker()
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens))
  // Also persist refresh_token to SQLite for durability across localStorage clears.
  // The backup write may run after a newer login. Serialize and verify its
  // source pair so an older background write cannot replace that backup.
  // The SQLite write is bounded: a stalled api-key-store op inside the
  // credential lock must not block later logins/refreshes/logouts forever
  // (the lock-held fallback path in loadStoredTokensWithFallback gets the
  // same treatment via its bounded load).
  void withGatewayCredentialLock(async () => {
    const current = loadStoredTokens()
    if (!current || JSON.stringify(current) !== JSON.stringify(tokens)) return
    // Await BOTH the raced result and the underlying settlement: releasing
    // the lock while the write is still pending would let it land after a
    // logout has purged the backup, restoring a logged-out session. The
    // write is FENCED at its landing point: an op that stayed pending past
    // a newer credential commit must not overwrite that commit's backup
    // with this (older) pair — the identity re-check above reads the state
    // at dispatch, not at landing (round-20). The fenced write is swallowed
    // by this fire-and-forget path's catch: the backup is an eventual-
    // consistency copy of localStorage, and the next saveStoredTokens
    // rewrites it.
    // write is FENCED at its landing point: an op that stayed pending past
    // a newer credential commit must not overwrite that commit's backup
    // with this (older) pair — the identity re-check above reads the state
    // at dispatch, not at landing (round-20). The fenced write is swallowed
    // by this fire-and-forget path's catch: the backup is an eventual-
    // consistency copy of localStorage, and the next saveStoredTokens
    // rewrites it.
    try {
      await runBoundedFencedKeyStoreMutation(async (opId) => {
        // The SQLite write's factory first awaits a dynamic import (an async
        // effect): a newer credential commit can interleave during that
        // await. A second fence check immediately before the effectful call
        // shrinks the window — the landing-point check below still covers a
        // commit that interleaves mid-await inside saveApiKey (round-21).
        const { saveApiKey } = await import('@/security/api-key-store')
        if (pendingKeyStoreOpIsFenced(opId)) {
          throw new Error('key-store op fenced: a newer credential commit landed while this op was pending')
        }
        const blob = buildRefreshTokenBackupBlob(tokens)
        await saveApiKey(REFRESH_TOKEN_DB_KEY, blob)
      })
    } catch {
      // A fenced/stalled backup write is non-fatal here: the backup is an
      // eventual-consistency copy of localStorage — the next saveStoredTokens
      // rewrites it. The outer .catch already logs.
    }
  }).catch((e) => {
    console.warn('[llm-gateway] persist refresh_token to SQLite failed:', e)
  })
}

/**
 * Build the compact SQLite backup blob for a token pair (extracted from the
 * old persistRefreshTokenToSQLite so the fenced-mutation factory can run the
 * fence check AFTER the dynamic import and IMMEDIATELY before the effectful
 * saveApiKey call — round-21).
 */
function buildRefreshTokenBackupBlob(tokens: StoredTokens): string {
  return JSON.stringify({
    refresh_token: tokens.refresh_token,
    refresh_expires_at: tokens.refresh_expires_at,
    access_token: tokens.access_token,
    access_expires_at: tokens.access_expires_at,
    client_id: tokens.client_id,
    base_url: tokens.base_url,
  })
}

/**
 * Bound a key-store operation used while holding the credential lock.
 *
 * The deletion/reads in `clearStoredTokens` and `purgeStaleAccessTokenShadow`
 * previously ran unbounded: a key-store op that never settles would hold the
 * origin-wide credential lock forever, and every later login, refresh and
 * logout would queue behind it indefinitely. Every bounded op returns a
 * `settled` promise that MUST be awaited before the lock's critical section
 * returns, so an op that outlived its deadline cannot land after a newer
 * credential commit (see `withKeyStoreDeadline`).
 */
async function runBoundedKeyStoreOp<T>(p: Promise<T>): Promise<T> {
  const { result, settled } = withKeyStoreDeadline(p)
  try {
    return await result
  } finally {
    await settled
  }
}

/**
 * Bounded key-store MUTATION with commit fencing closed BEFORE dispatch
 * (Sourcery round-21) plus escalation for a fenced write that landed anyway.
 *
 * The mutation is passed as a FACTORY, not an already-started promise: the
 * op is registered (and fence-stamped) FIRST, the fence is checked, and only
 * an unfenced op is released to run — a fenced mutation never dispatches its
 * effect at all. After the effect lands, the fence is re-checked: a commit
 * that interleaved between the pre-dispatch check and the write turns the
 * landed mutation into a detected failure (the effect may already have hit
 * the store, so the session is escalated — see `escalateFencedKeyStoreWrite`).
 *
 * The deadline path is also covered: when `result` rejects via the 10s
 * deadline while the underlying op is still pending, the post-write check
 * cannot run — the awaited continuation on `settled` re-checks the fence
 * once the underlying op completes, so a fenced late write is DETECTED and
 * escalated instead of silently damaging a newer session.
 */
async function runBoundedFencedKeyStoreMutation<T>(
  factory: (opId: string) => Promise<T>,
): Promise<T> {
  // Deferred gate: the effectful write starts only after the op is
  // registered and the fence checked (see withKeyStoreDeadlineFactory).
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const registeredOpIdHolder: { opId?: string } = {}
  const { result, settled, opId, underlying } = withKeyStoreDeadlineFactory(
    gate,
    () => {
      // `factory` runs only after registration completes below, so the id
      // is always set by the time the effectful body reads it.
      return factory(registeredOpIdHolder.opId as string)
    },
  )
  registeredOpIdHolder.opId = opId
  // Dispatch-time fence check: a commit that already landed between the
  // caller's snapshot and this registration fences the op before it ever
  // runs — nothing is written or deleted.
  if (pendingKeyStoreOpIsFenced(opId)) {
    // Resolve the gate WITHOUT invoking the factory: the mutation is never
    // dispatched. The underlying promise settles immediately (the factory
    // is not called), so `settled` below resolves and no lock is held.
    release()
    throw new Error('key-store op fenced: a newer credential commit landed while this op was pending')
  }
  release()
  try {
    const value = await result
    if (pendingKeyStoreOpIsFenced(opId)) {
      // The commit raced us between the pre-dispatch check and the effect:
      // the write/deletion HAS landed on top of a newer credential — the
      // stored state is untrustworthy. Escalate, then throw.
      escalateFencedKeyStoreWrite(opId)
      throw new Error('key-store op fenced: a newer credential commit landed while this op was pending')
    }
    return value
  } finally {
    await settled
    // Deadline path: when `result` rejected via the deadline while the
    // underlying op was still pending, the check above never ran. Once the
    // underlying op settles, re-check: a fenced late write that landed
    // anyway is detected and escalated (the newer session it damaged must
    // not be trusted).
    void underlying.then(
      () => {
        if (pendingKeyStoreOpIsFenced(opId)) escalateFencedKeyStoreWrite(opId)
      },
      () => {
        if (pendingKeyStoreOpIsFenced(opId)) escalateFencedKeyStoreWrite(opId)
      },
    )
  }
}

/**
 * Session-invalidation hook for a FENCED key-store mutation that LANDED
 * (Sourcery round-21): a stale write or delete may have overwritten or
 * removed a newer credential, so the stored state cannot be trusted — the
 * user must re-login. The newer credential is gone; no attempt is made to
 * resurrect it. The escalation marks the settings store's credential-status
 * error (the ProviderManager gateway card renders it as a re-login banner)
 * and flips the auth layer's own status mirror to 'expired' so subsequent
 * token acquisitions do not ride a possibly damaged session. No new
 * persisted state: the flag lives in the existing in-memory store field.
 */
function escalateFencedKeyStoreWrite(opId: string): void {
  console.warn(
    `[llm-gateway] fenced key-store mutation ${opId} landed after a newer credential commit — stored credentials are untrustworthy, forcing re-login`,
  )
  escalateFencedKeyStoreMutation()
}

/**
 * Session-invalidation for a FENCED key-store mutation that LANDED (shared
 * by the auth layer and gateway-login — Sourcery round-21): a stale write or
 * delete may have overwritten or removed a newer credential, so the stored
 * state cannot be trusted — the user must re-login. The newer credential is
 * gone; no attempt is made to resurrect it. The escalation marks the
 * settings store's credential-status error (the ProviderManager gateway
 * card renders it as a re-login banner) and flips the credential status to
 * 'expired' so subsequent token acquisitions do not ride a possibly damaged
 * session. No new persisted state: the flag lives in the existing in-memory
 * store field.
 */
export function escalateFencedKeyStoreMutation(): void {
  credentialRegistry.commit('llm-gateway', { kind: 'expired' })
  void import('@/store/settings.store')
    .then(({ useSettingsStore }) => {
      const state = useSettingsStore.getState()
      state.setModelCredentialStatusError(
        translate(
          useI18nStore.getState().locale,
          'conversation.error.gatewayCredentialStaleWrite',
        ),
      )
    })
    .catch(() => {
      // Auth must remain usable even when the settings store is unavailable.
    })
}

/**
 * Test hook: the fenced-mutation wrapper with the deadline/waiting machinery
 * intact, exported so tests can drive the pre-dispatch fence refusal and
 * the async-factory second fence check directly (production call sites use
 * the module-private `runBoundedFencedKeyStoreMutation`).
 */
export function runBoundedFencedKeyStoreMutationForTests<T>(
  factory: (opId: string) => Promise<T>,
): Promise<T> {
  return runBoundedFencedKeyStoreMutation(factory)
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
  const cleared = await withGatewayCredentialLock(async () => {
    const current = loadStoredTokens()
    if (expectedRefreshToken && current?.refresh_token !== expectedRefreshToken) return false
    bumpAuthSessionGeneration()
    // An explicit logout removes the provider: a signed-out user must not keep
    // a dead entry in the switcher. An EXPIRED session is NOT a logout — the
    // catalog layer records the outage instead (it keeps the registration and
    // the last usable model list, so Retry / re-login stay reachable, #224).
    // The notification is synchronous and happens BEFORE any key-store await
    // below: a later catalog write could demote a refresh that committed in
    // the meantime (review: "Working catalog shows outage").
    if (finalStatus === 'missing') {
      unregisterDynamicProvider('llm-gateway')
    } else {
      notifyGatewayTokensPurged('expired')
    }
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    // An expired purge destroys the refresh-token record (#277 tombstone),
    // so the "session died" evidence must move somewhere the next read can
    // still see: the marker keeps the verdict 'expired' for the rest of the
    // session instead of letting it degrade to 'missing' (#282).
    if (finalStatus === 'expired') {
      markExpiredSession()
    } else {
      // An explicit logout means the user INTENTIONALLY ended the session:
      // the next read must offer setup, not a re-login prompt for a session
      // they chose to end.
      clearExpiredSessionMarker()
    }
    // Record the logout timestamp so a login attempt that was pending
    // (device-code approval / model preparation) in another tab cannot
    // commit AFTER this logout: gateway-login's commit re-checks this
    // marker and refuses to persist a session that predates it.
    try {
      localStorage.setItem(LOGOUT_MARKER_KEY, String(Date.now()))
    } catch {
      // Non-fatal: the marker is a cross-tab heuristic, not a guarantee.
    }
    // Purge both SQLite-side credentials before releasing the lock, so a
    // later login cannot have its new access key deleted by this logout.
    // Each deletion is attempted INDEPENDENTLY: a failure purging the
    // refresh-token backup must not skip the access-token shadow deletion
    // (the settings card derives its logged-in badge from that key alone —
    // leaving it behind shows "Logged in" UI with a logout button while
    // every request 401s, user-reported bug).
    const { deleteApiKey } = await import('@/security/api-key-store')
    // Bound each deletion: a key-store op that never settles must not hold
    // the credential lock forever (later logins, refreshes and logouts all
    // queue behind it). Each deletion is ALSO fenced at its landing point
    // (runBoundedFencedKeyStoreMutation): a deletion that stayed pending
    // past a newer credential commit must not delete that commit's key
    // (round-20).
    const purgeFailures: unknown[] = []
    try {
      await runBoundedFencedKeyStoreMutation(() => deleteApiKey(REFRESH_TOKEN_DB_KEY))
    } catch (e) {
      purgeFailures.push(e)
    }
    try {
      await runBoundedFencedKeyStoreMutation(() => deleteApiKey(getGatewayDispatchCredentialKey()))
    } catch (e) {
      purgeFailures.push(e)
    }
    if (purgeFailures.length > 0) {
      // Diagnostic log on purpose — a silent failure here would re-create
      // the "logged-in badge on a dead session" state with no way to debug.
      console.warn('[llm-gateway] failed to purge stored credentials:', purgeFailures)
      // A surviving refresh-token record can be resurrected by
      // loadStoredTokensWithFallback, so the session is not gone. Do NOT
      // report the logout complete: mark the status write as FAILED so the UI
      // renders
      // a stale-state hint instead of trusting 'missing', and throw so the
      // caller surfaces a retryable error instead of silently declaring a
      // session gone that can come back.
      const purgeError = new Error(
        translate(useI18nStore.getState().locale, 'conversation.error.gatewayCredentialPurgeFailed')
      ) as Error & { code: string; retriable: boolean }
      purgeError.code = 'network_error'
      purgeError.retriable = true
      try {
        const { useSettingsStore } = await import('@/store/settings.store')
        useSettingsStore.getState().setModelCredentialStatusError(purgeError.message)
      } catch {
        // Auth must remain usable even when the settings store is unavailable.
      }
      throw purgeError
    }
    // The purge succeeded — clear any earlier stale-state flag so the UI
    // trusts the status written below.
    try {
      const { useSettingsStore } = await import('@/store/settings.store')
      useSettingsStore.getState().setModelCredentialStatusError(null)
    } catch {
      // Non-fatal.
    }
    // The status write is part of the same critical section as the purge:
    // a login committing between the purge and a post-lock status write
    // would be reported "logged out"/"expired" over fresh valid credentials.
    if (finalStatus) await setCredentialStatusLocked(finalStatus)
    return true
  })
  // Outside the credential lock: the re-read hits the key store, and later
  // logins/refreshes must not queue behind it.
  if (cleared) await resyncGatewayApiKeyAvailability()
  return cleared
}

/**
 * Re-resolve the gateway's API-key availability after its credentials were
 * purged.
 *
 * `checkHasApiKey()` answers from a module-level cache that outlives store
 * resets; only the login / logout / reconcile paths invalidate it. A purge
 * that leaves the entry in place keeps answering `true` for a dead session,
 * so a later check (the welcome screen reads it on every mount) still treats
 * the gateway as configured and never offers setup / re-login — the same
 * "logged-in badge on a dead session" class this purge exists to prevent
 * (review: "Expired credentials leave a stale key result").
 */
async function resyncGatewayApiKeyAvailability(): Promise<void> {
  try {
    const { useSettingsStore } = await import('@/store/settings.store')
    const settings = useSettingsStore.getState()
    // `checkHasApiKey()` answers for the SELECTED provider. Forcing a lookup
    // while another provider is selected would resolve ITS status — ending a
    // still-registering provider's loading state with a false "not
    // configured". Dropping the gateway's cache entry is enough on its own:
    // the verdict is re-resolved the next time the gateway is checked or
    // selected.
    if (settings.providerType !== 'llm-gateway') return
    // flush: an explicit logout has unregistered the provider by now, and a
    // deferred call would return without writing — leaving the stale `true`
    // (and its "configured" welcome screen) on display.
    await settings.checkHasApiKey({ flush: true })
  } catch (e) {
    // Auth must remain usable even when the settings store is unavailable.
    console.warn('[llm-gateway] failed to refresh the api-key status after a purge:', e)
  }
}

/**
 * Did this browser ever log in to the gateway?
 *
 * Two tombstones, in order:
 * 1. The expired-session marker (#282): set by the expired purge itself,
 *    cleared by logout and by any new credential commit. The SQLite record
 *    cannot serve this role — the purge DELETES it, which is exactly the
 *    bug: the verdict flipped 'expired' → 'missing' on the next read.
 * 2. The SQLite refresh-token record (#277): login writes it,
 *    `loadStoredTokensWithFallback` reads it. It still covers sessions
 *    whose token PAIR was cleared by older paths before the marker existed,
 *    and the localStorage-evicted case.
 *
 * So "the token pair is gone but a tombstone exists" means the session DIED,
 * not that the user never logged in.
 *
 * Tri-state on purpose: 'error' means the store could not be read, which is
 * NOT evidence of a logout (#172 finding 3) — callers keep the session
 * retryable instead of declaring the user signed out.
 */
type PriorSessionInspection = 'had-session' | 'none' | 'error'

async function inspectPriorSession(): Promise<PriorSessionInspection> {
  try {
    return await withGatewayCredentialLock(async (): Promise<PriorSessionInspection> => {
      if (loadStoredTokens()) return 'none'
      // The refresh-token record is DELETED by the expired purge itself, so
      // its absence no longer proves "never logged in": a session that died
      // (invalid_grant) leaves the expired marker behind, and every later
      // read must keep reporting 'had-session' → 'expired' (#282).
      if (hasExpiredSessionMarker()) return 'had-session'
      const { loadApiKey } = await import('@/security/api-key-store')
      // Bounded read only: a stalled read must not hold the credential lock.
      const record = await runBoundedKeyStoreOp(loadApiKey(REFRESH_TOKEN_DB_KEY))
      // A new session can appear during the read; then it is not a tombstone.
      if (!record || loadStoredTokens()) return 'none'
      return 'had-session'
    })
  } catch (e) {
    console.warn('[llm-gateway] failed to inspect the refresh-token record:', e)
    return 'error'
  }
}

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
  const signal = AbortSignal.timeout(15_000)
  return abortableRequest(gatewayFetch<TokenResponse>(baseURL, '/v1/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal,
  }), signal)
}

/**
 * Bound any promise with a hard deadline so a stalled key-store write (or
 * SQLite read) cannot hold the origin-wide credential lock forever — every
 * later login/refresh/logout queues behind it and never completes.
 *
 * The deadline is deliberately generous (10s): the goal is deadlock
 * protection, not fast failure.
 *
 * Returns `{ result, settled }`: `result` resolves/rejects with the raced
 * outcome (deadline expiry rejects), and `settled` resolves only when the
 * UNDERLYING operation completes. Callers holding the credential lock MUST
 * await `settled` before returning — a timed-out write that later lands
 * would otherwise modify the shared credential state after a newer
 * login/logout has committed under the lock.
 */
export function withKeyStoreDeadline<T>(
  p: Promise<T>,
): { result: Promise<T>; settled: Promise<void>; opId: string } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('key store write timed out')), 10_000)
  })
  let settleDone = false
  let settleResolve!: () => void
  const settled = new Promise<void>((resolve) => {
    settleResolve = () => {
      if (!settleDone) {
        settleDone = true
        resolve()
      }
    }
  })
  const result = Promise.race([
    p.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      settleResolve()
    }),
    deadline.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    }),
  ])
  // Safety net: if the underlying promise NEVER settles (a hung worker),
  // `settled` would block the lock forever — the very deadlock this helper
  // exists to prevent. Give the underlying op an extra grace window after
  // the deadline, then release the lock regardless. The op's real
  // completion is tracked in the shared pendingKeyStoreOps registry (via
  // `trackPendingKeyStoreOp(p)` below), so `withGatewayCredentialLock`
  // waits for the UNDERLYING operation — not just this grace timer —
  // before granting a new credential commit.
  setTimeout(() => settleResolve(), 10_000 + 5_000)
  // Registration returns the op's fencing id: a credential commit landing
  // after this point bumps the shared sequence past the op's stamp, and
  // the caller checks `pendingKeyStoreOpIsFenced(opId)` right before its
  // write to refuse a stale write over a newer credential (the
  // suspended-tab window the heartbeat barrier cannot close).
  const opId = trackPendingKeyStoreOp(p)
  return { result, settled, opId }
}

/**
 * Deadline-bounded op over a DEFERRED mutation (Sourcery round-21): the
 * underlying promise is created only when `gate` resolves, so the helper can
 * register (fence-stamp) the op BEFORE the effectful factory runs. Structurally
 * identical to `withKeyStoreDeadline` (same 10s deadline, same grace timer,
 * same registry tracking); `underlying` exposes the real op promise so the
 * fenced-mutation wrapper can re-check the fence when it settles even after
 * the deadline rejected `result`.
 */
export function withKeyStoreDeadlineFactory<T>(
  gate: Promise<void>,
  factory: () => Promise<T>,
): {
  result: Promise<T>
  settled: Promise<void>
  opId: string
  underlying: Promise<T>
} {
  const underlying = gate.then(factory)
  return { ...withKeyStoreDeadline(underlying), underlying }
}

/**
 * Re-exported so callers of `withKeyStoreDeadline` (which cannot import the
 * lock module without creating a cycle through the provider module) can
 * check their op's fence right before writing.
 */
export { pendingKeyStoreOpIsFenced } from '@/agent/providers/gateway-credential-lock'

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
  // Only update the SYNCHRONOUS mirror here. The settings-store write is
  // deferred (dynamic import, unawaited): scheduled during this
  // lock-held commit, it could land AFTER the lock releases and after a
  // concurrent logout wrote 'missing' — reporting valid credentials for a
  // logged-out session. The registry projects this status into settings.
  credentialRegistry.commit('llm-gateway', { kind: 'valid' })
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
  clientId: string,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const generation = authSessionGeneration
  // Reuse the in-flight refresh only within the same credential session — a
  // logout or new login invalidates the result the promise will resolve with.
  if (refreshInFlight && generation === (refreshInFlight as InFlightRefresh).generation) {
    return abortableRefreshResult(refreshInFlight, signal)
  }
  const beforeLock = loadStoredTokens()
  const request = withGatewayRefreshLock(async (): Promise<RefreshResult> => {
    // A peer may refresh while this tab waits. Adopt only a newer token for
    // the same session; a replacement account must not receive this request.
    const current = loadStoredTokens()
    if (beforeLock && current && current.refresh_token !== beforeLock.refresh_token) {
      return { status: 'temporary_error', error: new Error('session changed while waiting for refresh') }
    }
    if (
      beforeLock && current && current.refresh_token === beforeLock.refresh_token &&
      typeof current.access_token === 'string' && current.access_token.trim() &&
      current.access_token !== beforeLock.access_token && current.access_expires_at > Date.now() + 60_000
    ) {
      setCredentialStatus('valid', generation)
      return { status: 'success', accessToken: current.access_token }
    }
    return refreshAccessTokenWithStatusImpl(baseURL, clientId)
  })
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
  return abortableRefreshResult(tracked, signal)
}

function abortableRefreshResult(
  refresh: Promise<RefreshResult>,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  return abortableRequest(refresh, signal)
}

function abortableRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request
  if (signal.aborted) return Promise.reject(signal.reason)
  // A refresh can be shared by model discovery and another caller. Bound the
  // discovery caller without cancelling the shared credential operation.
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

interface InFlightRefresh extends Promise<RefreshResult> {
  generation: number
}

let refreshInFlight: Promise<RefreshResult> | null = null

/**
 * Dedicated ORIGIN-WIDE refresh lock (#172 finding 2).
 *
 * `refreshInFlight` deduplicates only within one tab: two tabs can run
 * `/v1/auth/refresh` concurrently. Under the documented non-rotating
 * contract that is merely duplicate work — but if the backend ever starts
 * rotating refresh tokens, the loser receives `invalid_grant` and would
 * mislabel the winner's NEWER session as expired. Serializing the whole
 * refresh (network call + credential commit) behind an origin-wide Web Lock
 * closes that race: the second tab acquires the lock only after the first
 * tab's commit, and `loadStoredTokensWithFallback` re-reads the refreshed
 * pair, so it validates against the newest credential instead of racing.
 *
 * Deliberately NOT the credential commit lock: `refreshAccessTokenWithStatusImpl`
 * acquires `withGatewayCredentialLock` internally, and Web Locks are not
 * reentrant — wrapping it in the same lock would deadlock. This lock is
 * acquired strictly outside and only orders refresh attempts against each
 * other; the commit/ownership fencing inside the impl is unchanged.
 *
 * Without Web Locks (test environments, exotic browsers) the lock degrades
 * to running directly — today's per-tab dedup behavior, which the current
 * non-rotating contract makes safe.
 */
const GATEWAY_REFRESH_LOCK = 'eo2weave-gateway-refresh'

function getWebLocksForRefresh(): { request<T>(name: string, cb: () => T | Promise<T>): Promise<T> } | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { locks?: { request<T>(name: string, cb: () => T | Promise<T>): Promise<T> } }).locks ?? null
}

async function withGatewayRefreshLock<T>(refresh: () => Promise<T>): Promise<T> {
  const locks = getWebLocksForRefresh()
  if (!locks) return refresh()
  let acquired = false
  try {
    return await locks.request(GATEWAY_REFRESH_LOCK, () => {
      acquired = true
      return refresh()
    })
  } catch (e) {
    if (acquired) throw e
    // A failed lock acquisition (SecurityError etc.) must not break refresh:
    // degrade to the unlocked path (pre-lock behavior).
    console.warn('[llm-gateway] refresh lock unavailable, refreshing without cross-tab serialization:', e)
    return refresh()
  }
}

/**
 * Session generation — bumped on every credential-set change (new login via
 * saveStoredTokens, logout/clear via clearStoredTokens). Async work started
 * under one generation must not write under a newer one: a late shadow save
 * after logout would resurrect cleared credentials, and an in-flight refresh
 * for a replaced session must not overwrite the new token pair.
 */
let authSessionGeneration = 0

export function getGatewayAuthSessionGeneration(): number {
  return authSessionGeneration
}

/** Invalidate async work belonging to the previous credential set. */
function bumpAuthSessionGeneration(): void {
  authSessionGeneration++
}

type GatewayTokenPurgeListener = (finalStatus: 'expired' | 'missing') => void

/**
 * Listeners notified SYNCHRONOUSLY when the stored credential pair is purged.
 *
 * The catalog layer uses this to record that its catalog can no longer load.
 * The notification is synchronous on purpose: the catalog write happens in the
 * same tick as the purge verdict, so no catalog refresh that commits while the
 * purge is still running key-store deletions can be demoted afterwards
 * (review: "Working catalog shows outage"). A dynamic import from the purge
 * path would open exactly that window.
 */
const gatewayTokenPurgeListeners: GatewayTokenPurgeListener[] = []

export function onGatewayTokensPurged(listener: GatewayTokenPurgeListener): void {
  gatewayTokenPurgeListeners.push(listener)
}

function notifyGatewayTokensPurged(finalStatus: 'expired' | 'missing'): void {
  for (const listener of gatewayTokenPurgeListeners) {
    try {
      listener(finalStatus)
    } catch {
      // A failing listener must never abort the credential purge.
    }
  }
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
  let stored: StoredTokens | null
  try {
    stored = await loadStoredTokensWithFallback()
  } catch (e) {
    if (e instanceof GatewayTokenStoreUnavailableError) {
      // A failed storage read is retryable, not a dead session (#175 review):
      // report temporary_error instead of the missing/expired verdicts the
      // absence path produces.
      console.warn('[llm-gateway] forceRefresh: token store read failed', e)
      return { status: 'temporary_error', error: e }
    }
    throw e
  }
  if (!stored) {
    console.warn('[llm-gateway] forceRefresh: no stored tokens (localStorage + SQLite both empty)')
    // The token pair is gone, but the api-key-store may still hold the
    // access_token shadow of an earlier session. That means the session DIED
    // (the user had logged in), not that they never logged in — report
    // 'expired' so the settings card offers a re-login instead of a logout.
    // The record itself stays: it is the tombstone this verdict came from.
    // Distinguish "a session existed" (it died) from a failed inspection
    // (storage unreachable — retryable, NOT absence; #175 review).
    const inspection = await inspectPriorSession()
    if (inspection === 'error') {
      return { status: 'temporary_error', error: new Error('gateway credential storage unavailable') }
    }
    setCredentialStatus(inspection === 'had-session' ? 'expired' : 'missing', generation)
    return inspection === 'had-session' ? { status: 'expired' } : { status: 'missing' }
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
    if (!await clearStoredTokens(requestRefreshToken, 'expired')) {
      return { status: 'temporary_error', error: new Error('session changed during refresh') }
    }
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
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token.trim() ||
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
      // SQLite refresh-token backup remain authoritative. The write is ALSO
      // fenced at its landing point: an op that stayed pending past a newer
      // credential commit must not overwrite that commit's shadow with this
      // refresh's (older) token (round-20). A fenced write is swallowed by
      // the catch below — same best-effort degradation as a write failure.
      // The helper awaits `settled` in its finally, so the lock is held
      // until the write SETTLES: a late write cannot land after a newer
      // credential committed by another tab.
      // The verdict belongs to the session this refresh just committed, and
      // that commit advanced the generation itself — declaring it under the
      // pre-commit snapshot would fence it out and leave the mirror stale
      // (#180 review round 2).
      setCredentialStatus('valid', getGatewayAuthSessionGeneration())
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
        setCredentialStatus('expired', generation)
        return { status: 'expired', error: e }
      }
      console.warn('[llm-gateway] forceRefresh: token invalid, clearing stored tokens', e)
      // The refresh_token is dead, so the login is unrecoverable.
      // clearStoredTokens() also purges the api-key-store access_token
      // shadow (the key the settings card's logged-in badge derives from),
      // so the UI falls back to the logged-out state with a login button.
      if (!await clearStoredTokens(requestRefreshToken, 'expired')) {
        return { status: 'temporary_error', error: new Error('session changed during refresh') }
      }
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

// ── Dispatch-time credential resolution (#172 findings 4+5) ───────────

export type GatewayDispatchCredential =
  | { ok: true; accessToken: string }
  | { ok: false; kind: 'missing' | 'expired' | 'temporary'; error?: unknown }

/**
 * Authoritative, status-bearing gateway credential resolution for dispatch.
 *
 * The dispatch path (runAgent) used to load the api-key-store shadow (the
 * access-token copy removed in #277) directly and — because the keyless-custom-
 * provider exception applied to the dynamically-registered gateway — let an
 * EMPTY result pass the send gate, reaching the request layer which then
 * sent without Authorization (#172 finding 4). The shadow is also a
 * best-effort cache: a refresh whose SQLite shadow write failed leaves a
 * stale or missing shadow behind even though localStorage holds the current
 * token (#172 finding 5).
 *
 * This resolver reads the AUTHORITATIVE token pair (localStorage, with the
 * SQLite refresh-token fallback), validates the access token's freshness,
 * refreshes when needed, and reports WHY it failed:
 *  - 'missing' / 'expired' — confirmed absence/expiry: the caller must stop
 *    before network dispatch and offer login.
 *  - 'temporary' — transient storage/refresh/network failure: retryable,
 *    and it must NOT clear a possibly valid session.
 */
export async function resolveGatewayDispatchCredential(
  baseURL: string,
  clientId: string
): Promise<GatewayDispatchCredential> {
  // Snapshot before the first await: a logout/login during credential
  // resolution bumps this and makes the verdict's status write stale (#180).
  const dispatchGeneration = authSessionGeneration
  let stored: StoredTokens | null
  try {
    stored = await loadStoredTokensWithFallback()
  } catch (e) {
    // A storage READ FAILURE is not absence (#172 finding 3, #175 review):
    // report temporary so the caller keeps the session retryable instead of
    // falsely declaring the user logged out.
    if (e instanceof GatewayTokenStoreUnavailableError) {
      return { ok: false, kind: 'temporary', error: e }
    }
    throw e
  }
  if (!stored) {
    // The token pair is gone. Distinguish a session that DIED (the access
    // shadow of an earlier session survives — 'expired') from never having
    // logged in ('missing'). A storage error is NOT proof of absence (#172
    // finding 3): report it as temporary so the caller keeps the session
    // retryable instead of falsely declaring the user logged out.
    const inspection = await inspectPriorSession()
    if (inspection === 'error') {
      return { ok: false, kind: 'temporary', error: new Error('gateway credential storage unavailable') }
    }
    if (inspection === 'had-session') {
      setCredentialStatus('expired', dispatchGeneration)
      return { ok: false, kind: 'expired' }
    }
    setCredentialStatus('missing', dispatchGeneration)
    return { ok: false, kind: 'missing' }
  }

  const now = Date.now()
  // A malformed persisted record (future expiry, empty/whitespace token)
  // must not pass as a usable credential: the request would go out without
  // an Authorization header (#175 review). Treat it as not-fresh and fall
  // through to the refresh/clear paths below.
  const accessTokenUsable =
    typeof stored.access_token === 'string' && stored.access_token.trim().length > 0
  // Fresh access token (60s buffer, same as getValidAccessToken).
  if (accessTokenUsable && stored.access_expires_at > now + 60_000) {
    setCredentialStatus('valid', dispatchGeneration)
    return { ok: true, accessToken: stored.access_token }
  }

  // Expired access token but a live refresh token: refresh (the shared
  // refresh lock + per-tab in-flight dedup inside
  // refreshAccessTokenWithStatus serialize this across tabs).
  if (stored.refresh_expires_at > now) {
    const result = await refreshAccessTokenWithStatus(baseURL, clientId)
    if (result.status === 'success') return { ok: true, accessToken: result.accessToken }
    if (result.status === 'expired') return { ok: false, kind: 'expired', error: result.error }
    if (result.status === 'missing') return { ok: false, kind: 'missing' }
    return { ok: false, kind: 'temporary', error: result.error }
  }

  // Both tokens expired locally: clearStoredTokens marks 'expired' inside
  // its critical section when this context still owns the session; a
  // no-op purge (another context already replaced/cleared) still leaves
  // the caller unable to dispatch — report expired (the liveness of a
  // REPLACED session is re-checked on the next dispatch, and a refreshed
  // foreign session is picked up by the resolver's next read).
  if (await clearStoredTokens(stored.refresh_token, 'expired')) {
    return { ok: false, kind: 'expired' }
  }
  return { ok: false, kind: 'expired', error: new Error('session changed during dispatch') }
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no tokens are stored or refresh fails.
 */
export async function getValidAccessToken(
  baseURL: string,
  clientId: string
): Promise<string | null> {
  // Snapshot before the first await so a logout/login during the read cannot
  // let this verdict overwrite the newer session's status (#180).
  const loadGeneration = authSessionGeneration
  // Use the async fallback loader — recovers refresh_token from SQLite
  // when localStorage has been cleared
  const stored = await loadStoredTokensWithFallback()
  if (!stored) {
    // The token pair is gone, but the api-key-store may still hold the
    // access_token shadow of an earlier session. That means the session DIED
    // (the user had logged in), not that they never logged in — report
    // 'expired' and purge the shadow so the settings card offers a re-login
    // instead of a logout.
    const hadSession = (await inspectPriorSession()) === 'had-session'
    setCredentialStatus(hadSession ? 'expired' : 'missing', loadGeneration)
    return null
  }

  const now = Date.now()

  // If access token is still valid (with 60s buffer), return it
  if (stored.access_expires_at > now + 60_000) {
    setCredentialStatus('valid', loadGeneration)
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
 * Is there a session the UI should show as logged in?
 *
 * Unlike `hasStoredTokens()` (localStorage only) this also counts the durable
 * refresh-token record: a browser that evicted localStorage still renders
 * "logged in", because the next dispatch restores the pair from that record
 * (#277). The api-key shadow used to cover this case; the record is the record
 * the restore actually reads. A store failure reports false — the card then
 * offers login, which is recoverable.
 */
export async function hasStoredSession(): Promise<boolean> {
  if (hasStoredTokens()) return true
  return (await inspectPriorSession()) === 'had-session'
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
  // The call can now REJECT when the key-store purge fails (a surviving
  // refresh-token backup would be resurrectable, a surviving access-key
  // shadow keeps the "Logged in" badge lit). Surface that to the caller —
  // a failed logout must not render as success — with an i18n message.
  try {
    await clearStoredTokens(undefined, 'missing')
  } catch (e) {
    console.warn('[llm-gateway] logout purge failed:', e)
    throw new Error(
      translate(useI18nStore.getState().locale, 'conversation.error.gatewayCredentialPurgeFailed')
    )
  }
}

/** Expire a token rejected by the gateway only if it still owns the session. */
export async function invalidateGatewayAccessToken(accessToken: string): Promise<void> {
  const stored = loadStoredTokens()
  if (stored?.access_token !== accessToken) return
  await clearStoredTokens(stored.refresh_token, 'expired')
}

/**
 * Fetch available models from the gateway.
 *
 * The result distinguishes an AUTHORITATIVE empty catalog from a FAILED
 * fetch — the two look identical in the response body (`data: []` vs a
 * non-200 response) but mean opposite things:
 *
 * - `failed` — the request did not produce a usable catalog (non-2xx,
 *   unparseable body, network error). The provider's model list is UNKNOWN:
 *   it is missing information, never proof that every model was delisted.
 *   Callers must not switch the user's selection or flag pins as stale.
 * - `empty` — the gateway answered successfully and positively reports that
 *   it serves no models. This IS authoritative information: pins for this
 *   provider are genuinely gone.
 * - `ready` — the gateway answered with a non-empty catalog.
 */
export async function fetchGatewayModels(
  baseURL: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ models: Array<{ id: string; name: string }>; status: ProviderCatalogStatus; authRejected?: boolean }> {
  let res: Response
  try {
    res = await fetch(`${baseURL}/v1/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    })
  } catch (e) {
    // An explicit cancellation still propagates; only genuine network
    // failures degrade to a failed (unknown) catalog.
    if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e
    // A network failure carries NO catalog information — it is a failed
    // refresh, not an authoritative empty list.
    return { models: [], status: 'failed' }
  }
  // A non-2xx response carries NO catalog information — it is a failed
  // refresh, not an authoritative empty list.
  if (!res.ok) return { models: [], status: 'failed', authRejected: res.status === 401 }

  // A body that cannot be read or parsed (truncated stream, malformed JSON)
  // is an unusable response, not an authoritative "no models": degrade to a
  // failed catalog instead of rejecting (Sourcery: "Invalid JSON rejects
  // model fetch" — res.json() previously threw outside this handling, so
  // callers never received the failed-catalog result).
  let data: { data?: unknown }
  try {
    data = (await res.json()) as { data?: unknown }
  } catch (e) {
    // An abort landing while the body read is still pending (the discovery
    // deadline firing after the headers arrived) is NOT a failed catalog —
    // it carries no catalog information at all. Re-throw it so the caller's
    // timeout/cancellation handling runs instead of committing an empty
    // result that would drop previously registered models (Sourcery:
    // "Timed-out body read erases gateway models").
    if (signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e
    return { models: [], status: 'failed' }
  }
  // A body that is not a model array is an unusable response, not an
  // authoritative "no models".
  if (!data?.data || !Array.isArray(data.data)) return { models: [], status: 'failed' }

  // Per-entry validation (Sourcery round 6, "Malformed gateway models are
  // accepted"): a gateway that answers 200 with garbage entries — null,
  // non-objects, or entries without a usable string `id` — is not sending a
  // catalog. Mapping blind dereferenced null entries or empty-string ids
  // produced either a thrown rejection (callers never saw the failed status)
  // or a 'ready' status over an unusable list (empty-string ids selectable).
  // Malformed SHAPE is treated like malformed JSON (b244dfeb): a failed,
  // retryable catalog — never an authoritative empty one.
  type RawModel = { id?: unknown; name?: unknown }
  const usable: Array<{ id: string; name: string }> = []
  for (const entry of data.data) {
    if (typeof entry !== 'object' || entry === null) return { models: [], status: 'failed' }
    const m = entry as RawModel
    if (typeof m.id !== 'string' || m.id.trim() === '') return { models: [], status: 'failed' }
    usable.push({ id: m.id, name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id })
  }
  // A SUCCESSFUL response IS authoritative, empty or not: an empty `data:[]`
  // positively reports that the gateway serves no models.
  return { models: usable, status: usable.length > 0 ? 'ready' : 'empty' }
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
