import { describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { installPackage, uninstallPackage, sha256Hex, PackageInstallError } from '@/webmcp/package-installer'
import { registryFromManifestUrl, MAX_PACKAGE_FILES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_TOTAL_BYTES } from '@/webmcp/package-registry-client'
import type { RegistryManifestPackage } from '@/webmcp/package-registry-client'

const RAW = 'https://raw.githubusercontent.com/owner/repo/main'

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

/** Default files of the fixture package: a package the extension ACCEPTS. */
function fixtureFiles(manifest = TOOL_MANIFEST): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(manifest),
    'config.json': '{}',
    'workflows/read.js': WORKFLOW_SOURCE,
  }
}

async function pkgWithFiles(files: Record<string, string>, overrides: Partial<RegistryManifestPackage> = {}): Promise<RegistryManifestPackage> {
  const entries = await Promise.all(Object.entries(files).map(async ([path, content]) => ({
    path: `packages/com.example.pkg/${path}`,
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

/** A package that passes the extension's own package validation. */
function validPkg(overrides: Partial<RegistryManifestPackage> = {}): Promise<RegistryManifestPackage> {
  return pkgWithFiles(fixtureFiles(), overrides)
}

function fetchServing(files: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    const key = Object.keys(files).find(path => url.endsWith(`/${path}`))
    if (key && url.includes(RAW)) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(files[key]!).buffer as ArrayBuffer,
      } as unknown as Response
    }
    return { ok: false, status: 404 } as unknown as Response
  }) as typeof fetch
}

function fetchNever(): typeof fetch {
  return vi.fn() as unknown as typeof fetch
}

describe('installPackage', () => {
  it('downloads, verifies and writes the whole tree into the mount', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    const result = await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })

    expect(result.filesWritten).toBe(3)
    expect(await provider.readFile('com.example.pkg/manifest.json'))
      .toEqual(new TextEncoder().encode(files['manifest.json']))
    expect(await provider.readFile('com.example.pkg/workflows/read.js'))
      .toEqual(new TextEncoder().encode(files['workflows/read.js']))
  })

  it('leaves NOTHING on the mount when one file fails verification', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    // Corrupt one checksum — as if the registry or the download was tampered.
    const tampered: RegistryManifestPackage = {
      ...pkg,
      files: pkg.files.map(file =>
        file.path.endsWith('read.js') ? { ...file, sha256: '0'.repeat(64) } : file,
      ),
    }
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, tampered, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'SHA256_MISMATCH' })
    await expect(provider.stat('com.example.pkg')).rejects.toThrow()
    await expect(provider.stat('.com.example.pkg.installing')).rejects.toThrow()
  })

  it('forces the registry config.json to the disabled default (never trusts a shipped activation)', async () => {
    // A malicious registry could ship activation:enabled to bypass the
    // on-site opt-in consent flow.
    const files = fixtureFiles({
      ...TOOL_MANIFEST,
      config: undefined,
      // (extra manifest fields are tolerated by validateManifest only via the
      // exact-fields rule — keep the manifest clean and poison config.json.)
    } as never)
    const servingFiles = { ...files, 'config.json': '{"activation":"enabled"}' }
    const pkg = await pkgWithFiles(servingFiles)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(servingFiles) })
    // The installed config.json is ALWAYS the LITERAL disabled default —
    // asserted against the literal, NOT `INSTALLER_DEFAULT_CONFIG` (finding:
    // "Enabled default passes test"): the constant is what the installer
    // writes, so comparing against it would still pass if the constant were
    // ever changed to `{ activation: 'enabled' }` and silently armed every
    // installed package without consent.
    expect(JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/config.json'))))
      .toEqual({ activation: 'disabled' })
  })

  it('rejects aliased registry paths that would overwrite each other', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const aliased: RegistryManifestPackage = {
      ...pkg,
      files: [
        ...pkg.files,
        { path: 'packages/com.example.pkg/workflows/./read.js', sha256: await sha256Of(WORKFLOW_SOURCE) },
      ],
    }
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, aliased, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('replaces a previous install atomically via the staging rename', async () => {
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await installPackage(registry, await validPkg(), provider, { fetchImpl: fetchServing(fixtureFiles()) })

    const v2Manifest = { ...TOOL_MANIFEST, version: '2.0.0' }
    const v2Files = {
      'manifest.json': JSON.stringify(v2Manifest),
      'workflows/read.js': WORKFLOW_SOURCE,
      'extra.js': 'x',
    }
    const v2Pkg = await pkgWithFiles(v2Files, { version: '2.0.0' })
    await installPackage(registry, v2Pkg, provider, { fetchImpl: fetchServing(v2Files) })

    await expect(provider.stat('com.example.pkg/extra.js')).resolves.toMatchObject({ kind: 'file' })
    const listed = await provider.readdir('com.example.pkg')
    // The installer always appends the disabled-default config.json.
    expect(listed.map(entry => entry.name).sort()).toEqual(['config.json', 'extra.js', 'manifest.json', 'workflows'])
    // No staging/backup leftovers.
    await expect(provider.stat('.com.example.pkg.installing')).rejects.toThrow()
    await expect(provider.stat('.com.example.pkg.previous')).rejects.toThrow()
    const mountRoot = await provider.readdir('')
    expect(mountRoot.map(entry => entry.name).sort()).toEqual(['com.example.pkg'])
  })

  it('fails with DOWNLOAD_FAILED when a file 404s and writes nothing', async () => {
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const missing: RegistryManifestPackage = {
      ...pkg,
      files: [...pkg.files, { path: 'packages/com.example.pkg/gone.js', sha256: 'a'.repeat(64) }],
    }
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, missing, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    await expect(provider.stat('com.example.pkg')).rejects.toThrow()
    await expect(provider.stat('.com.example.pkg.installing')).rejects.toThrow()
  })
})

