/**
 * Registry store (issue #143): the same-version reinstall fingerprint.
 *
 * The under-lock collision check compares the incoming catalog entry's
 * whole-content fingerprint against the installed tree. The two sides must
 * describe the SAME thing:
 *   - the same ENCODING (the catalog side hashes each file's sha256 digest
 *     bytes — the installed side must hash each installed file's own sha256
 *     digest, not its raw bytes); and
 *   - the same FILE SET (the installer rewrites `config.json` to the
 *     disabled default, so the catalog's config checksum cannot describe
 *     the on-disk file — both sides exclude it).
 * Otherwise every identical same-version reinstall was rejected as
 * "different contents" (findings: "Identical installs look different",
 * "Identical config packages conflict"), while a genuinely tampered
 * same-version package must still be rejected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'

const mount = vi.hoisted(async () => {
  const { memoryProvider } = await import('@creatorweave/fs-provider/memory')
  return memoryProvider()
})

vi.mock('../provider-storage', () => ({
  getAdapterStorage: async () => await mount,
}))

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

const RAW = 'https://raw.githubusercontent.com/owner/repo/main'

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

function fixtureFiles(workflow = WORKFLOW_SOURCE): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(TOOL_MANIFEST),
    'config.json': JSON.stringify({ activation: 'enabled', publisher: 'catalog' }),
    'workflows/read.js': workflow,
  }
}

async function sha256Of(text: string): Promise<string> {
  const { sha256Hex } = await import('../package-installer')
  return sha256Hex(new TextEncoder().encode(text))
}

/** A catalog package entry built from real file contents. */
async function pkgFromFiles(files: Record<string, string>): Promise<import('../registry-client').RegistryManifestPackage> {
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
  }
}

/** Serve the fixture files for BOTH the direct raw host and the mirror. */
function installFetchServing(files: Record<string, string>): void {
  ;(globalThis as { fetch?: unknown }).fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(files).find(filePath => url.endsWith(`/${filePath}`))
    if (!key) return { ok: false, status: 404 } as unknown as Response
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

const { installRegistryPackage } = await import('../registry-store')
const { registryFromManifestUrl } = await import('../registry-client')

describe('installRegistryPackage (same-version reinstall fingerprint)', () => {
  beforeEach(async () => {
    const m = await mount
    await m.remove('com.example.pkg', { recursive: true }).catch(() => {})
    await m.remove('.com.example.pkg.previous', { recursive: true }).catch(() => {})
  })

  it.each(['invalid manifest', 'missing workflow'])('recovers a partial live package with a preserved backup (%s)', async damage => {
    const files = fixtureFiles()
    const pkg = await pkgFromFiles(files)
    installFetchServing(files)
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const m = await mount
    await m.mkdir('com.example.pkg/workflows', { recursive: true })
    await m.mkdir('.com.example.pkg.previous/workflows', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(content)
      await m.writeFile(`.com.example.pkg.previous/${path}`, bytes)
      if (damage !== 'missing workflow' || path !== 'workflows/read.js') {
        await m.writeFile(`com.example.pkg/${path}`, bytes)
      }
    }
    if (damage === 'invalid manifest') {
      await m.writeFile('com.example.pkg/manifest.json', new TextEncoder().encode('{broken'))
    }
    // Provenance is part of a complete install (issue #228): a tree the
    // installer would restore must carry the marker, or recovery would hand
    // back a package that reads as authored.
    const markerBytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      registryId: `${RAW}/manifest.json`,
      packageId: 'com.example.pkg',
      version: '1.0.0',
      installedAt: '2026-11-06T00:00:00.000Z',
    }))
    await m.writeFile('.com.example.pkg.previous/.webmcp-install.json', markerBytes)
    await m.writeFile('com.example.pkg/.webmcp-install.json', markerBytes)
    await expect(installRegistryPackage(registry, pkg)).resolves.toBeTruthy()
    expect(await m.readFile('com.example.pkg/workflows/read.js')).toEqual(new TextEncoder().encode(WORKFLOW_SOURCE))
  })

  it('does not delete an invalid live directory when the backup is invalid too', async () => {
    const files = fixtureFiles()
    const pkg = await pkgFromFiles(files)
    installFetchServing(files)
    const m = await mount
    await m.mkdir('com.example.pkg', { recursive: true })
    await m.writeFile('com.example.pkg/manifest.json', new TextEncoder().encode('{broken'))
    await m.mkdir('.com.example.pkg.previous', { recursive: true })
    await m.writeFile('.com.example.pkg.previous/manifest.json', new TextEncoder().encode('{}'))
    await expect(installRegistryPackage(registryFromManifestUrl(`${RAW}/manifest.json`), pkg))
      .rejects.toThrow(/not a valid package/)
    expect(await m.readFile('com.example.pkg/manifest.json')).toEqual(new TextEncoder().encode('{broken'))
  })

  it('accepts a same-version reinstall of an IDENTICAL package', async () => {
    // MEDIUM ("Identical installs look different"): the catalog side of the
    // fingerprint hashes each file's sha256 digest bytes while the
    // installed side hashed raw file bytes — the two could never match and
    // every identical reinstall was rejected as "different contents".
    const files = fixtureFiles()
    const pkg = await pkgFromFiles(files)
    installFetchServing(files)
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installRegistryPackage(registry, pkg)
    // The identical reinstall must NOT read as a conflict.
    await expect(installRegistryPackage(registry, pkg)).resolves.toBeTruthy()
  })

  it('accepts a reinstall when the catalog config differs from the on-disk default', async () => {
    // MEDIUM ("Identical config packages conflict"): the installer rewrites
    // config.json to the disabled default, but the fingerprint included the
    // catalog's config checksum — an otherwise identical reinstall was
    // rejected as a conflict.
    const files = fixtureFiles() // the catalog config is NOT the installer default
    const pkg = await pkgFromFiles(files)
    installFetchServing(files)
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installRegistryPackage(registry, pkg)
    const m = await mount
    const onDiskConfig = JSON.parse(new TextDecoder().decode(await m.readFile('com.example.pkg/config.json')))
    expect(onDiskConfig.activation).toBe('disabled')
    // Same catalog again — an identical reinstall.
    await expect(installRegistryPackage(registry, pkg)).resolves.toBeTruthy()
  })

  it('still rejects a same-version reinstall whose file contents differ', async () => {
    // The exclusion of config.json must not blind the check: a package with
    // tampered TOOL content is a conflict, not a reinstall.
    const files = fixtureFiles()
    const pkg = await pkgFromFiles(files)
    installFetchServing(files)
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installRegistryPackage(registry, pkg)

    const tamperedFiles = fixtureFiles(`export default {
  inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
  tree: { type: 'condition', inspect() { return true } },
  result() { return 'TAMPERED TITLE' }
}`)
    const tamperedCatalog = await pkgFromFiles(tamperedFiles)
    installFetchServing(tamperedFiles)
    await expect(installRegistryPackage(registry, tamperedCatalog))
      .rejects.toThrow(/different contents/)
  })
})

