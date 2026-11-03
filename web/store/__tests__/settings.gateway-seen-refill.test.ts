/**
 * Regression tests for nutstore/eo2weave#146.
 *
 * The llm-gateway branch of getAvailableProviders() must refill the
 * "seen" bookkeeping from the authoritative registry list, mirroring the
 * built-in and dynamic-provider branches — WITHOUT letting a bookkeeping
 * failure (the persist middleware's localStorage write throwing) swallow
 * the gateway result (PR #150 Sourcery: "Gateway disappears after
 * persistence failure").
 *
 * (The empty-catalog guard inside getStalePinnedModels itself is covered
 * in settings.empty-catalog-catalog-status.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// getAvailableProviders() dynamic-imports these modules; they must be
// mocked BEFORE the store module is imported.
const mocks = vi.hoisted(() => ({
  loadApiKey: vi.fn<(id: string) => Promise<string | null>>(async () => null),
  isLLMGatewayConfigured: vi.fn(() => true),
  getModelsForProvider: vi.fn<(id: string) => Array<{ id: string; name: string }>>(() => []),
  getCachedModels: vi.fn<(type: string, key?: string) => Array<{ id: string; name: string }> | null>(() => null),
  getProviderCatalogStatus: vi.fn<(type: string) => 'ready' | 'empty' | 'failed' | undefined>(() => undefined),
}))

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: mocks.loadApiKey,
}))

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    getModelsForProvider: mocks.getModelsForProvider,
    getProviderCatalogStatus: mocks.getProviderCatalogStatus,
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

import { useSettingsStore } from '@/store/settings.store'
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
    // No recorded registration status: a non-empty list reads as 'ready'.
    mocks.getProviderCatalogStatus.mockReturnValue('ready')
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
    mocks.getProviderCatalogStatus.mockReturnValue('failed')
    const results = await useSettingsStore.getState().getAvailableProviders()

    // The gateway entry is present with an empty authoritative list.
    const gw = results.find((r) => r.providerType === GW)
    expect(gw).toBeDefined()
    expect(gw?.authoritativeIds).toEqual([])
    // An empty UNKNOWN catalog reads as "unknown": nothing stale.
    expect(useSettingsStore.getState().getStalePinnedModels(GW, [])).toEqual([])
  })

  it('auto-removal loop keeps pins when the gateway catalog is empty', async () => {
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getProviderCatalogStatus.mockReturnValue('failed')
    const before = useSettingsStore.getState().pinnedModelsByProvider[GW]

    await useSettingsStore.getState().getAvailableProviders()

    // Empty catalog → no auto-removal, no wiped pins.
    expect(useSettingsStore.getState().pinnedModelsByProvider[GW]).toEqual(before)
  })

  it('keeps the gateway result when markPinnedModelsSeen throws (persist write failure)', async () => {
    // PR #150 Sourcery 🟡 "Gateway disappears after persistence failure":
    // the seen-bookkeeping set() can throw inside the persist middleware
    // (localStorage write). The gateway branch's surrounding catch must
    // not swallow it — the gateway entry must still reach `results` so
    // reconciliation sees the active provider.
    const spy = vi.spyOn(useSettingsStore.getState(), 'markPinnedModelsSeen')
      .mockImplementation(() => {
        throw new Error('persist: localStorage write failed')
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const results = await useSettingsStore.getState().getAvailableProviders()

      const gw = results.find((r) => r.providerType === GW)
      expect(gw).toBeDefined()
      expect(gw?.authoritativeIds).toEqual(['gw-model-a', 'gw-model-b'])
      // The failure was contained (warned about), not propagated.
      expect(warn).toHaveBeenCalled()
      // The active selection is untouched — the gateway did not vanish
      // from reconciliation.
      expect(useSettingsStore.getState().providerType).toBe(GW)
      expect(useSettingsStore.getState().modelName).toBe('gw-model-a')
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})