describe('installPackage — package validation at install time', () => {
  it('rejects a downloaded manifest whose id does not match the registry id', async () => {
    const files = fixtureFiles({ ...TOOL_MANIFEST, id: 'com.other.pkg' })
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
    await expect(provider.stat('com.example.pkg')).rejects.toThrow()
  })

  it('rejects a manifest that violates the extension package schema', async () => {
    const files = fixtureFiles({ ...TOOL_MANIFEST, version: 'not-semver' })
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('rejects a manifest whose urlRegex is not a valid tool URL pattern', async () => {
    // No ^...$ anchors — the extension's validateUrlRegex rejects it.
    const files = fixtureFiles({
      ...TOOL_MANIFEST,
      tools: [{ ...TOOL_MANIFEST.tools[0], urlRegex: 'https://example\\.com/.*' }],
    })
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('rejects a package whose referenced tool source is missing', async () => {
    // manifest.json downloads fine, but workflows/read.js is not in the file
    // list — the extension's validatePackage rejects the missing tool source.
    const files = { 'manifest.json': JSON.stringify(TOOL_MANIFEST) }
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('rejects a tool source that is not a valid workflow', async () => {
    const files = { 'manifest.json': JSON.stringify(TOOL_MANIFEST), 'workflows/read.js': 'export default {}' }
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })
})

describe('installPackage — resource limits', () => {
  it('rejects a manifest listing more than the file-count cap before downloading', async () => {
    const pkg = await validPkg()
    const many: RegistryManifestPackage = {
      ...pkg,
      files: [...pkg.files, ...Array.from({ length: MAX_PACKAGE_FILES }, (_, i) => ({
        path: `packages/com.example.pkg/filler/${i}.js`,
        sha256: 'a'.repeat(64),
      }))],
    }
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Rejected BEFORE any download happens.
    await expect(installPackage(registry, many, provider, { fetchImpl: fetchNever() }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('rejects a single file above the per-file size cap', async () => {
    const files = fixtureFiles()
    files['workflows/read.js'] = 'x'.repeat(MAX_PACKAGE_FILE_BYTES + 1)
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
  })

  it('rejects when the total staged size exceeds the package cap', async () => {
    const chunk = 'x'.repeat(1024 * 1024)
    const fillerCount = Math.ceil(MAX_PACKAGE_TOTAL_BYTES / chunk.length)
    const files: Record<string, string> = { 'manifest.json': JSON.stringify(TOOL_MANIFEST) }
    for (let i = 0; i < fillerCount; i += 1) files[`filler/${i}.js`] = chunk
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
    await expect(provider.stat('com.example.pkg')).rejects.toThrow()
  })

  it('aborts a download that never completes (bounded timeout)', async () => {
    const pkg = await validPkg()
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const hanging: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch
    await expect(installPackage(registry, pkg, provider, { fetchImpl: hanging, timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
  })
})

describe('installPackage — failed replacement keeps the old package', () => {
  it('preserves the previous install when a staging write fails', async () => {
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, await validPkg(), provider, { fetchImpl: fetchServing(fixtureFiles()) })
    const before = await provider.readFile('com.example.pkg/manifest.json')

    // v2 downloads fine but the provider refuses a write mid-tree.
    const v2Manifest = { ...TOOL_MANIFEST, version: '2.0.0' }
    const v2Files = { 'manifest.json': JSON.stringify(v2Manifest), 'workflows/read.js': WORKFLOW_SOURCE }
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    const failing = new Proxy(provider, {
      get(target, prop, receiver) {
        if (prop === 'writeFile') {
          return async (path: string, bytes: Uint8Array) => {
            if (String(path).startsWith('.com.example.pkg.installing/')) {
              throw new Error('quota exceeded mid-write')
            }
            return (Reflect.get(target, prop, receiver) as typeof provider.writeFile).call(target, path, bytes)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    await expect(installPackage(registry, v2, failing, { fetchImpl: fetchServing(v2Files) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })

    // The OLD package is still intact and byte-identical.
    expect(await provider.readFile('com.example.pkg/manifest.json')).toEqual(before)
    const listed = await provider.readdir('')
    expect(listed.map(entry => entry.name).sort()).toEqual(['com.example.pkg'])
  })

  it('ABORTS before removing the live package when the backup cannot be listed (no-rename provider)', async () => {
    // Finding: "Backup failure loses old package" — a readdir error during
    // the backup must be a backup FAILURE, not "source absent": treating it
    // as absent would proceed without a backup and let a later failure
    // delete the only copy.
    const full = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, await validPkg(), full, { fetchImpl: fetchServing(fixtureFiles()) })
    const before = await full.readFile('com.example.pkg/manifest.json')

    const bridge = {
      stat: (path: string) => full.stat(path),
      readdir: (path: string) => {
        if (path === 'com.example.pkg') throw new Error('readdir exploded')
        return full.readdir(path)
      },
      readFile: (path: string) => full.readFile(path),
      writeFile: (path: string, bytes: Uint8Array) => full.writeFile(path, bytes),
      mkdir: (path: string, options?: { recursive?: boolean }) => full.mkdir(path, options),
      remove: (path: string, options?: { recursive?: boolean }) => full.remove(path, options),
    }
    const v2Manifest = { ...TOOL_MANIFEST, version: '2.0.0' }
    const v2Files = { 'manifest.json': JSON.stringify(v2Manifest), 'workflows/read.js': WORKFLOW_SOURCE }
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    await expect(installPackage(registry, v2, bridge, { fetchImpl: fetchServing(v2Files) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })

    // The live package was never touched.
    expect(await full.readFile('com.example.pkg/manifest.json')).toEqual(before)
    expect((await full.readdir('')).map(entry => entry.name).sort()).toEqual(['com.example.pkg'])
  })

  it('PRESERVES the backup when both replacement and restore fail (no-rename provider)', async () => {
    // Finding (critical): "Failed rollback deletes working package" — when
    // the swap fails AND restoring the backup fails, the backup directory
    // must survive: it holds the only remaining copy of the old package.
    const full = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, await validPkg(), full, { fetchImpl: fetchServing(fixtureFiles()) })
    const before = await full.readFile('com.example.pkg/manifest.json')

    let liveWrites = 0
    let backupRestoreAttempted = false
    const bridge = {
      stat: (path: string) => full.stat(path),
      readdir: (path: string) => full.readdir(path),
      readFile: (path: string) => full.readFile(path),
      writeFile: (path: string, bytes: Uint8Array) => {
        const p = String(path)
        if (p.startsWith('com.example.pkg/') && !p.startsWith('com.example.pkg/.') ) {
          liveWrites += 1
          // Fail the FIRST write into the live dir AND the restore writes.
          if (liveWrites === 1 || backupRestoreAttempted) throw new Error('bridge write refused')
        }
        if (p.startsWith('.com.example.pkg.previous/')) backupRestoreAttempted = true
        return full.writeFile(path, bytes)
      },
      mkdir: (path: string, options?: { recursive?: boolean }) => full.mkdir(path, options),
      remove: (path: string, options?: { recursive?: boolean }) => full.remove(path, options),
    }
    const v2Manifest = { ...TOOL_MANIFEST, version: '2.0.0' }
    const v2Files = { 'manifest.json': JSON.stringify(v2Manifest), 'workflows/read.js': WORKFLOW_SOURCE }
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    await expect(installPackage(registry, v2, bridge, { fetchImpl: fetchServing(v2Files) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })

    // The backup SURVIVED (deleting it would have destroyed the only copy).
    await expect(full.stat('.com.example.pkg.previous')).resolves.toMatchObject({ kind: 'directory' })
    expect(await full.readFile('.com.example.pkg.previous/manifest.json')).toEqual(before)
  })

  it('ABORTS and keeps the backup when the live-package stat is INDETERMINATE (round 3)', async () => {
    // Finding: "Retry deletes the last backup" — a stat that fails with
    // something OTHER than ENOENT (transient/permission error) must not read
    // as "exists": that is how a retry skipped backup recovery and then
    // deleted the preserved backup. The swap refuses and the backup survives.
    const full = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, await validPkg(), full, { fetchImpl: fetchServing(fixtureFiles()) })
    const before = await full.readFile('com.example.pkg/manifest.json')
    // Simulate the post-failure state: only the backup remains.
    if (!full.rename) throw new Error('memory provider must support rename')
    await full.rename('com.example.pkg', '.com.example.pkg.previous')

    let liveStatCalls = 0
    const flaky = {
      stat: (path: string) => {
        if (String(path) === 'com.example.pkg') {
          liveStatCalls += 1
          throw new Error('EACCES: transient stat failure')
        }
        return full.stat(path)
      },
      readdir: (path: string) => full.readdir(path),
      readFile: (path: string) => full.readFile(path),
      writeFile: (path: string, bytes: Uint8Array) => full.writeFile(path, bytes),
      mkdir: (path: string, options?: { recursive?: boolean }) => full.mkdir(path, options),
      remove: (path: string, options?: { recursive?: boolean }) => full.remove(path, options),
    }
    const v2Files = { 'manifest.json': JSON.stringify({ ...TOOL_MANIFEST, version: '2.0.0' }), 'workflows/read.js': WORKFLOW_SOURCE }
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    await expect(installPackage(registry, v2, flaky, { fetchImpl: fetchServing(v2Files) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    expect(liveStatCalls).toBeGreaterThan(0)
    // The preserved backup was NOT touched — it still holds the old package.
    expect(await full.readFile('.com.example.pkg.previous/manifest.json')).toEqual(before)
  })

  it('removes the PARTIAL live directory when a FIRST install fails mid-copy', async () => {
    // Finding: "Failed first install leaves partial package" — nothing to
    // roll back to, so the half-written directory must be removed instead
    // of being reported as installed.
    const full = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    let refused = false
    const bridge = {
      stat: (path: string) => full.stat(path),
      readdir: (path: string) => full.readdir(path),
      readFile: (path: string) => full.readFile(path),
      writeFile: (path: string, bytes: Uint8Array) => {
        if (String(path).startsWith('com.example.pkg/') && !refused) {
          refused = true
          throw new Error('bridge write refused')
        }
        return full.writeFile(path, bytes)
      },
      mkdir: (path: string, options?: { recursive?: boolean }) => full.mkdir(path, options),
      remove: (path: string, options?: { recursive?: boolean }) => full.remove(path, options),
    }
    const pkg = await validPkg()
    await expect(installPackage(registry, pkg, bridge, { fetchImpl: fetchServing(fixtureFiles()) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })
    // No partial package and no staging leftovers remain.
    await expect(full.stat('com.example.pkg')).rejects.toThrow()
    expect((await full.readdir('')).filter(entry => !entry.name.startsWith('.')).map(entry => entry.name)).toEqual([])
  })

  it('preserves the previous install on a provider WITHOUT rename (the extension bridge)', async () => {
    // The bridge provider exposes stat/readdir/readFile/writeFile/mkdir/remove
    // only — there is no atomic rename, so the installer must fall back to
    // the copy-aside + restore path.
    const full = memoryProvider()
    const bridge = {
      stat: (path: string) => full.stat(path),
      readdir: (path: string) => full.readdir(path),
      readFile: (path: string) => full.readFile(path),
      writeFile: (path: string, bytes: Uint8Array) => full.writeFile(path, bytes),
      mkdir: (path: string, options?: { recursive?: boolean }) => full.mkdir(path, options),
      remove: (path: string, options?: { recursive?: boolean }) => full.remove(path, options),
    }
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, await validPkg(), bridge, { fetchImpl: fetchServing(fixtureFiles()) })
    const before = await full.readFile('com.example.pkg/manifest.json')

    // v2 fails while copying the new tree into place.
    const v2Manifest = { ...TOOL_MANIFEST, version: '2.0.0' }
    const v2Files = { 'manifest.json': JSON.stringify(v2Manifest), 'workflows/read.js': WORKFLOW_SOURCE }
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    let failed = false
    const failing = {
      ...bridge,
      writeFile: async (path: string, bytes: Uint8Array) => {
        // Fail ONCE while the new tree is copied into the live directory
        // (the rollback that follows must be able to write again).
        if (String(path).startsWith('com.example.pkg/') && !String(path).includes('.installing') && !failed) {
          failed = true
          throw new Error('bridge write refused')
        }
        return full.writeFile(path, bytes)
      },
    }
    await expect(installPackage(registry, v2, failing, { fetchImpl: fetchServing(v2Files) }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' })

    // The OLD package survived the failed replacement.
    expect(await full.readFile('com.example.pkg/manifest.json')).toEqual(before)
    const roots = (await full.readdir('')).map(entry => entry.name).sort()
    expect(roots).toEqual(['com.example.pkg'])
  })
})

describe('installPackage — overlapping operations', () => {
  /** Distinct workflow source per version (finding: "Torn versions pass
   * concurrency test"): a shared source would let a TORN tree — one
   * version's manifest next to the other version's workflow — pass the
   * coherence check, since the workflow assertion could not tell which
   * version the file came from. */
  const workflowSourceFor = (version: string) => WORKFLOW_SOURCE.replace("'title'", `'title-v${version}'`)

  /** The installed tree must be ONE complete version: manifest and workflow
   * contents must both come from the SAME fixture (never a torn mix). */
  async function expectCoherentInstall(provider: ReturnType<typeof memoryProvider>): Promise<'1.0.0' | '2.0.0'> {
    const manifest = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/manifest.json'))) as { version: string }
    expect(['1.0.0', '2.0.0']).toContain(manifest.version)
    const workflow = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    // The workflow must belong to the SAME version as the manifest — a torn
    // tree (manifest v1 + workflow v2) fails this assertion.
    expect(workflow).toBe(workflowSourceFor(manifest.version))
    // The installer always appends the disabled-default config.json
    // (asserted against the literal — see the finding note above).
    expect(JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/config.json'))))
      .toEqual({ activation: 'disabled' })
    const listed = (await provider.readdir('com.example.pkg')).map(entry => entry.name).sort()
    expect(listed).toEqual(['config.json', 'manifest.json', 'workflows'])
    return manifest.version as '1.0.0' | '2.0.0'
  }

  it('serializes two installs of the same id (each ends with a complete tree)', async () => {
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const v1Files: Record<string, string> = { ...fixtureFiles(), 'workflows/read.js': workflowSourceFor('1.0.0') }
    const v1Manifest = { ...TOOL_MANIFEST, version: '1.0.0' }
    v1Files['manifest.json'] = JSON.stringify(v1Manifest)
    const v2Files = {
      'manifest.json': JSON.stringify({ ...TOOL_MANIFEST, version: '2.0.0' }),
      'workflows/read.js': workflowSourceFor('2.0.0'),
    }
    const v1 = await pkgWithFiles(v1Files)
    const v2 = await pkgWithFiles(v2Files, { version: '2.0.0' })
    const [r1, r2] = await Promise.all([
      installPackage(registry, v1, provider, { fetchImpl: fetchServing(v1Files) }),
      installPackage(registry, v2, provider, { fetchImpl: fetchServing(v2Files) }),
    ])
    expect(r1.filesWritten).toBeGreaterThan(0)
    expect(r2.filesWritten).toBeGreaterThan(0)
    // The final directory is ONE complete version, never a mix, and no
    // staging leftovers remain.
    await expectCoherentInstall(provider)
    expect((await provider.readdir('')).map(entry => entry.name).sort()).toEqual(['com.example.pkg'])
  })

  it('serializes an uninstall against a running install', async () => {
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Same per-version workflow source as the test above, so a torn tree
    // cannot pass the coherence check here either.
    const files: Record<string, string> = { ...fixtureFiles(), 'workflows/read.js': workflowSourceFor('1.0.0') }
    files['manifest.json'] = JSON.stringify({ ...TOOL_MANIFEST, version: '1.0.0' })
    const pkg = await pkgWithFiles(files)
    const installPromise = installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    const uninstallPromise = uninstallPackage('com.example.pkg', provider)
    await Promise.all([installPromise, uninstallPromise])
    // Whichever ran last wins — the package is either ABSENT or ONE
    // complete, coherent install (never an empty or partial directory).
    const roots = (await provider.readdir('')).map(entry => entry.name).sort()
    expect(roots).toEqual(roots.includes('com.example.pkg') ? ['com.example.pkg'] : [])
    if (roots.includes('com.example.pkg')) await expectCoherentInstall(provider)
    expect(roots.filter(name => name.includes('installing') || name.includes('previous'))).toEqual([])
  })
})

describe('uninstallPackage', () => {
  it('removes the package directory including the activation override', async () => {
    const pkg = await validPkg()
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(fixtureFiles()) })
    await provider.writeFile('com.example.pkg/config.json', new TextEncoder().encode(JSON.stringify({ activation: 'enabled' })))

    await uninstallPackage('com.example.pkg', provider)

    await expect(provider.stat('com.example.pkg')).rejects.toThrow()
  })

  it('is idempotent for a package that was never installed', async () => {
    const provider = memoryProvider()
    await expect(uninstallPackage('com.never.installed', provider)).resolves.toBeUndefined()
  })
})

describe('sha256Hex', () => {
  it('matches the sha256 of the empty string', async () => {
    expect(await sha256Hex(new Uint8Array(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('PackageInstallError', () => {
  it('carries a structured code', () => {
    expect(new PackageInstallError('x', 'INVALID_PACKAGE').code).toBe('INVALID_PACKAGE')
  })
})
