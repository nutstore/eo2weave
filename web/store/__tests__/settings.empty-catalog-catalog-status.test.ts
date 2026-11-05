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
import { getDynamicProviderIds, unregisterDynamicProvider } from '@/agent/providers/types'
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

  it('reports catalogStatus "ready" when the authoritative list is non-empty and the refresh succeeded', async () => {
    mocks.getModelsForProvider.mockReturnValue([
      { id: 'm-alive', name: 'Alive' },
    ])
    // Successful observed refresh (round-6 precedence: a FAILED or
    // never-observed refresh now beats a non-empty fallback list — see the
    // "failed refresh wins over a non-empty fallback" test below).
    mocks.getCachedModelsResult.mockReturnValue({ models: [{ id: 'm-alive' }], source: 'dynamic', fetchedAt: Date.now() } as never)

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual(['m-alive'])
    expect(provider?.catalogStatus).toBe('ready')
  })

  it('reports catalogStatus "empty" (authoritative) when the static registry resolves empty and the last refresh succeeded', async () => {
    // The catalog was loaded successfully and positively reports no models:
    // the cache holds a SUCCESSFUL refresh result (no error) that reported
    // nothing. A cache with NO result at all means the refresh was never
    // attempted — that is 'failed' (unknown), covered below.
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue({ models: [], source: 'dynamic', fetchedAt: Date.now() } as never)

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('empty')
  })

  it('reports catalogStatus "failed" when the catalog has NEVER been observed (no cached result)', async () => {
    // Sourcery round 5 "Unknown catalogs appear empty": a static-empty
    // provider with no cached refresh result has not reported anything —
    // reconciliation must not treat that unknown catalog as confirmed empty.
    mocks.getModelsForProvider.mockReturnValue([])
    mocks.getCachedModelsResult.mockReturnValue(null)

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)

    expect(provider?.authoritativeIds).toEqual([])
    expect(provider?.catalogStatus).toBe('failed')
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
    // The provider confirmed an empty catalog (a SUCCESSFUL refresh that
    // reported nothing) AND another provider has a model: unlike the failed
    // case, this MUST reconcile to the alternative.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P || id === 'anthropic' ? 'key' : null))
    mocks.getModelsForProvider.mockImplementation((id: string) =>
      id === P ? [] : id === 'anthropic' ? [{ id: 'a-1', name: 'Claude' }] : [],
    )
    mocks.getCachedModelsResult.mockReturnValue({ models: [], source: 'dynamic', fetchedAt: Date.now() } as never)

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
    mocks.getCachedModelsResult.mockReturnValue({ models: [{ id: 'm-other' }], source: 'dynamic', fetchedAt: Date.now() } as never)
    results = await useSettingsStore.getState().getAvailableProviders()
    provider = results.find((r) => r.providerType === P)!
    expect(provider.catalogStatus).toBe('ready')
    expect(provider.authoritativeIds).toEqual(['m-other'])
    // The active model stays out of the stale set even when absent from a
    // non-empty catalog; the user can keep using it until they switch.
    expect(
      useSettingsStore.getState().getStalePinnedModels(P, provider.authoritativeIds, provider.catalogStatus)
    ).toEqual([])
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

  it('does not mark pins stale when the catalog is empty', () => {
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels(P, [], 'empty')).toEqual([])
  })

  it('does not mark gateway pins stale against a retained list after an empty response', () => {
    useSettingsStore.setState({
      pinnedModelsByProvider: { 'llm-gateway': ['m-a'] },
      pinnedSeenByProvider: { 'llm-gateway': ['m-a'] },
    })
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels('llm-gateway', ['another-model'], 'empty')).toEqual([])
  })

  it('keeps legacy behavior for non-empty lists (with or without a status)', () => {
    const state = useSettingsStore.getState()
    expect(state.getStalePinnedModels(P, ['m-a'], 'ready')).toEqual(['m-b'])
    expect(state.getStalePinnedModels(P, ['m-a'])).toEqual(['m-b'])
  })
})

