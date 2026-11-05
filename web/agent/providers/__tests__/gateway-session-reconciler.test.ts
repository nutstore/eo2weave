/**
 * Tests for the observer-side gateway session reconciler (issues #171/#172).
 *
 * Contract: the auth layer's storage listener implements INVALIDATION only
 * (generation bump + provider unregister). The reconciler subscribes to the
 * auth layer's session events and RE-ADOPTS the latest shared session:
 *  - identity-change to a usable session → provider registered, catalog
 *    loaded, both credential-status representations reconciled to 'valid',
 *    stale errors cleared, availability cache invalidated.
 *  - identity-change to a confirmed-absent session → provider removed,
 *    status reconciled logged-out.
 *  - transient failures never falsely label a live session logged out.
 *  - access-only refresh (same refresh token, #172.1) reconciles a tab that
 *    had marked the session expired back to valid.
 *  - every async result is fenced against the session generation: a stale
 *    job cannot restore state after a newer session change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks (same conventions as llm-gateway-auth.test.ts) ──────────────

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

// Persistent settings-store stub so tests can assert the credential-status
// reconciliation the reconciler performs.
const settingsStoreState = vi.hoisted(() => {
  const state = {
    modelCredentialStatus: 'unknown' as string,
    modelCredentialStatusError: null as string | null,
    invalidateApiKeyCacheCalls: [] as Array<string | undefined>,
    checkHasApiKeyCalls: 0,
    triggerProviderRefreshCalls: 0,
  }
  return state
})
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({
      setModelCredentialStatus: (status: string) => {
        settingsStoreState.modelCredentialStatus = status
      },
      setModelCredentialStatusError: (message: string | null) => {
        settingsStoreState.modelCredentialStatusError = message
      },
      invalidateApiKeyCache: (provider?: string) => {
        settingsStoreState.invalidateApiKeyCacheCalls.push(provider)
      },
      checkHasApiKey: () => {
        settingsStoreState.checkHasApiKeyCalls++
      },
      triggerProviderRefresh: () => {
        settingsStoreState.triggerProviderRefreshCalls++
      },
      modelCredentialStatus: settingsStoreState.modelCredentialStatus,
      modelCredentialStatusError: settingsStoreState.modelCredentialStatusError,
    }),
  },
}))

const fetchMock = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

// registerLLMGatewayProvider is region-gated (ENABLE_LLM_GATEWAY is a
// build-time constant; test env has no CN region) and would no-op here.
// Spy on the registration calls instead so the tests can assert the
// reconciler's re-registration behavior without the region gate.
const registerCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/agent/providers/llm-gateway-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/llm-gateway-provider')>()
  return {
    ...actual,
    registerLLMGatewayProvider: () => {
      registerCalls.count++
      // Register through the REAL registry so getProviderConfig reflects it
      // (bypassing only the region gate the real function starts with).
      actual.registerGatewayModels([], 'loading')
    },
  }
})

const TOKENS_KEY = 'llm-gateway-tokens'

function seedStoredTokens(overrides: Partial<{
  refresh_token: string
  access_token: string
  access_expires_at: number
  refresh_expires_at: number
}> = {}): void {
  const now = Date.now()
  localStorage.setItem(TOKENS_KEY, JSON.stringify({
    access_token: overrides.access_token ?? 'fresh-access-token',
    refresh_token: overrides.refresh_token ?? 'refresh-token-a',
    access_expires_at: overrides.access_expires_at ?? now + 10 * 60 * 1000,
    refresh_expires_at: overrides.refresh_expires_at ?? now + 30 * 24 * 60 * 60 * 1000,
    client_id: 'test-client-id',
    base_url: 'https://ai.jianguoyun.com',
  }))
}

/** Emit a cross-tab storage event the way another tab's write would. */
function emitStorageEvent(oldValue: string | null, newValue: string | null): void {
  // localStorage is SHARED per origin: the writing tab's write is already
  // visible to this tab's reads — the event only notifies. Simulate both
  // halves of a cross-tab write: commit the new value, then dispatch the
  // notification the writer's tab would NOT receive.
  try {
    if (newValue === null) localStorage.removeItem(TOKENS_KEY)
    else localStorage.setItem(TOKENS_KEY, newValue)
  } catch { /* ignore */ }
  window.dispatchEvent(new StorageEvent('storage', {
    key: TOKENS_KEY,
    oldValue,
    newValue,
  }))
}

