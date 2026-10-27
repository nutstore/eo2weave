/**
 * Cross-tab settings sync regression tests (Sourcery round-3 findings)
 *
 * Covers:
 * - TDZ: the storage listener must actually install during synchronous
 *   rehydration (crossTabSyncInstalled / suppressPersistWrites are read
 *   during module init — declared after the store they crashed with a
 *   ReferenceError that zustand swallowed silently).
 * - Concurrent-write guard: a queued storage event older than this tab's own
 *   persist write must not revert the local edit.
 * - Schema-version guard: a v3 snapshot from an old tab must not overwrite
 *   this tab's v4 settings.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const STORAGE_KEY = 'bfosa-settings'

interface PersistedShape {
  enableThinking?: boolean
  thinkingLevel?: string
  temperature?: number
  [key: string]: unknown
}

function seedStorage(value: PersistedShape | null, version = 4) {
  if (value === null) {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: value, version }))
  }
}

function dispatchStorageEvent(timeStamp: number, rawValue: string | null) {
  const event = new Event('storage') as Event & { key: string | null; newValue: string | null; timeStamp: number }
  Object.defineProperties(event, {
    key: { value: STORAGE_KEY },
    newValue: { value: rawValue },
    timeStamp: { value: timeStamp },
  })
  window.dispatchEvent(event)
}

async function importStore() {
  return import('@/store/settings.store')
}

describe('cross-tab settings sync (round-3 findings)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('installs the storage listener during synchronous rehydration (no TDZ)', async () => {
    // Rehydration happens during module init; if the sync state were still
    // declared after the store, this import would silently fail to register
    // the listener and the event below would be ignored.
    seedStorage({ enableThinking: false })
    const { useSettingsStore } = await importStore()

    const raw = JSON.stringify({
      state: { temperature: 0.42 },
      version: 4,
    })
    dispatchStorageEvent(performance.now() + 5, raw)

    expect(useSettingsStore.getState().temperature).toBe(0.42)
  })

  it('ignores a queued snapshot older than this tab\'s own write (concurrent edit)', async () => {
    seedStorage({ enableThinking: true, temperature: 0.7 })
    const { useSettingsStore } = await importStore()

    // This tab edits and persists (sets lastLocalWriteAt).
    useSettingsStore.getState().setTemperature(0.9)
    expect(useSettingsStore.getState().temperature).toBe(0.9)

    // The other tab wrote BEFORE our write; its storage event arrives now,
    // carrying the stale pre-write snapshot (temperature 0.7).
    const staleRaw = JSON.stringify({
      state: { enableThinking: true, temperature: 0.7 },
      version: 4,
    })
    dispatchStorageEvent(performance.now() - 1000, staleRaw)

    // The local edit must survive.
    expect(useSettingsStore.getState().temperature).toBe(0.9)
  })

  it('applies a newer snapshot after our own write (freshness not over-blocked)', async () => {
    seedStorage({ temperature: 0.7 })
    const { useSettingsStore } = await importStore()

    useSettingsStore.getState().setTemperature(0.9)

    // The other tab wrote AFTER our write — the event must be applied.
    const newerRaw = JSON.stringify({
      state: { temperature: 0.5, maxIterations: 42 },
      version: 4,
    })
    dispatchStorageEvent(performance.now() + 1000, newerRaw)

    expect(useSettingsStore.getState().temperature).toBe(0.5)
    expect(useSettingsStore.getState().maxIterations).toBe(42)
  })

  it('rejects a v3 snapshot from an old tab (schema-version guard)', async () => {
    seedStorage({ enableThinking: false, temperature: 0.7 })
    const { useSettingsStore } = await importStore()
    expect(useSettingsStore.getState().enableThinking).toBe(false)

    // A pre-deploy v3 tab writes its stale full snapshot (thinking true).
    const v3Raw = JSON.stringify({
      state: { enableThinking: true, temperature: 0.3 },
      version: 3,
    })
    dispatchStorageEvent(performance.now() + 5, v3Raw)

    // v4 state must not be reverted by the older-schema snapshot.
    expect(useSettingsStore.getState().enableThinking).toBe(false)
    expect(useSettingsStore.getState().temperature).toBe(0.7)
  })

  it('applies a v4 peer snapshot with a changed setting (baseline behavior)', async () => {
    seedStorage({ enableThinking: false })
    const { useSettingsStore } = await importStore()

    const v4Raw = JSON.stringify({
      state: { enableThinking: true, thinkingLevel: 'low' },
      version: 4,
    })
    dispatchStorageEvent(performance.now() + 5, v4Raw)

    expect(useSettingsStore.getState().enableThinking).toBe(true)
    expect(useSettingsStore.getState().thinkingLevel).toBe('low')
  })
})
