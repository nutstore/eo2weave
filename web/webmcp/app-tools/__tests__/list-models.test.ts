/**
 * list_models cache regression tests (issue #247, scope item 3).
 *
 * `list_models` used to read `getCachedModels()` — which returns
 * `ModelInfo[] | null` — as if it were the `{ models, source }` cache record,
 * so the live catalog was never surfaced and every answer said "static".
 * These tests pin the corrected contract: read the cache through
 * getCachedModelsResult() (provider-scoped key first, then the unqualified
 * entry) and fall back to the static catalog when there is no usable entry.
 *
 * Kept in its own file so the module mock applies to the handlers' dynamic
 * `import('@/agent/providers/model-store')` before that module is loaded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, initAppToolDeps } from '../handlers'
import { makeDeps } from './fixtures'

const cache = vi.hoisted(() => ({
  scoped: {} as Record<string, unknown>,
  unscoped: null as unknown,
}))

vi.mock('@/agent/providers/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/model-store')>()
  return {
    ...actual,
    getCachedModels: () => null,
    getCachedModelsResult: (providerType: string, providerKey?: string) =>
      (providerKey ? cache.scoped[`${providerType}:${providerKey}`] ?? null : cache.unscoped),
  }
})

function dynamicEntry(ids: string[], source: 'dynamic' | 'static' = 'dynamic') {
  return {
    models: ids.map((id) => ({ id, name: id.toUpperCase(), capabilities: ['text'] })),
    source,
    fetchedAt: 1,
  }
}

function listModels(providerId = 'codex-oauth') {
  return handlers.list_models({ providerId }).then((r) => JSON.parse(r.content))
}

/** Provider whose static catalog is non-empty (the fallback path needs one). */
const STATIC_PROVIDER = 'openai'

describe('list_models cache handling', () => {
  beforeEach(() => {
    initAppToolDeps(makeDeps())
    cache.scoped = {}
    cache.unscoped = null
  })

  it('serves the provider-scoped catalog the settings UI cached', async () => {
    cache.scoped['codex-oauth:codex-oauth'] = dynamicEntry(['cached-model'])
    const result = await listModels()
    expect(result.source).toBe('dynamic')
    expect(result.models).toEqual([
      { id: 'cached-model', name: 'CACHED-MODEL', contextWindow: null, pinned: false },
    ])
  })

  it('prefers the provider-scoped entry over the unqualified one', async () => {
    cache.scoped['codex-oauth:codex-oauth'] = dynamicEntry(['scoped-model'])
    cache.unscoped = dynamicEntry(['unqualified-model'])
    const result = await listModels()
    expect(result.models.map((m: { id: string }) => m.id)).toEqual(['scoped-model'])
  })

  it('serves the unqualified cached catalog when there is no scoped entry', async () => {
    cache.unscoped = dynamicEntry(['cached-model'])
    const result = await listModels()
    expect(result.source).toBe('dynamic')
    expect(result.models.map((m: { id: string }) => m.id)).toEqual(['cached-model'])
  })

  it('flags pinned models from the cached catalog', async () => {
    cache.unscoped = dynamicEntry(['gpt-5.4'])
    const result = await listModels()
    expect(result.models[0]).toMatchObject({ id: 'gpt-5.4', pinned: true })
  })

  it('falls back to the static catalog when nothing is cached', async () => {
    const result = await listModels(STATIC_PROVIDER)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models.map((m: { id: string }) => m.id)).toContain('gpt-4o')
  })

  it('falls back to the static catalog when the cached entry holds no models', async () => {
    cache.unscoped = { models: [], source: 'dynamic', fetchedAt: 1 }
    const result = await listModels(STATIC_PROVIDER)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
  })

  it('does not throw when a persisted cache entry is malformed', async () => {
    cache.unscoped = { models: 'not-an-array', source: 'dynamic', fetchedAt: 1 }
    const result = await listModels(STATIC_PROVIDER)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
  })

  it('keeps rejecting an omitted providerId', async () => {
    const result = JSON.parse((await handlers.list_models({})).content)
    expect(result.error).toMatch(/providerId is required/)
  })
})
