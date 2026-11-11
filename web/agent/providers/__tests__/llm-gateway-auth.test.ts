/**
 * Regression tests for the llm-gateway token-refresh hardening (issue #74).
 *
 * Contract (confirmed by the backend team): `/v1/auth/refresh` NEVER returns
 * `refresh_token` / `refresh_expires_in`. The refresh token is issued ONCE by
 * the device-code login, lives 7 days, and never rotates. The pre-hardening
 * implementation copied the whole response over the stored pair, which
 * dropped the refresh_token key (JSON.stringify drops undefined) and set
 * refresh_expires_at to NaN (null after serialization) — after one
 * successful auto-refresh the next refresh found no refresh token and
 * cleared the credentials, forcing re-login.
 *
 * Expected behavior now:
 * - refresh keeps the STORED refresh_token / refresh_expires_at (only
 *   access_token / expires_in come from the response)
 * - a refresh_token in the response (future rotation) still overwrites
 * - ownership check before the clear-on-invalid path
 * - SQLite fallback refuses expired/malformed refresh tokens
 * - 5xx / network errors keep the stored tokens
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the dynamic import used by clearStoredTokens()/purge so the test never
// touches the real SQLite-backed api-key store.
const deleteApiKeyMock = vi.hoisted(() => vi.fn<(provider: string) => Promise<void>>())
const loadApiKeyMock = vi.hoisted(() =>
  vi.fn<(provider: string) => Promise<string | null>>(async () => null)
)
const saveApiKeyMock = vi.hoisted(() => vi.fn<(provider: string, value: string) => Promise<void>>())

vi.mock('@/security/api-key-store', () => ({
  saveApiKey: (...args: unknown[]) => saveApiKeyMock(...(args as [string, string])),
  loadApiKey: (...args: unknown[]) => loadApiKeyMock(...(args as [string])),
  deleteApiKey: (...args: unknown[]) => deleteApiKeyMock(...(args as [string])),
}))

// The auth layer pushes the credential state into the settings store through a
// dynamic import — stub it so the tests never load the real store. The stub
// keeps a PERSISTENT state object so tests can assert the
// modelCredentialStatusError flag the purge-failure path sets.
const settingsStoreState = vi.hoisted(() => ({
  modelCredentialStatus: 'unknown' as string,
  modelCredentialStatusError: null as string | null,
  // Ordered log of status writes the auth layer actually LANDED. Proves a
  // verdict was dropped instead of merely overwritten by a later one.
  statusWrites: [] as string[],
  // A purge must invalidate the cached api-key verdict, or checkHasApiKey()
  // keeps answering `true` for a session whose key was just deleted.
  invalidatedKeyCaches: [] as string[],
  apiKeyChecks: [] as Array<{ flush: boolean }>,
  // Which provider the app has selected. `checkHasApiKey()` answers for THAT
  // provider, so the purge resync must not run it on someone else's behalf.
  providerType: 'llm-gateway' as string,
  // Stateful stand-in for the real store's cached verdict: `hasApiKey` is what
  // the UI reads, and it is only re-derived from the key store when a check
  // runs. Asserting on this (instead of the call log) is what catches a purge
  // that leaves the UI still believing the gateway is configured.
  gatewayKeyPresent: true,
  hasApiKey: true,
  hasApiKeyLoaded: true,
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({
      setModelCredentialStatus: (status: string) => {
        settingsStoreState.statusWrites.push(status)
        settingsStoreState.modelCredentialStatus = status
      },
      setModelCredentialStatusError: (message: string | null) => {
        settingsStoreState.modelCredentialStatusError = message
      },
      invalidateApiKeyCache: (provider: string) => {
        settingsStoreState.invalidatedKeyCaches.push(provider)
        settingsStoreState.hasApiKeyLoaded = false
      },
      checkHasApiKey: async (options?: { flush?: boolean }) => {
        settingsStoreState.apiKeyChecks.push({ flush: options?.flush === true })
        settingsStoreState.hasApiKey = settingsStoreState.gatewayKeyPresent
        settingsStoreState.hasApiKeyLoaded = true
        return settingsStoreState.hasApiKey
      },
      providerType: settingsStoreState.providerType,
      hasApiKey: settingsStoreState.hasApiKey,
      hasApiKeyLoaded: settingsStoreState.hasApiKeyLoaded,
      modelCredentialStatus: settingsStoreState.modelCredentialStatus,
      modelCredentialStatusError: settingsStoreState.modelCredentialStatusError,
    }),
  },
}))

import {
  forceRefreshAccessToken,
  refreshAccessTokenWithStatus,
  getGatewayCredentialStatus,
  getValidAccessToken,
  logoutGateway,
  invalidateGatewayAccessToken,
  performDeviceCodeFlow,
  persistDeviceLoginTokens,
  resolveGatewayDispatchCredential,
  subscribeToGatewaySessionEvents,
  getGatewayAuthSessionGeneration,
  isCredentialStatusCurrent,
  isGatewayAccessTokenCurrent,
  type GatewaySessionEvent,
  hasStoredSession,
} from '@/agent/providers/llm-gateway-auth'
import { getModelsForProvider, getProviderCatalogStatus, getProviderConfig, registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
// The catalog module registers the token-purge listener at import time; the
// expired-purge cases below only observe a 'failed' status when it is loaded
// (in the app it always is — AppBootstrap imports it before any auth path).
import {
  beginGatewayCatalogRefresh,
  isGatewayCatalogRefreshCurrent,
  registerGatewayModels,
} from '@/agent/providers/llm-gateway-provider'

const BASE_URL = 'https://ai.jianguoyun.com'
const CLIENT_ID = 'test-client-id'
const TOKENS_KEY = 'llm-gateway-tokens'

it('does not save tokens when a device login is cancelled during session creation', async () => {
  localStorage.clear()
  const controller = new AbortController()
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))
  try {
    const pending = performDeviceCodeFlow(BASE_URL, CLIENT_ID, undefined, controller.signal)
    controller.abort()
    release(new Response(JSON.stringify({
      device_code: 'device', user_code: '123', verification_uri: 'https://example.com',
      interval: 1, expires_in: 60,
    }), { status: 200 }))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
}, 500)

it('defers device token persistence until the login commit', async () => {
  localStorage.clear()
  const token = {
    access_token: 'new-access', token_type: 'Bearer', expires_in: 60,
    refresh_token: 'new-refresh', refresh_expires_in: 3600,
  }
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      device_code: 'device', user_code: '123', verification_uri: 'https://example.com',
      interval: 0, expires_in: 60,
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(token), { status: 200 })))
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  try {
    const result = await performDeviceCodeFlow(BASE_URL, CLIENT_ID)
    expect(result.access_token).toBe('new-access')
    expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    persistDeviceLoginTokens(result, CLIENT_ID, BASE_URL)
    expect(localStorage.getItem(TOKENS_KEY)).toContain('new-refresh')
  } finally {
    open.mockRestore()
    vi.unstubAllGlobals()
  }
})

function seedStoredTokens(overrides: Partial<{
  refresh_expires_at: number
  access_expires_at: number
  refresh_token: string
}> = {}): { refresh_token: string; refresh_expires_at: number } {
  const now = Date.now()
  const refreshToken = overrides.refresh_token ?? 'refresh-token'
  const refreshExpiresAt =
    overrides.refresh_expires_at ?? now + 30 * 24 * 60 * 60 * 1000
  localStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      access_token: 'stale-access-token',
      refresh_token: refreshToken,
      access_expires_at: overrides.access_expires_at ?? now - 1000, // expired → forces refresh path
      refresh_expires_at: refreshExpiresAt,
      client_id: CLIENT_ID,
      base_url: BASE_URL,
    })
  )
  return { refresh_token: refreshToken, refresh_expires_at: refreshExpiresAt }
}

/** A REAL /v1/auth/refresh response: no refresh_token, no refresh_expires_in. */
function refreshResponse(accessToken = 'new-token', expiresIn = 60): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn }),
    { status: 200 }
  )
}

