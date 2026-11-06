import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'

/**
 * Marker-based install provenance on the web side (issue #231 — the mirror
 * of the extension's registry-store contract, issues #228/#230). Install
 * markers are the ONLY evidence of registry ownership: a package whose
 * manifest id merely matches a catalog entry is not an install.
 */

const providers = vi.hoisted(() => ({ webmcp: { current: null as unknown } }))

vi.mock('@/vfs/provider-registry', () => ({
  providerRegistry: {
    get: async (mount: string) => {
      const provider = providers.webmcp.current
      if (mount !== 'webmcp' || !provider) throw new Error(`Mount ${mount} is unavailable`)
      return provider
    },
  },
}))

vi.mock('@/webmcp/bridge-client', () => ({ getWebMCPBridge: () => null }))

import { listInstalledPackageIds, listInstalledPackageProvenance, uninstallRegistryPackage } from '@/webmcp/package-registry-store'

const marker = (packageId: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    registryId: 'https://example.com/manifest.json',
    packageId,
    version: '1.0.0',
    installedAt: '2026-11-06T00:00:00.000Z',
  }))

const manifest = (id: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ id, version: '1.0.0', description: '', tools: [{ name: 'tool', description: 'Tool', urlRegex: '^https://example\\.com/.*$', path: 't.js' }] }))

async function seedAuthored(provider: ReturnType<typeof memoryProvider>, directory: string): Promise<void> {
  await provider.mkdir(`${directory}/workflows`, { recursive: true })
  await provider.writeFile(`${directory}/manifest.json`, manifest(directory))
  await provider.writeFile(`${directory}/workflows/t.js`, new TextEncoder().encode('export default {}'))
}

beforeEach(() => {
  providers.webmcp.current = memoryProvider()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('listInstalledPackageProvenance', () => {
  it('counts a directory with a matching marker as installed', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.installed', { recursive: true })
    await provider.writeFile('com.example.installed/manifest.json', manifest('com.example.installed'))
    await provider.writeFile('com.example.installed/.webmcp-install.json', marker('com.example.installed'))

    const provenance = await listInstalledPackageProvenance()
    expect([...provenance.installed]).toEqual(['com.example.installed'])
    expect(provenance.indeterminate.size).toBe(0)
    expect(await listInstalledPackageIds()).toEqual(provenance.installed)
  })

  it('reads an authored package as authored even when its manifest id matches its directory', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await seedAuthored(provider, 'com.example.authored')

    const provenance = await listInstalledPackageProvenance()
    expect(provenance.installed.size).toBe(0)
    expect(provenance.indeterminate.size).toBe(0)
  })

  it('reports a marker naming a DIFFERENT directory as indeterminate', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.copy', { recursive: true })
    await provider.writeFile('com.example.copy/.webmcp-install.json', marker('com.example.other'))

    const provenance = await listInstalledPackageProvenance()
    expect(provenance.installed.size).toBe(0)
    expect([...provenance.indeterminate]).toEqual(['com.example.copy'])
  })

  it('reports a malformed marker as indeterminate', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.broken', { recursive: true })
    await provider.writeFile('com.example.broken/.webmcp-install.json', new TextEncoder().encode('{"schemaVersion":2}'))

    const provenance = await listInstalledPackageProvenance()
    expect(provenance.installed.size).toBe(0)
    expect([...provenance.indeterminate]).toEqual(['com.example.broken'])
  })

  it('reports a transient marker-read failure as indeterminate, not authored', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.flaky', { recursive: true })
    await provider.writeFile('com.example.flaky/.webmcp-install.json', marker('com.example.flaky'))
    const original = provider.readFile.bind(provider)
    provider.readFile = (async (path: string) => {
      if (path === 'com.example.flaky/.webmcp-install.json') throw Object.assign(new Error('I/O error'), { code: 'EIO' })
      return original(path)
    }) as typeof provider.readFile

    const provenance = await listInstalledPackageProvenance()
    expect(provenance.installed.size).toBe(0)
    expect([...provenance.indeterminate]).toEqual(['com.example.flaky'])
  })

  it('skips installer-internal dot-directories', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('.com.example.pkg.installing', { recursive: true })
    await provider.writeFile('.com.example.pkg.installing/.webmcp-install.json', marker('com.example.pkg'))

    const provenance = await listInstalledPackageProvenance()
    expect(provenance.installed.size).toBe(0)
    expect(provenance.indeterminate.size).toBe(0)
  })
})

describe('uninstallRegistryPackage', () => {
  it('removes a marker-proven install', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.installed', { recursive: true })
    await provider.writeFile('com.example.installed/manifest.json', manifest('com.example.installed'))
    await provider.writeFile('com.example.installed/.webmcp-install.json', marker('com.example.installed'))

    await uninstallRegistryPackage('com.example.installed')
    await expect(provider.stat('com.example.installed')).rejects.toThrow()
  })

  it('REFUSES to remove an authored package (no marker)', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await seedAuthored(provider, 'com.example.authored')

    await expect(uninstallRegistryPackage('com.example.authored'))
      .rejects.toThrow('is not a registry-installed package')
    // The authored files are untouched.
    expect(await provider.readFile('com.example.authored/manifest.json')).toEqual(manifest('com.example.authored'))
  })

  it('REFUSES to remove an indeterminate directory', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.copy', { recursive: true })
    await provider.writeFile('com.example.copy/.webmcp-install.json', marker('com.example.other'))

    await expect(uninstallRegistryPackage('com.example.copy'))
      .rejects.toThrow('is not a registry-installed package')
    expect(await provider.readFile('com.example.copy/.webmcp-install.json')).toEqual(marker('com.example.other'))
  })
})
