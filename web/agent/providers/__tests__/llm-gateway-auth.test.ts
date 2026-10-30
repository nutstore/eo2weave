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
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({
      setModelCredentialStatus: (status: string) => {
        settingsStoreState.modelCredentialStatus = status
      },
      setModelCredentialStatusError: (message: string | null) => {
        settingsStoreState.modelCredentialStatusError = message
      },
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
  performDeviceCodeFlow,
  persistDeviceLoginTokens,
} from '@/agent/providers/llm-gateway-auth'

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
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  describe('refresh preserves the stored refresh token (real backend contract)', () => {
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
        expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
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

    it('does not purge a new login while checking a stale access shadow', async () => {
      let releaseShadow!: (value: string) => void
      loadApiKeyMock.mockImplementation((provider) => provider === '__llm_gateway_token__'
        ? new Promise<string>((resolve) => { releaseShadow = resolve })
        : Promise.resolve(null))
      const pending = getValidAccessToken(BASE_URL, CLIENT_ID)
      await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__'))
      seedStoredTokens({ access_expires_at: Date.now() + 3600_000, refresh_token: 'new-login-refresh' })
      releaseShadow('old-access-shadow')
      await pending
      expect(deleteApiKeyMock).not.toHaveBeenCalledWith('__llm_gateway_token__')
      expect(JSON.parse(localStorage.getItem(TOKENS_KEY)!).refresh_token).toBe('new-login-refresh')
    })

    it('serializes logout behind an in-flight refreshed access-key write', async () => {
      seedStoredTokens()
      vi.stubGlobal('fetch', vi.fn(async () => refreshResponse('refreshed-access')))
      let releaseShadow!: () => void
      saveApiKeyMock.mockImplementation(async (provider) => {
        if (provider === '__llm_gateway_token__') {
          await new Promise<void>((resolve) => { releaseShadow = resolve })
        }
      })
      const refresh = refreshAccessTokenWithStatus(BASE_URL, CLIENT_ID)
      await vi.waitFor(() => expect(saveApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__', 'refreshed-access'))
      const logout = logoutGateway()
      const finishedEarly = await Promise.race([
        Promise.resolve(logout).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
      ])
      expect(finishedEarly).toBe(false)
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
      releaseShadow()
      await refresh
      await logout
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
      expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
    })

    it('logout does not hold the credential lock forever on a stalled key-store delete', async () => {
      seedStoredTokens()
      // A deletion that NEVER settles: the logout must still complete within
      // the deadline window (bounded key-store ops), not hang forever.
      deleteApiKeyMock.mockImplementation((provider) =>
        provider === '__llm_gateway_refresh_token__'
          ? new Promise<void>(() => {}) // never settles
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
    }, 20_000)

    it('logout rejects instead of reporting success when the purge fails', async () => {
      seedStoredTokens()
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

    it('purges the api-key shadow key when the refresh_token is expired locally', async () => {
      seedStoredTokens({ refresh_expires_at: Date.now() - 1000 })

      const result = await forceRefreshAccessToken(BASE_URL, CLIENT_ID)

      expect(result).toBeNull()
      await vi.waitFor(() => {
        expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
      })
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
    })

    it('getValidAccessToken purges the shadow on a definitively invalid token', async () => {
      seedStoredTokens()

      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ code: 'invalid_grant', message: 'token revoked' }), { status: 401 })
        )
      )

      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBeNull()
      await vi.waitFor(() => {
        expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
      })
      expect(localStorage.getItem(TOKENS_KEY)).toBeNull()
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

    it('stale access_token shadow without a token pair reports "expired"', async () => {
      loadApiKeyMock.mockImplementation(async (provider: string) =>
        provider === '__llm_gateway_token__' ? 'stale-access-token' : null
      )

      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBeNull()
      expect(getGatewayCredentialStatus()).toBe('expired')
      expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
    })

    it('no shadow either (never logged in) still reports "missing"', async () => {
      const token = await getValidAccessToken(BASE_URL, CLIENT_ID)

      expect(token).toBeNull()
      expect(getGatewayCredentialStatus()).toBe('missing')
      expect(deleteApiKeyMock).not.toHaveBeenCalled()
    })

    it('logoutGateway also purges the api-key shadow key', async () => {
      await logoutGateway()

      await vi.waitFor(() => {
        expect(deleteApiKeyMock).toHaveBeenCalledWith('__llm_gateway_token__')
      })
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
})