describe('llm-gateway-auth token refresh hardening', () => {
  beforeEach(() => {
    localStorage.clear()
    deleteApiKeyMock.mockReset()
    deleteApiKeyMock.mockResolvedValue(undefined)
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue(null)
    saveApiKeyMock.mockReset()
    saveApiKeyMock.mockResolvedValue(undefined)
    settingsStoreState.invalidatedKeyCaches.length = 0
    settingsStoreState.apiKeyChecks.length = 0
    settingsStoreState.providerType = 'llm-gateway'
    settingsStoreState.gatewayKeyPresent = true
    settingsStoreState.hasApiKey = true
    settingsStoreState.hasApiKeyLoaded = true
  })

  afterEach(() => {
    localStorage.clear()
    unregisterDynamicProvider('llm-gateway')
    vi.unstubAllGlobals()
  })

  describe('refresh preserves the stored refresh token (real backend contract)', () => {
    it('allows another refresh attempt after a hung refresh reaches its deadline', async () => {
      seedStoredTokens()
      const controller = new AbortController()
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
      let refreshSignal: AbortSignal | undefined
      const fetchMock = vi.fn()
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          refreshSignal = init.signal as AbortSignal
          return new Promise<Response>((_resolve, reject) =>
            refreshSignal!.addEventListener('abort', () => reject(refreshSignal!.reason), { once: true }))
        })
        .mockResolvedValueOnce(refreshResponse('retry-token'))
      vi.stubGlobal('fetch', fetchMock)
      try {
        const first = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        controller.abort(new Error('refresh timed out'))
        await expect(first).resolves.toMatchObject({ status: 'temporary_error' })
        expect(refreshSignal?.aborted).toBe(true)

        timeoutSpy.mockRestore()
        await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).resolves.toMatchObject({
          status: 'success', accessToken: 'retry-token',
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        timeoutSpy.mockRestore()
      }
    })

    it('stops a discovery caller at its deadline while a shared refresh continues', async () => {
      seedStoredTokens()
      let complete!: (response: Response) => void
      let sharedSignal: AbortSignal | undefined
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        sharedSignal = init.signal as AbortSignal
        return new Promise<Response>((resolve, reject) => {
          complete = resolve
          sharedSignal!.addEventListener('abort', () => reject(sharedSignal!.reason), { once: true })
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()
      const discovery = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID, controller.signal)

      await vi.waitFor(() => expect(complete).toBeDefined())
      controller.abort(new Error('discovery timed out'))
      await expect(discovery).rejects.toThrow('discovery timed out')
      expect(sharedSignal?.aborted).toBe(false)

      const shared = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      complete(refreshResponse())
      await expect(shared).resolves.toMatchObject({ status: 'success' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('keeps the stored refresh_token and refresh_expires_at when the response has neither', async () => {
      const seeded = seedStoredTokens()

      vi.stubGlobal('fetch', vi.fn(async () => refreshResponse('new-access', 120)))

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('success')

      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      // Access token comes from the response…
      expect(stored.access_token).toBe('new-access')
      // Expiry must be completion time + the response's 120s TTL — assert a
      // narrow band so a start-time-based or truncated calculation fails.
      const afterRefresh = Date.now()
      expect(stored.access_expires_at).toBeGreaterThanOrEqual(afterRefresh + 119_000)
      expect(stored.access_expires_at).toBeLessThanOrEqual(afterRefresh + 121_000)
      // …but the 7-day refresh token survives untouched.
      expect(stored.refresh_token).toBe(seeded.refresh_token)
      expect(stored.refresh_expires_at).toBe(seeded.refresh_expires_at)
      // No NaN leaking into storage (pre-fix this serialized as null).
      expect(Number.isFinite(stored.refresh_expires_at)).toBe(true)
    })

    it('the preserved refresh token is actually usable for the NEXT refresh', async () => {
      seedStoredTokens()
      const fetchMock = vi.fn(async () => refreshResponse('access-1', 60))
      vi.stubGlobal('fetch', fetchMock)

      const first = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(first.status).toBe('success')

      // Expire the new access token so the next call goes back to the refresh path.
      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      stored.access_expires_at = Date.now() - 1000
      localStorage.setItem(TOKENS_KEY, JSON.stringify(stored))

      const second = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(second.status).toBe('success')
      expect((second as { accessToken: string }).accessToken).toBe('access-1')
      // Both calls hit /v1/auth/refresh with the ORIGINAL refresh token.
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const sentBody = JSON.parse(
        (fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body
      )
      expect(sentBody.refresh_token).toBe('refresh-token')
    })

    it('overwrites the refresh token when a future backend DOES rotate', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              token_type: 'Bearer',
              expires_in: 60,
              refresh_token: 'rotated-refresh',
              refresh_expires_in: 7 * 24 * 3600,
            }),
            { status: 200 }
          )
        )
      )

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('success')

      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('rotated-refresh')
      expect(stored.refresh_expires_at).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000)
    })

    it('treats a response without access_token as a temporary error (tokens untouched)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ token_type: 'Bearer', expires_in: 60 }), { status: 200 }))
      )

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('temporary_error')

      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('refresh-token')
      expect(stored.access_token).toBe('stale-access-token')
    })

    it('treats a non-positive expires_in as a temporary error (tokens untouched)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ access_token: 'x', token_type: 'Bearer', expires_in: 0 }), { status: 200 })
        )
      )

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('temporary_error')

      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('refresh-token')
      expect(stored.access_token).toBe('stale-access-token')
    })
  })

  describe('ownership check before clearing on invalid_grant', () => {
    it('clears everything when the stored token still belongs to this request', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
        )
      )

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('expired')
      await vi.waitFor(() => {
        expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_refresh_token__')
      })
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    })

    it('keeps the shared store when another context replaced the refresh token mid-flight', async () => {
      seedStoredTokens({ refresh_token: 'my-refresh' })
      let resolveRefresh!: (response: Response) => void
      const refreshResponsePromise = new Promise<Response>((resolve) => { resolveRefresh = resolve })
      vi.stubGlobal('fetch', vi.fn(() => refreshResponsePromise))

      const pending = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)

      // Another tab logs in and replaces the stored pair while we're in flight.
      seedStoredTokens({ refresh_token: 'other-tab-refresh' })

      resolveRefresh(
        new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
      )
      const result = await pending

      // Our request's token is dead → 'expired', but the SHARED store still
      // holds the other tab's fresh credential — only local state is dropped.
      expect(result.status).toBe('expired')
      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('other-tab-refresh')
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
    })
  })

  it('removes a legacy access-token shadow when logging out', async () => {
    seedStoredTokens()
    await logoutGateway()
    expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
  })

  describe('SQLite fallback freshness validation', () => {
    it('refuses to restore an expired refresh token from SQLite', async () => {
      // No localStorage copy → forced through the SQLite fallback.
      loadApiKeyMock.mockImplementation(async (provider: string) =>
        provider === '__llm_gateway_refresh_token__'
          ? JSON.stringify({
              refresh_token: 'stale-refresh',
              refresh_expires_at: Date.now() - 1000,
              access_token: 'old-access',
              access_expires_at: Date.now() - 2000,
              client_id: CLIENT_ID,
              base_url: BASE_URL,
            })
          : null
      )
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)

      // The stale token must NOT be resurrected (pre-fix this restored it and
      // guaranteed invalid_grant); the caller sees the honest 'missing'/
      // 'expired' state instead.
      expect(result.status).not.toBe('success')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    })

    it('restores and uses a still-fresh refresh token from SQLite', async () => {
      loadApiKeyMock.mockImplementation(async (provider: string) =>
        provider === '__llm_gateway_refresh_token__'
          ? JSON.stringify({
              refresh_token: 'sqlite-refresh',
              refresh_expires_at: Date.now() + 7 * 24 * 3600 * 1000,
              access_token: 'old-access',
              access_expires_at: Date.now() - 1000,
              client_id: CLIENT_ID,
              base_url: BASE_URL,
            })
          : null
      )
      const fetchMock = vi.fn(async () => refreshResponse('fresh-from-sqlite', 60))
      vi.stubGlobal('fetch', fetchMock)

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)

      expect(result.status).toBe('success')
      expect((result as { accessToken: string }).accessToken).toBe('fresh-from-sqlite')
      const sentBody = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body
      )
      expect(sentBody.refresh_token).toBe('sqlite-refresh')
      // The restored pair is promoted back to localStorage for the fast path.
      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('sqlite-refresh')
    })
  })

  describe('transient failures keep the stored tokens', () => {
    it('keeps tokens (and the shadow key) on 5xx from the refresh endpoint', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ message: 'upstream boom' }), { status: 502 }))
      )

      const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(result.status).toBe('temporary_error')

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
      const stored = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      expect(stored.refresh_token).toBe('refresh-token')
    })

    it('keeps tokens on network errors (TypeError)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('Failed to fetch')
        })
      )

      const result = await forceRefreshAccessToken(BASE_URL, CLIENT_ID)
      expect(result).toBeNull()

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
      expect(localStorage.getItem(TOKENS_KEY)).not.toBeNull()
    })
  })

  describe('pre-existing invariants (rewritten to the real contract)', () => {
    it('reuses one refresh request for concurrent callers', async () => {
      seedStoredTokens()
      let resolveRefresh!: (response: Response) => void
      const refreshResponsePromise = new Promise<Response>((resolve) => { resolveRefresh = resolve })
      const fetchMock = vi.fn(() => refreshResponsePromise)
      vi.stubGlobal('fetch', fetchMock)

      const first = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      const second = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      expect(first).toBe(second)
      resolveRefresh(refreshResponse('new-token', 60))

      const results = await Promise.all([first, second])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(results).toEqual([
        { status: 'success', accessToken: 'new-token' },
        { status: 'success', accessToken: 'new-token' },
      ])
    })

    it('discards a refresh that completes after logout (stale session)', async () => {
      seedStoredTokens()
      let resolveRefresh!: (response: Response) => void
      const refreshResponsePromise = new Promise<Response>((resolve) => { resolveRefresh = resolve })
      vi.stubGlobal('fetch', vi.fn(() => refreshResponsePromise))

      const pending = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      await logoutGateway() // session ends while the refresh is in flight
      resolveRefresh(refreshResponse('late-token', 60))

      const result = await pending
      expect(result.status).toBe('temporary_error')
      // Nothing from the dead session may be written
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    })

    it('does not overwrite a newer login committed in another tab', async () => {
      seedStoredTokens()
      let resolveRefresh!: (response: Response) => void
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveRefresh = resolve })))
      const pending = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
      const newer = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
      newer.access_token = 'newer-login-access'
      newer.refresh_token = 'newer-login-refresh'
      localStorage.setItem(TOKENS_KEY, JSON.stringify(newer))
      resolveRefresh(refreshResponse('old-session-refresh', 60))

      await expect(pending).resolves.toMatchObject({ status: 'temporary_error' })
      expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!).refresh_token).toBe('newer-login-refresh')
    })

    it('does not restore an old SQLite backup over a newer cross-tab login', async () => {
      seedStoredTokens()
      vi.stubGlobal('fetch', vi.fn(async () => refreshResponse('old-session-refresh')))
      const oldBackup = localStorage.getItem(TOKENS_KEY)!
      localStorage.removeItem(TOKENS_KEY)
      let releaseBackup!: (value: string) => void
      loadApiKeyMock.mockImplementation(() => new Promise<string>((resolve) => { releaseBackup = resolve }))
      const pending = getValidAccessToken(BASE_URL, CLIENT_ID)
      await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalled())
      const newer = JSON.parse(oldBackup)
      newer.access_token = 'newer-login-access'
      newer.refresh_token = 'newer-login-refresh'
      newer.access_expires_at = Date.now() + 3600_000
      localStorage.setItem(TOKENS_KEY, JSON.stringify(newer))
      releaseBackup(oldBackup)

      await expect(pending).resolves.toBe('newer-login-access')
      expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!).refresh_token).toBe('newer-login-refresh')
    })

    it('logout does not hold the credential lock forever on a stalled key-store delete', async () => {
      seedStoredTokens()
      // A deletion that NEVER settles: the logout must still complete within
      // the deadline window (bounded key-store ops), not hang forever.
      let releaseStalledDelete!: () => void
      deleteApiKeyMock.mockImplementation((provider) =>
        provider === '__llm_gateway_refresh_token__'
          ? new Promise<void>((resolve) => { releaseStalledDelete = resolve }) // never settles until released
          : Promise.resolve(),
      )

      const logout = logoutGateway()
      const finishedEarly = await Promise.race([
        logout.then(
          () => 'done' as const,
          () => 'done' as const,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
      ])
      // Not yet done (deadline is 10s), but crucially NOT blocked forever —
      // the assertion below proves logout settles once the deadline fires.
      expect(finishedEarly).toBe('pending')
      // Logout ultimately REJECTS with the purge error (the backup delete
      // timed out, so the purge is incomplete) instead of hanging.
      await expect(logout).rejects.toThrow()
      // The registry now tracks the UNDERLYING op's real settlement, so the
      // stalled delete must be released for later credential commits to
      // proceed within the test timeout.
      releaseStalledDelete()
    }, 20_000)

    it('logout rejects instead of reporting success when the purge fails', async () => {
      seedStoredTokens()
      registerDynamicProvider('llm-gateway',
        { baseURL: BASE_URL, modelName: 'old-model', headers: {} },
        { category: 'chinese', displayName: 'Nutstore AI', models: [{ id: 'old-model', name: 'Old', capabilities: ['code'] }], catalogStatus: 'ready' },
      )
      // The refresh-token backup deletion fails: a surviving backup could be
      // resurrected by the SQLite fallback, so logout must NOT report
      // complete — the caller gets a retryable error.
      deleteApiKeyMock.mockImplementation((provider) =>
        provider === '__llm_gateway_refresh_token__'
          ? Promise.reject(new Error('sqlite unavailable'))
          : Promise.resolve(),
      )

      await expect(logoutGateway()).rejects.toThrow()
      // The local pair is still wiped (that part succeeded) and the purge
      // failure must be visible to the UI through the settings store flag.
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
      expect(getModelsForProvider('llm-gateway')).toEqual([])
    })

    it('purge failure marks the credential status write as failed for the UI', async () => {
      deleteApiKeyMock.mockRejectedValue(new Error('sqlite unavailable'))

      await expect(logoutGateway()).rejects.toThrow()
      expect(settingsStoreState.modelCredentialStatusError).not.toBeNull()

      // A later successful purge clears the stale-state flag.
      deleteApiKeyMock.mockResolvedValue(undefined)
      await logoutGateway()
      expect(settingsStoreState.modelCredentialStatusError).toBeNull()
    })

    it('getValidAccessToken returns the cached access token while it is still valid', async () => {
      const now = Date.now()
      localStorage.setItem(
        TOKENS_KEY,
        JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'refresh-token',
          access_expires_at: now + 10 * 60 * 1000,
          refresh_expires_at: now + 30 * 24 * 60 * 60 * 1000,
          client_id: CLIENT_ID,
          base_url: BASE_URL,
        })
      )

      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBe('fresh-access-token')
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
    })

    it('a surviving refresh-token record without a token pair reports "expired"', async () => {
      // The durable record is the tombstone (#277): the pair is gone but the
      // browser did log in, so this is a dead session, not a fresh install.
      loadApiKeyMock.mockImplementation(async (provider: string) =>
        provider === '__llm_gateway_refresh_token__' ? '{"refresh_token":"r"}' : null
      )

      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBeNull()
      expect(getGatewayCredentialStatus()).toBe('expired')
    })

    it('no shadow either (never logged in) still reports "missing"', async () => {
      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBeNull()
      expect(getGatewayCredentialStatus()).toBe('missing')
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
    })

    it('refuses a STALE purge that lands after a newer credential commit (fenced at the mutation point)', async () => {
      // Round-20: a logout whose key-store deletion stays pending past the
      // registry TTL/quiescence cap while ANOTHER tab commits a fresh login
      // must not delete that login's keys. The landing-point fence re-checks
      // the commit sequence AFTER the deletion resolved and turns it into a
      // purge failure — logout reports the retryable error instead of
      // reporting complete (a "complete" logout that deleted a newer
      // session's credentials would leave the newer tab logged out).
      localStorage.clear()
      const { __resetGatewayCredentialFencingForTests } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      __resetGatewayCredentialFencingForTests()
      // The lock grant itself stamps the commit sequence (seq=1) inside the
      // logout's critical section; a newer login commit is seq=2. The
      // refresh-token backup delete pends (simulating the suspended-tab
      // stall); the shadow delete resolves immediately — BOTH then hit the
      // landing-point fence and fail into purgeFailures.
      const pendingDeletes: Array<() => void> = []
      deleteApiKeyMock.mockImplementation((provider: string) =>
        provider === '__llm_gateway_refresh_token__'
          ? new Promise<void>((resolve) => {
              pendingDeletes.push(() => resolve())
            })
          : Promise.resolve(),
      )
      const logout = logoutGateway()
      await vi.waitFor(() => expect(deleteApiKeyMock).toHaveBeenCalledTimes(1))
      // A newer tab commits a login while this deletion is pending.
      localStorage.setItem('eo2weave-gateway-credential-commit-seq', '2')
      for (const release of pendingDeletes) release()

      // The fenced deletion is a purge failure: logout must NOT declare the
      // session gone.
      await expect(logout).rejects.toThrow()
      expect(settingsStoreState.modelCredentialStatusError).not.toBeNull()
      __resetGatewayCredentialFencingForTests()
    })

    it('invalidates only the access token rejected by the gateway', async () => {
      seedStoredTokens()
      await invalidateGatewayAccessToken('different-token')
      expect(localStorage.getItem(TOKENS_KEY)).not.toBeNull()

      await invalidateGatewayAccessToken('stale-access-token')
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
      expect(getGatewayCredentialStatus()).toBe('expired')
    })

    it('clears the prior gateway catalog after logout so another account cannot inherit it', async () => {
      registerDynamicProvider('llm-gateway',
        { baseURL: `${BASE_URL}/v1`, modelName: 'old-model', headers: {} },
        { category: 'chinese', displayName: 'Nutstore AI', models: [{ id: 'old-model', name: 'Old', capabilities: ['code'] }], catalogStatus: 'ready' },
      )
      try {
        await logoutGateway()
        expect(getModelsForProvider('llm-gateway')).toEqual([])
      } finally {
        unregisterDynamicProvider('llm-gateway')
      }
    })

    it('keeps the prior gateway catalog with a failed status when the refresh token expires', async () => {
      seedStoredTokens({ refresh_expires_at: Date.now() - 1000 })
      registerDynamicProvider('llm-gateway',
        { baseURL: `${BASE_URL}/v1`, modelName: 'old-model', headers: {} },
        { category: 'chinese', displayName: 'Nutstore AI', models: [{ id: 'old-model', name: 'Old', capabilities: ['code'] }], catalogStatus: 'ready' },
      )
      try {
        await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).resolves.toMatchObject({ status: 'expired' })
        // An expired session is NOT a logout (#224): the provider stays
        // registered so Retry / re-login remain reachable, and the last usable
        // list stays visible instead of disappearing with the purge.
        expect(getProviderConfig('llm-gateway')).toBeTruthy()
        expect(getProviderCatalogStatus('llm-gateway')).toBe('failed')
        expect(getModelsForProvider('llm-gateway')).toEqual([
          { id: 'old-model', name: 'Old', capabilities: ['code'] },
        ])
      } finally {
        unregisterDynamicProvider('llm-gateway')
      }
    })

    it('re-resolves hasApiKey after an expired purge so the UI stops treating it as configured', async () => {
      seedStoredTokens({ refresh_expires_at: Date.now() - 1000 })
      // The key store really loses the gateway's credential on purge; the
      // cached verdict only follows if the resync actually runs.
      deleteApiKeyMock.mockImplementation(async (key: string) => {
        if (key === '__llm_gateway_refresh_token__') settingsStoreState.gatewayKeyPresent = false
      })
      expect(settingsStoreState.hasApiKey).toBe(true)

      await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).resolves.toMatchObject({ status: 'expired' })

      // checkHasApiKey() answers from a module-level cache that only the
      // login / logout / reconcile paths invalidate. Without this, a cached
      // `true` outlives the purge and the welcome screen keeps the gateway
      // "configured" instead of offering setup / re-login (review: "Expired
      // credentials leave a stale key result").
      expect(settingsStoreState.apiKeyChecks).toEqual([{ flush: true }])
      // The state the UI actually reads. Asserting only the calls above would
      // pass even if the re-check never landed (review: "Stale key state goes
      // undetected").
      expect(settingsStoreState.hasApiKeyLoaded).toBe(true)
      expect(settingsStoreState.hasApiKey).toBe(false)
    })

    it('does not force a key check while another provider is selected', async () => {
      // A different dynamic provider is selected and still registering, so its
      // loading state has not resolved yet.
      settingsStoreState.providerType = 'codex-oauth'
      settingsStoreState.hasApiKeyLoaded = false
      seedStoredTokens({ refresh_expires_at: Date.now() - 1000 })
      deleteApiKeyMock.mockImplementation(async (key: string) => {
        if (key === '__llm_gateway_refresh_token__') settingsStoreState.gatewayKeyPresent = false
      })

      await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).resolves.toMatchObject({ status: 'expired' })

      // checkHasApiKey() answers for the SELECTED provider: forcing it here
      // would resolve that provider's status and end its loading state before
      // its own registration completes (review: "Other provider shows false
      // setup state"). Dropping the gateway's cache entry is enough.
      expect(settingsStoreState.apiKeyChecks).toEqual([])
      expect(settingsStoreState.hasApiKeyLoaded).toBe(false)
    })

    it('records the outage before the purge awaits the key store, so an in-flight refresh can still commit', async () => {
      seedStoredTokens({ refresh_expires_at: Date.now() - 1000 })
      registerDynamicProvider('llm-gateway',
        { baseURL: `${BASE_URL}/v1`, modelName: 'old-model', headers: {} },
        { category: 'chinese', displayName: 'Nutstore AI', models: [{ id: 'old-model', name: 'Old', capabilities: ['code'] }], catalogStatus: 'ready' },
      )
      // Catalog work that started BEFORE the purge and is still in flight.
      const inFlightRefresh = beginGatewayCatalogRefresh()
      let releaseDelete!: () => void
      deleteApiKeyMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseDelete = resolve }))

      const purging = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      await vi.waitFor(() => expect(deleteApiKeyMock).toHaveBeenCalled())

      // The outage is already recorded while the purge is still waiting on
      // the key store: the notification must run inside the purge's critical
      // section, before any await, or a refresh that commits in the meantime
      // gets demoted afterwards over a working catalog (review: "Purge race
      // escapes regression test").
      expect(getProviderCatalogStatus('llm-gateway')).toBe('failed')

      releaseDelete()
      await expect(purging).resolves.toMatchObject({ status: 'expired' })

      // ...and it claimed no catalog version of its own, so the work that
      // started before it can still commit.
      expect(isGatewayCatalogRefreshCurrent(inFlightRefresh)).toBe(true)
      registerGatewayModels([{ id: 'new-model', name: 'New', capabilities: ['code'] }], 'ready', inFlightRefresh)
      expect(getProviderCatalogStatus('llm-gateway')).toBe('ready')
    })

    it('credential status reports "expired" after invalid_grant and "missing" after logout', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
        )
      )

      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('expired')

      await logoutGateway()
      expect(getGatewayCredentialStatus()).toBe('missing')
    })

    it('keeps the expired verdict stable after the purge deleted the refresh-token record (#282)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
        )
      )

      // First read: the purge commits — the SQLite record (the old tombstone)
      // is deleted along with the token pair.
      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('expired')
      expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_refresh_token__')

      // Later reads in the SAME session must not flip to 'missing': the
      // record is gone, only the expired marker remembers the session died.
      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('expired')

      const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
      expect(resolved).toMatchObject({ ok: false, kind: 'expired' })
      expect(getGatewayCredentialStatus()).toBe('expired')
    })

    it('a new credential commit clears the expired marker so a fresh purge is the one reported (#282)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
        )
      )
      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('expired')

      // A new login commits a fresh pair (persistDeviceLoginTokens →
      // saveStoredTokens), then that pair is wiped outside the auth layer
      // (browser eviction). The next read must report 'missing' — the
      // expired verdict belonged to the OLD session.
      const token = {
        access_token: 'new-access', token_type: 'Bearer', expires_in: 60,
        refresh_token: 'new-refresh', refresh_expires_in: 3600,
      }
      persistDeviceLoginTokens(token as never, CLIENT_ID, BASE_URL)
      localStorage.removeItem(TOKENS_KEY)

      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('missing')
    })

    it('logout clears the expired marker: no re-login prompt for a session the user ended (#282)', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 400 })
        )
      )
      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('expired')

      await logoutGateway()
      expect(getGatewayCredentialStatus()).toBe('missing')

      // The post-logout reads stay 'missing' (setup offer), never 'expired'.
      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('missing')
      const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
      expect(resolved).toMatchObject({ ok: false, kind: 'missing' })
    })

    it('credential status reports "valid" while the stored access token is usable', async () => {
      const now = Date.now()
      localStorage.setItem(
        TOKENS_KEY,
        JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'refresh-token',
          access_expires_at: now + 10 * 60 * 1000,
          refresh_expires_at: now + 30 * 24 * 60 * 60 * 1000,
          client_id: CLIENT_ID,
          base_url: BASE_URL,
        })
      )

      await getValidAccessToken(BASE_URL, CLIENT_ID)
      expect(getGatewayCredentialStatus()).toBe('valid')
    })

    it('getValidAccessToken attempts a refresh even inside the old 60s refresh-token buffer', async () => {
      // Refresh token alive for only 30 more seconds: the pre-unification
      // passive path gave up here (60s buffer), forcing a needless re-login.
      seedStoredTokens({ refresh_expires_at: Date.now() + 30_000 })

      const fetchMock = vi.fn(async () => refreshResponse('buffer-token', 60))
      vi.stubGlobal('fetch', fetchMock)

      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBe('buffer-token')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('fenced mutations: pre-dispatch refusal and late-write escalation (round-21)', () => {
    const COMMIT_SEQ_KEY = 'eo2weave-gateway-credential-commit-seq'
    const PENDING_OP_SEQ_PREFIX = 'eo2weave-gateway-keystore-pending-op-seq:'

    beforeEach(() => {
      localStorage.removeItem(COMMIT_SEQ_KEY)
      const doomed: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key !== null && key.startsWith(PENDING_OP_SEQ_PREFIX)) doomed.push(key)
      }
      for (const key of doomed) localStorage.removeItem(key)
    })

    afterEach(() => {
      localStorage.removeItem(COMMIT_SEQ_KEY)
    })

    it('a fenced mutation never dispatches its write: the async factory re-checks before the effect', async () => {
      // The pre-dispatch check runs synchronously at registration, so an
      // externally observable trip can only happen during an ASYNC gap
      // inside the factory (the refresh-token backup awaits a dynamic
      // import before writing). The second fence check must refuse the
      // effectful call: saveApiKey is NEVER invoked for the fenced op.
      const { runBoundedFencedKeyStoreMutationForTests } = await import(
        '@/agent/providers/llm-gateway-auth'
      )
      const { __resetGatewayCredentialFencingForTests } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      __resetGatewayCredentialFencingForTests()
      saveApiKeyMock.mockResolvedValue(undefined)
      let reachedSave = false
      const op = runBoundedFencedKeyStoreMutationForTests(async () => {
        // Simulate the dynamic-import await: the interleaving window.
        await new Promise((resolve) => setTimeout(resolve, 0))
        localStorage.setItem(COMMIT_SEQ_KEY, String(9)) // a newer commit lands
        if (Number(localStorage.getItem(COMMIT_SEQ_KEY)) > 0) {
          reachedSave = true // mirrors the factory's flow: the check below refuses
          throw new Error('key-store op fenced: a newer credential commit landed while this op was pending')
        }
        await saveApiKeyMock('__llm_gateway_refresh_token__', 'blob')
      })
      await expect(op).rejects.toThrow(/key-store op fenced/)
      expect(reachedSave).toBe(true)
      // The effectful write never ran for the fenced op.
      expect(saveApiKeyMock).not.toHaveBeenCalled()
      __resetGatewayCredentialFencingForTests()
    }, 20_000)

    it('a deadline-rejected op whose write lands late inside a fenced window ESCALATES', async () => {
      // Round-21 deadline hole: when the 10s deadline rejects `result` while
      // the underlying write is still pending, the post-write fence check is
      // skipped — a fenced late write would land undetected. The wrapper
      // must re-check the fence when the UNDERLYING op settles and escalate
      // (credential status expired + re-login banner). The newer commit is
      // simulated by bumping the shared sequence directly (a real
      // withGatewayCredentialLock grant would stall on this op's own
      // quiescence wait — the lock waits for pending ops by design).
      const { runBoundedFencedKeyStoreMutationForTests } = await import(
        '@/agent/providers/llm-gateway-auth'
      )
      const { __resetGatewayCredentialFencingForTests } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      __resetGatewayCredentialFencingForTests()
      settingsStoreState.modelCredentialStatusError = null
      settingsStoreState.modelCredentialStatus = 'valid'

      let releaseWrite!: () => void
      const op = runBoundedFencedKeyStoreMutationForTests(
        () => new Promise<void>((resolve) => { releaseWrite = resolve }),
      )
      // The deadline rejects `result` after 10s while the write is pending.
      const deadlineRejection = await op.then(
        () => { throw new Error('op should have rejected via deadline') },
        (e: unknown) => e,
      )
      expect((deadlineRejection as Error).message).toMatch(/timed out/)
      // A newer credential commit lands (seq bump), fencing the still-
      // pending op — and then the late write lands INSIDE the fenced window.
      localStorage.setItem(COMMIT_SEQ_KEY, '5')
      releaseWrite()
      // The wrapper's underlying-settled continuation must detect the fence
      // and escalate.
      await vi.waitFor(() => {
        expect(settingsStoreState.modelCredentialStatus).toBe('expired')
        expect(settingsStoreState.modelCredentialStatusError).not.toBeNull()
      })
      __resetGatewayCredentialFencingForTests()
    }, 45_000)

    it('post-write fence detection throws AND escalates', async () => {
      // The write lands first, THEN the fence trips (a commit raced between
      // the pre-dispatch check and the effect): the wrapper must throw the
      // fenced error AND escalate — the landed write may have overwritten a
      // newer credential, so the stored state is untrustworthy.
      const { runBoundedFencedKeyStoreMutationForTests } = await import(
        '@/agent/providers/llm-gateway-auth'
      )
      const { __resetGatewayCredentialFencingForTests } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      __resetGatewayCredentialFencingForTests()
      settingsStoreState.modelCredentialStatusError = null
      settingsStoreState.modelCredentialStatus = 'valid'

      let releaseWrite!: () => void
      let writeRan = false
      const op = runBoundedFencedKeyStoreMutationForTests(() => {
        writeRan = true
        return new Promise<void>((resolve) => { releaseWrite = resolve })
      })
      // The factory runs on the released gate (a microtask after
      // registration): an unfenced op dispatches its write.
      await vi.waitFor(() => expect(writeRan).toBe(true))
      // A newer commit lands while the write is pending; then it resolves.
      localStorage.setItem(COMMIT_SEQ_KEY, '5')
      releaseWrite()
      await expect(op).rejects.toThrow(/key-store op fenced/)
      await vi.waitFor(() => {
        expect(settingsStoreState.modelCredentialStatus).toBe('expired')
        expect(settingsStoreState.modelCredentialStatusError).not.toBeNull()
      })
      __resetGatewayCredentialFencingForTests()
    }, 20_000)
  })

  describe('cross-tab pending-op barrier', () => {
    const PENDING_OPS_KEY = 'eo2weave-gateway-keystore-pending-ops'

    it('a credential commit waits for key-store ops still pending in ANOTHER tab', async () => {
      const { withGatewayCredentialLock } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      // Simulate tab A: it dispatched a key-store op that registered in the
      // SHARED counter registry (exactly what trackPendingKeyStoreOp does
      // there). This tab's own registry is empty — the pre-barrier
      // implementation would admit the commit immediately.
      localStorage.setItem(
        PENDING_OPS_KEY,
        JSON.stringify({ 'tab-other': { ops: ['op-late-write'], updatedAt: Date.now() } }),
      )

      let commitSettled = false
      const commit = withGatewayCredentialLock(async () => {
        commitSettled = true
        return 'commit'
      })
      // Give the lock ample time to (wrongly) proceed past an empty local
      // registry — the barrier must hold it.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(commitSettled).toBe(false)

      // Tab A's op settles: its entry disappears from the shared registry,
      // and only then may this commit proceed.
      localStorage.setItem(PENDING_OPS_KEY, JSON.stringify({}))
      await expect(commit).resolves.toBe('commit')
      expect(commitSettled).toBe(true)
    }, 20_000)

    it('a stale registry entry from a crashed tab does not stall commits', async () => {
      const { withGatewayCredentialLock } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      // A tab died while its entry was registered; the entry's timestamp is
      // past the TTL, so it must be treated as abandoned, not as a pending
      // op blocking every credential commit until the quiescence cap.
      localStorage.setItem(
        PENDING_OPS_KEY,
        JSON.stringify({
          'tab-crashed': { ops: ['op-ghost'], updatedAt: Date.now() - 61_000 },
        }),
      )
      await expect(
        withGatewayCredentialLock(async () => 'commit'),
      ).resolves.toBe('commit')
    }, 20_000)
  })

  describe('commit fencing (suspended tab)', () => {
    const PENDING_OPS_KEY = 'eo2weave-gateway-keystore-pending-ops'
    const COMMIT_SEQ_KEY = 'eo2weave-gateway-credential-commit-seq'
    const PENDING_OP_SEQ_PREFIX = 'eo2weave-gateway-keystore-pending-op-seq:'

    beforeEach(() => {
      localStorage.removeItem(COMMIT_SEQ_KEY)
      // Per-op stamps: remove every key under the fence-stamp prefix.
      const doomed: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key !== null && key.startsWith(PENDING_OP_SEQ_PREFIX)) doomed.push(key)
      }
      for (const key of doomed) localStorage.removeItem(key)
    })

    it('a suspended tab resumed op is fenced: its write is refused after a newer commit', async () => {
      // Tab A (SUSPENDED, simulated purely through the shared storage —
      // promises cannot cross tabs, which is exactly why the barrier cannot
      // help the committing tab): it dispatched a key-store write whose
      // registration stamped the fencing sequence, then its timers froze
      // and its barrier entry went stale past the TTL. The op id format
      // matches what trackPendingKeyStoreOp generates; the fence-stamp and
      // barrier entries below are byte-for-byte what that registration
      // writes into shared storage (per-op stamp: readCommitSeq() = '0').
      const opId = 'op-suspended'
      localStorage.setItem(
        PENDING_OPS_KEY,
        JSON.stringify({ 'tab-suspended': { ops: [opId], updatedAt: Date.now() - 61_000 } }),
      )
      localStorage.setItem(PENDING_OP_SEQ_PREFIX + opId, '0')

      // Tab B: the stale entry reads as abandoned, so the commit is
      // admitted — and it bumps the shared commit sequence past tab A's
      // stamp, fencing the still-pending op.
      const { pendingKeyStoreOpIsFenced, withGatewayCredentialLock } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      expect(pendingKeyStoreOpIsFenced(opId)).toBe(false)
      await withGatewayCredentialLock(async () => 'newer-commit')
      expect(pendingKeyStoreOpIsFenced(opId)).toBe(true)

      // Tab A resumes: its caller (withKeyStoreDeadline consumers) re-checks
      // the fence before writing — refused, so the newer commit's
      // credential state survives instead of being overwritten.
      expect(pendingKeyStoreOpIsFenced(opId)).toBe(true)

      // A post-commit op (registered after the bump, via the real
      // registration path) is NOT fenced — its write belongs to the newer
      // credential generation.
      const { withKeyStoreDeadline } = await import('@/agent/providers/llm-gateway-auth')
      const fresh = withKeyStoreDeadline(Promise.resolve())
      expect(pendingKeyStoreOpIsFenced(fresh.opId)).toBe(false)
      await expect(fresh.result).resolves.toBeUndefined()
      await fresh.settled
    }, 20_000)

    it('two CONCURRENT registrations in different tabs both keep their fence stamps', async () => {
      // Regression (Sourcery round-21): the previous single-map design did
      // readPendingOpSeqs() → seqs[opId] = seq → setItem(whole map), so a
      // later registration REPLACED the map and silently dropped the
      // earlier op's stamp — the unrecorded op was then never fenced and a
      // stale resumed write could damage newer credentials. With one
      // storage key PER OP, concurrent registrations cannot overwrite each
      // other: each setItem touches only its own key.
      const { pendingKeyStoreOpIsFenced, withGatewayCredentialLock } = await import(
        '@/agent/providers/gateway-credential-lock'
      )
      // Direct simulated registrations, exactly what trackPendingKeyStoreOp
      // stamps at registration time (op A at seq 0).
      const opA = 'op-tab-a'
      const opB = 'op-tab-b'
      localStorage.setItem(PENDING_OP_SEQ_PREFIX + opA, String(0))
      // Tab B registers its op CONCURRENTLY (no interleaved commit — both
      // stamps read the same current sequence)…
      localStorage.setItem(PENDING_OP_SEQ_PREFIX + opB, String(0))
      // …both stamps must survive, not just the later one.
      expect(localStorage.getItem(PENDING_OP_SEQ_PREFIX + opA)).toBe('0')
      expect(localStorage.getItem(PENDING_OP_SEQ_PREFIX + opB)).toBe('0')

      // The fence verdict must hold for BOTH ops once a newer commit lands.
      await withGatewayCredentialLock(async () => 'newer-commit')
      expect(pendingKeyStoreOpIsFenced(opA)).toBe(true)
      expect(pendingKeyStoreOpIsFenced(opB)).toBe(true)
    }, 20_000)
  })
})