const tokensJson = (refresh: string, access = 'fresh-access-token') =>
  JSON.stringify({
    access_token: access,
    refresh_token: refresh,
    // Fresh access token: the reconciler's resolver must adopt without a
    // forced refresh (tests that need the refresh path seed their own).
    access_expires_at: Date.now() + 10 * 60 * 1000,
    refresh_expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000,
    client_id: 'test-client-id',
    base_url: 'https://ai.jianguoyun.com',
  })

import {
  __resetGatewaySessionReconcilerForTests,
  getLastGatewayReconcileOutcome,
  setupGatewaySessionReconciler,
  whenGatewayReconcilerSettledForTests,
} from '@/agent/providers/gateway-session-reconciler'
import { getGatewayAuthSessionGeneration } from '@/agent/providers/llm-gateway-auth'
import {
  getModelsForProvider,
  getProviderConfig,
  getProviderCatalogStatus,
  unregisterDynamicProvider,
} from '@/agent/providers/types'
import {
  LLM_GATEWAY_PROVIDER_TYPE,
  registerGatewayModels,
} from '@/agent/providers/llm-gateway-provider'

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('gateway session reconciler', () => {
  let dispose: (() => void) | null = null

  beforeEach(async () => {
    // Drain stragglers from the PREVIOUS test: happy-dom fires a REAL storage
    // event for the localStorage writes in emitStorageEvent (in addition to
    // the synthetic one), and its listener job can land inside the NEXT test
    // and bump the auth generation there. Flushing here keeps every test's
    // event stream its own.
    await whenGatewayReconcilerSettledForTests()
    await new Promise((resolve) => setTimeout(resolve, 0))
    localStorage.clear()
    settingsStoreState.modelCredentialStatus = 'unknown'
    settingsStoreState.modelCredentialStatusError = null
    settingsStoreState.invalidateApiKeyCacheCalls = []
    settingsStoreState.checkHasApiKeyCalls = 0
    settingsStoreState.triggerProviderRefreshCalls = 0
    deleteApiKeyMock.mockReset()
    deleteApiKeyMock.mockResolvedValue(undefined)
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockResolvedValue(null)
    saveApiKeyMock.mockReset()
    saveApiKeyMock.mockResolvedValue(undefined)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => okResponse({ data: [{ id: 'glm-5.2', name: 'GLM' }] }))
    unregisterDynamicProvider('llm-gateway')
    registerCalls.count = 0
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    __resetGatewaySessionReconcilerForTests()
    localStorage.clear()
    unregisterDynamicProvider('llm-gateway')
    vi.restoreAllMocks()
  })

  it('re-adopts a usable session after another tab logs in: provider registered, catalog loaded, status valid', async () => {
    dispose = setupGatewaySessionReconciler()

    // No shared session before the event.
    emitStorageEvent(null, tokensJson('refresh-token-a'))
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('adopted')
    })

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('ready')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
    expect(settingsStoreState.modelCredentialStatus).toBe('valid')
    expect(settingsStoreState.modelCredentialStatusError).toBeNull()
    expect(settingsStoreState.invalidateApiKeyCacheCalls).toContain('__llm_gateway_token__')
    expect(settingsStoreState.checkHasApiKeyCalls).toBeGreaterThan(0)
    expect(settingsStoreState.triggerProviderRefreshCalls).toBeGreaterThan(0)
    // /v1/models was fetched with the shared session's token.
    const modelsCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/models'))
    expect(modelsCall).toBeDefined()
  })

  it('reconciles logged-out after another tab logs out: provider removed, status missing', async () => {
    // Establish a registered provider with a catalog first (this tab's own
    // previous session).
    registerGatewayModels([{ id: 'glm-5.2', name: 'GLM', capabilities: ['code'], contextWindow: 128000 }], 'ready')
    settingsStoreState.modelCredentialStatus = 'valid'
    dispose = setupGatewaySessionReconciler()

    // Drain the setup-time initial reconcile: it sees an empty shared session
    // (localStorage cleared in beforeEach) and reconciles logged-out — its
    // credential-lock work must settle before this test's logout event job
    // queues behind it, or the event job waits on happy-dom's Web Locks
    // manager past vi.waitFor's window.
    await whenGatewayReconcilerSettledForTests()

    emitStorageEvent(tokensJson('refresh-token-a'), null)
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('logged-out')
    })

    expect(getProviderConfigRegistered()).toBe(false)
    expect(settingsStoreState.modelCredentialStatus).toBe('missing')
  })

  it('reconciles account replacement: the previous account catalog is replaced by the new discovery', async () => {
    // Previous account's catalog.
    registerGatewayModels([{ id: 'old-model', name: 'Old', capabilities: ['code'], contextWindow: 128000 }], 'ready')
    dispose = setupGatewaySessionReconciler()

    fetchMock.mockImplementation(async () =>
      okResponse({ data: [{ id: 'new-account-model', name: 'New' }] })
    )
    emitStorageEvent(tokensJson('refresh-token-a'), tokensJson('refresh-token-b'))
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('adopted')
    })

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['new-account-model'])
    expect(settingsStoreState.modelCredentialStatus).toBe('valid')
  })

  it('keeps a failed discovery outcome: catalog marked failed, status still valid', async () => {
    dispose = setupGatewaySessionReconciler()
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500 } as Response))

    emitStorageEvent(null, tokensJson('refresh-token-a'))
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('adopted')
    })

    // The discovery failed: the registry must record a FAILED (unknown)
    // catalog — never an authoritative empty one, and never a stale list
    // presented as the new account's verified models.
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
    expect(settingsStoreState.modelCredentialStatus).toBe('valid')
  })

  it('does not mark a rejected session valid when discovery cannot refresh it', async () => {
    seedStoredTokens()
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('/v1/models')) return { ok: false, status: 401 } as Response
      return { ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) } as Response
    })
    dispose = setupGatewaySessionReconciler()
    await whenGatewayReconcilerSettledForTests()
    expect(settingsStoreState.modelCredentialStatus).toBe('expired')
    expect(getProviderConfigRegistered()).toBe(false)
  })

  it('treats a transient refresh failure as retryable and does NOT reconcile logged-out', async () => {
    dispose = setupGatewaySessionReconciler()
    // Drain the setup-time initial reconcile and reset the status it wrote
    // (empty session → 'missing') so the transient assertions below observe
    // ONLY this test's refresh failure.
    await whenGatewayReconcilerSettledForTests()
    settingsStoreState.modelCredentialStatus = 'unknown'
    // Tokens exist but the access token is expired → resolver refreshes →
    // network failure = temporary_error.
    // #175 review: generate the expiry ONCE under FROZEN fake timers — two
    // Date.now() calls can straddle a millisecond boundary, the replace()
    // would miss, and the test would silently skip the refresh path it
    // exists to cover.
    vi.useFakeTimers({ now: Date.now() })
    try {
      const now = Date.now()
      const expired = tokensJson('refresh-token-a', 'stale-access')
        .replace(`"access_expires_at":${now + 10 * 60 * 1000}`, `"access_expires_at":${now - 1000}`)
      expect(expired).toContain(`"access_expires_at":${now - 1000}`)
      fetchMock.mockRejectedValue(new TypeError('network down'))

      emitStorageEvent(tokensJson('old-refresh'), expired)
      await vi.waitFor(() => {
        expect(getLastGatewayReconcileOutcome()).toBe('transient')
      }, { timeout: 5000, interval: 20 })
    } finally {
      vi.useRealTimers()
    }

    // Transient: status representations untouched (not 'missing'/'expired').
    expect(settingsStoreState.modelCredentialStatus).toBe('unknown')
    // Provider re-registered for retry.
    expect(registerCalls.count).toBeGreaterThan(0)
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
    // Tokens NOT wiped.
    expect(localStorage.getItem(TOKENS_KEY)).not.toBeNull()
  })

  it('clears the previous catalog when identity reconciliation fails transiently', async () => {
    registerGatewayModels([{ id: 'old-model', name: 'Old', capabilities: ['code'], contextWindow: 128000 }], 'ready')
    seedStoredTokens({ access_expires_at: Date.now() - 1000 })
    fetchMock.mockRejectedValue(new TypeError('network down'))
    dispose = setupGatewaySessionReconciler()
    await vi.waitFor(() => expect(getLastGatewayReconcileOutcome()).toBe('transient'))
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })

  it('reconciles an expired-marked tab to valid after an access-only refresh in another tab (#172.1)', async () => {
    // This tab marked the session expired (its own refresh raced and failed).
    settingsStoreState.modelCredentialStatus = 'expired'
    dispose = setupGatewaySessionReconciler()

    // The setup-time initial reconcile sees NO session yet — drain it via
    // the deterministic hook so the event-driven access-refresh job's
    // outcome is what the assertions observe.
    await whenGatewayReconcilerSettledForTests()
    // Same refresh identity, fresher access token: storage rewrite from the
    // refreshing tab fires an access-refresh event here.
    seedStoredTokens({ refresh_token: 'refresh-token-a' })
    emitStorageEvent(tokensJson('refresh-token-a', 'old-access'), tokensJson('refresh-token-a', 'fresh-access'))

    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('adopted')
    })
    expect(settingsStoreState.modelCredentialStatus).toBe('valid')
    expect(settingsStoreState.modelCredentialStatusError).toBeNull()
    // No generation bump / no provider unregister for an access-only refresh:
    // the reconciler does NOT re-register (the account did not change, the
    // provider was never unregistered).
    expect(registerCalls.count).toBe(0)
  })

  it('access-refresh that races a logout reconciles logged-out, not valid', async () => {
    settingsStoreState.modelCredentialStatus = 'expired'
    dispose = setupGatewaySessionReconciler()

    // The event says access-refresh, but by the time the reconciler re-reads
    // the shared session it is GONE (a logout won the race). Re-read wins
    // over the event: reconcile logged-out. Drain the setup-time initial
    // reconcile first so the assertions observe the EVENT-driven job.
    await whenGatewayReconcilerSettledForTests()
    emitStorageEvent(tokensJson('refresh-token-a', 'old'), tokensJson('refresh-token-a', 'fresh'))
    localStorage.removeItem(TOKENS_KEY)
    // The resolver's no-tokens path consults the access shadow; none either.
    loadApiKeyMock.mockResolvedValue(null)

    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('logged-out')
    })
    expect(settingsStoreState.modelCredentialStatus).toBe('missing')
    expect(getProviderConfigRegistered()).toBe(false)
  })

  it('fences an older job after a rapid login → logout: the stale adoption never lands', async () => {
    dispose = setupGatewaySessionReconciler()
    // Drain the setup-time initial reconcile so the jobs tracked below belong
    // to THIS test's events only.
    await whenGatewayReconcilerSettledForTests()

    // Gate the /v1/models discovery so the first (login) job stays pending.
    let releaseDiscovery!: () => void
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve })
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes('/v1/models')) {
        await discoveryGate
        return okResponse({ data: [{ id: 'stale-model', name: 'Stale' }] })
      }
      return okResponse({ data: [] })
    })

    emitStorageEvent(null, tokensJson('refresh-token-a'))
    // Wait until the login job is parked inside the gated discovery.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/v1/models'))).toBe(true)
    })

    // Logout while the discovery is pending: generation bumps, provider
    // unregisters, and a SECOND (logout) job queues behind the first.
    emitStorageEvent(tokensJson('refresh-token-a'), null)
    const generationAtLogout = getGatewayAuthSessionGeneration()

    // Release the stale discovery AFTER the logout — the login job's result
    // belongs to a dead session.
    releaseDiscovery()
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).not.toBeNull()
    })
    // Let the queued logout job run to completion.
    await vi.waitFor(() => {
      expect(settingsStoreState.modelCredentialStatus).toBe('missing')
    })

    // The stale job must not have restored the provider/catalog.
    expect(getProviderConfigRegistered()).toBe(false)
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBeUndefined()
    expect(getGatewayAuthSessionGeneration()).toBe(generationAtLogout)
    expect(getLastGatewayReconcileOutcome()).toBe('logged-out')
  })

  it('dispose unsubscribes: events after dispose are ignored', async () => {
    dispose = setupGatewaySessionReconciler()
    // Drain the setup-time initial reconcile (empty session → it reconciles
    // logged-out); capture its outcome so the assertions below verify that
    // NO NEW reconcile ran after dispose.
    await whenGatewayReconcilerSettledForTests()
    const outcomeAfterInitial = getLastGatewayReconcileOutcome()
    const statusAfterInitial = settingsStoreState.modelCredentialStatus
    dispose()
    dispose = null

    emitStorageEvent(null, tokensJson('refresh-token-a'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The event must NOT have been reconciled: outcome and status are
    // exactly what the (drained) initial reconcile left behind.
    expect(getLastGatewayReconcileOutcome()).toBe(outcomeAfterInitial)
    expect(settingsStoreState.modelCredentialStatus).toBe(statusAfterInitial)
  })

  it('setup is idempotent: a second call does not double-subscribe', async () => {
    const dispose1 = setupGatewaySessionReconciler()
    setupGatewaySessionReconciler()

    // Drain the setup-time initial reconcile so checkHasApiKeyCalls reflects
    // only THIS test's event below.
    await whenGatewayReconcilerSettledForTests()
    emitStorageEvent(null, tokensJson('refresh-token-a'))
    await vi.waitFor(() => {
      expect(getLastGatewayReconcileOutcome()).toBe('adopted')
    })
    // One adoption only (not two competing jobs writing twice).
    expect(settingsStoreState.checkHasApiKeyCalls).toBe(1)
    dispose1()
    dispose = null
  })
})

/** Whether the llm-gateway dynamic provider currently has a registry config. */
function getProviderConfigRegistered(): boolean {
  return getProviderConfig(LLM_GATEWAY_PROVIDER_TYPE) !== null
}
