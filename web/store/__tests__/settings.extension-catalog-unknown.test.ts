/**
 * Regression tests for the PR #150 Sourcery round-8 findings:
 *
 * 1. 🟠 "Extension catalog treated as empty": codex-oauth is excluded from
 *    canFetchModels() like anthropic, but its registry is NOT authoritative
 *    by construction — the catalog arrives asynchronously from the browser
 *    extension. getAvailableProviders' built-in branch must classify an
 *    extension-fed provider with no positively reported catalog as 'failed'
 *    (unknown — defer), never 'empty' (authoritative — sweep pins +
 *    reconcile away). anthropic keeps its ready/empty classification.
 *
 * 2. 🟡 "Older tab overwrites newer disk cache": memoryCache is per-tab, so
 *    setCachedModels' ordering guard cannot see another tab's localStorage
 *    write. A late older refresh must not clobber the newer disk entry —
 *    the persisted catalog is re-read and ordered before writeToDisk.
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

vi.mock('@/sqlite', () => ({
  initSQLiteDB: vi.fn(() => Promise.resolve()),
  getApiKeyRepository: vi.fn(() => ({
    load: vi.fn(() => Promise.resolve(null)),
  })),
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

const CODEX = 'codex-oauth' as LLMProviderType

describe('getAvailableProviders: extension-fed provider with an unloaded catalog (Sourcery round 8, finding 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === CODEX ? 'key' : null))
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getCachedModelsResult.mockReturnValue(null)
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    useSettingsStore.setState({
      providerType: CODEX,
      modelName: 'gpt-6-luna',
      pinnedModelsByProvider: { [CODEX]: ['gpt-6-luna'] },
      pinnedSeenByProvider: { [CODEX]: ['gpt-6-luna'] },
    })
  })

  it('reports catalogStatus "failed" (unknown) when the codex-oauth registry is empty and the catalog never arrived', async () => {
    // codex-oauth has an API key (a stale registration/key) but the
    // extension catalog has NOT loaded: the static registry is empty,
    // canFetchModels() is false (same as anthropic) — yet the registry is
    // NOT authoritative for this provider, so the status must be unknown.
    mocks.getModelsForProvider.mockReturnValue([])

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === CODEX)

    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('failed')
  })

  it('does NOT sweep confirmed pins for an extension-fed provider with an unloaded catalog', async () => {
    // The 🟠 harm: an 'empty' classification let the stale-pin sweep remove
    // the previously confirmed pin while the extension catalog was merely
    // not-yet-loaded. 'failed' must keep the sweep frozen.
    mocks.getModelsForProvider.mockReturnValue([])

    const results = await useSettingsStore.getState().getAvailableProviders()

    expect(useSettingsStore.getState().pinnedModelsByProvider[CODEX]).toEqual(['gpt-6-luna'])
    expect(results.find((r) => r.providerType === CODEX)?.models.map((m) => m.id)).toEqual(['gpt-6-luna'])
  })

  it('reports catalogStatus "ready" for a static-only provider with a non-empty registry (unchanged)', async () => {
    // anthropic has no /models endpoint (canFetchModels false) but its
    // registry IS authoritative by construction — the round-6 fix that made
    // its static models visible must keep working.
    const A = 'anthropic' as LLMProviderType
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === A ? 'key' : null))
    useSettingsStore.setState({
      providerType: A,
      modelName: 'claude-3-5-haiku-20241022',
      pinnedModelsByProvider: { [A]: ['claude-3-5-haiku-20241022'] },
      pinnedSeenByProvider: { [A]: ['claude-3-5-haiku-20241022'] },
    })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === A)

    expect(provider?.catalogStatus).toBe('ready')
  })
})
