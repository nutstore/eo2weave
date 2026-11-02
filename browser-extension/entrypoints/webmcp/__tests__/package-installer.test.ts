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
  const version = (JSON.parse(files['manifest.json']!) as { version?: string }).version ?? '1.0.0'
  return {
    id: 'com.example.pkg',
    version,
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

  it('stops mirror fallback on a non-404 client error from a candidate (403)', async () => {
    // A 403 is a DEFINITIVE client error: without the status on the error the
    // fallback treated it as a generic transport failure and asked a second
    // origin for a file the first origin refused to serve (finding:
    // "Canonical client errors are masked").
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const tried: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      tried.push(url)
      if (url.startsWith(RAW)) return { ok: false, status: 403 } as unknown as Response
      return fetchServing(files)(input)
    }) as typeof fetch

    await expect(installPackage(registry, pkg, provider, { fetchImpl, preference: 'global' }))
      .rejects.toThrow(/HTTP 403/)
    // The mirror was NEVER asked — the client error stopped the fallback.
    expect(tried.every(url => !url.startsWith(MIRROR))).toBe(true)
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

  it('restores a manifest-only partial tree from the backup instead of trusting it', async () => {
    // A prior restore copied manifest.json and died before the rest of the
    // package: the live tree holds a parseable manifest but no content
    // files, and the backup holds the only COMPLETE copy. The recovery gate
    // must treat the partial live tree as INCOMPLETE and restore over it —
    // trusting the manifest alone would clear the backup and the swap's
    // pre-cleanup would destroy the only complete copy.
    //
    // The proof isolates the BACKUP as the content source (finding:
    // "Recovery tests don't prove backup recovery"): the backup carries
    // DISTINCT workflow content that is NOT in the download fixture, and
    // the replacement's own swap write is made to fail AFTER recovery ran.
    // The final mount can then hold the backup's workflow text ONLY if the
    // recovery path copied the backup — the failed swap never wrote its
    // own copy, so the old "assert the download's content" assertions
    // passed even with recovery broken.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    // Live tree: a parseable manifest only — visibly incomplete.
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile('com.example.pkg/manifest.json', new TextEncoder().encode(JSON.stringify(TOOL_MANIFEST)))
    // Backup: the complete package, but with DISTINCT workflow content the
    // fixture download does not contain.
    const BACKUP_WORKFLOW = 'export default { fromBackup: true }'
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      await provider.writeFile(
        `.com.example.pkg.previous/${path}`,
        new TextEncoder().encode(path === 'workflows/read.js' ? BACKUP_WORKFLOW : content),
      )
    }

    // The replacement's own copy-in fails (storage failure on the staged
    // write), so the download's fixture content never reaches the live
    // tree — the install reports the storage failure, and whatever survives
    // on the mount must come from the backup recovery.
    const failingWrite = provider.writeFile.bind(provider)
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path.startsWith('.com.example.pkg.installing/')) throw new Error('EIO: simulated staging write failure')
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    // No `rename` — exercise the COPY swap path (the production OPFS shape).
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toThrow(/Failed to write package/)

    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(BACKUP_WORKFLOW)
    const manifest = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/manifest.json')))
    expect(manifest.id).toBe('com.example.pkg')
  })

  it('probes the backup even when an incomplete live directory exists', async () => {
    // Same precondition, reached differently: the live directory exists AND
    // the backup holds the complete copy. The old code set backupExists
    // whenever the live directory existed, so the recovery gate never ran
    // and the pre-swap cleanup deleted the preserved copy.
    //
    // Same proof shape: DISTINCT backup content + a failing swap write, so
    // the surviving workflow text can only be the backup's (finding:
    // "Recovery tests don't prove backup recovery").
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    // Live tree: config only (no manifest) — visibly incomplete.
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile('com.example.pkg/config.json', new TextEncoder().encode('{}'))
    // Backup: the complete package with DISTINCT workflow content.
    const BACKUP_WORKFLOW = 'export default { fromBackup: true }'
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      await provider.writeFile(
        `.com.example.pkg.previous/${path}`,
        new TextEncoder().encode(path === 'workflows/read.js' ? BACKUP_WORKFLOW : content),
      )
    }

    const failingWrite = provider.writeFile.bind(provider)
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path.startsWith('.com.example.pkg.installing/')) throw new Error('EIO: simulated staging write failure')
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toThrow(/Failed to write package/)

    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(BACKUP_WORKFLOW)
    expect(await listFiles(provider, 'com.example.pkg')).toContain('workflows')
  })

  it('keeps the backup when the rollback cannot remove the partial live tree', async () => {
    // A failing replacement whose PARTIAL live tree cannot be removed must
    // NOT copy the backup over the leftovers (copyTree keeps extra files)
    // and then clear the backup — that would leave a mixed package with the
    // backup, the only clean copy, gone.
    const files = fixtureFiles()
    const full = fixtureFiles({ ...TOOL_MANIFEST, version: '2.0.0' })
    const pkg = await pkgWithFiles(full, { version: '2.0.0' })
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Old install in place.
    await provider.mkdir('com.example.pkg', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      await provider.writeFile(`com.example.pkg/${path}`, new TextEncoder().encode(content))
    }
    // The replacement's staged copy-in dies mid-copy (a storage failure on
    // one of the package's files), and BOTH the rollback's partial-tree
    // removal and the backup removal fail (storage failure) too, so a
    // copy-over rollback would leave BOTH versions' files mixed and would
    // then try to clear the backup it failed to restore from. `rename` is
    // stripped so the swap uses the COPY path — the production OPFS
    // provider has no rename, and that is the path this finding is about.
    // The FIRST removal of the live tree (before the copy-in) still
    // succeeds — only the ROLLBACK-time removal fails.
    const failingRemove = provider.remove.bind(provider)
    const failingWrite = provider.writeFile.bind(provider)
    let liveRemovals = 0
    provider.remove = (async (path: string, options?: { recursive?: boolean }) => {
      if (path === 'com.example.pkg') {
        liveRemovals += 1
        if (liveRemovals >= 2) throw new Error('EIO: simulated removal failure')
      }
      return failingRemove(path, options)
    }) as typeof provider.remove
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path === 'com.example.pkg/workflows/read.js') throw new Error('EIO: simulated write failure')
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(full) }))
      .rejects.toThrow(/previous install was preserved/)

    // The backup survives with the COMPLETE old package...
    const backupManifest = JSON.parse(new TextDecoder().decode(await provider.readFile('.com.example.pkg.previous/manifest.json')))
    expect(backupManifest.version).toBe('1.0.0')
    // ...and the live tree was NOT left as a copy-over mixture of the old
    // workflow file and the new package's files.
    const liveFiles = (await listFiles(provider, 'com.example.pkg')).sort()
    expect(liveFiles).toEqual(['config.json', 'manifest.json', 'workflows'])
  })

  it('aborts the install when the package was uninstalled while the download ran', async () => {
    // The download+validation happen BEFORE the lock; an uninstall can win
    // the lock race in between. Without the presence fence the install then
    // saw "no collision" and wrote the package back — the user watched a
    // package they had just removed reappear (finding: "Uninstalled package
    // reappears").
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    // An old install is present when the install STARTS…
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile('com.example.pkg/config.json', new TextEncoder().encode('{}'))
    // …and a concurrent uninstall removes it while the download is running
    // (simulated by deleting the directory during the LAST download fetch —
    // the download phase never touches the mount, so the directory stays
    // gone when the lock is finally acquired).
    const serving = fetchServing(files)
    const fileUrls = Object.keys(files).map(path => `${RAW}/packages/com.example.pkg/${path}`)
    let downloadsLeft = fileUrls.length
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (fileUrls.includes(url)) {
        downloadsLeft -= 1
        if (downloadsLeft === 0) await provider.remove('com.example.pkg', { recursive: true })
      }
      return serving(input)
    }) as typeof fetch

    await expect(installPackage(registry, pkg, provider, { fetchImpl })).rejects.toThrow(
      /was removed while it was being prepared/,
    )
    // The removed package was NOT resurrected.
    expect(await listFiles(provider, '')).toEqual([])
  })

  it('keeps the backup when the rollback RESTORE copy itself fails', async () => {
    // SECURITY (critical, "Rollback failure deletes last copy"): when the
    // copy-in fails and the rollback's restore copy ALSO fails (a storage
    // error mid-restore, after the partial live tree was removed), the
    // backup is the only surviving copy of the working package. The old
    // code left `backupPreserved` false on this path, so the finally block
    // deleted the backup — leaving NEITHER the old package nor a complete
    // replacement. The restore failure must preserve the backup instead;
    // the next install's recovery gate can still restore it.
    const files = fixtureFiles()
    const full = fixtureFiles({ ...TOOL_MANIFEST, version: '2.0.0' })
    const pkg = await pkgWithFiles(full, { version: '2.0.0' })
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Old (working) install in place.
    await provider.mkdir('com.example.pkg', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      await provider.writeFile(`com.example.pkg/${path}`, new TextEncoder().encode(content))
    }
    // The copy-in of the new tree fails mid-copy (after the live tree was
    // removed), and the rollback's restore copy fails too — BOTH on the
    // live-tree write path. The FIRST restore removal of the live tree
    // still succeeds, so the restore copy is the step that fails.
    const failingWrite = provider.writeFile.bind(provider)
    let liveWrites = 0
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path === 'com.example.pkg/workflows/read.js') {
        liveWrites += 1
        // 1st: the swap's staged copy-in (staging path is separate — this
        // counts only the LIVE tree writes: copy-in + restore).
        if (liveWrites >= 1) throw new Error('EIO: simulated live write failure')
      }
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(full) }))
      .rejects.toThrow(/previous install could not be restored/)

    // The backup SURVIVES with the complete old package — the finally
    // cleanup must not have deleted the only remaining copy.
    const backupManifest = JSON.parse(new TextDecoder().decode(await provider.readFile('.com.example.pkg.previous/manifest.json')))
    expect(backupManifest.version).toBe('1.0.0')
    expect(await provider.readFile('.com.example.pkg.previous/workflows/read.js')).toBeInstanceOf(Uint8Array)
  })
})
