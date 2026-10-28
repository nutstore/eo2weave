/**
 * First-run thinking default tests (issue #88)
 *
 * Fresh installs must get enableThinking=true at 'medium'; existing installs
 * with persisted settings must keep whatever they stored (including an
 * explicit false).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const STORAGE_KEY = 'bfosa-settings'

// Minimal shape of what matters for these tests. The persisted object may
// contain other keys; they're untouched by the behavior under test.
interface PersistedShape {
  enableThinking?: boolean
  thinkingLevel?: string
  [key: string]: unknown
}

async function importStore() {
  // Dynamic import so each test can control localStorage BEFORE the store
  // module (and its zustand persist middleware) rehydrates.
  const mod = await import('@/store/settings.store')
  return mod
}

function seedStorage(value: PersistedShape | null, version = 4) {
  if (value === null) {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: value, version }))
  }
}

describe('first-run thinking default (#88)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('fresh install (no persisted settings) defaults to thinking ON at high', async () => {
    seedStorage(null)
    const { useSettingsStore } = await importStore()

    // zustand persist rehydrates synchronously from localStorage at creation.
    const state = useSettingsStore.getState()
    expect(state.enableThinking).toBe(true)
    expect(state.thinkingLevel).toBe('medium')
  })

  it('existing install with stored enableThinking:false is NOT flipped', async () => {
    seedStorage({
      enableThinking: false,
      thinkingLevel: 'medium',
      providerType: 'glm-coding',
      modelName: 'glm-4.7-flash',
    })
    const { useSettingsStore } = await importStore()

    const state = useSettingsStore.getState()
    expect(state.enableThinking).toBe(false)
    expect(state.thinkingLevel).toBe('medium')
    expect(state.providerType).toBe('glm-coding')
  })

  it('existing install with stored enableThinking:true, level low is preserved', async () => {
    seedStorage({ enableThinking: true, thinkingLevel: 'low' })
    const { useSettingsStore } = await importStore()

    const state = useSettingsStore.getState()
    expect(state.enableThinking).toBe(true)
    expect(state.thinkingLevel).toBe('low')
  })

  it('persist migrate on a v2 state keeps stored thinking fields verbatim', async () => {
    seedStorage(
      {
        enableThinking: false,
        thinkingLevel: 'medium',
        enableSchedules: false, // legacy field the v3 migrate strips
      },
      2,
    )
    const { useSettingsStore } = await importStore()

    const state = useSettingsStore.getState()
    // v4 migrate must not seed the new defaults over stored values...
    expect(state.enableThinking).toBe(false)
    expect(state.thinkingLevel).toBe('medium')
    // ...while still carrying forward the v3 behavior (strip enableSchedules).
    expect((state as unknown as Record<string, unknown>).enableSchedules).toBeUndefined()
  })

  it('defaults persist at version 4: a later set() round-trips through storage', async () => {
    seedStorage(null)
    const { useSettingsStore } = await importStore()

    expect(useSettingsStore.getState().enableThinking).toBe(true)
    expect(useSettingsStore.getState().thinkingLevel).toBe('medium')

    // Force a state change so zustand persist writes to localStorage.
    useSettingsStore.getState().setEnableThinking(false)

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as { state: PersistedShape & { __settingsWriteRevision?: number }; version: number }
    expect(parsed.version).toBe(4)
    expect(parsed.state.enableThinking).toBe(false)
    expect(parsed.state.thinkingLevel).toBe('medium')
  })
})
