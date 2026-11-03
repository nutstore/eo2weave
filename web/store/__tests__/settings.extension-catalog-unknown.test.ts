/**
 * Regression tests for the PR #150 Sourcery round-8 finding 🟠 "Extension
 * catalog treated as empty" (web/store/settings.store.ts getAvailableProviders,
 * built-in provider branch).
 *
 * `canFetchModels()` is false for TWO different kinds of provider:
 *
 * - static-only providers (anthropic — no /models endpoint): their static
 *   registry is authoritative BY CONSTRUCTION, so an empty registry really
 *   does mean "this provider serves no models" ('empty').
 * - extension-fed providers (codex-oauth — models arrive asynchronously from
 *   the browser extension): an empty/unloaded registry means "the catalog has
 *   not been reported yet" (unknown → 'failed'), NOT a confirmed empty
 *   catalog.
 *
 * Conflating the two let the stale-pin sweep remove previously confirmed
 * pins and reconciliation switch away from the provider while its catalog
 * was merely not-yet-loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { PROVIDER_META } from '@/agent/providers/types'
import type { LLMProviderType, ProviderMeta } from '@/agent/providers/types'
import {
  canFetchModels,
  hasAuthoritativeStaticRegistry,
} from '@/agent/providers/model-fetcher'

const CODEX = 'codex-oauth' as LLMProviderType

describe('extension-fed provider classification predicates', () => {
  it('excludes codex-oauth from canFetchModels but not from the static-only set', () => {
    // Both facts the fix relies on: codex-oauth cannot be fetched (its
    // catalog comes from the extension) and its registry is NOT
    // authoritative by construction.
    expect(canFetchModels(CODEX)).toBe(false)
    expect(hasAuthoritativeStaticRegistry(CODEX)).toBe(false)
    // anthropic keeps the static-only property.
    expect(canFetchModels('anthropic')).toBe(false)
    expect(hasAuthoritativeStaticRegistry('anthropic')).toBe(true)
  })
})

describe('getAvailableProviders: extension-fed provider with an unloaded catalog (Sourcery round 8)', () => {
  // The built-in branch iterates PROVIDER_META, so the extension-fed
  // provider is registered there for this test to reach the branch under
  // review (the exact shape the finding describes: registered, but its
  // catalog has not arrived).
  const codexMeta: ProviderMeta = {
    category: 'custom',
    displayName: 'Codex (Browser OAuth)',
    models: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(PROVIDER_META as Record<string, ProviderMeta>)[CODEX] = codexMeta
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === CODEX ? 'key' : null))
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getCachedModelsResult.mockReturnValue(null)
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    mocks.getModelsForProvider.mockReturnValue([])
    useSettingsStore.setState({
      providerType: CODEX,
      modelName: 'gpt-6-luna',
      pinnedModelsByProvider: { [CODEX]: ['gpt-6-luna'] },
      pinnedSeenByProvider: { [CODEX]: ['gpt-6-luna'] },
    })
  })

  afterEach(() => {
    delete (PROVIDER_META as Record<string, ProviderMeta>)[CODEX]
  })

  it('reports catalogStatus "failed" (unknown) when the codex-oauth registry is empty and the catalog never arrived', async () => {
    // codex-oauth has a saved key (registration) but the extension catalog
    // has NOT loaded: the registry is empty, canFetchModels() is false
    // (same as anthropic) — yet the registry is NOT authoritative for this
    // provider, so the status must be UNKNOWN, not a confirmed empty.
    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === CODEX)

    expect(provider).toBeDefined()
    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('failed')
  })

  it('does NOT sweep confirmed pins for an extension-fed provider with an unloaded catalog', async () => {
    // The 🟠 harm: an 'empty' classification let the stale-pin sweep remove
    // the previously confirmed pin while the extension catalog was merely
    // not-yet-loaded. 'failed' must keep the sweep frozen.
    const results = await useSettingsStore.getState().getAvailableProviders()

    expect(useSettingsStore.getState().pinnedModelsByProvider[CODEX]).toEqual(['gpt-6-luna'])
    expect(results.find((r) => r.providerType === CODEX)?.models.map((m) => m.id)).toEqual(['gpt-6-luna'])
  })

  it('reports catalogStatus "ready" when the extension-fed registry DOES carry a catalog', async () => {
    // A non-empty registry is a positive report: 'ready' in both provider
    // kinds. Only the EMPTY case differs.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }])

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === CODEX)

    expect(provider?.catalogStatus).toBe('ready')
    expect(provider?.authoritativeIds).toEqual(['gpt-6-luna'])
  })

  it('reports catalogStatus "ready" for a static-only provider with a non-empty registry (unchanged)', async () => {
    // anthropic has no /models endpoint (canFetchModels false) but its
    // registry IS authoritative by construction — the round-6 fix that made
    // its static models visible must keep working.
    const A = 'anthropic' as LLMProviderType
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === A ? 'key' : null))
    mocks.getModelsForProvider.mockReturnValue([{ id: 'claude-3-5-haiku-20241022', name: 'Haiku' }])
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

  it('reports catalogStatus "empty" (authoritative) for a static-only provider with an empty registry', async () => {
    // anthropic's registry is authoritative by construction: an empty one
    // IS the confirmed answer. (The extension-fed counterpart is exercised
    // above as 'failed'.)
    const A = 'anthropic' as LLMProviderType
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === A ? 'key' : null))
    mocks.getModelsForProvider.mockReturnValue([])
    useSettingsStore.setState({
      providerType: A,
      modelName: 'claude-3-5-haiku-20241022',
      pinnedModelsByProvider: { [A]: ['claude-3-5-haiku-20241022'] },
      pinnedSeenByProvider: { [A]: ['claude-3-5-haiku-20241022'] },
    })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === A)

    expect(provider?.catalogStatus).toBe('empty')
  })
})
