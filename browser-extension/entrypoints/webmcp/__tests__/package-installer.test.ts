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

const { installPackage, uninstallPackage, sha256Hex, PackageInstallError, resetUninstallIntentStateForTest } = await import('../package-installer')
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
    // The uninstall-INTENT map is module state shared by every test in this
    // file. Tests exercising the fence (and the fake-timer tests, whose
    // records are written against a clock that ends up AHEAD of the real
    // one) leave records behind that read as "uninstalled in the future" —
    // without the reset they spuriously fence later tests' installs
    // (production expires records by TTL instead; this export never runs
    // there).
    resetUninstallIntentStateForTest()
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

  it('falls through a stale mirror to the canonical origin instead of aborting the install', async () => {
    // MEDIUM ("Stale mirrors abort installs"): a mirror can serve STALE
    // bytes with a successful 200. Checking the checksum only after the
    // fallback returned aborted the whole install even when the NEXT
    // candidate served the catalog-matching file. The verification now
    // runs inside the candidate attempt and a mismatch falls through.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const staleFiles = { ...files, 'workflows/read.js': 'export default { stale: true }' }
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      // The FIRST candidate (the canonical raw host) serves STALE bytes.
      if (url.startsWith(RAW)) return fetchServing(staleFiles)(input)
      // The mirror has the catalog-matching file.
      return fetchServing(files)(input)
    }) as typeof fetch

    const result = await installPackage(registry, pkg, provider, { fetchImpl, preference: 'global' })

    expect(result.filesWritten).toBeGreaterThan(0)
    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(WORKFLOW_SOURCE)
  })

  it('still reports SHA256_MISMATCH when EVERY candidate serves stale bytes', async () => {
    const staleFiles = { ...fixtureFiles(), 'workflows/read.js': 'export default { stale: true }' }
    const pkg = await pkgWithFiles(fixtureFiles())
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(staleFiles) }))
      .rejects.toThrow(/Checksum mismatch/)
    // Nothing was written.
    expect(await listFiles(provider, '')).toEqual([])
  })

  it('uninstall removes the package directory AND a preserved backup', async () => {
    // MEDIUM ("Uninstalled packages reappear"): a failed replacement leaves
    // a `.${id}.previous` backup; removing only the live directory left the
    // backup behind and a later failed install restored it — the explicitly
    // uninstalled package came back.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    // A failed replacement left a preserved backup behind.
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    await provider.writeFile('.com.example.pkg.previous/manifest.json', new TextEncoder().encode('{}'))

    await uninstallPackage('com.example.pkg', provider)

    expect(await listFiles(provider, '')).toEqual([])
  })

  it('honors an uninstall intent recorded while the install preflight ran (fence anchor predates preflight)', async () => {
    // MEDIUM ("Fence compares against the wrong clock"): `installPackage`
    // captured `startedAt` AFTER its callers' async preflight, so an intent
    // recorded during that preflight compared as OLDER than the install and
    // passed the `at >= since` fence — the install resurrected the package.
    // The start time must anchor BEFORE any async install work.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const serving = fetchServing(files)
    const fileUrls = Object.keys(files).map(path => `${RAW}/packages/com.example.pkg/${path}`)
    let downloadsLeft = fileUrls.length
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (fileUrls.includes(url)) {
        downloadsLeft -= 1
        if (downloadsLeft === 0) {
          // A concurrent uninstall records its intent DURING the download —
          // i.e. before the install reaches the fence but, with the bug,
          // after the install's (late) start-time capture.
          await uninstallPackage('com.example.pkg', provider)
        }
      }
      return serving(input)
    }) as typeof fetch

    await expect(installPackage(registry, pkg, provider, { fetchImpl }))
      .rejects.toThrow(/was uninstalled while it was being prepared/)
    expect(await listFiles(provider, '')).toEqual([])
  })

  it('keeps an install-started-before-uninstall fenceable even after the intent TTL expires', async () => {
    // MEDIUM ("Pruned intent resurrects an uninstalled package"): intent
    // records expire after 10 minutes, but a still-running install that
    // STARTED before the uninstall only evaluates the fence when it finally
    // acquires the lock — pruning the record first dropped the removal
    // evidence and the install resurrected the package. The prune must keep
    // intents whose timestamp postdates a pending install's start.
    vi.useFakeTimers()
    try {
      // Confirm the TTL constant under test: the prune must outlive it.
      const { UNINSTALL_INTENT_TTL_MS: ttl } = (await import('../package-installer')) as { UNINSTALL_INTENT_TTL_MS?: number }
      expect(ttl === undefined || ttl <= 11 * 60_000).toBe(true)
      const files = fixtureFiles()
      const pkg = await pkgWithFiles(files)
      const provider = memoryProvider()
      const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
      const serving = fetchServing(files)
      const fileUrls = Object.keys(files).map(path => `${RAW}/packages/com.example.pkg/${path}`)
      let downloadsLeft = fileUrls.length
      let releaseDownload: (() => void) | undefined
      const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve })
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input)
        if (fileUrls.includes(url)) {
          downloadsLeft -= 1
          if (downloadsLeft === 0) {
            // Hold the LAST download until the uninstall + TTL have passed.
            await downloadGate
          }
        }
        return serving(input)
      }) as typeof fetch

      const install = installPackage(registry, pkg, provider, { fetchImpl })
      // Give the install time to capture its start and reach the held
      // download, then uninstall while the install is still pending.
      await vi.advanceTimersByTimeAsync(50)
      await uninstallPackage('com.example.pkg', provider)
      // Now let the intent TTL lapse WELL past its 10 minutes while the
      // install has still not evaluated its fence.
      await vi.advanceTimersByTimeAsync(11 * 60_000)
      // The prune ran (recording + reading intents); release the download.
      releaseDownload!()
      await expect(install).rejects.toThrow(/was uninstalled while it was being prepared/)
      expect(await listFiles(provider, '')).toEqual([])
    } finally {
      // The uninstall above recorded its intent against the FAKE clock,
      // which at restore time sits ahead of the real one — without this
      // cleanup the record would read as "uninstalled in the future" and
      // spuriously fence later tests' installs (production expires it by
      // TTL; tests reset the module state explicitly).
      resetUninstallIntentStateForTest()
      vi.useRealTimers()
    }
  })

  it('keeps a same-millisecond install fenced after its peer fails', async () => {
    vi.useFakeTimers()
    try {
      const files = fixtureFiles()
      const pkg = await pkgWithFiles(files)
      const provider = memoryProvider()
      const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
      const serving = fetchServing(files)
      let releaseDownload: (() => void) | undefined
      const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve })
      const fileUrls = Object.keys(files).map(path => `${RAW}/packages/com.example.pkg/${path}`)
      let downloadsLeft = fileUrls.length
      const heldFetch = (async (input: RequestInfo | URL) => {
        if (fileUrls.includes(String(input)) && --downloadsLeft === 0) await downloadGate
        return serving(input)
      }) as typeof fetch
      const failingFetch = (async () => { throw new Error('network unavailable') }) as typeof fetch

      const failed = expect(installPackage(registry, pkg, provider, { fetchImpl: failingFetch })).rejects.toThrow()
      const pending = installPackage(registry, pkg, provider, { fetchImpl: heldFetch })
      await vi.advanceTimersByTimeAsync(50)
      await failed
      await uninstallPackage('com.example.pkg', provider)
      await vi.advanceTimersByTimeAsync(11 * 60_000)
      releaseDownload!()
      await expect(pending).rejects.toThrow(/was uninstalled while it was being prepared/)
    } finally {
      resetUninstallIntentStateForTest()
      vi.useRealTimers()
    }
  })

  it('does NOT report a clean uninstall when the preserved backup cannot be removed', async () => {
    // MEDIUM ("Uninstall succeeds while its backup survives"): the backup
    // removal failure was swallowed, the uninstall reported success while
    // `.${id}.previous` stayed on the mount, and a later failed install's
    // recovery gate restored it — the uninstalled package resurrected. The
    // failure must surface so the caller can retry.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // The intent map is module state that earlier tests in this file wrote
    // against a DIFFERENT clock (fake timers); those stale records would
    // read as "uninstalled in the future" and spuriously fence THIS
    // install. Clear them (production expires records by TTL instead).
    resetUninstallIntentStateForTest()
    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    await provider.writeFile('.com.example.pkg.previous/manifest.json', new TextEncoder().encode('{}'))

    const failingRemove = provider.remove.bind(provider)
    provider.remove = (async (path: string, options?: { recursive?: boolean }) => {
      if (path === '.com.example.pkg.previous') throw new Error('EIO: simulated backup removal failure')
      return failingRemove(path, options)
    }) as typeof provider.remove

    await expect(uninstallPackage('com.example.pkg', provider)).rejects.toThrow(/preserved backup .* could not be deleted/)
    // The live directory IS gone; the backup remains (its removal failure
    // was surfaced, so no caller mistakes the package for cleanly removed).
    await expect(provider.stat('com.example.pkg')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(provider.stat('.com.example.pkg.previous')).resolves.toBeTruthy()
  })

  it('installs a package whose only uninstall intent predates the install (no stale fence)', async () => {
    // GUARD for the intent fence: an intent that PREDATES the install's
    // start must not abort a legitimate reinstall — the fence compares
    // `intentAt >= startedAt`, so an old record (in production retired by
    // the TTL prune) stays inert. This exercises the OTHER side of the T3
    // change: pruning keeps only records that a pending fence still needs,
    // never records that would over-fence fresh installs.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // An uninstall records the intent NOW; the fresh install afterwards
    // starts AFTER that record and must succeed. Clear the intent map
    // first: earlier tests in this file wrote records against a fake
    // clock, and a stale "future" record would spuriously fence THIS
    // install when the suite runs in file order.
    resetUninstallIntentStateForTest()
    await uninstallPackage('com.example.pkg', provider)
    // The install's fence anchor (`startedAt`) must be STRICTLY newer than
    // the uninstall's intent record: the previous test's fake clock can run
    // the uninstall to completion within the SAME millisecond the install
    // starts, and `at >= since` then misreads the older intent as
    // concurrent. One timer step separates the two (real time always does);
    // under real timers this resolves immediately and stays a no-op.
    await new Promise(resolve => setTimeout(resolve, 1))
    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .resolves.toBeTruthy()
    expect(await listFiles(provider, '')).toEqual(['com.example.pkg'])
  })

  it('aborts an install whose id was uninstalled after the install started', async () => {
    // MEDIUM ("Uninstalled packages return"): an install that STARTS while
    // the id is absent sees presenceBefore=false, so the presence fence
    // cannot fire. If a create→uninstall sequence completes while the
    // download runs, the install would otherwise write the package back and
    // undo the explicit uninstall. The uninstall-intent fence aborts it.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    const serving = fetchServing(files)
    const fileUrls = Object.keys(files).map(path => `${RAW}/packages/com.example.pkg/${path}`)
    let downloadsLeft = fileUrls.length
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (fileUrls.includes(url)) {
        downloadsLeft -= 1
        if (downloadsLeft === 0) {
          // Another install creates the package mid-download…
          await provider.mkdir('com.example.pkg', { recursive: true })
          await provider.writeFile('com.example.pkg/config.json', new TextEncoder().encode('{}'))
          // …and a concurrent uninstall removes it (recording intent).
          await uninstallPackage('com.example.pkg', provider)
        }
      }
      return serving(input)
    }) as typeof fetch

    await expect(installPackage(registry, pkg, provider, { fetchImpl }))
      .rejects.toThrow(/was uninstalled while it was being prepared/)
    expect(await listFiles(provider, '')).toEqual([])
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

  it('does NOT discard the backup over a live tree whose tool CONTENT is corrupt', async () => {
    // MEDIUM ("Corrupt live tree discards backup"): `liveTreeIsComplete`
    // accepted any parseable manifest with a tools array whose paths stat as
    // files — it never validated the CONTENTS. A live tree with garbage tool
    // sources (e.g. a failed/partial restore overwriting the tool file)
    // read as "complete", the recovery gate kept it and the pre-swap
    // cleanup DELETED the complete backup; a later failure then left the
    // corrupt live package as the only copy. Completeness now runs the
    // SAME validators the installer runs at install time
    // (`validateManifest` + `validatePackage` over the live bytes).
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Live tree: intact manifest + config, but the TOOL SOURCE is garbage.
    await provider.mkdir('com.example.pkg', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      const corrupt = path === 'workflows/read.js' ? 'export default { corrupt: true }' : content
      await provider.writeFile(`com.example.pkg/${path}`, new TextEncoder().encode(corrupt))
    }
    // Backup: the COMPLETE package with distinct content.
    const BACKUP_WORKFLOW = 'export default { fromBackup: true }'
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      await provider.writeFile(
        `.com.example.pkg.previous/${path}`,
        new TextEncoder().encode(path === 'workflows/read.js' ? BACKUP_WORKFLOW : content),
      )
    }
    // The swap fails after recovery, so the recovery decision is observable.
    const failingWrite = provider.writeFile.bind(provider)
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path.startsWith('.com.example.pkg.installing/')) throw new Error('EIO: simulated staging write failure')
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) }))
      .rejects.toThrow(/Failed to write package/)

    // The backup was RECOVERED over the corrupt live tree: the surviving
    // workflow content is the backup's, not the corrupt live garbage.
    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(BACKUP_WORKFLOW)
  })

  it('does NOT clear the backup when the live tree is missing its generated config.json', async () => {
    // MEDIUM ("Recovery accepts incomplete packages"): a restore that
    // stopped after copying the manifest and every tool source but BEFORE
    // the installer-generated `config.json` read as "complete" — the
    // backup (holding the only copy of the activation state) was cleared,
    // and a later staging failure left the package without config state.
    // The generated config is guaranteed installed state, so its absence
    // reads as INCOMPLETE and the backup is recovered instead.
    const files = fixtureFiles()
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // Live tree: manifest + tool source, but NO config.json.
    await provider.mkdir('com.example.pkg', { recursive: true })
    for (const [path, content] of Object.entries(files)) {
      if (path === 'config.json') continue
      await provider.writeFile(`com.example.pkg/${path}`, new TextEncoder().encode(content))
    }
    // Backup: the COMPLETE package with distinct workflow content.
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

    // The backup was recovered, INCLUDING its config.json (the recovered
    // live tree must hold the activation-state file again).
    const liveFiles = await listFiles(provider, 'com.example.pkg')
    expect(liveFiles).toContain('config.json')
    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(BACKUP_WORKFLOW)
  })

  it('does NOT restore an older backup over a live install whose tool paths use the ./ prefix', async () => {
    // MEDIUM ("Valid installs appear incomplete"): a manifest may declare a
    // tool path beginning with `./` — the validator normalizes it and the
    // install writes the normalized file. The completeness check stat-ed the
    // RAW path, which the provider rejects, so a perfectly valid live
    // install read as incomplete and the recovery gate restored an OLDER
    // preserved backup over it.
    const DOT_MANIFEST = {
      ...TOOL_MANIFEST,
      tools: [{ ...TOOL_MANIFEST.tools[0]!, path: './workflows/read.js' }],
    }
    // The catalog ships the raw ./ path in the manifest; the installer
    // normalizes it on write (validateManifest's toolSourcePath).
    const files = {
      'manifest.json': JSON.stringify(DOT_MANIFEST),
      'config.json': '{}',
      'workflows/read.js': WORKFLOW_SOURCE,
    }
    const pkg = await pkgWithFiles(files)
    const provider = memoryProvider()
    const registry = registryFromManifestUrl(`${RAW}/manifest.json`)
    // First install succeeds and writes the NORMALIZED path; the on-disk
    // manifest keeps the raw `./` tool path.
    await installPackage(registry, pkg, provider, { fetchImpl: fetchServing(files) })
    // An OLDER backup exists (as a previous failed replacement would leave).
    const OLD_WORKFLOW = 'export default { fromOldBackup: true }'
    const OLD_MANIFEST = { ...TOOL_MANIFEST, version: '0.9.0' }
    await provider.mkdir('.com.example.pkg.previous', { recursive: true })
    await provider.writeFile('.com.example.pkg.previous/manifest.json', new TextEncoder().encode(JSON.stringify(OLD_MANIFEST)))
    await provider.writeFile('.com.example.pkg.previous/workflows/read.js', new TextEncoder().encode(OLD_WORKFLOW))
    // A later install of a NEW version — its staged write fails, so the
    // recovery gate decides between the live tree and the backup.
    const full = { ...files, 'manifest.json': JSON.stringify({ ...DOT_MANIFEST, version: '2.0.0' }) }
    const failingWrite = provider.writeFile.bind(provider)
    provider.writeFile = (async (path: string, data: Uint8Array) => {
      if (path.startsWith('.com.example.pkg.installing/')) throw new Error('EIO: simulated staging write failure')
      return failingWrite(path, data)
    }) as typeof provider.writeFile
    delete (provider as { rename?: unknown }).rename

    await expect(installPackage(registry, await pkgWithFiles(full, { version: '2.0.0' }), provider, { fetchImpl: fetchServing(full) }))
      .rejects.toThrow(/Failed to write package/)

    // The LIVE install survived: its workflow content is the CURRENT one,
    // not the backup's older copy.
    const source = new TextDecoder().decode(await provider.readFile('com.example.pkg/workflows/read.js'))
    expect(source).toBe(WORKFLOW_SOURCE)
    const manifest = JSON.parse(new TextDecoder().decode(await provider.readFile('com.example.pkg/manifest.json')))
    expect(manifest.version).toBe('1.0.0')
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

  it('releases the package lock only after a pending stale write settles', async () => {
    // HIGH ("Stale writes corrupt packages"): when the lease is lost while
    // a storage mutation of the losing transaction is still pending,
    // `withPackageLock` must not release the lease (letting the next owner
    // start) until that mutation settles. Exercised through the REAL loss
    // path: the stored lease is taken over by another owner, the next
    // heartbeat reports the loss, and the wrapper must stay pending while
    // the transaction's pending write is still in flight.
    vi.useFakeTimers()
    try {
      const { withPackageLock } = await import('../package-lock')
      const key = 'webmcp_package_lock_com.example.locktest'
      let resolveWrite: (() => void) | undefined
      const pendingWrite = new Promise<void>(resolve => { resolveWrite = resolve })
      let writeAborted: AbortSignal | undefined

      const transaction = withPackageLock('com.example.locktest', async signal => {
        writeAborted = signal
        await pendingWrite // the stale in-flight write
        if (signal.aborted) throw new Error('aborted: the lease was lost')
      })
      // Let the transaction reach its pending write.
      await vi.advanceTimersByTimeAsync(0)
      expect(writeAborted).toBeDefined()

      // Another owner steals the stored lease (the holder cannot see it).
      await chrome.storage.local.set({ [key]: { owner: 'intruder', expiresAt: Date.now() + 60_000 } })
      // Advance past the heartbeat interval: the holder's heartbeat now
      // reports the loss and the wrapper's abort fires.
      await vi.advanceTimersByTimeAsync(5_100)

      // THE FIX UNDER TEST: while the stale write is still pending, the
      // wrapper must NOT have settled (settling means the finally already
      // released the lease). Flush microtasks and check.
      let settled = false
      void transaction.then(() => { settled = true }, () => { settled = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)

      // The stale write completes; only then does the wrapper settle and
      // release the lease — the next owner never raced a stale write.
      resolveWrite!()
      await expect(transaction).rejects.toThrow(/lease was lost|aborted/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not grant the lease to a new owner until the losing transaction is quiescent', async () => {
    // MEDIUM ("Stale writes still overlap"): the previous owner lost the
    // lease while a storage write was still pending. The released lease
    // must not be grantable to a replacement owner until that stale write
    // has SETTLED — otherwise the stale write lands under the new owner's
    // lease and mixes the package. Proven through the PUBLIC surface: a
    // second `withPackageLock` whose acquire must stay pending until the
    // losing transaction's write resolves.
    vi.useFakeTimers()
    try {
      const { withPackageLock } = await import('../package-lock')
      const key = 'webmcp_package_lock_com.example.quiesce'
      let resolveWrite: (() => void) | undefined
      let loserAborted: AbortSignal | undefined
      let winnerStarted = false

      // Loser: holds the lease; its write stays PENDING past the loss.
      const loser = withPackageLock('com.example.quiesce', async signal => {
        loserAborted = signal
        await new Promise<void>(resolve => { resolveWrite = resolve })
        if (signal.aborted) throw new Error('aborted: the lease was lost')
      })

      // Let the loser reach its pending write.
      await vi.advanceTimersByTimeAsync(0)
      expect(loserAborted).toBeDefined()

      // Take over the stored lease; the loser's next heartbeat reports the
      // loss and the wrapper aborts → the finally registers the quiescence
      // gate and releases. The stale write is STILL pending. (The intruder
      // lease is SHORT: an unowned lease expires, and this test watches the
      // winner take over exactly when the lease becomes free.)
      await chrome.storage.local.set({ [key]: { owner: 'intruder', expiresAt: Date.now() + 2_000 } })
      await vi.advanceTimersByTimeAsync(5_100)

      // THE FIX UNDER TEST: a replacement owner starting to acquire NOW
      // (while the stale write is still in flight) must NOT be granted the
      // lease and must NOT start mutating — its acquire only proceeds after
      // the gate settles.
      const winner = withPackageLock('com.example.quiesce', async () => {
        winnerStarted = true
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(winnerStarted).toBe(false) // the winner did NOT start...

      // The stale write settles; the gate clears and the winner proceeds.
      resolveWrite!()
      await expect(winner).resolves.toBeUndefined()
      expect(winnerStarted).toBe(true)
      // The loser aborted on its lost lease (its post-write fence).
      await expect(loser).rejects.toThrow(/lease was lost|aborted/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
