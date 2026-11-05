/**
 * Single-flight coalescing of `getAvailableProviders` (issue #188 fix 2).
 *
 * Startup fires several overlapping discovery calls (ModelQuickSwitch mount,
 * WorkspaceLayout reconcile, the session reconciler, the gateway card).
 * Before coalescing, each call started its own run and bumped the generation
 * counter, so every earlier run landed superseded (current:false) and the
 * quick switcher — which drops superseded snapshots — stayed empty until the
 * last run finished. Concurrent callers must now JOIN one run: one
 * generation bump, one store reconciliation, identical results, all
 * current:true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getAvailableProviders() dynamic-imports these modules; they must be
// mocked BEFORE the store module is imported.
const mocks = vi.hoisted(() => ({
  loadApiKey: vi.fn<(id: string) => Promise<string | null>>(async () => null),
  isLLMGatewayConfigured: vi.fn(() => false),
  getModelsForProvider: vi.fn<(id: string) => Array<{ id: string; name: string }>>(() => []),
  getCachedModels: vi.fn<(type: string, key?: string) => Array<{ id: string; name: string }> | null>(() => null),
  getCachedModelsResult: vi.fn<(type: string, key?: string) => { error?: string } | null>(() => null),
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

const P = 'openai' as LLMProviderType

describe('getAvailableProviders single-flight coalescing (#188)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getCachedModelsResult.mockReturnValue(null)
    useSettingsStore.setState({
      providerType: P,
      modelName: 'm1',
      pinnedModelsByProvider: {},
      pinnedSeenByProvider: {},
      customProviders: [],
    })
  })

  afterEach(async () => {
    // Drain the in-flight slot so later suites start a fresh generation.
    await Promise.resolve()
  })

  it('joins concurrent callers into ONE run sharing the same generation', async () => {
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm1', name: 'M1' }])

    // Gate the built-in loadApiKey batch: every caller must reach it while
    // run 1 is still in flight — that is exactly the startup overlap.
    let releaseBatch: (() => void) | null = null
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve })
    let batchCalls = 0
    mocks.loadApiKey.mockImplementation(async (id: string) => {
      batchCalls += 1
      if (batchCalls === 1) await batchGate
      return id === P ? 'key' : null
    })

    const p1 = useSettingsStore.getState().getAvailableProviders()
    const p2 = useSettingsStore.getState().getAvailableProviders()
    const p3 = useSettingsStore.getState().getAvailableProviders()

    // Give each caller a turn to reach the store entry point; if runs were
    // NOT coalesced, the 2nd/3rd calls would have bumped the generation and
    // superseded run 1 before it released the gate.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseBatch!()

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    // All three callers got the SAME snapshot (same run), and it is current.
    expect(r1).toBe(r2)
    expect(r2).toBe(r3)
    expect(r1.length).toBeGreaterThan(0)
    expect(r1.every((p) => p.current)).toBe(true)

    // Exactly one generation was consumed: a follow-up call starts fresh
    // (slot cleared) and is also current — no stale supersede chain.
    const fresh = await useSettingsStore.getState().getAvailableProviders()
    expect(fresh.every((p) => p.current)).toBe(true)
  })

  it('runs a FRESH discovery after the previous run settles', async () => {
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm1', name: 'M1' }])

    const first = await useSettingsStore.getState().getAvailableProviders()
    const second = await useSettingsStore.getState().getAvailableProviders()

    // Sequential calls do NOT share the finished run's promise.
    expect(second).not.toBe(first)
    expect(second.every((p) => p.current)).toBe(true)
  })

  it('clears the in-flight slot when a run rejects, so callers retry cleanly', async () => {
    mocks.loadApiKey.mockImplementation(async () => {
      throw new Error('api-key store exploded')
    })

    const p1 = useSettingsStore.getState().getAvailableProviders()
    const p2 = useSettingsStore.getState().getAvailableProviders()
    await expect(p1).rejects.toThrow('api-key store exploded')
    // Coalesced caller observes the same rejection (same run).
    await expect(p2).rejects.toThrow('api-key store exploded')

    // Slot cleared: the next call starts a new run instead of replaying the
    // rejection. It succeeds because loadApiKey no longer throws.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    const recovery = await useSettingsStore.getState().getAvailableProviders()
    expect(recovery.every((p) => p.current)).toBe(true)
  })
})
