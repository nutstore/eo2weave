/**
 * list_models cache regression tests (issue #247, scope item 3).
 *
 * `list_models` used to read `getCachedModels()` — which returns
 * `ModelInfo[] | null` — as if it were the `{ models, source }` cache record,
 * so the live catalog was never surfaced and every answer said "static".
 * These tests pin the corrected contract: read the cache through
 * getCachedModelsResult() and fall back to the static catalog when there is
 * no usable cached entry.
 *
 * Kept in its own file so the module mock applies to the handlers' dynamic
 * `import('@/agent/providers/model-store')` before that module is loaded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, initAppToolDeps } from '../handlers'
import { makeDeps } from './fixtures'

interface CachedModels {
  models: Array<{ id: string; name: string; capabilities: string[] }>
  source: 'dynamic' | 'static'
  fetchedAt: number
  error?: string
}

const cache = vi.hoisted(() => ({ value: null as CachedModels | null }))

vi.mock('@/agent/providers/model-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/model-store')>()
  return {
    ...actual,
    getCachedModels: () => null,
    getCachedModelsResult: () => cache.value,
  }
})

function listModels(providerId = 'codex-oauth') {
  return handlers.list_models({ providerId }).then((r) => JSON.parse(r.content))
}

/** Provider whose static catalog is non-empty (the fallback path needs one). */
const STATIC_PROVIDER = 'openai'

describe('list_models cache handling', () => {
  beforeEach(() => {
    initAppToolDeps(makeDeps())
    cache.value = null
  })

  it('serves the cached catalog and its source when the cache has models', async () => {
    cache.value = {
      models: [{ id: 'cached-model', name: 'Cached Model', capabilities: ['text'] }],
      source: 'dynamic',
      fetchedAt: 1,
    }
    const result = await listModels()
    expect(result.source).toBe('dynamic')
    expect(result.models).toEqual([
      { id: 'cached-model', name: 'Cached Model', contextWindow: null, pinned: false },
    ])
  })

  it('flags pinned models from the cached catalog', async () => {
    cache.value = {
      models: [{ id: 'gpt-5.4', name: 'GPT 5.4', capabilities: ['text'] }],
      source: 'dynamic',
      fetchedAt: 1,
    }
    const result = await listModels()
    expect(result.models[0]).toMatchObject({ id: 'gpt-5.4', pinned: true })
  })

  it('falls back to the static catalog when nothing is cached', async () => {
    cache.value = null
    const result = await listModels(STATIC_PROVIDER)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
    expect(result.models.map((m: { id: string }) => m.id)).toContain('gpt-4o')
  })

  it('falls back to the static catalog when the cached entry holds no models', async () => {
    cache.value = { models: [], source: 'dynamic', fetchedAt: 1 }
    const result = await listModels(STATIC_PROVIDER)
    expect(result.source).toBe('static')
    expect(result.models.length).toBeGreaterThan(0)
  })

  it('keeps rejecting an omitted providerId', async () => {
    const result = JSON.parse((await handlers.list_models({})).content)
    expect(result.error).toMatch(/providerId is required/)
  })
})
