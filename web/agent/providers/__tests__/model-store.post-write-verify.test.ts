import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression test for the PR #150 Sourcery round-10 finding "older tab still
 * overwrites newer cache".
 *
 * The round-8 guard reads the disk BEFORE the write, so two tabs whose
 * refreshes overlap can both pass it:
 *
 *   disk holds fetchedAt=50; tab A (fetchedAt=100) and tab B (fetchedAt=200)
 *   both read 50 → both pass the `100 < 50`/`200 < 50` checks → B writes 200
 *   → A writes 100 LAST → the shared cache reverts to a stale snapshot.
 *
 * localStorage has no cross-tab compare-and-swap, so the fix is a post-write
 * verification: the writer re-reads the disk and, if a NEWER entry beat it to
 * storage, restores that newer entry (and adopts it in memory).
 *
 * Tabs are separate JS contexts, so the interleaving is simulated the same way
 * the round-8 test does it: the "other tab's" newer write happens directly on
 * the shared localStorage BETWEEN this tab's read (inside setCachedModels) and
 * verification — here, by a localStorage mock whose setItem injects the other
 * tab's write on the FIRST setItem (the tab's own write), leaving the verify
 * re-read to observe it.
 */

type CachedModels = {
  models: Array<{ id: string; name: string; capabilities: Array<'code' | 'writing' | 'reasoning' | 'vision' | 'fast' | 'long-context'> }>
  source: string
  fetchedAt: number
  error: string | null
}

const STORAGE_KEY = 'cw-models:api:test-provider'

describe('setCachedModels — post-write cross-tab verification (Sourcery round 10)', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v)
      },
      removeItem: (k: string) => {
        storage.delete(k)
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadStore() {
    const mod = await import('../model-store')
    return mod
  }

  function entry(models: string[], fetchedAt: number): CachedModels {
    return {
      models: models.map((id) => ({ id, name: id, capabilities: [] })),
      source: 'dynamic',
      fetchedAt,
      error: null,
    }
  }

  function injectOtherTabWrite(newer: CachedModels): void {
    // The other tab's newer write lands AFTER this tab's own setItem: wrap
    // setItem so the first call (this tab's write) is followed immediately by
    // the other tab's newer write — then this tab's post-write re-read sees
    // the newer entry, exactly the interleaving in the finding.
    const rawSet = storage.set.bind(storage)
    let injected = false
    storage.set = (k: string, v: string) => {
      rawSet(k, v)
      if (!injected) {
        injected = true
        rawSet(STORAGE_KEY, JSON.stringify(newer))
      }
      return storage
    }
  }

  it('repairs the shared cache when an older write lands after a newer one', async () => {
    const store = await loadStore()
    const older = entry(['gpt-4o'], 100)
    const newer = entry(['gpt-4o', 'gpt-4o-mini'], 200)
    injectOtherTabWrite(newer)

    // This tab's refresh started at fetchedAt=100 and completes now. The
    // pre-write disk check reads an empty disk (other tab has not written
    // yet), so the round-8 guard passes — only the post-write verification
    // can save the shared cache.
    store.setCachedModels('api', {
      models: older.models,
      source: 'dynamic',
      fetchedAt: 100,
      error: undefined,
    }, 'test-provider')

    // The newer tab's entry must be what survives on disk.
    const onDisk = JSON.parse(storage.get(STORAGE_KEY)!) as CachedModels
    expect(onDisk.fetchedAt).toBe(200)
    expect(onDisk.models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini'])

    // And this tab adopts it in memory too.
    expect(store.getCachedModels('api', 'test-provider')?.map((m) => m.id)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ])
  })

  it('does not repair when the disk already holds OUR write (normal path)', async () => {
    const store = await loadStore()
    const mine = entry(['gpt-4o'], 100)

    store.setCachedModels('api', {
      models: mine.models,
      source: 'dynamic',
      fetchedAt: 100,
      error: undefined,
    }, 'test-provider')

    const onDisk = JSON.parse(storage.get(STORAGE_KEY)!) as CachedModels
    expect(onDisk.fetchedAt).toBe(100)
    expect(onDisk.models.map((m) => m.id)).toEqual(['gpt-4o'])
  })

  it('keeps OUR newer write when the disk entry is older (forward progress)', async () => {
    const store = await loadStore()
    // Simulate a pre-existing OLDER disk entry (a previous session's cache).
    storage.set(STORAGE_KEY, JSON.stringify(entry(['old-model'], 50)))
    const mine = entry(['gpt-4o', 'gpt-4o-mini'], 300)

    store.setCachedModels('api', {
      models: mine.models,
      source: 'dynamic',
      fetchedAt: 300,
      error: undefined,
    }, 'test-provider')

    const onDisk = JSON.parse(storage.get(STORAGE_KEY)!) as CachedModels
    expect(onDisk.fetchedAt).toBe(300)
    expect(onDisk.models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })
})