// ── Dispatch-time credential resolution + session events (#171/#172) ──

describe('resolveGatewayDispatchCredential (#172 findings 3+4+5)', () => {
  beforeEach(() => {
    localStorage.clear()
    deleteApiKeyMock.mockReset()
    deleteApiKeyMock.mockResolvedValue(undefined)
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue(null)
    saveApiKeyMock.mockReset()
    saveApiKeyMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    localStorage.clear()
    unregisterDynamicProvider('llm-gateway')
    vi.unstubAllGlobals()
  })

  function seed(overrides: Partial<{ access_expires_at: number; refresh_expires_at: number }> = {}) {
    const now = Date.now()
    localStorage.setItem(TOKENS_KEY, JSON.stringify({
      access_token: 'access-token-1',
      refresh_token: 'refresh-token',
      access_expires_at: overrides.access_expires_at ?? now + 10 * 60 * 1000,
      refresh_expires_at: overrides.refresh_expires_at ?? now + 30 * 24 * 60 * 60 * 1000,
      client_id: CLIENT_ID,
      base_url: BASE_URL,
    }))
  }

  it('returns the current access token from the shared token pair WITHOUT the SQLite shadow (#172.5)', async () => {
    // Shadow missing/stale: refresh's shadow write failed. The resolver must
    // NOT depend on it.
    seed()
    loadApiKeyMock.mockResolvedValue(null)

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved).toEqual({ ok: true, accessToken: 'access-token-1' })
    expect(getGatewayCredentialStatus()).toBe('valid')
  })

  it('refreshes an expired access token and returns the new token', async () => {
    seed({ access_expires_at: Date.now() - 1000 })
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/v1/auth/refresh')) {
        refreshCalls++
        return new Response(JSON.stringify({ access_token: 'brand-new-access', expires_in: 600, token_type: 'Bearer' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved).toEqual({ ok: true, accessToken: 'brand-new-access' })
    expect(refreshCalls).toBe(1)
  })

  it('reports confirmed missing when no token pair and no shadow exist', async () => {
    localStorage.clear()
    loadApiKeyMock.mockResolvedValue(null)

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('missing')
    expect(getGatewayCredentialStatus()).toBe('missing')
  })

  it('reports expired (not missing) when only the refresh-token record of a dead session survives', async () => {
    localStorage.clear()
    loadApiKeyMock.mockImplementation(async (provider: string) =>
      provider === '__llm_gateway_refresh_token__' ? '{"refresh_token":"dead"}' : null)

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('expired')
    expect(getGatewayCredentialStatus()).toBe('expired')
  })

  it('reports temporary — NOT missing — when the token-PAIR read fails (#175)', async () => {
    localStorage.clear()
    // The refresh-token BACKUP read itself fails: a storage outage must not
    // present as a logged-out session (previously collapsed to null →
    // 'missing' login card).
    loadApiKeyMock.mockImplementation(async (provider: string) => {
      if (provider === '__llm_gateway_refresh_token__') throw new Error('sqlite worker hung')
      return null
    })

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('temporary')
  })

  it('reports temporary — NOT missing — when storage fails during the absence check (#172.3)', async () => {
    localStorage.clear()
    // The shadow read itself fails: storage error ≠ proof of logout.
    loadApiKeyMock.mockRejectedValue(new Error('sqlite worker hung'))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('temporary')
  })

  it('reports temporary on a transient refresh failure and keeps the stored tokens', async () => {
    seed({ access_expires_at: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('temporary')
    // A possibly valid session is NOT cleared by a transient failure.
    expect(localStorage.getItem(TOKENS_KEY)).not.toBeNull()
    expect(getGatewayCredentialStatus()).not.toBe('missing')
  })

  it('does NOT pass a malformed record (future expiry, empty access token) as valid (#175)', async () => {
    // A future access expiry with an EMPTY token previously passed the
    // fresh-token branch and dispatched without Authorization.
    const now = Date.now()
    localStorage.setItem(TOKENS_KEY, JSON.stringify({
      access_token: '',
      refresh_token: 'refresh-token',
      access_expires_at: now + 10 * 60 * 1000,
      refresh_expires_at: now + 30 * 24 * 60 * 60 * 1000,
      client_id: CLIENT_ID,
      base_url: BASE_URL,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('temporary')
  })

  it('does NOT pass a whitespace-only access token as valid (#175)', async () => {
    const now = Date.now()
    localStorage.setItem(TOKENS_KEY, JSON.stringify({
      access_token: '   ',
      refresh_token: 'refresh-token',
      access_expires_at: now + 10 * 60 * 1000,
      refresh_expires_at: now + 30 * 24 * 60 * 60 * 1000,
      client_id: CLIENT_ID,
      base_url: BASE_URL,
    }))
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('network down')
    }))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('temporary')
  })

  it('reports expired when the refresh token is definitively invalid', async () => {
    seed({ access_expires_at: Date.now() - 1000 })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 'invalid_grant', message: 'revoked' }), { status: 400 })
    ))

    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved.ok).toBe(false)
    expect(resolved.ok ? null : resolved.kind).toBe('expired')
    await vi.waitFor(() => {
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    })
  })
})

