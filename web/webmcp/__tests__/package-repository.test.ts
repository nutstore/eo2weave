import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import type { FsProvider } from '@creatorweave/fs-provider'
import { readWebMCPCatalog, readWebMCPCatalogDetailed } from '../../../browser-extension/entrypoints/webmcp/package-repository'
import { getAdapterStorage } from '../../../browser-extension/entrypoints/webmcp/provider-storage'
import { getBuiltinStorage } from '../../../browser-extension/entrypoints/webmcp/builtin-storage'

/**
 * Finding: "Transient listing failure removes routes" — the preflight user
 * mount listing can succeed while the SECOND listing inside
 * readMountedWebMCPCatalog fails; the combined read must degrade to
 * builtin-only (userMountComplete: false) instead of rejecting, because a
 * rejection makes catalog refresh clear every adapter route including
 * healthy builtins.
 */
vi.mock('../../../browser-extension/entrypoints/webmcp/provider-storage', () => ({
  getAdapterStorage: vi.fn(),
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/builtin-storage', () => ({
  getBuiltinStorage: vi.fn(),
  readBuiltinConfig: vi.fn(),
  setBuiltinConfig: vi.fn(),
  BUILTIN_CONFIG_STORAGE_KEY: 'webmcp_builtin_package_configs',
}))

/** A provider whose first directories() fails, then recovers. */
function flakyProvider(): FsProvider {
  const inner = memoryProvider()
  let firstCall = true
  return {
    ...inner,
    async readdir(path: string) {
      if (path === '' && firstCall) {
        firstCall = false
        throw new Error('transient OPFS listing failure')
      }
      return inner.readdir(path)
    },
  }
}

describe('readWebMCPCatalogDetailed (transient user-mount listing failure)', () => {
  beforeEach(() => {
    vi.mocked(getBuiltinStorage).mockResolvedValue(memoryProvider())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('degrades to builtin-only instead of rejecting when the SECOND user-mount listing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Preflight directories() succeeds; the one INSIDE
      // readMountedWebMCPCatalog fails (call order per mount).
      vi.mocked(getAdapterStorage).mockResolvedValue(flakyProvider())
      const [entries, meta] = await readWebMCPCatalogDetailed()
      expect(meta.userMountComplete).toBe(false)
      // Builtin entries still served — no rejection, no wiped catalog.
      expect(Array.isArray(entries)).toBe(true)
      expect(warn).toHaveBeenCalled()
      // readWebMCPCatalog shares the same degradation path.
      await expect(readWebMCPCatalog()).resolves.toBeDefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('still reports userMountComplete: true when both listings succeed', async () => {
    vi.mocked(getAdapterStorage).mockResolvedValue(memoryProvider())
    const [, meta] = await readWebMCPCatalogDetailed()
    expect(meta.userMountComplete).toBe(true)
  })
})
