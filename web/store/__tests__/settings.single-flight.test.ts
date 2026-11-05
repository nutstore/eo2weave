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
import { registerDynamicProvider, unregisterDynamicProvider, type LLMProviderType } from '@/agent/providers/types'

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

  it('uses the gateway catalog failure state when no token is available', async () => {
    mocks.isLLMGatewayConfigured.mockReturnValue(true)
    mocks.loadApiKey.mockResolvedValue(null)
    registerDynamicProvider('llm-gateway',
      { baseURL: 'https://gateway.example/v1', modelName: '', headers: {} },
      { category: 'chinese', displayName: 'Nutstore AI', models: [], catalogStatus: 'failed' },
    )
    try {
      const result = await useSettingsStore.getState().getAvailableProviders()
      expect(result.find((provider) => provider.providerType === 'llm-gateway')?.catalogStatus).toBe('failed')
    } finally {
      unregisterDynamicProvider('llm-gateway')
    }
  })

  it('invalidates an in-flight discovery when the provider registry changes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    mocks.loadApiKey.mockImplementation(async () => {
      if (++calls === 1) await gate
      return null
    })
    const pending = useSettingsStore.getState().getAvailableProviders()
    await new Promise((resolve) => setTimeout(resolve, 0))
    registerDynamicProvider('custom-test',
      { baseURL: 'https://example.com/v1', modelName: '', headers: {} },
      { category: 'custom', displayName: 'Test', models: [] },
    )
    release()
    try {
      expect((await pending).runCurrent).toBe(false)
    } finally {
      unregisterDynamicProvider('custom-test')
    }
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
    expect(fresh.find((p) => p.providerType === P)?.models.map((m) => m.id)).toContain('m1')
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
    expect(recovery.length).toBeGreaterThan(0)
    expect(recovery.every((p) => p.current)).toBe(true)
  })

  it('reports runCurrent on every result and lets triggerProviderRefresh break the in-flight slot', async () => {
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm1', name: 'M1' }])

    // Hold the run mid-flight so a refresh can arrive while it is in flight —
    // the exact mutation-during-discovery overlap.
    let releaseBatch: (() => void) | null = null
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve })
    let batchCalls = 0
    mocks.loadApiKey.mockImplementation(async () => {
      batchCalls += 1
      if (batchCalls === 1) await batchGate
      return 'key'
    })

    const inFlight = useSettingsStore.getState().getAvailableProviders()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A mutation announces a refresh while the run is in flight: the run
    // captured PRE-mutation state, so the slot must be broken and the
    // refresh-driven reload must start a FRESH discovery (not JOIN the stale
    // one and receive it flagged current).
    useSettingsStore.getState().triggerProviderRefresh()
    const refreshed = useSettingsStore.getState().getAvailableProviders()
    releaseBatch!()
    const stale = await inFlight
    const fresh = await refreshed

    // The refresh caller did NOT receive the pre-mutation run's promise.
    expect(fresh).not.toBe(stale)
    // The old run still settles normally (read-only snapshot, no crash).
    expect(stale.length).toBeGreaterThan(0)
    // The fresh run is current and reports the run-level currency flag.
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((r) => r.runCurrent === true)).toBe(true)
    expect(fresh.find((r) => r.providerType === P)?.models.map((m) => m.id)).toContain('m1')
  })

  it('flags a superseded run via runCurrent even when it found ZERO providers', async () => {
    // Regression for Sourcery "Empty stale snapshots erase providers": an
    // empty superseded result carries no per-entry current:false marker —
    // the run-level flag must still say superseded so the UI gate
    // (shouldApplyProviderSnapshot) keeps the accepted snapshot.
    mocks.loadApiKey.mockImplementation(async () => null)
    mocks.getModelsForProvider.mockReturnValue([])

    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let batchCalls = 0
    mocks.loadApiKey.mockImplementation(async () => {
      batchCalls += 1
      if (batchCalls === 1) await firstGate
      return null
    })

    // Run 1 held mid-flight; run 2 starts (no keys → empty results) and
    // completes while run 1 is still awaiting, making run 1 superseded.
    const p1 = useSettingsStore.getState().getAvailableProviders()
    await new Promise((resolve) => setTimeout(resolve, 0))
    useSettingsStore.getState().triggerProviderRefresh()
    const p2 = useSettingsStore.getState().getAvailableProviders()
    releaseFirst!()
    const stale = await p1
    const fresh = await p2

    expect(stale.length).toBe(0)
    expect(fresh.length).toBe(0)
    // The empty result is still flagged as coming from a SUPERSEDED run.
    expect(stale.runCurrent).toBe(false)
    expect(fresh.runCurrent).toBe(true)
  })

  it('marks an in-flight discovery stale when its provider state is refreshed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.loadApiKey.mockImplementation(async (id: string) => { await gate; return id === P ? 'key' : null })
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm1', name: 'M1' }])
    const pending = useSettingsStore.getState().getAvailableProviders()
    await vi.waitFor(() => expect(mocks.loadApiKey).toHaveBeenCalled())
    useSettingsStore.getState().triggerProviderRefresh()
    release()
    expect((await pending).runCurrent).toBe(false)
  })

  it('discovers newly pinned models when a pin changes during discovery', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let first = true
    mocks.loadApiKey.mockImplementation(async (id: string) => {
      if (first) { first = false; await gate }
      return id === P ? 'key' : null
    })
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }])
    const pending = useSettingsStore.getState().getAvailableProviders()
    await vi.waitFor(() => expect(mocks.loadApiKey).toHaveBeenCalled())
    useSettingsStore.getState().pinModel(P, 'm2')
    const fresh = useSettingsStore.getState().getAvailableProviders()
    release()
    expect((await fresh).find((provider) => provider.providerType === P)?.models.map((model) => model.id)).toEqual(['m2'])
    expect((await pending).runCurrent).toBe(false)
  })
})
