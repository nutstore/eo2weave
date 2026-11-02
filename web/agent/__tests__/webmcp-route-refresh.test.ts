import { describe, expect, it } from 'vitest'
import { raceRouteRefreshAgainstAbort } from '@/agent/webmcp-route-refresh'

// Contract: the legacy-route key refresh is an OPTIMIZATION — every failure
// degrades to "no refreshed key" so the original pre-execution routing error
// keeps its classification (#139 review round 6: safe route failures become
// ambiguous).
describe('raceRouteRefreshAgainstAbort', () => {
  it('degrades to undefined when the refresh fails or the run aborts', async () => {
    await expect(raceRouteRefreshAgainstAbort(Promise.reject(new Error('catalog down')))).resolves.toBeUndefined()

    const controller = new AbortController()
    const pending = raceRouteRefreshAgainstAbort(new Promise<string>(() => {}), controller.signal)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
  })

  it('returns the refreshed key when the refresh succeeds', async () => {
    await expect(raceRouteRefreshAgainstAbort(Promise.resolve('key-1'))).resolves.toBe('key-1')
  })
})