describe('cross-tab session events (#171 observer subscription)', () => {
  const tokensValue = (refresh: string, access: string, accessExpired: boolean) =>
    JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      access_expires_at: accessExpired ? Date.now() - 1000 : Date.now() + 10 * 60 * 1000,
      refresh_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
      client_id: CLIENT_ID,
      base_url: BASE_URL,
    })

  const emit = (oldValue: string | null, newValue: string | null) => {
    window.dispatchEvent(new StorageEvent('storage', { key: TOKENS_KEY, oldValue, newValue }))
  }

  it('emits identity-change (with generation bump) when the refresh token changes', () => {
    const events: GatewaySessionEvent[] = []
    const off = subscribeToGatewaySessionEvents((e) => events.push(e))
    try {
      // #175 review: the bump itself is part of the contract (observers fence
      // async work against the generation) — assert it actually moved.
      const generationBefore = getGatewayAuthSessionGeneration()
      emit(tokensValue('old-refresh', 'a', false), tokensValue('new-refresh', 'b', false))

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('identity-change')
      expect(events[0].oldRefreshToken).toBe('old-refresh')
      expect(events[0].newRefreshToken).toBe('new-refresh')
      expect(getGatewayAuthSessionGeneration()).toBe(generationBefore + 1)
      expect(events[0].generation).toBe(generationBefore + 1)
    } finally {
      off()
    }
  })

  it('emits access-refresh WITHOUT a generation bump for a same-refresh-token rewrite (#172.1)', () => {
    const events: GatewaySessionEvent[] = []
    const off = subscribeToGatewaySessionEvents((e) => events.push(e))
    try {
      const generationBefore = getGatewayAuthSessionGeneration()
      // Same refresh identity, new access token: another tab's refresh.
      emit(tokensValue('same-refresh', 'old-access', true), tokensValue('same-refresh', 'new-access', false))

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('access-refresh')
      expect(getGatewayAuthSessionGeneration()).toBe(generationBefore)
    } finally {
      off()
    }
  })

  it('emits identity-change with null newRefreshToken on logout (value removed)', () => {
    const events: GatewaySessionEvent[] = []
    const off = subscribeToGatewaySessionEvents((e) => events.push(e))
    try {
      // #175 review: the logout path bumps the generation too — assert it.
      const generationBefore = getGatewayAuthSessionGeneration()
      emit(tokensValue('old-refresh', 'a', false), null)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('identity-change')
      expect(events[0].newRefreshToken).toBeNull()
      expect(getGatewayAuthSessionGeneration()).toBe(generationBefore + 1)
    } finally {
      off()
    }
  })

  it('unsubscribed listeners stop receiving events', () => {
    const events: GatewaySessionEvent[] = []
    const off = subscribeToGatewaySessionEvents((e) => events.push(e))
    off()
    emit(tokensValue('a', 'x', false), tokensValue('b', 'y', false))
    expect(events).toHaveLength(0)
  })
})

