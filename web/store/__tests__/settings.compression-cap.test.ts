/**
 * Absolute compression cap settings (#104)
 *
 * The cap fields are new in persist schema v5: a pre-v5 snapshot has neither
 * field, so the migrate must backfill them, and hand-edited/out-of-range
 * values must be clamped before they reach the trigger maths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const STORAGE_KEY = 'bfosa-settings'

async function importStore() {
  return import('@/store/settings.store')
}

function seedStorage(state: Record<string, unknown>, version = 4) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, version }))
}

describe('absolute compression cap settings (#104)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('backfills the cap on a pre-v5 snapshot that never had the fields', async () => {
    seedStorage({ enableThinking: false, temperature: 0.7 }, 4)
    const { useSettingsStore } = await importStore()

    const state = useSettingsStore.getState()
    expect(state.compressionAbsoluteCapEnabled).toBe(true)
    expect(state.compressionAbsoluteCap).toBe(200_000)
    // Unrelated settings still hydrate.
    expect(state.temperature).toBe(0.7)
  })

  it('keeps an explicit opt-out and clamps an out-of-range cap from a pre-v5 snapshot', async () => {
    seedStorage({ compressionAbsoluteCapEnabled: false, compressionAbsoluteCap: 5_000 }, 4)
    const { useSettingsStore } = await importStore()

    const state = useSettingsStore.getState()
    expect(state.compressionAbsoluteCapEnabled).toBe(false)
    expect(state.compressionAbsoluteCap).toBe(32_000)
  })

  it('falls back to the default cap when the stored value is not a number', async () => {
    seedStorage({ compressionAbsoluteCap: 'not-a-number' }, 4)
    const { useSettingsStore } = await importStore()

    expect(useSettingsStore.getState().compressionAbsoluteCap).toBe(200_000)
  })

  it('leaves a current-version snapshot untouched', async () => {
    seedStorage({ compressionAbsoluteCapEnabled: true, compressionAbsoluteCap: 45_000 }, 5)
    const { useSettingsStore } = await importStore()

    expect(useSettingsStore.getState().compressionAbsoluteCap).toBe(45_000)
  })

  it('clamps writes and ignores a cleared input', async () => {
    seedStorage({ compressionAbsoluteCap: 120_000 }, 5)
    const { useSettingsStore } = await importStore()

    useSettingsStore.getState().setCompressionAbsoluteCap(2_000_000)
    expect(useSettingsStore.getState().compressionAbsoluteCap).toBe(1_000_000)

    useSettingsStore.getState().setCompressionAbsoluteCap(1_000)
    expect(useSettingsStore.getState().compressionAbsoluteCap).toBe(32_000)

    // A cleared number input yields NaN; the previous value must survive.
    useSettingsStore.getState().setCompressionAbsoluteCap(Number.NaN)
    expect(useSettingsStore.getState().compressionAbsoluteCap).toBe(32_000)
  })
})
