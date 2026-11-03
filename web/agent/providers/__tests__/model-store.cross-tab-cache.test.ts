/**
 * Regression test for the PR #150 Sourcery round-8 🟡 finding "Older tab
 * overwrites newer disk cache": `memoryCache` is per-tab, so the existing
 * fetchedAt ordering guard cannot see another tab's localStorage write.
 * Simulate the cross-tab interleaving by writing the "other tab's" newer
 * entry straight to localStorage, then applying this tab's OLDER refresh:
 * the persisted catalog must keep the newer entry (and this tab adopts it).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setCachedModels,
  getCachedModels,
  getCachedModelsResult,
  __clearMemoryCacheForTests,
} from '@/agent/providers/model-store'

const model = (id: string): { id: string; name: string; capabilities: ['code'] } => ({
  id,
  name: id,
  capabilities: ['code'],
})

// Write DIRECTLY to localStorage, bypassing the per-tab memory cache —
// exactly what another tab's writeToDisk leaves behind.
const seedDisk = (entry: unknown): void => {
  localStorage.setItem('cw-models:openai', JSON.stringify(entry))
}

const readDisk = (): { models: Array<{ id: string }>; fetchedAt: number; error?: string } =>
  JSON.parse(localStorage.getItem('cw-models:openai')!)

describe('setCachedModels — cross-tab disk ordering (Sourcery round 8)', () => {
  beforeEach(() => {
    localStorage.clear()
    __clearMemoryCacheForTests('openai' as never)
  })

  afterEach(() => {
    localStorage.clear()
    __clearMemoryCacheForTests('openai' as never)
  })

  it('does NOT overwrite a newer disk entry written by another tab with a late older refresh', () => {
    const t0 = Date.now()
    // Tab B started earlier, tab A later. Tab A's refresh completes first
    // and persists the NEWER catalog (bypassing this tab's memory cache —
    // simulate its write landing in shared localStorage only).
    seedDisk({
      models: [model('gpt-tab-b-new'), model('gpt-newer')],
      source: 'dynamic',
      fetchedAt: t0 + 1000,
    })

    // Tab B's OLDER refresh settles last and calls setCachedModels: its own
    // memory cache is empty (per-tab), so only the disk guard can save the
    // newer entry.
    setCachedModels('openai' as never, {
      models: [model('gpt-old')],
      source: 'dynamic',
      fetchedAt: t0,
    })

    // The persisted catalog is still tab A's newer snapshot.
    expect(readDisk().models.map((m) => m.id)).toEqual(['gpt-tab-b-new', 'gpt-newer'])
    expect(readDisk().fetchedAt).toBe(t0 + 1000)
    // This tab adopts the fresher disk entry so its session reads the same
    // data a reload would.
    expect(getCachedModels('openai' as never)?.map((m) => m.id)).toEqual(['gpt-tab-b-new', 'gpt-newer'])
    expect(getCachedModelsResult('openai' as never)?.fetchedAt).toBe(t0 + 1000)
  })

  it('still lets a NEWER refresh replace an older disk entry (guard must not block forward progress)', () => {
    const t0 = Date.now()
    seedDisk({ models: [model('gpt-old')], source: 'dynamic', fetchedAt: t0 })

    setCachedModels('openai' as never, {
      models: [model('gpt-new')],
      source: 'dynamic',
      fetchedAt: t0 + 1000,
    })

    expect(readDisk().models.map((m) => m.id)).toEqual(['gpt-new'])
    expect(getCachedModels('openai' as never)?.map((m) => m.id)).toEqual(['gpt-new'])
  })

  it('does not adopt a disk entry whose cached list carries an error into memory on a skipped write', () => {
    // The cross-tab guard compares against successful disk entries only: a
    // disk FAILURE (memory-only by design in this tab, but a theoretical
    // disk artifact) must not block or seed this tab's successful refresh.
    const t0 = Date.now()
    seedDisk({ models: [], source: 'static', fetchedAt: t0, error: 'network down' })

    setCachedModels('openai' as never, {
      models: [model('gpt-fresh')],
      source: 'dynamic',
      fetchedAt: t0 - 500,
    })

    expect(readDisk().models.map((m) => m.id)).toEqual(['gpt-fresh'])
    expect(readDisk().error).toBeUndefined()
  })
})