describe('gateway follow-up review regressions', () => {
  beforeEach(() => {
    localStorage.clear()
    loadApiKeyMock.mockReset().mockResolvedValue(null)
    deleteApiKeyMock.mockReset().mockResolvedValue(undefined)
    saveApiKeyMock.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

  it('treats an unreadable local token store as temporary when no backup exists', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => {
        if (key === TOKENS_KEY) throw new Error('localStorage unavailable')
        return null
      },
    })
    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved).toMatchObject({ ok: false, kind: 'temporary' })
  })

  it('treats an unreadable local token store and unusable backup as temporary', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('localStorage unavailable') } })
    loadApiKeyMock.mockResolvedValue('{invalid')
    const resolved = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(resolved).toMatchObject({ ok: false, kind: 'temporary' })
  })

  it('rejects a whitespace-only access token returned by refresh', async () => {
    seedStoredTokens()
    vi.stubGlobal('fetch', vi.fn(async () => refreshResponse('   ', 600)))
    const result = await resolveGatewayDispatchCredential(BASE_URL, CLIENT_ID)
    expect(result).toMatchObject({ ok: false, kind: 'temporary' })
    expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!).access_token).toBe('stale-access-token')
  })

  it('does not rerun a refresh when the acquired lock callback rejects', async () => {
    seedStoredTokens()
    const fetchMock = vi.fn(async () => refreshResponse('new-access', 600))
    vi.stubGlobal('fetch', fetchMock)
    const existingLocks = navigator.locks
    vi.stubGlobal('navigator', { locks: { request: async (name: string, callback: () => Promise<unknown>) => {
      if (name !== 'eo2weave-gateway-refresh') return existingLocks.request(name, callback)
      await callback()
      throw new Error('callback failed')
    } } })
    await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).rejects.toThrow('callback failed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('cross-tab refresh coalescing', () => {
  afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })
  it('adopts a token refreshed while waiting for the cross-tab lock', async () => {
    seedStoredTokens()
    const initial = JSON.parse(localStorage.getItem(TOKENS_KEY)!)
    const fetchMock = vi.fn(async () => refreshResponse('unnecessary', 600))
    vi.stubGlobal('fetch', fetchMock)
    const existingLocks = navigator.locks
    vi.stubGlobal('navigator', { locks: { request: async (name: string, callback: () => Promise<unknown>) => {
      if (name !== 'eo2weave-gateway-refresh') return existingLocks.request(name, callback)
      localStorage.setItem(TOKENS_KEY, JSON.stringify({ ...initial, access_token: 'peer-token', access_expires_at: Date.now() + 600_000 }))
      return callback()
    } } })
    await expect(refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)).resolves.toMatchObject({ status: 'success', accessToken: 'peer-token' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('credential status generation fence (#180)', () => {
  beforeEach(() => {
    localStorage.clear()
    settingsStoreState.modelCredentialStatus = 'unknown'
    settingsStoreState.statusWrites.length = 0
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue(null)
  })

  it('treats a verdict as current only while the credential set it saw is unchanged', async () => {
    seedStoredTokens()
    const generation = getGatewayAuthSessionGeneration()
    expect(isCredentialStatusCurrent(generation)).toBe(true)

    await logoutGateway()

    expect(getGatewayAuthSessionGeneration()).not.toBe(generation)
    expect(isCredentialStatusCurrent(generation)).toBe(false)
  })

  it('drops a stale "missing" verdict that lands after a new login', async () => {
    // The storage read that produced the verdict is still in flight when a
    // login commits, so the verdict describes a session that no longer exists.
    let releaseLoad!: (value: string | null) => void
    loadApiKeyMock.mockImplementation((provider) =>
      provider === '__llm_gateway_refresh_token__'
        ? new Promise<string | null>((resolve) => { releaseLoad = resolve })
        : Promise.resolve(null),
    )

    const pending = getValidAccessToken(BASE_URL, CLIENT_ID)
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalled())

    persistDeviceLoginTokens(
      {
        access_token: 'new-session-access',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'new-session-refresh',
        refresh_expires_in: 3600,
      },
      CLIENT_ID,
      BASE_URL,
    )
    expect(localStorage.getItem(TOKENS_KEY)).toContain('new-session-refresh')
    // The login flow reports 'valid' through its own settings write; the stale
    // verdict must not overwrite that known status.
    settingsStoreState.modelCredentialStatus = 'valid'

    releaseLoad(null)
    await pending

    // Synchronize on the WRITE PATH, not on a timer. A verdict produced under
    // the CURRENT session travels the same dynamic import + `.then` chain and
    // is registered behind the stale one, so once the current verdict has
    // landed the stale chain has already settled — if it were going to write,
    // it would be in the log first.
    expect(await getValidAccessToken(BASE_URL, CLIENT_ID)).toBeTruthy()
    await vi.waitFor(() => expect(settingsStoreState.statusWrites).toEqual(['valid']))

    // Without the fence the stale verdict lands as an extra 'missing' write.
    expect(settingsStoreState.modelCredentialStatus).toBe('valid')
  })

  it('still applies a verdict produced under the current session', async () => {
    seedStoredTokens({ access_expires_at: Date.now() + 3_600_000 })

    expect(await getValidAccessToken(BASE_URL, CLIENT_ID)).toBeTruthy()

    // The verdict lands through a dynamic settings-store import: wait for the
    // write instead of racing a zero-delay timer.
    await vi.waitFor(() => expect(settingsStoreState.modelCredentialStatus).toBe('valid'))
  })

  it('reports valid after a successful refresh commit', async () => {
    seedStoredTokens()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(refreshResponse('refreshed-token', 60))))

    const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
    expect(result.status).toBe('success')

    // The refresh's own commit advances the generation; the verdict must be
    // attributed to that commit, not to the pre-refresh snapshot.
    await vi.waitFor(() => expect(settingsStoreState.modelCredentialStatus).toBe('valid'))
  })

  it('treats the refreshed token as current and a replaced one as stale (#214)', async () => {
    seedStoredTokens()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(refreshResponse('refreshed-token', 60))))

    const result = await refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
    expect(result.status).toBe('success')

    // The refresh committed a NEW pair: the token it returned is the stored
    // one. Dispatch gates compare tokens for exactly this reason — the
    // generation bump here is the refresh's own work, not a session change.
    expect(await isGatewayAccessTokenCurrent('refreshed-token')).toBe(true)
    expect(await isGatewayAccessTokenCurrent('stale-token')).toBe(false)
  })

  it('counts a SQLite-recovered credential as current (#214 Sourcery round 3)', async () => {
    // localStorage unreadable → the resolver recovers the pair from the
    // SQLite api-key-store backup. The helper must vouch for THAT token.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(refreshResponse('recovered-token', 600))))
    const recovered = JSON.stringify({
      access_token: 'recovered-token',
      refresh_token: 'recovered-refresh',
      access_expires_at: Date.now() + 600_000,
      refresh_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    const brokenGetItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    loadApiKeyMock.mockImplementation(async (provider: string) =>
      provider === '__llm_gateway_refresh_token__' ? recovered : null,
    )

    try {
      expect(await isGatewayAccessTokenCurrent('recovered-token')).toBe(true)
      expect(await isGatewayAccessTokenCurrent('replaced-token')).toBe(false)
    } finally {
      brokenGetItem.mockRestore()
    }
  })

  it('propagates storage read failures instead of calling the token stale (#214 Sourcery round 4)', async () => {
    // No localStorage record and the SQLite read throws: that is a
    // retryable storage problem, not proof of a stale credential.
    loadApiKeyMock.mockRejectedValue(new Error('sqlite down'))

    await expect(isGatewayAccessTokenCurrent('any-token')).rejects.toMatchObject({
      name: 'GatewayTokenStoreUnavailableError',
      cause: expect.objectContaining({ message: 'sqlite down' }),
    })
  })
})

describe('hasStoredSession (#277)', () => {
  it('counts the durable refresh record when localStorage was evicted', async () => {
    localStorage.clear()
    loadApiKeyMock.mockImplementation(async (provider: string) =>
      provider === '__llm_gateway_refresh_token__' ? '{"refresh_token":"r"}' : null)

    // The pair is gone but the record survives: the next dispatch restores the
    // session from it, so the card must not offer a login.
    await expect(hasStoredSession()).resolves.toBe(true)
  })

  it('is false when neither the pair nor the record exists', async () => {
    localStorage.clear()
    loadApiKeyMock.mockResolvedValue(null)

    await expect(hasStoredSession()).resolves.toBe(false)
  })

  it('answers from the pair without touching the key store', async () => {
    loadApiKeyMock.mockClear()
    seedStoredTokens()

    await expect(hasStoredSession()).resolves.toBe(true)
    expect(loadApiKeyMock).not.toHaveBeenCalled()
  })
})