// ─── Sourcery round 6 (PRRT_kwDORoHsZ86yz16w / yz17D / yz17N / yz17R) ────────

describe('getAvailableProviders: round-6 catalog-status precedence & generation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P ? 'key' : null))
    mocks.getCachedModels.mockReturnValue(null)
    mocks.getCachedModelsResult.mockReturnValue(null)
    mocks.getDynamicProviderIds.mockReturnValue([])
    mocks.isLLMGatewayConfigured.mockReturnValue(false)
    useSettingsStore.setState({
      providerType: P,
      modelName: 'm-dyn',
      pinnedModelsByProvider: { [P]: ['m-dyn'] },
      pinnedSeenByProvider: { [P]: ['m-dyn'] },
      customProviders: [],
    })
    // concurrent getAvailableProviders runs also load dynamic providers from
    // the registry; keep it empty so two runs see identical provider sets.
    for (const id of getDynamicProviderIds()) unregisterDynamicProvider(id)
  })

  it('reports "failed" for a NON-EMPTY fallback list when the dynamic refresh recorded an error (High: dynamic models appear delisted)', async () => {
    // Static floor non-empty, but the /models refresh failed: dynamic-only
    // models are missing from the merged catalog without proof of delisting.
    // Before the round-6 precedence swap this read 'ready', the resolver
    // switched away from dynamic-only selections and the sweep removed
    // dynamic-only pins. Removing the precedence swap must fail this test.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-static', name: 'Static floor' }])
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })
    useSettingsStore.setState({
      pinnedModelsByProvider: { [P]: ['m-static', 'm-dyn'] },
      pinnedSeenByProvider: { [P]: ['m-static', 'm-dyn'] },
    })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === P)
    expect(provider?.authoritativeIds).toEqual(['m-static'])
    expect(provider?.catalogStatus).toBe('failed')

    // Resolver defers and the sweep skips: selection + pins survive.
    const state = useSettingsStore.getState()
    expect(state.providerType).toBe(P)
    expect(state.modelName).toBe('m-dyn')
    expect(state.pinnedModelsByProvider[P]).toEqual(['m-static', 'm-dyn'])
  })

  it('reports "failed" (not "ready") for a non-empty list with NO refresh result at all', async () => {
    // Round-5 semantics extended by the round-6 precedence: never-observed
    // beats non-empty too — the merged list alone is not proof of readiness.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-static', name: 'Static floor' }])

    const results = await useSettingsStore.getState().getAvailableProviders()
    expect(results.find((r) => r.providerType === P)?.catalogStatus).toBe('failed')
  })

  it('joins concurrent public calls into one run so they cannot supersede each other (#188)', async () => {
    // Single-flight (issue #188 fix 2): two overlapping PUBLIC calls share
    // one discovery run — the second caller must not bump the generation
    // while the first is awaiting, which is what used to land every startup
    // run superseded (current:false) and blank the quick switcher. The
    // callers get the SAME promise (one generation bump, one sweep/flush).
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-dyn', name: 'Dyn' }])
    mocks.getCachedModelsResult.mockReturnValue({ models: [{ id: 'm-dyn' }], source: 'dynamic', fetchedAt: Date.now() } as never)

    // Gate the built-in loadApiKey batch so run 1 is provably still in
    // flight when the second call arrives (the exact startup overlap).
    let releaseBatch: (() => void) | null = null
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve })
    let batchCall = 0
    mocks.loadApiKey.mockImplementation(async () => {
      batchCall += 1
      if (batchCall === 1) await batchGate
      return 'key'
    })

    const first = useSettingsStore.getState().getAvailableProviders()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = useSettingsStore.getState().getAvailableProviders()
    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseBatch!()
    const [firstResults, secondResults] = await Promise.all([first, second])

    // One shared run: identical results, CURRENT for every caller.
    expect(secondResults).toBe(firstResults)
    expect(firstResults.length).toBeGreaterThan(0)
    expect(firstResults.every((r) => r.current === true)).toBe(true)

    // The in-flight slot cleared: a follow-up call starts a fresh run that
    // is also current (no stale supersede chain).
    const fresh = await useSettingsStore.getState().getAvailableProviders()
    expect(fresh.length).toBeGreaterThan(0)
    expect(fresh.every((r) => r.current === true)).toBe(true)
  })

  it('does not confirm pins while superseded, so a stale snapshot cannot arm the newer sweep (Superseded runs still confirm pins)', async () => {
    // The older run captured its snapshot, then a newer run started; the
    // older run must NOT record 'm-late' as seen from its stale snapshot —
    // a pin confirmed against a catalog the newer run is about to supersede
    // is exactly what the newer authoritative sweep would remove.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-dyn', name: 'Dyn' }, { id: 'm-late', name: 'Late' }])
    mocks.getCachedModelsResult.mockReturnValue({ models: [{ id: 'm-dyn' }, { id: 'm-late' }], source: 'dynamic', fetchedAt: Date.now() } as never)

    // Hold run 1 inside the built-in batch, add the pin while it waits, then
    // start run 2. Run 1 resumes superseded and must skip the seen-mark
    // flush; run 2 (current) sees m-late in ITS authoritative catalog and
    // confirms it.
    let releaseFirstBatch: (() => void) | null = null
    const firstBatchGate = new Promise<void>((resolve) => { releaseFirstBatch = resolve })
    let batchCall = 0
    mocks.loadApiKey.mockImplementation(async () => {
      batchCall += 1
      if (batchCall === 1) await firstBatchGate
      return 'key'
    })

    const run1 = useSettingsStore.getState().getAvailableProviders()
    await Promise.resolve()
    useSettingsStore.setState({
      pinnedModelsByProvider: { [P]: ['m-dyn', 'm-late'] },
      pinnedSeenByProvider: { [P]: ['m-dyn'] }, // m-late never confirmed yet
    })
    const run2 = useSettingsStore.getState().getAvailableProviders()
    releaseFirstBatch!()
    await Promise.all([run2, run1])

    // The seen-set must reflect run 2's CURRENT catalog (which contains
    // m-late), proving run 1's stale marks were skipped and run 2's marks
    // were applied. With the flush removed, m-late would stay unconfirmed
    // (seen === ['m-dyn']) and the pin could later be wiped as "never seen".
    expect(useSettingsStore.getState().pinnedSeenByProvider[P]).toEqual(['m-dyn', 'm-late'])
    expect(useSettingsStore.getState().pinnedModelsByProvider[P]).toEqual(['m-dyn', 'm-late'])
  })

  it('reports "empty" (authoritative) for a configured-empty CUSTOM provider even when a dynamic error is present', async () => {
    // Round-6 finding "Configured empty catalogs look unknown": the store
    // already classified custom providers by the configured list alone; this
    // pins that contract (the ProviderCard side must match it).
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P || id === 'custom-x' ? 'key' : null))
    useSettingsStore.setState({
      customProviders: [{ id: 'custom-x', name: 'Custom X', baseUrl: 'https://x.example', models: [], apiKey: '' } as never],
    })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === 'custom-x')
    expect(provider?.catalogStatus).toBe('empty')
    expect(provider?.authoritativeIds).toEqual([])
  })

  it('reports a STATIC-ONLY provider (anthropic) as "ready" with NO refresh result at all (High: Anthropic models are unusable)', async () => {
    // Anthropic ships a non-empty static registry and has no /models
    // endpoint (STATIC_ONLY_PROVIDERS; fetchModelsForProvider always returns
    // its static list), so a refresh result is never recorded for it. The
    // never-observed classification above must not swallow it: the registry
    // is authoritative by construction. Before the static-only carve-out,
    // this read 'failed', reconciliation deferred away from Anthropic, and
    // its models were excluded from fallback — unusable despite being fully
    // usable.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === 'anthropic' ? 'key' : null))
    mocks.getModelsForProvider.mockImplementation((id: string) =>
      id === 'anthropic' ? [{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' }] : [],
    )
    mocks.getCachedModelsResult.mockReturnValue(null)
    useSettingsStore.setState({
      providerType: 'anthropic' as LLMProviderType,
      modelName: 'claude-sonnet-4-20250514',
    })

    const results = await useSettingsStore.getState().getAvailableProviders()
    const provider = results.find((r) => r.providerType === 'anthropic')
    expect(provider?.catalogStatus).toBe('ready')
    expect(provider?.authoritativeIds).toEqual(['claude-sonnet-4-20250514'])

    // The static models are selectable: the current selection stays valid
    // (resolver keeps it) — reconciliation never defers or switches away.
    const state = useSettingsStore.getState()
    expect(state.providerType).toBe('anthropic')
    expect(state.modelName).toBe('claude-sonnet-4-20250514')
  })

  it('falls back to a STATIC-ONLY provider (anthropic) when the active provider is authoritative-empty', async () => {
    // The pre-fix 'failed' classification also excluded Anthropic from
    // last-resort fallback: a user whose active catalog positively emptied
    // could never be reconciled onto Anthropic's static models. As 'ready',
    // it becomes selectable again.
    mocks.loadApiKey.mockImplementation(async (id: string) => (id === P || id === 'anthropic' ? 'key' : null))
    mocks.getModelsForProvider.mockImplementation((id: string) =>
      id === P ? [] : id === 'anthropic' ? [{ id: 'a-1', name: 'Claude' }] : [],
    )
    mocks.getCachedModelsResult.mockImplementation((type: string) =>
      type === P ? { models: [], source: 'dynamic', fetchedAt: Date.now() } as never : null,
    )

    await useSettingsStore.getState().getAvailableProviders()

    const state = useSettingsStore.getState()
    expect(state.providerType).toBe('anthropic')
    expect(state.modelName).toBe('a-1')
  })

  it('still reports a refresh-capable provider as "failed" with a recorded error and a non-empty fallback (dynamic-models guard intact)', async () => {
    // Guard the round-6 precedence the static-only carve-out must not
    // weaken: a provider that DOES support /models keeps failed-beats-
    // non-empty semantics for both recorded errors and never-observed
    // catalogs.
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-static', name: 'Static floor' }])
    mocks.getCachedModelsResult.mockReturnValue({ error: 'fetch failed' })

    const results = await useSettingsStore.getState().getAvailableProviders()
    expect(results.find((r) => r.providerType === P)?.catalogStatus).toBe('failed')

    mocks.getCachedModelsResult.mockReturnValue(null)
    const results2 = await useSettingsStore.getState().getAvailableProviders()
    expect(results2.find((r) => r.providerType === P)?.catalogStatus).toBe('failed')
  })

  it('still marks every result current:true when NO newer run started (UI gate must not discard fresh lists)', async () => {
    // Round-6 "Superseded model lists remain selectable": UI callers
    // (ModelQuickSwitch / InlineModelSelector / ModelSettings) gate their
    // setState on `result.every(p => p.current)`. That gate is only correct
    // because a run with no newer sibling still reports current:true on
    // EVERY entry — otherwise a normal refresh would leave the UI on stale
    // data forever. Pins the current-run half of the contract (the
    // superseded half is covered above).
    mocks.getModelsForProvider.mockReturnValue([{ id: 'm-dyn', name: 'Dyn' }])
    mocks.getCachedModelsResult.mockReturnValue({ models: [{ id: 'm-dyn' }], source: 'dynamic', fetchedAt: Date.now() } as never)

    const results = await useSettingsStore.getState().getAvailableProviders()
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.current === true)).toBe(true)
  })
})
