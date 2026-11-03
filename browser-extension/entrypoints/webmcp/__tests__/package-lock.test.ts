import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeAcquirePackageLock, bridgeReleasePackageLock, PACKAGE_LOCK_LEASE_TTL_MS } from '../package-lock'

afterEach(() => vi.useRealTimers())

describe('package lease', () => {
  it('grants the full TTL even immediately before a global TTL boundary', async () => {
    const leases = new Map<string, unknown>()
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: { local: {
        get: async (key: string) => ({ [key]: leases.get(key) }),
        set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) leases.set(key, value) },
        remove: async (key: string) => { leases.delete(key) },
      } },
    }
    vi.useFakeTimers()
    vi.setSystemTime(PACKAGE_LOCK_LEASE_TTL_MS - 1)
    const acquired = await bridgeAcquirePackageLock('com.example.pkg')
    expect(acquired.ok).toBe(true)
    const lease = leases.get('webmcp_package_lock_com.example.pkg') as { expiresAt: number }
    expect(lease.expiresAt - Date.now()).toBe(PACKAGE_LOCK_LEASE_TTL_MS)
    await bridgeReleasePackageLock('com.example.pkg', acquired.owner!)
  })
})
