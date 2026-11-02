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

import { fetchGatewayModels } from '@/agent/providers/llm-gateway-auth'
import { getProviderCatalogStatus, registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'
import type { ModelInfo } from '@/agent/providers/types'

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