describe('listInstalledPackages (install markers are the only evidence)', () => {
  const marker = (packageId: string): string => JSON.stringify({
    schemaVersion: 1,
    registryId: 'https://example.com/registry.json',
    packageId,
    version: '1.0.0',
    installedAt: '2026-11-06T00:00:00.000Z',
  })

  it('reads an authored package as authored even when its manifest id matches its directory', async () => {
    const { listInstalledPackages } = await import('../registry-store')
    const m = await mount
    const encoder = new TextEncoder()
    await m.writeFile('com.example.authored/manifest.json', encoder.encode(JSON.stringify({ id: 'com.example.authored' })))

    const result = await listInstalledPackages(m)
    expect(result.ids.has('com.example.authored')).toBe(false)
    expect(result.directories.has('com.example.authored')).toBe(false)
  })

  it('counts a marked directory as installed', async () => {
    const { listInstalledPackages } = await import('../registry-store')
    const m = await mount
    await m.writeFile('com.example.installed/.webmcp-install.json', new TextEncoder().encode(marker('com.example.installed')))

    const result = await listInstalledPackages(m)
    expect([...result.ids]).toContain('com.example.installed')
    expect([...result.directories]).toContain('com.example.installed')
  })

  it('ignores a marker that names a different directory', async () => {
    const { listInstalledPackages } = await import('../registry-store')
    const m = await mount
    await m.writeFile('com.example.copy/.webmcp-install.json', new TextEncoder().encode(marker('com.example.other')))

    const result = await listInstalledPackages(m)
    expect([...result.ids]).not.toContain('com.example.other')
    expect([...result.directories]).not.toContain('com.example.copy')
  })

  it('keeps a directory whose marker cannot be read on the installed side', async () => {
    const { listInstalledPackages } = await import('../registry-store')
    const m = await mount
    await m.writeFile('com.example.broken/.webmcp-install.json', new TextEncoder().encode(marker('com.example.broken')))

    // A TRANSIENT read failure (not ENOENT) must not demote the package to
    // "authored": that would offer a delete for something we cannot prove.
    const original = m.readFile.bind(m)
    m.readFile = (async (path: string) => {
      if (path === 'com.example.broken/.webmcp-install.json') throw Object.assign(new Error('I/O error'), { code: 'EIO' })
      return original(path)
    }) as typeof m.readFile
    try {
      const result = await listInstalledPackages(m)
      expect([...result.ids]).toContain('com.example.broken')
    } finally {
      m.readFile = original as typeof m.readFile
    }
  })
})
