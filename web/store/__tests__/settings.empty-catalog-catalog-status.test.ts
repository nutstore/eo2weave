/**
 * Regression tests for the PR #150 Sourcery 🟠 finding "Selection changes
 * during outages" (web/store/settings.store.ts getAvailableProviders /
 * ensureValidModelSelection).
 *
 * An empty provider catalog has two meanings and the selection reconciler
 * must not conflate them:
 *
 * - FAILED/UNKNOWN refresh (the /models fetch 500'd, login discovery timed
 *   out, or the registry bootstrap threw): nothing authoritative is known,
 *   so `getAvailableProviders` must report catalogStatus 'failed' for that
 *   provider — `resolveDefaultModelSelection` then DEFERS and the user's
 *   active provider/model survives the outage untouched.
 * - AUTHORITATIVE empty (the provider itself confirmed the catalog is
 *   empty): the result must still be consumable by stale-pin callers via
 *   `authoritativeIds` (empty IS the answer), while the selection sweep
 *   defers for the failed-shaped result.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// getAvailableProviders() dynamic-imports these modules; they must be
// mocked BEFORE the store module is imported.
const mocks = vi.hoisted(() => ({
  loadApiKey: vi.fn<(id: string) => Promise<string | null>>(async () => null),
  isLLMGatewayConfigured: vi.fn(() => false),
  getModelsForProvider: vi.fn<(id: string) => Array<{ id: string; name: string }>>(() => []),
  getCachedModels: vi.fn<(type: string, key?: string) => Array<{ id: string; name: string }> | null>(() => null),
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
  }
})

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  LLM_GATEWAY_PROVIDER_TYPE: 'llm-gateway',
  getLLMGatewayApiKeyProviderKey: () => '__llm_gateway_token__',
  isLLMGatewayConfigured: mocks.isLLMGatewayConfigured,
}))

import { useSettingsStore } from '../settings.store'
import type { LLMProviderType } from '@/agent/providers/types'

const P = 'openai' as LLMProviderType

describe('getAvailableProviders: failed vs authoritative-empty catalogs (PR #150)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    useSettingsStore.setState({
      providerType: P,
      modelName: 'm-alive',
      pinnedModelsByProvider: { [P]: ['m-alive'] },
      pinnedSeenByProvider: { [P]: ['m-alive'] },
    })
  })

  it('reports catalogStatus "failed" when the static registry resolves empty (failed/unknown refresh)', async () => {
    // Registry bootstrap failed → getModelsForProvider([]) → authoritativeIds [].
    mocks.getModelsForProvider.mockReturnValue([])

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

  it('DEFERS selection changes on a failed catalog (keeps the active provider/model)', async () => {
    mocks.getModelsForProvider.mockReturnValue([])

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

  it('does not auto-remove pins when the catalog failed (empty authoritative list)', async () => {
    mocks.getModelsForProvider.mockReturnValue([])

    await useSettingsStore.getState().getAvailableProviders()

    expect(useSettingsStore.getState().pinnedModelsByProvider[P]).toEqual(['m-alive'])
    expect(useSettingsStore.getState().pinnedSeenByProvider[P]).toEqual(['m-alive'])
  })

  it('exposes the failed/empty distinction to stale-pin callers via authoritativeIds', async () => {
    // Failed refresh: pins stay (the empty list reads as "unknown").
    mocks.getModelsForProvider.mockReturnValue([])
    let results = await useSettingsStore.getState().getAvailableProviders()
    let provider = results.find((r) => r.providerType === P)!
    expect(provider.catalogStatus).toBe('failed')
    expect(useSettingsStore.getState().getStalePinnedModels(P, provider.authoritativeIds)).toEqual([])

    // Authoritative delisting: same provider NOW lists one model, the pin is
    // gone from it → the caller sees the stale pin through authoritativeIds.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-other', name: 'Other' }])
    results = await useSettingsStore.getState().getAvailableProviders()
    provider = results.find((r) => r.providerType === P)!
    expect(provider.catalogStatus).toBe('ready')
    expect(provider.authoritativeIds).toEqual(['m-other'])
    // 'm-alive' was seen before and is absent from the authoritative list.
    // (It is also the active model, so the auto-removal keeps it, but the
    // stale-pin API itself must report it.)
    expect(useSettingsStore.getState().getStalePinnedModels(P, provider.authoritativeIds)).toEqual(['m-alive'])
  })
})
