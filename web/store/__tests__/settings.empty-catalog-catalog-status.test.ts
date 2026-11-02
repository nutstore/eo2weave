/**
 * Regression tests for the PR #150 Sourcery 🟠 finding "Selections change
 * during catalog outages" (web/store/settings.store.ts getAvailableProviders
 * / resolveDefaultModelSelection) plus the 🟡 follow-ups "Confirmed empty
 * catalogs leave stale selections" and "Outage test misses broken deferral".
 *
 * An empty provider catalog has two meanings and the reconciler must not
 * conflate them:
 *
 * - FAILED/UNKNOWN refresh (the /models fetch 500'd or was never attempted):
 *   nothing authoritative is known, so `getAvailableProviders` reports
 *   catalogStatus 'failed' for that provider — `resolveDefaultModelSelection`
 *   then DEFERS and the user's active provider/model survives the outage
 *   untouched, EVEN WHEN another provider could take over.
 * - AUTHORITATIVE empty (the provider itself confirmed the catalog is
 *   empty): the stale-pin sweep processes it as empty and the selection
 *   reconciles away from the delisted model, while a failed refresh keeps
 *   everything frozen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// getAvailableProviders() dynamic-imports these modules; they must be
// mocked BEFORE the store module is imported.
const mocks = vi.hoisted(() => ({
  loadApiKey: vi.fn<(id: string) => Promise<string | null>>(async () => null),
  isLLMGatewayConfigured: vi.fn(() => false),
  getModelsForProvider: vi.fn<(id: string) => Array<{ id: string; name: string }>>(() => []),
  getCachedModels: vi.fn<(type: string, key?: string) => Array<{ id: string; name: string }> | null>(() => null),
  getCachedModelsResult: vi.fn<
    (type: string, key?: string) => { error?: string } | null
  >(() => null),
  getDynamicProviderIds: vi.fn<() => string[]>(() => []),
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: mocks.loadApiKey,
}))

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    getModelsForProvider: mocks.getModelsForProvider,
    getDynamicProviderIds: mocks.getDynamicProviderIds,
  }
})

vi.mock('@/agent/providers/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/model-store')>()
  return {
    ...actual,
    getCachedModels: mocks.getCachedModels,
    getCachedModelsResult: mocks.getCachedModelsResult,
  }
})

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  LLM_GATEWAY_PROVIDER_TYPE: 'llm-gateway',
  getLLMGatewayApiKeyProviderKey: () => '__llm_gateway_token__',
  isLLMGatewayConfigured: mocks.isLLMGatewayConfigured,
}))

import { useSettingsStore } from '@/store/settings.store'
import type { LLMProviderType } from '@/agent/providers/types'

const P = 'openai' as LLMProviderType

describe('getAvailableProviders: failed vs authoritative-empty catalogs (PR #150)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getCachedModelsResult.mockReturnValue(null)
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    useSettingsStore.setState({
      providerType: P,
      modelName: 'm-alive',
      pinnedModelsByProvider: { [P]: ['m-alive'] },
      pinnedSeenByProvider: { [P]: ['m-alive'] },
    })
  })

  it('reports catalogStatus "failed" when the static registry resolves empty AND the last /models refresh recorded an error', async () => {
    // Registry bootstrap failed → getModelsForProvider([]) and the last
    // refresh recorded an error → the catalog is UNKNOWN, not empty.
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('failed')
  })

  it('reports catalogStatus "ready" when the authoritative list is non-empty', async () => {
    mocks.getModelsForProvider.mockReturnValue([
      { id: 'm-alive', name: 'Alive' },
    ])

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual(['m-alive'])
    expect(provider?.catalogStatus).toBe('ready')
  })

  it('reports catalogStatus "empty" (authoritative) when the static registry resolves empty with NO refresh error', async () => {
    // The catalog was loaded successfully and positively reports no models.
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue(null)

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('empty')
  })

  it('DEFERS selection changes on a failed catalog EVEN when another provider has an available model', async () => {
    // Regression guard for Sourcery "Outage test misses broken deferral":
    // a second provider (anthropic) has a usable model, so WITHOUT the
    // failed-catalog defer the resolver would switch the active selection
    // to it. Removing the defer must make this test fail.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P || id === 'anthropic' ? 'key' : null))
    mocks.getModelsForProvider.mockImplementation((id: string) =>
      id === P ? [] : id === 'anthropic' ? [{ id: 'a-1', name: 'Claude' }] : [],
    )
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })

    await useSettingsStore.getState().getAvailableProviders()

    const state = useSettingsStore.getState()
    expect(state.providerType).toBe(P)
    expect(state.modelName).toBe('m-alive')
  })

  it('keeps the selection when the authoritative list confirms the current model (ready catalog)', async () => {
    mocks.getModelsForProvider.mockReturnValue([
      { id: 'm-alive', name: 'Alive' },
      { id: 'm-other', name: 'Other' },
    ])

    await useSettingsStore.getState().getAvailableProviders()

    const state = useSettingsStore.getState()
    expect(state.providerType).toBe(P)
    expect(state.modelName).toBe('m-alive')
  })

  it('switches away on an AUTHORITATIVE empty catalog (the model is genuinely gone)', async () => {
    // The provider confirmed an empty catalog AND another provider has a
    // model: unlike the failed case, this MUST reconcile to the alternative.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P || id === 'anthropic' ? 'key' : null))
    mocks.getModelsForProvider.mockImplementation((id: string) =>
      id === P ? [] : id === 'anthropic' ? [{ id: 'a-1', name: 'Claude' }] : [],
    )
    mocks.getCachedModelsResult.mockReturnValue(null)

    await useSettingsStore.getState().getAvailableProviders()

    const state = useSettingsStore.getState()
    expect(state.providerType).toBe('anthropic')
    expect(state.modelName).toBe('a-1')
  })

  it('does not auto-remove pins when the catalog failed (empty authoritative list)', async () => {
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })

    await useSettingsStore.getState().getAvailableProviders()

    expect(useSettingsStore.getState().pinnedModelsByProvider[P]).toEqual(['m-alive'])
    expect(useSettingsStore.getState().pinnedSeenByProvider[P]).toEqual(['m-alive'])
  })

  it('exposes the failed/empty distinction to stale-pin callers via authoritativeIds + catalogStatus', async () => {
    // Failed refresh: pins stay (the empty list reads as "unknown").
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })
    let results = await useSettingsStore.getState().getAvailableProviders()
    let provider = results.find((r) => r.providerType === P)!
    expect(provider.catalogStatus).toBe('failed')
    expect(
      useSettingsStore.getState().getStalePinnedModels(P, provider.authoritativeIds, provider.catalogStatus)
    ).toEqual([])

    // Authoritative delisting: same provider NOW lists one model, the pin is
    // gone from it → the caller sees the stale pin through authoritativeIds.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-other', name: 'Other' }])
    mocks.getCachedModelsResult.mockReturnValue(null)
    results = await useSettingsStore.getState().getAvailableProviders()
    provider = results.find((r) => r.providerType === P)!
    expect(provider.catalogStatus).toBe('ready')
    expect(provider.authoritativeIds).toEqual(['m-other'])
    // 'm-alive' was seen before and is absent from the authoritative list.
    // (It is also the active model, so the auto-removal keeps it, but the
    // stale-pin API itself must report it.)
    expect(
      useSettingsStore.getState().getStalePinnedModels(P, provider.authoritativeIds, provider.catalogStatus)
    ).toEqual(['m-alive'])
  })
})

describe('getStalePinnedModels: catalogStatus semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      pinnedModelsByProvider: { [P]: ['m-a', 'm-b'] },
      pinnedSeenByProvider: { [P]: ['m-a', 'm-b'] },
    })
  })

  it('reports nothing stale for a failed/unknown catalog even against an empty list', () => {
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels(P, [], 'failed')).toEqual([])
    expect(state.getStalePinnedModels(P, [], 'loading')).toEqual([])
    expect(state.getStalePinnedModels(P, [], undefined)).toEqual([])
  })

  it('reports every seen pin stale for an AUTHORITATIVE empty catalog', () => {
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels(P, [], 'empty')).toEqual(['m-a', 'm-b'])
  })

  it('keeps legacy behavior for non-empty lists (with or without a status)', () => {
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels(P, ['m-a'], 'ready')).toEqual(['m-b'])
    expect(state.getStalePinnedModels(P, ['m-a'])).toEqual(['m-b'])
  })
})
