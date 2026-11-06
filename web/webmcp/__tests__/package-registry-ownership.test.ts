/**
 * Web-side install ownership (issue #231).
 *
 * The settings section must only offer uninstall for packages this extension
 * installed. Ownership comes from the install marker, not from the directory
 * shape — an authored package laid out as `<id>/manifest.json` is
 * shape-identical to an install and used to be handed the registry row's
 * Remove action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'

const providers: { current: Awaited<ReturnType<typeof memoryProvider>> | undefined } = { current: undefined }

vi.mock('@/vfs/provider-registry', () => ({
  providerRegistry: {
    get: async () => {
      if (!providers.current) throw new Error('Mount webmcp is unavailable')
      return providers.current
    },
  },
}))

const marker = (packageId: string): string => JSON.stringify({
  schemaVersion: 1,
  registryId: 'https://example.com/registry.json',
  packageId,
  version: '1.0.0',
  installedAt: '2026-11-06T00:00:00.000Z',
})

const manifest = (id: string): string => JSON.stringify({ id, name: id, version: '1.0.0', tools: [] })

describe('listInstalledPackageIds (marker-based ownership)', () => {
  beforeEach(() => {
    providers.current = memoryProvider()
  })

  it('does not report an authored package as installed, even when its directory matches its manifest id', async () => {
    const provider = providers.current!
    await provider.mkdir('com.example.authored', { recursive: true })
    await provider.writeFile('com.example.authored/manifest.json', new TextEncoder().encode(manifest('com.example.authored')))

    const { listInstalledPackageIds } = await import('../package-registry-store')
    expect([...(await listInstalledPackageIds())]).not.toContain('com.example.authored')
  })

  it('reports a package carrying its own install marker as installed', async () => {
    const provider = providers.current!
    await provider.mkdir('com.example.installed', { recursive: true })
    await provider.writeFile('com.example.installed/manifest.json', new TextEncoder().encode(manifest('com.example.installed')))
    await provider.writeFile('com.example.installed/.webmcp-install.json', new TextEncoder().encode(marker('com.example.installed')))

    const { listInstalledPackageIds } = await import('../package-registry-store')
    expect([...(await listInstalledPackageIds())]).toContain('com.example.installed')
  })

  it('ignores a marker that names a different directory and a malformed marker', async () => {
    const provider = providers.current!
    await provider.mkdir('com.example.copy', { recursive: true })
    await provider.mkdir('com.example.broken', { recursive: true })
    await provider.writeFile('com.example.copy/.webmcp-install.json', new TextEncoder().encode(marker('com.example.other')))
    await provider.writeFile('com.example.broken/.webmcp-install.json', new TextEncoder().encode('{not json'))

    const { listInstalledPackageIds } = await import('../package-registry-store')
    const ids = await listInstalledPackageIds()
    expect([...ids]).not.toContain('com.example.other')
    expect([...ids]).not.toContain('com.example.copy')
    expect([...ids]).not.toContain('com.example.broken')
  })
})
