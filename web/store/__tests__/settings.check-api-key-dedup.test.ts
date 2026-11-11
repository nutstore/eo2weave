/**
 * checkHasApiKey deduplication regression (#84 review round 3).
 *
 * Two overlapping checkHasApiKey() calls for the SAME provider: the second
 * caller must reuse the in-flight promise, and when it resolves BOTH
 * callers' side effects must have landed — in particular the reactive
 * `hasApiKey` write. The pre-fix code claimed an epoch at function entry,
 * so the deduplicated second caller bumped the epoch and the in-flight
 * lookup's write guard (epoch === latest) failed: the promise resolved,
 * callers got `true`, but `hasApiKey` stayed false and onboarding/sends
 * stayed blocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../settings.store'

const loadApiKeyMock = vi.fn<() => Promise<string | null>>()
let resolveLoad: (key: string | null) => void

vi.mock('@/security/api-key-store', () => ({
  loadApiKey: (...args: unknown[]) => loadApiKeyMock(...(args as [])),
  saveApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
}))

describe('checkHasApiKey deduplication', () => {
  beforeEach(() => {
    loadApiKeyMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveLoad = resolve
        })
    )
    // Clear the CALL RECORD (not the implementations): call counts leak
    // across tests, so the second test's `toHaveBeenCalledTimes(1)` waitFor
    // would pass instantly on the first test's stale count — before its own
    // lookup even starts — and its resolveLoad() would fire on nothing
    // (Sourcery round 4). Combined with the per-provider cache isolation in
    // the cache-hit test, each test's waitFor sees only its own lookup.
    loadApiKeyMock.mockClear()
    useSettingsStore.setState({
      providerType: 'openai',
      modelName: 'gpt-test',
      hasApiKey: false,
      hasApiKeyLoaded: false,
    })
  })

  it('writes hasApiKey when a deduplicated overlapping caller reuses the in-flight promise', async () => {
    const store = useSettingsStore.getState()

    const first = store.checkHasApiKey()
    // Second caller for the same provider while the first lookup is still
    // in flight — pre-fix, this bumped the epoch and suppressed the write.
    const second = store.checkHasApiKey()

    // The underlying key lookup must be deduplicated to ONE query (the
    // promise cache; the async wrapper means the returned promises are
    // distinct objects even though they share one lookup). The lookup
    // starts behind a dynamic `await import(...)`, so wait for it.
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledTimes(1))

    // The lookup resolves with a saved key.
    resolveLoad('sk-test')
    expect(await first).toBe(true)
    expect(await second).toBe(true)

    const state = useSettingsStore.getState()
    expect(state.hasApiKey).toBe(true)
    expect(state.hasApiKeyLoaded).toBe(true)
  })

  it('still resolves correctly for a cache-hit caller after the write', async () => {
    // Distinct provider (Sourcery round 4): the module-level key cache
    // outlives a single test, so reusing 'openai' here would hit the
    // previous test's cached entry, never call loadApiKeyMock, and hang
    // the waitFor below. 'anthropic' is a built-in static provider with
    // its own cache key, so this test exercises its own uncached lookup.
    useSettingsStore.setState({ providerType: 'anthropic' })

    const store = useSettingsStore.getState()

    const first = store.checkHasApiKey()
    await vi.waitFor(() => expect(loadApiKeyMock).toHaveBeenCalledTimes(1))
    resolveLoad('sk-test')
    expect(await first).toBe(true)

    // Switching away and back re-projects the cached provider verdict.
    useSettingsStore.setState({ providerType: 'openai' })
    useSettingsStore.setState({ providerType: 'anthropic' })
    expect(useSettingsStore.getState().hasApiKey).toBe(true)

    // Later caller hits the key cache: same answer, no re-lookup.
    const later = await store.checkHasApiKey()
    expect(later).toBe(true)
    expect(useSettingsStore.getState().hasApiKey).toBe(true)
  })
})
