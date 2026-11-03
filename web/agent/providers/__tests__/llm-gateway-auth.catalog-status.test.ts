/**
 * Regression tests for the gateway catalog-status plumbing (PR #150 round 4).
 *
 * `fetchGatewayModels` must distinguish an AUTHORITATIVE empty catalog (the
 * gateway answered 200 and positively reports it serves no models) from a
 * FAILED fetch (non-2xx, unparseable body, network error) — the two look
 * identical as "empty list" but mean opposite things for selection
 * reconciliation and stale-pin sweeps (#146).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<typeof fetch>()

vi.stubGlobal('fetch', fetchMock)

// The session-change tests drive the real refresh/logout paths, which
// dynamic-import the SQLite-backed api-key-store and the settings store.
// Stub both with in-memory fakes so the tests never touch real storage.
vi.mock('@/security/api-key-store', () => ({
  loadApiKey: vi.fn(async () => null),
  saveApiKey: vi.fn(async () => {}),
  deleteApiKey: vi.fn(async () => {}),
}))
vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: () => ({
      setModelCredentialStatus: vi.fn(),
      setModelCredentialStatusError: vi.fn(),
    }),
  },
}))

import { fetchGatewayModels, getGatewayAuthSessionGeneration } from '@/agent/providers/llm-gateway-auth'
import { getModelsForProvider, getProviderCatalogStatus, registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
import { registerGatewayModels, unregisterLLMGatewayProvider, updateGatewayModels, LLM_GATEWAY_PROVIDER_TYPE } from '@/agent/providers/llm-gateway-provider'
import type { ModelInfo } from '@/agent/providers/types'

const TOKENS_KEY = 'llm-gateway-tokens'
const BASE_URL = 'https://ai.jianguoyun.com'
const CLIENT_ID = 'test-client-id'

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response
}

describe('fetchGatewayModels: ready / empty / failed statuses', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns status "ready" for a non-empty catalog', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ id: 'glm-5.2', name: 'GLM' }] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models.map((m) => m.id)).toEqual(['glm-5.2'])
    expect(result.status).toBe('ready')
  })

  it('returns status "empty" for a successful 200 with an empty data array (authoritative)', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('empty')
  })

  it('returns status "failed" for a non-2xx response (unknown, not empty)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response)
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('marks HTTP 401 separately so callers can refresh rejected credentials', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response)
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.status).toBe('failed')
    expect(result.authRejected).toBe(true)
  })

  it('returns status "failed" for a 200 with an unparseable body (unknown, not empty)', async () => {
    fetchMock.mockResolvedValue(okResponse({ unexpected: true }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns status "failed" when a 200 body fails to parse (malformed JSON rejects json())', async () => {
    // Sourcery round 5: the shape-based failure above resolves json(); a
    // truncated/malformed body makes json() itself REJECT — that rejection
    // must degrade to a failed catalog, not escape fetchGatewayModels.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    } as unknown as Response)
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns status "failed" for a network error (unknown, not empty)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('still propagates an AbortError from an aborted signal', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    const signal = new AbortController().signal
    fetchMock.mockRejectedValue(abortError)
    await expect(fetchGatewayModels('https://gw.example', 'tok', signal)).rejects.toBeInstanceOf(DOMException)
  })

  // Sourcery: "Timed-out body read erases gateway models" — an abort that
  // lands while res.json() is still pending (the discovery deadline firing
  // after the headers arrived) must REJECT, not degrade to a failed catalog;
  // the caller's timeout handler then runs instead of an empty list being
  // committed over previously registered models.
  it('re-throws an abort that fires while the body read is pending', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    const controller = new AbortController()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort()
        throw abortError
      },
    } as unknown as Response)
    await expect(
      fetchGatewayModels('https://gw.example', 'tok', controller.signal),
    ).rejects.toBe(abortError)
  })

  // Sourcery round 6, "Malformed gateway models are accepted": a 200 whose
  // data array contains unusable entries is NOT a usable catalog. The old
  // mapping dereferenced null entries (throwing past the failed-catalog
  // handling) and mapped missing ids to '' while still reporting 'ready'.
  it('returns status "failed" when a data entry is null', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [null] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns status "failed" when a data entry is not an object', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ id: 'ok' }, 'garbage'] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns status "failed" when a data entry lacks a usable string id', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ name: 'NoId' }] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns status "failed" when a data entry has an empty/whitespace id (no empty-string ids become selectable)', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ id: '   ' }] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('maps name to id when missing but keeps a non-empty id catalog usable', async () => {
    fetchMock.mockResolvedValue(okResponse({ data: [{ id: 'glm-5.2' }] }))
    const result = await fetchGatewayModels('https://gw.example', 'tok')
    expect(result.models).toEqual([{ id: 'glm-5.2', name: 'glm-5.2' }])
    expect(result.status).toBe('ready')
  })
})

describe('registry catalog status bookkeeping', () => {
  const GW = 'llm-gateway-test'

  afterEach(() => {
    unregisterDynamicProvider(GW)
  })

  it('records and exposes an explicit catalog status', () => {
    const models: ModelInfo[] = [{ id: 'm1', name: 'M1', capabilities: ['code'], contextWindow: 128000 }]
    registerDynamicProvider(
      GW,
      { baseURL: 'https://gw.example/v1', modelName: 'm1', headers: {}, apiMode: 'chat-completions' },
      { category: 'chinese', displayName: 'GW', models, catalogStatus: 'empty' },
    )
    expect(getProviderCatalogStatus(GW)).toBe('empty')
  })

  it('reads an unrecorded status: non-empty list → ready, empty list → failed (unknown)', () => {
    registerDynamicProvider(
      GW,
      { baseURL: 'https://gw.example/v1', modelName: '', headers: {}, apiMode: 'chat-completions' },
      { category: 'chinese', displayName: 'GW', models: [] },
    )
    expect(getProviderCatalogStatus(GW)).toBe('failed')

    const models: ModelInfo[] = [{ id: 'm1', name: 'M1', capabilities: ['code'], contextWindow: 128000 }]
    registerDynamicProvider(
      GW,
      { baseURL: 'https://gw.example/v1', modelName: 'm1', headers: {}, apiMode: 'chat-completions' },
      { category: 'chinese', displayName: 'GW', models },
    )
    expect(getProviderCatalogStatus(GW)).toBe('ready')
  })

  it('returns undefined for an unregistered provider', () => {
    expect(getProviderCatalogStatus('never-registered-provider')).toBeUndefined()
  })
})

describe('gateway last known catalog', () => {
  const model: ModelInfo = { id: 'glm-5.2', name: 'GLM', capabilities: ['code'], contextWindow: 128000 }

  afterEach(() => unregisterLLMGatewayProvider())

  it('keeps the last successful models but marks them non-authoritative after a failed refresh', () => {
    registerGatewayModels([model], 'ready')
    registerGatewayModels([], 'failed')

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it('replaces the last successful models after an authoritative empty response', () => {
    // Issue #146: an EMPTY successful catalog reads as UNKNOWN, not as
    // all-pins-delisted — the local stale comparison would otherwise flag
    // every seen pin. The registration downgrades to 'failed' and RETAINS
    // the last-known list instead of wiping it.
    registerGatewayModels([model], 'ready')
    registerGatewayModels([], 'empty')

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })

  it('does not retain models after the provider is unregistered for logout', () => {
    registerGatewayModels([model], 'ready')
    unregisterLLMGatewayProvider()
    registerGatewayModels([], 'failed')

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })

  it('marks a timed-out refresh as failed while retaining the previous models', async () => {
    registerGatewayModels([model], 'ready')
    fetchMock.mockRejectedValueOnce(new DOMException('Timed out', 'AbortError'))

    await expect(updateGatewayModels('token')).rejects.toThrow('Timed out')

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })
})

describe('empty catalog reads as unknown (issue #146)', () => {
  const model: ModelInfo = { id: 'glm-5.2', name: 'GLM', capabilities: ['code'], contextWindow: 128000 }

  afterEach(() => unregisterLLMGatewayProvider())

  it('treats an empty-but-successful (empty) catalog as unknown, not all-pins-delisted', () => {
    // Issue #146: the stale/offline badge is a LOCAL comparison — an empty
    // authoritative set would mark every previously seen pin as delisted. A
    // successful fetch that reports nothing carries no usable catalog and
    // must register as unknown ('failed'), retaining the last-known list.
    registerGatewayModels([model], 'ready')
    registerGatewayModels([], 'empty')

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
  })

  it('registers an empty catalog with no explicit status as unknown too', () => {
    registerGatewayModels([])

    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })
})

describe('credential-session change clears the cached catalog (issue #146)', () => {
  const model: ModelInfo = { id: 'glm-5.2', name: 'GLM', capabilities: ['code'], contextWindow: 128000 }

  beforeEach(() => {
    localStorage.setItem(TOKENS_KEY, JSON.stringify({
      access_token: 'access-1', refresh_token: 'refresh-1',
      access_expires_at: Date.now() + 3600_000,
      refresh_expires_at: Date.now() + 7 * 24 * 3600_000,
      client_id: CLIENT_ID, base_url: BASE_URL,
    }))
  })

  afterEach(() => {
    localStorage.clear()
    unregisterLLMGatewayProvider()
  })

  it('does not let a failed discovery after logout resurrect the previous catalog', async () => {
    // Account A: a successful discovery registers its models.
    registerGatewayModels([model], 'ready')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])

    // Credentials disappear (another tab logs out via logoutGateway): the
    // session generation bumps and the cached catalog must NOT survive into
    // the next session.
    localStorage.removeItem(TOKENS_KEY)
    const { logoutGateway } = await import('@/agent/providers/llm-gateway-auth')
    await logoutGateway()
    const before = getGatewayAuthSessionGeneration()
    expect(before).toBeGreaterThan(0)
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])

    // A failed discovery in the new (logged-out) state retains nothing —
    // account A's models must not appear after the session change.
    registerGatewayModels([], 'failed')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })

  it('does not let a failed discovery after a NEW login inherit the previous account models', async () => {
    // Account A's catalog is registered...
    registerGatewayModels([model], 'ready')
    // ...then account B logs in (saveStoredTokens bumps the generation and
    // clears the cached catalog)...
    localStorage.setItem(TOKENS_KEY, JSON.stringify({
      access_token: 'access-2', refresh_token: 'refresh-2',
      access_expires_at: Date.now() + 3600_000,
      refresh_expires_at: Date.now() + 7 * 24 * 3600_000,
      client_id: CLIENT_ID, base_url: BASE_URL,
    }))
    const { persistDeviceLoginTokens } = await import('@/agent/providers/llm-gateway-auth')
    persistDeviceLoginTokens({
      access_token: 'access-b', token_type: 'Bearer', expires_in: 3600,
      refresh_token: 'refresh-b', refresh_expires_in: 7 * 24 * 3600,
    }, CLIENT_ID, BASE_URL)

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])

    // ...and B's discovery FAILS: retention keeps nothing — there is no
    // last-known list of B's to keep, so A's models must not resurface.
    registerGatewayModels([], 'failed')
    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE)).toEqual([])
  })

  it('still retains models for a failed refresh within the SAME session', async () => {
    // No credential change between the two registrations: retention-on-
    // failed-refresh for the same account stays intact.
    registerGatewayModels([model], 'ready')
    registerGatewayModels([], 'failed')

    expect(getModelsForProvider(LLM_GATEWAY_PROVIDER_TYPE).map((m) => m.id)).toEqual(['glm-5.2'])
    expect(getProviderCatalogStatus(LLM_GATEWAY_PROVIDER_TYPE)).toBe('failed')
  })
})
