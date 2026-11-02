/**
 * Extension-side install transaction (issue #143).
 *
 * The transaction is the extension's port of the web app's installer: every
 * file is downloaded and sha256-verified BEFORE anything is written, the
 * tree is staged and swapped atomically, and the extension's own
 * cross-context lease (`package-lock.ts`) serializes the mutation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import type { FsProvider } from '@creatorweave/fs-provider'

/**
 * A minimal in-memory `chrome.storage.local` so the extension's own lease
 * works under the test runner (the lock lives in chrome.storage).
 */
function installChromeStorageMock(): void {
  const store = new Map<string, unknown>()
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string | string[]) {
          const keys = Array.isArray(key) ? key : [key]
          const result: Record<string, unknown> = {}
          for (const name of keys) if (store.has(name)) result[name] = store.get(name)
          return result
        },
        async set(items: Record<string, unknown>) {
          for (const [name, value] of Object.entries(items)) store.set(name, value)
        },
        async remove(key: string) {
          store.delete(key)
        },
      },
    },
  }
}

installChromeStorageMock()

const { installPackage, uninstallPackage, sha256Hex, PackageInstallError } = await import('../package-installer')
const { registryFromManifestUrl, MAX_PACKAGE_FILES } = await import('../registry-client')
type RegistryManifestPackage = import('../registry-client').RegistryManifestPackage

const RAW = 'https://raw.githubusercontent.com/owner/repo/main'
const MIRROR = 'https://cdn.jsdelivr.net/gh/owner/repo@main'

async function sha256Of(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text))
}

const WORKFLOW_SOURCE = `export default {
  inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
  tree: { type: 'condition', inspect() { return true } },
  result() { return 'title' }
}`
const TOOL_MANIFEST = {
  id: 'com.example.pkg',
  version: '1.0.0',
  description: 'Test package.',
  tools: [
    { name: 'read_title', description: 'Read title.', urlRegex: '^https://example\\.com/.*$', path: 'workflows/read.js' },
  ],
}

function fixtureFiles(manifest: unknown = TOOL_MANIFEST): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(manifest),
    'config.json': '{}',
    'workflows/read.js': WORKFLOW_SOURCE,
  }
}

async function pkgWithFiles(files: Record<string, string>, overrides: Partial<RegistryManifestPackage> = {}): Promise<RegistryManifestPackage> {
  const entries = await Promise.all(Object.entries(files).map(async ([filePath, content]) => ({
    path: `packages/com.example.pkg/${filePath}`,
    sha256: await sha256Of(content),
  })))
  return {
    id: 'com.example.pkg',
    version: '1.0.0',
    description: 'Test package.',
    toolCount: 1,
    files: entries,
    ...overrides,
  }
}

/** A fetch double serving the fixture files from the direct raw host. */
function fetchServing(files: Record<string, string>, options: { directFails?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(files).find(filePath => url.endsWith(`/${filePath}`))
    if (!key) return { ok: false, status: 404 } as unknown as Response
    if (options.directFails && url.startsWith(RAW)) throw new Error('network unreachable')
    const body = new TextEncoder().encode(files[key]!)
    return {
      ok: true,
      status: 200,
      url,
      body: null,
      arrayBuffer: async () => body.buffer as ArrayBuffer,
    } as unknown as Response
  }) as typeof fetch
}

async function listFiles(provider: FsProvider, dir: string): Promise<string[]> {
  const entries = await provider.readdir(dir)
  return entries.map(entry => entry.name).sort()
}

describe('installPackage (extension side)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads, verifies and writes the whole tree into the mount', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    const result = await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })

    expect(result.filesWritten).toBeGreaterThan(0)
    expect(await listFiles(provider, 'com.example.pkg')).toEqual(['config.json', 'manifest.json', 'workflows'])
    const manifest = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/manifest.json')))
    expect(manifest.id).toBe('com.example.pkg')
  })

  it('writes the DISABLED default config instead of the registry\'s config', async () => {
    const files = fixtureFiles()
    files['config.json'] = JSON.stringify({ activation: 'enabled' })
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })

    const config = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/config.json')))
    expect(config.activation).toBe('disabled')
  })

  it('aborts with NOTHING written when a checksum does not match', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    // Corrupt one file's expected checksum.
    pkg.files[0]!.sha256 = 'b'.repeat(64)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toBeInstanceOf(PackageInstallError)
    expect(await listFiles(provider, '')).toEqual([])
  })

  it('keeps the previous install when the new download fails', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    expect(await listFiles(provider, 'com.example.pkg')).toContain('manifest.json')

    const broken = await pkgWithFiles(fixtureFiles({ ...TOOL_MANIFEST, version: '2.0.0' }))
    broken.files[0]!.sha256 = 'c'.repeat(64)
    await expect(installPackage(registry, broken, provider, { fetchImpl: fetchServing(files) })).rejects.toBeInstanceOf(PackageInstallError)
    // The OLD install is still intact.
    const manifest = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/manifest.json')))
    expect(manifest.version).toBe('1.0.0')
  })

  it('rejects a manifest whose version disagrees with the registry entry', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files, { version: '9.9.9' })
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })).rejects.toThrow(/does not match registry version/)
    expect(await listFiles(provider, '')).toEqual([])
  })

  it('rejects a package that lists too many files', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    pkg.files = Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, index) => ({
      path: `packages/com.example.pkg/file-${index}.js`,
      sha256: 'a'.repeat(64),
    }))
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })).rejects.toThrow(/too many files/)
  })

  it('falls back to the jsDelivr mirror when the direct raw host fails', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const tried: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      tried.push(String(input))
      return fetchServing(files, { directFails: true })(input)
    }) as typeof fetch

    const result = await installPackage(registry, pkg, provider, { fetchImpl, preference: 'global' })

    expect(result.filesWritten).toBeGreaterThan(0)
    expect(tried.some(url => url.startsWith(MIRROR))).toBe(true)
    expect(await listFiles(provider, 'com.example.pkg')).toContain('manifest.json')
  })

  it('uninstall removes the package directory', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    await uninstallPackage('com.example.pkg', provider)
    expect(await listFiles(provider, '')).toEqual([])
  })
})
