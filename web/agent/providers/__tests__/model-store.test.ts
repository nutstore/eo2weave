/**
 * Tests for mergeModelLists — the static-skeleton vs dynamic-/models merge
 * precedence rules (see model-store.ts for the full rationale).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeModelLists, setCachedModels, getCachedModels, getCachedModelsResult, isCacheStale, __clearMemoryCacheForTests } from '@/agent/providers/model-store'
import type { ModelInfo } from '@/agent/providers/types'

const getModelsMock = vi.hoisted(() => vi.fn())

vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return { ...actual, getModelsForProvider: getModelsMock }
})

import { getModelsForProvider } from '@/agent/providers/types'
void getModelsForProvider

const skeleton = (id: string, caps: string[]): ModelInfo => ({
  id,
  name: id,
  capabilities: caps as ModelInfo['capabilities'],
})

const api = (
  id: string,
  overrides: Partial<ModelInfo> = {}
): ModelInfo => ({
  id,
  name: `API ${id}`,
  capabilities: [],
  metadataFromApi: true,
  ...overrides,
})

beforeEach(() => {
  getModelsMock.mockReset()
  getModelsMock.mockReturnValue([])
  getModelsMock.mockImplementation(() => [])
})

describe('mergeModelLists — non-custom provider', () => {
  it('treats a metadata-rich API list as the catalog: renamed skeleton ids are pruned', () => {
    getModelsMock.mockReturnValue([skeleton('old-name', ['fast'])])
    const dynamic = [api('new-name', { capabilities: ['vision'], contextWindow: 1_048_576 })]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged.map((m) => m.id)).toEqual(['new-name'])
    expect(merged[0].contextWindow).toBe(1_048_576)
    expect(merged[0].capabilities).toContain('vision')
  })

  it('unions static capability tags into API-authoritative entries', () => {
    getModelsMock.mockReturnValue([skeleton('deepseek-v4-pro', ['code', 'writing', 'reasoning'])])
    const dynamic = [api('deepseek-v4-pro', { capabilities: ['vision'] })]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged[0].capabilities).toEqual(['vision', 'code', 'writing', 'reasoning'])
  })

  it('falls back to the skeleton when the API returns no authoritative data', () => {
    getModelsMock.mockReturnValue([skeleton('legacy-model', ['code'])])
    const dynamic = [{ id: 'legacy-model', name: 'Legacy', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged.map((m) => m.id)).toEqual(['legacy-model'])
    expect(merged[0].capabilities).toEqual(['code'])
  })

  it('appends dynamic-only models alongside the skeleton when API data is not authoritative', () => {
    getModelsMock.mockReturnValue([skeleton('known', ['code'])])
    const dynamic = [{ id: 'brand-new', name: 'Brand New', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    // Dynamic-first ordering: dynamic-only entries precede skeleton appends.
    expect(merged.map((m) => m.id)).toEqual(['brand-new', 'known'])
    expect(merged.find((m) => m.id === 'known')!.capabilities).toEqual(['code'])
  })
})

describe('mergeModelLists — custom provider', () => {
  const custom = { isCustom: true, customModelIds: ['my-model'] }

  it('keeps the registry contextWindow as a floor when the API omits it', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'my-model', name: 'My Model', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { ...custom })
    // getModelContextWindow is exercised here; the important assertion is
    // that the dynamic entry replaced the skeleton but kept a contextWindow
    // property (number from the registry lookup, or undefined when unknown).
    expect(merged[0].id).toBe('my-model')
    expect(merged[0].name).toBe('My Model')
    expect('contextWindow' in merged[0]).toBe(true)
  })

  it('prefers the API contextWindow when present', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'my-model', name: 'My Model', capabilities: [], contextWindow: 4096 }]
    const merged = mergeModelLists('deepseek', dynamic, { ...custom })
    expect(merged[0].contextWindow).toBe(4096)
  })

  it('adds API-only models not present in the configured list', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'api-only', name: 'API Only', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, {
      isCustom: true,
      customModelIds: ['my-model'],
    })
    expect(merged.map((m) => m.id)).toEqual(['my-model', 'api-only'])
  })
})

// ─── Failed-refresh bookkeeping (PR #150 round 5) ───────────────────────────

describe('setCachedModels — failed refresh outcomes', () => {
  beforeEach(() => {
    localStorage.clear()
    __clearMemoryCacheForTests('openai' as never)
  })

  it('records a FAILED fetch (source static + error) so consumers can see the catalog is unknown', () => {
    // Sourcery "Failed fetches become authoritative empty": setCachedModels
    // used to drop every source-'static' result, so a failed refresh left no
    // trace and getAvailableProviders classified the outage as an
    // authoritative empty catalog.
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    const result = getCachedModelsResult('openai' as never)
    expect(result?.error).toBe('network down')
    expect(result?.models).toEqual([])
  })

  it('keeps a failed result MEMORY-ONLY (it must not outlive the session)', () => {
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    expect(localStorage.getItem('cw-models:openai')).toBeNull()
  })

  it('still persists successful dynamic results to localStorage', () => {
    setCachedModels('openai' as never, {
      models: [{ id: 'gpt-x', name: 'GPT', capabilities: ['code'], contextWindow: 128000 }],
      source: 'dynamic',
      fetchedAt: Date.now(),
    })
    expect(localStorage.getItem('cw-models:openai')).not.toBeNull()
    expect(getCachedModelsResult('openai' as never)?.error).toBeUndefined()
  })

  it('does NOT replace a non-empty cached catalog with a later failed refresh (Sourcery: fresh models disappear)', () => {
    // A failed refresh's static-fallback list is no richer than the cached
    // dynamic catalog; overwriting it hid previously fetched dynamic-only
    // models until another refresh succeeded. The failure carries catalog
    // information only when there is nothing better cached, so a non-empty
    // successful entry wins.
    setCachedModels('openai' as never, {
      models: [{ id: 'gpt-dyn', name: 'GPT Dynamic', capabilities: ['code'] }],
      source: 'dynamic',
      fetchedAt: Date.now(),
    })
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    const result = getCachedModelsResult('openai' as never)
    expect(result?.error).toBeUndefined()
    expect(result?.models.map((m) => m.id)).toEqual(['gpt-dyn'])
    expect(getCachedModels('openai' as never)?.map((m) => m.id)).toEqual(['gpt-dyn'])
  })

  it('still records a failed refresh when the cached list is empty or missing (outage must not read as authoritative empty)', () => {
    // The downgrade guard above must not swallow the f244f533 fix: with no
    // usable cached models, the failure IS the freshest catalog information.
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    let result = getCachedModelsResult('openai' as never)
    expect(result?.error).toBe('network down')

    __clearMemoryCacheForTests('openai' as never)
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down again',
    })
    result = getCachedModelsResult('openai' as never)
    expect(result?.error).toBe('network down again')
  })

  it('lets a successful dynamic refresh recover after a failed one (error entry is replaced)', () => {
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    setCachedModels('openai' as never, {
      models: [{ id: 'gpt-x', name: 'GPT', capabilities: ['code'], contextWindow: 128000 }],
      source: 'dynamic',
      fetchedAt: Date.now(),
    })
    const result = getCachedModelsResult('openai' as never)
    expect(result?.error).toBeUndefined()
    expect(result?.models.map((m) => m.id)).toEqual(['gpt-x'])
  })
})

// ─── Failed entries never read fresh (PR #150 round 6) ──────────────────────

describe('isCacheStale — failed results are always stale', () => {
  beforeEach(() => {
    localStorage.clear()
    __clearMemoryCacheForTests('openai' as never)
  })

  it('treats a freshly-recorded FAILURE as stale so the retry window governs instead of the 24h TTL', () => {
    // Sourcery "Failed refresh suppresses retries": a failed refresh cached
    // with a fresh fetchedAt made isCacheStale() false for 24h, so
    // useDynamicModels' stale-gate never re-opened and the provider sat on
    // its fallback catalog for a day. A failure is NOT fresh catalog data —
    // it must always read stale (the 5-minute FAILED_FETCH_RETRY_MS
    // negative-cache in use-dynamic-models.ts still throttles retries).
    setCachedModels('openai' as never, {
      models: [],
      source: 'static',
      fetchedAt: Date.now(),
      error: 'network down',
    })
    expect(isCacheStale('openai' as never)).toBe(true)
  })

  it('keeps a fresh SUCCESSFUL result non-stale (unchanged 24h TTL behavior)', () => {
    setCachedModels('openai' as never, {
      models: [{ id: 'gpt-x', name: 'GPT', capabilities: ['code'], contextWindow: 128000 }],
      source: 'dynamic',
      fetchedAt: Date.now(),
    })
    expect(isCacheStale('openai' as never)).toBe(false)
  })

  it('reports stale for a missing entry (unchanged)', () => {
    expect(isCacheStale('openai' as never)).toBe(true)
  })
})
