import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'

/**
 * Package-id collision guard for the registry installer (issue #117).
 *
 * A registry package id doubles as the directory name on the mount, so an
 * install whose id collides with an existing package would DELETE and
 * replace that package. The install must be rejected instead.
 */

const providers = vi.hoisted(() => ({
  webmcp: { current: null as unknown },
  builtin: { current: null as unknown },
}))

vi.mock('@/vfs/provider-registry', () => ({
  providerRegistry: {
    get: async (mount: string) => {
      const provider = mount === 'builtin-webmcp' ? providers.builtin.current : providers.webmcp.current
      if (!provider) throw new Error(`Mount ${mount} is unavailable`)
      return provider
    },
  },
}))

import { findPackageIdCollision, installRegistryPackage } from '@/webmcp/package-registry-store'

const MANIFEST = (id: string) => new TextEncoder().encode(JSON.stringify({ id, version: '1.0.0', description: '', tools: [] }))

async function seed(provider: ReturnType<typeof memoryProvider>, directory: string, manifestId: string) {
  await provider.mkdir(directory, { recursive: true })
  await provider.writeFile(`${directory}/manifest.json`, MANIFEST(manifestId))
}

beforeEach(() => {
  providers.webmcp.current = memoryProvider()
  providers.builtin.current = memoryProvider()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('findPackageIdCollision', () => {
  it('reports no collision for a fresh id', async () => {
    expect(await findPackageIdCollision('com.example.new')).toBeNull()
  })

  it('allows a RE-install of the same package (same directory, same manifest id)', async () => {
    await seed(providers.webmcp.current as ReturnType<typeof memoryProvider>, 'com.example.pkg', 'com.example.pkg')
    expect(await findPackageIdCollision('com.example.pkg')).toBeNull()
  })

  it('detects a directory holding a DIFFERENT package (the id would replace it)', async () => {
    await seed(providers.webmcp.current as ReturnType<typeof memoryProvider>, 'com.example.pkg', 'com.other.pkg')
    expect(await findPackageIdCollision('com.example.pkg')).toMatch(/already holds the package com\.other\.pkg/)
  })

  it('detects a duplicate manifest id in ANOTHER directory (duplicate namespace)', async () => {
    await seed(providers.webmcp.current as ReturnType<typeof memoryProvider>, 'com.example.copy', 'com.example.pkg')
    expect(await findPackageIdCollision('com.example.pkg')).toMatch(/already publishes the package id/)
  })

  it('detects a collision with a BUILTIN package', async () => {
    await seed(providers.builtin.current as ReturnType<typeof memoryProvider>, 'com.builtin.pkg', 'com.builtin.pkg')
    expect(await findPackageIdCollision('com.builtin.pkg')).toMatch(/builtin-webmcp/)
  })

  it('ignores the installer-internal dot-directories', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('.com.example.pkg.installing', { recursive: true })
    await provider.writeFile('.com.example.pkg.installing/manifest.json', MANIFEST('com.example.pkg'))
    expect(await findPackageIdCollision('com.example.pkg')).toBeNull()
  })

  it('treats a MALFORMED target manifest as occupied, not as the package (round 3)', async () => {
    // Finding: "Malformed packages count as valid" — a directory holding a
    // manifest that is valid JSON but not a package (a bare object) is NOT
    // a re-install target: the installer must refuse to overwrite it.
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile('com.example.pkg/manifest.json', new TextEncoder().encode('{}'))
    expect(await findPackageIdCollision('com.example.pkg')).toMatch(/not a valid package/)
  })

  it('treats an unreadable NON-target manifest as a failed check (fail closed, round 3)', async () => {
    // Findings: "Transient reads bypass collision checks" / "Unreadable
    // manifests hide collisions" — a read error on a DIFFERENT directory
    // may hide the very id being installed; the check must fail instead of
    // continuing.
    const full = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await seed(full, 'com.other.pkg', 'com.other.pkg')
    providers.webmcp.current = {
      stat: (path: string) => full.stat(path),
      readdir: (path: string) => full.readdir(path),
      readFile: async (path: string) => {
        if (path === 'com.other.pkg/manifest.json') throw new Error('quota exceeded')
        return full.readFile(path)
      },
    }
    expect(await findPackageIdCollision('com.example.new')).toMatch(/could not be read/)
  })

  it('distinguishes a MISSING manifest from an unreadable one (round 3)', async () => {
    // A directory with NO manifest under a different name is not a
    // collision; the ENOENT path stays "skip", only real read errors fail.
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await provider.mkdir('com.hollow.dir', { recursive: true })
    expect(await findPackageIdCollision('com.example.new')).toBeNull()
  })
})

describe('installRegistryPackage', () => {
  it('refuses to install over an existing package with a different manifest id', async () => {
    const provider = providers.webmcp.current as ReturnType<typeof memoryProvider>
    await seed(provider, 'com.example.pkg', 'com.other.pkg')
    const seededBytes = await provider.readFile('com.example.pkg/manifest.json')
    const registry = { rawBase: 'https://raw.githubusercontent.com/o/r/main', manifestUrl: 'https://raw.githubusercontent.com/o/r/main/manifest.json', label: 'o/r' }
    const pkg = { id: 'com.example.pkg', version: '1.0.0', description: '', toolCount: 0, files: [] }

    await expect(installRegistryPackage(registry, pkg)).rejects.toThrow(/Cannot install com\.example\.pkg/)
    // The existing package is untouched (finding: "Replacement can pass
    // unnoticed"): existence alone would still pass if the install replaced
    // the contents before rejecting — the manifest must be BYTE-identical
    // to the seeded one.
    expect(await provider.readFile('com.example.pkg/manifest.json')).toEqual(seededBytes)
  })
})
