/**
 * Regression tests for nutstore/eo2weave#146.
 *
 * The llm-gateway branch of getAvailableProviders() must refill the
 * "seen" bookkeeping from the authoritative registry list, mirroring the
 * built-in and dynamic-provider branches. Without it, the gateway's seen
 * set only fills on manual pin events and a later empty catalog flags
 * every previously-seen pin as 已下线 (delisted) with no way to self-heal.
 *
 * (The empty-catalog guard inside getStalePinnedModels itself is covered
 * in settings.store.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// getAvailableProviders() dynamic-imports these modules; they must be
// mocked BEFORE the store module is imported.
const mocks = vi.hoisted(() => ({
  loadApiKey: vi.fn<(id: string) => Promise<string | null>>(async () => null),
  isLLMGatewayConfigured: vi.fn(() => true),
  getModelsForProvider: vi.fn<(id: string) => Array<{ id: string; name: string }>>(() => []),
  getCachedModels: vi.fn<(type: string, key?: string) => Array<{ id: string; name: string }> | null>(() => null),
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: mocks.loadApiKey,
}))

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    getModelsForProvider: mocks.getModelsForProvider,
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

vi.mock('@/agent/providers/llm-gateway-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/llm-gateway-auth')>()
  return {
    ...actual,
    fetchGatewayRateLimits: vi.fn(async () => {
      throw new Error('not available in tests')
    }),
  }
})

import { useSettingsStore } from '../settings.store'
import type { LLMProviderType } from '@/agent/providers/types'

const GW = 'llm-gateway' as LLMProviderType

describe('getAvailableProviders: llm-gateway branch refills pinned-seen (#146)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === '__llm_gateway_token__' ? 'gw-key' : null))
    mocks.getModelsForProvider.mockReturnValue([
      { id: 'gw-model-a', name: 'Model A' },
      { id: 'gw-model-b', name: 'Model B' },
    ])
    mocks.getCachedModels.mockReturnValue(null)
    useSettingsStore.setState({
      providerType: GW,
      modelName: 'gw-model-a',
      pinnedModelsByProvider: { [GW]: ['gw-model-a', 'gw-model-b'] },
      pinnedSeenByProvider: {},
    })
  })

  it('marks the gateway pins seen from the registry list on load', async () => {
    await useSettingsStore.getState().getAvailableProviders()

    const seen = useSettingsStore.getState().pinnedSeenByProvider[GW]
    expect(seen).toEqual(expect.arrayContaining(['gw-model-a', 'gw-model-b']))
    // ...and they are NOT reported stale against the non-empty list.
    expect(useSettingsStore.getState().getStalePinnedModels(GW, ['gw-model-a'])).toEqual(['gw-model-b'])
  })

  it('still refills seen when the registry list is empty (pin-only state)', async () => {
    // Registry not loaded yet (e.g. right after a login that committed an
    // empty catalog): the gateway still registers with an empty list.
    mocks.getModelsForProvider.mockReturnValue([])
    const results = await useSettingsStore.getState().getAvailableProviders()

    // The gateway entry is present with an empty authoritative list.
    const gw = results.find((r) => r.providerType === GW)
    expect(gw).toBeDefined()
    expect(gw?.authoritativeIds).toEqual([])
    // The empty authoritative list reads as "unknown": nothing stale.
    expect(useSettingsStore.getState().getStalePinnedModels(GW, [])).toEqual([])
  })

  it('auto-removal loop keeps pins when the gateway catalog is empty', async () => {
    mocks.getModelsForProvider.mockReturnValue([])
    const before = useSettingsStore.getState().pinnedModelsByProvider[GW]

    await useSettingsStore.getState().getAvailableProviders()

    // Empty catalog → no auto-removal, no wiped pins.
    expect(useSettingsStore.getState().pinnedModelsByProvider[GW]).toEqual(before)
  })
})
