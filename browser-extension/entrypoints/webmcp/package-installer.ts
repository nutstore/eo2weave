/**
 * WebMCP package installer — extension side (issue #143).
 *
 * Install flow (all-or-nothing):
 *   1. Download every file listed in `manifest.files` for ONE package,
 *      streaming with byte caps and an abort deadline that stays active
 *      through body consumption. The download retries through the jsDelivr
 *      mirror when the canonical `raw.githubusercontent.com` host does not
 *      answer (see `registry-mirrors.ts`).
 *   2. sha256-verify each download via Web Crypto — ALL files are verified
 *      BEFORE anything touches storage.
 *   3. Only then write the tree into the extension's OWN OPFS mount
 *      (`navigator.storage.getDirectory()/webmcp/`, i.e. `getAdapterStorage()`)
 *      — the same location the extension's adapter-validation recognizes.
 *      The tree is staged into `<id>.installing/` and renamed over the old
 *      install, so a failed write never loses the previously working package.
 *   4. Activation stays at its default (`disabled`) — enabling happens
 *      exclusively through the #102 on-site opt-in consent flow.
 *
 * This is the extension-side port of `web/webmcp/package-installer.ts`
 * (issue #117). The transaction, the verification and the swap rules are
 * kept equivalent; the LOCK is the extension's own cross-context lease
 * (`package-lock.ts`) instead of the web app's bridge-mediated lease, and
 * the storage is the extension's own OPFS provider instead of the injected
 * page provider — so an install NEVER goes through the page bridge.
 *
 * Any verification failure aborts the install with NOTHING written (no
 * half-installed packages). Operations on one package id are serialized
 * ACROSS CONTEXTS with the chrome.storage lease in `package-lock.ts` — the
 * same lease the management page's delete and the opt-in enable use — so an
 * install can never interleave with a removal or an activation on the same
 * directory.
 */

import { normalizeProviderPath, type FsProvider } from '@creatorweave/fs-provider'
import { toolSourcePath, validateManifest, validatePackage } from '@creatorweave/shared/webmcp-adapter'
import {
  MAX_PACKAGE_FILE_BYTES,
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_TOTAL_BYTES,
  MAX_REGISTRY_MANIFEST_BYTES,
  REGISTRY_FETCH_TIMEOUT_MS,
  RegistryError,
  registryAltFileUrls,
  registryFileUrl,
  type PackageRegistry,
  type RegistryManifestPackage,
} from './registry-client'
import { fetchWithMirrorFallback, isNotFoundError } from './registry-client'
import { mirrorCandidates, resolveMirrorPreference, type MirrorPreference } from './registry-mirrors'
import { withPackageLock } from './package-lock'

export class PackageInstallError extends Error {
  constructor(message: string, readonly code: 'SHA256_MISMATCH' | 'DOWNLOAD_FAILED' | 'INVALID_PACKAGE' | 'STORAGE_FAILED' | 'BUSY' | 'LOCK_LOST') {
    super(message)
    this.name = 'PackageInstallError'
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** sha256 over raw bytes via Web Crypto (available in all extension contexts). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return toHex(digest)
}

/**
 * Stream a response body under a byte cap with the abort deadline STILL
 * active. Buffering `arrayBuffer()` first would let a stalled connection
 * hang forever (the timer was cleared once the headers arrived) and let an
 * oversized body exhaust memory before the size check ever ran.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body?.getReader()
  if (!reader) {
    // No streaming body (old test doubles) — fall back to a buffered read.
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > maxBytes) throw new PackageInstallError(`Response body exceeds the limit (${maxBytes} bytes)`, 'INVALID_PACKAGE')
    return bytes
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new PackageInstallError(`Response body exceeds the limit (${maxBytes} bytes)`, 'INVALID_PACKAGE')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Download one file, verifying its catalog sha256, with the mirror fallback.
 *
 * The canonical URL is tried first (global preference) or the jsDelivr
 * mirror first (CN preference). A transport failure moves on to the next
 * candidate; a 404 is definitive and aborts the download.
 *
 * CHECKSUM-AWARE CANDIDATE SELECTION (finding: "Stale mirrors abort
 * installs"): a mirror can serve STALE bytes with a successful 200 —
 * checking the checksum only after the fallback returned would abort the
 * whole install even when a LATER candidate still serves the
 * catalog-matching file. The verification therefore runs INSIDE the
 * candidate loader and a mismatch is marked `retryable`, so the fallback
 * moves on to the next candidate; when no candidate matches, the last
 * mismatch is surfaced as the definitive SHA256_MISMATCH failure.
 */
async function downloadFile(
  url: string,
  fetchImpl: typeof fetch,
  expectedSha256: string,
  timeoutMs: number = REGISTRY_FETCH_TIMEOUT_MS,
  preference?: MirrorPreference,
  altUrls: string[] = [],
): Promise<Uint8Array> {
  const expected = expectedSha256.toLowerCase()
  const load = async (candidate: string): Promise<Uint8Array> => {
    const controller = new AbortController()
    // The deadline covers the WHOLE download — headers AND body. Clearing it
    // before the body streamed let a hostile server stall the install forever.
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(candidate, { credentials: 'omit', cache: 'no-cache', signal: controller.signal })
      if (!response.ok) {
        // Preserve the HTTP status on the error: without it every non-404
        // 4xx (e.g. a canonical host's 403) read as a generic transport
        // failure and the mirror fallback retried a DEFINITIVE client
        // error on another origin instead of surfacing it (finding:
        // "Canonical client errors are masked"). 404 keeps its own
        // "missing file" handling via `isNotFoundError`.
        throw Object.assign(
          new PackageInstallError(`Download failed for ${candidate}: HTTP ${response.status}`, 'DOWNLOAD_FAILED'),
          { status: response.status },
        )
      }
      // Byte cap enforced WHILE streaming, not after the body is in memory.
      const bytes = await readBodyCapped(response, MAX_PACKAGE_FILE_BYTES)
      // Verify INSIDE the candidate attempt: a mismatching candidate is a
      // stale-content verdict the NEXT candidate may still answer correctly
      // (the mirror fallback retries it), while the LAST candidate's
      // mismatch is rethrown below as the install's definitive failure.
      const actual = await sha256Hex(bytes)
      if (actual !== expected) {
        throw Object.assign(
          new PackageInstallError(
            `Checksum mismatch for ${candidate}: expected ${expectedSha256}, got ${actual}`,
            'SHA256_MISMATCH',
          ),
          // `retryable` — see `isRetryableFetchError`: a loader that
          // INSPECTED the bytes can distinguish a mirror's stale content
          // from a canonical origin's final mismatch.
          { retryable: true },
        )
      }
      return bytes
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PackageInstallError(`Download timed out after ${timeoutMs / 1000}s: ${candidate}`, 'DOWNLOAD_FAILED')
      }
      if (error instanceof PackageInstallError) throw error
      throw new PackageInstallError(`Download failed for ${candidate}: ${error instanceof Error ? error.message : String(error)}`, 'DOWNLOAD_FAILED')
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    // Candidates: the beside-the-manifest form first (both transports),
    // then the REF-ROOT alternative — a subdirectory manifest's catalog
    // lists repo-relative paths the primary form cannot address (finding:
    // "Subdirectory registries cannot load packages"). Every candidate is
    // verified against the catalog sha256 inside `load`, so the extra
    // same-origin candidate cannot serve tampered content.
    const candidates = mirrorCandidates(url, preference ?? resolveMirrorPreference())
    for (const alt of altUrls) {
      if (!candidates.includes(alt)) candidates.push(alt)
    }
    return await fetchWithMirrorFallback(url, load, { preference, candidates })
      .then(result => result.value)
  } catch (error) {
    if (error instanceof PackageInstallError && error.code === 'SHA256_MISMATCH') {
      // No candidate served the catalog-matching bytes — surface the
      // mismatch WITHOUT the retryable mark (nothing left to fall back to).
      throw new PackageInstallError(error.message, 'SHA256_MISMATCH')
    }
    throw error
  }
}

/**
 * Uninstall INTENT fence (finding: "Uninstalled packages return"): the
 * pre-download presence probe cannot detect a package that was CREATED and
 * REMOVED again while the download ran (probe `false` = "was absent" is
 * indistinguishable from "created then uninstalled mid-download"), so an
 * install that started before the uninstall can otherwise resurrect the
 * package the user explicitly removed. Every registry mutation runs in the
 * single background service worker, so a module-level record of uninstall
 * INTENT (kept briefly) lets the under-lock flow abort an install whose
 * id was uninstalled after the install started. A TTL bounds the record:
 * a LEGITIMATE reinstall started after the uninstall has an intent older
 * than its own start and proceeds normally.
 */
const uninstallIntents = new Map<string, number>()
const UNINSTALL_INTENT_TTL_MS = 10 * 60_000

function recordUninstallIntent(packageId: string): void {
  pruneUninstallIntents()
  uninstallIntents.set(packageId, Date.now())
}

function pruneUninstallIntents(): void {
  const now = Date.now()
  for (const [key, at] of uninstallIntents) {
    if (now - at > UNINSTALL_INTENT_TTL_MS) uninstallIntents.delete(key)
  }
}

/** True when the id was uninstalled at or after `since` (an in-flight install's start). */
function hasUninstallIntentSince(packageId: string, since: number): boolean {
  pruneUninstallIntents()
  const at = uninstallIntents.get(packageId)
  // `>=` on purpose: the uninstall is recorded at the moment it wins the
  // lock, which is always at or after the racing install started — and a
  // fast download can complete within the SAME millisecond as the start.
  return at !== undefined && at >= since
}

/**
 * Install one package into the extension's own WebMCP mount. Verifies EVERY
 * file first; a single mismatch aborts with no storage writes. Returns the
 * number of files written.
 */
export async function installPackage(
  registry: PackageRegistry,
  pkg: RegistryManifestPackage,
  provider: FsProvider,
  options?: {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    preference?: MirrorPreference
    /**
     * Whether the package directory was PRESENT on the mount before the
     * download started (`null` = indeterminate). When it was, the under-lock
     * flow re-checks presence and ABORTS if the directory disappeared — a
     * concurrent uninstall won the lock race and the install must not
     * resurrect the package it removed (finding: "Uninstalled package
     * reappears"). Callers that do not supply it get the installer's own
     * unlocked probe.
     */
    presenceBefore?: boolean | null
  },
  /**
   * Called INSIDE the per-package cross-context lock, after the lock is
   * held and before anything is written: lets the caller re-run its
   * id-collision check against the mount state the lock actually observed
   * — two concurrent first installs pass the unlocked check, serialize on
   * the lock, and the loser now rejects instead of silently replacing the
   * winner.
   */
  underLock?: (lockSignal: AbortSignal) => Promise<void>,
): Promise<{ filesWritten: number }> {
  const fetchImpl = options?.fetchImpl ?? fetch
  const id = pkg.id
  // Package id doubles as the directory name on the mount; keep the same
  // guard the extension applies to package directories.
  try {
    normalizeProviderPath(id)
  } catch {
    throw new PackageInstallError(`Invalid package id: ${id}`, 'INVALID_PACKAGE')
  }
  if (!id || id.includes('/')) throw new PackageInstallError(`Invalid package id: ${id}`, 'INVALID_PACKAGE')
  if (pkg.files.length > MAX_PACKAGE_FILES) {
    throw new PackageInstallError(`Package ${id} lists too many files (${pkg.files.length}; the limit is ${MAX_PACKAGE_FILES})`, 'INVALID_PACKAGE')
  }
  // FENCE against a concurrent uninstall (finding: "Uninstalled package
  // reappears"): the download+validation above can outlive the user's
  // removal of the same package, and an install that only checked the
  // mount BEFORE downloading would then write the package back under the
  // lock. Capture the pre-download presence (the caller's probe when it
  // has one, otherwise this installer's own) — the authoritative check
  // re-runs INSIDE the lock: a directory that existed before the download
  // but is gone under the lock means a concurrent uninstall won the race.
  // `false` here is also the NORMAL first-install case, so it never
  // aborts on its own.
  const presenceBefore = options?.presenceBefore !== undefined ? options.presenceBefore : await pathExists(provider, id)
  // The install's START time anchors the uninstall-intent fence below.
  const startedAt = Date.now()

  // Stage everything in memory BEFORE touching storage — the all-or-nothing
  // guarantee lives here, not in a rollback pass. Size caps bound the staged
  // buffer so a hostile manifest cannot exhaust browser memory.
  const staged: Array<{ path: string; bytes: Uint8Array }> = []
  const seenPaths = new Set<string>()
  let totalBytes = 0
  let manifestBytes: Uint8Array | undefined
  for (const file of pkg.files) {
    const url = registryFileUrl(registry, file.path)
    // Manifest paths are repo-relative (`packages/<id>/...`); on the mount
    // the package root IS the directory, so strip the `packages/<id>/` prefix.
    const prefix = `packages/${id}/`
    if (!file.path.startsWith(prefix)) {
      throw new PackageInstallError(`File ${file.path} does not belong to package ${id}`, 'INVALID_PACKAGE')
    }
    const rawRelative = file.path.slice(prefix.length)
    let relative: string
    try {
      relative = normalizeProviderPath(rawRelative)
    } catch {
      throw new PackageInstallError(`Invalid file path in package ${id}: ${file.path}`, 'INVALID_PACKAGE')
    }
    // A path that is not already in its normalized form aliases another entry
    // (`workflows/./read.js` == `workflows/read.js`); write neither.
    if (relative !== rawRelative) {
      throw new PackageInstallError(`File path ${file.path} is not normalized (aliased path)`, 'INVALID_PACKAGE')
    }
    if (seenPaths.has(relative)) {
      throw new PackageInstallError(`Package ${id} lists ${file.path} twice (aliased path)`, 'INVALID_PACKAGE')
    }
    seenPaths.add(relative)
    const bytes = await downloadFile(url, fetchImpl, file.sha256, options?.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS, options?.preference, registryAltFileUrls(registry, file.path))
    // The download already verified the sha256 per candidate (finding:
    // "Stale mirrors abort installs") — nothing to re-check here.
    totalBytes += bytes.length
    if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
      throw new PackageInstallError(`Package ${id} exceeds the total size limit (${MAX_PACKAGE_TOTAL_BYTES} bytes)`, 'INVALID_PACKAGE')
    }
    if (relative === 'manifest.json') manifestBytes = bytes
    staged.push({ path: relative, bytes })
  }

  // Validate the package EXACTLY like the extension catalog will read it:
  // manifest schema, id match against the registry entry AND the install
  // directory, urlRegex rules, tool source presence and workflow contracts.
  // Without this the install reports success while the catalog withdraws the
  // package as invalid and it can never be enabled.
  if (!manifestBytes) {
    throw new PackageInstallError(`Package ${id} is missing manifest.json`, 'INVALID_PACKAGE')
  }
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes))
  } catch {
    throw new PackageInstallError(`Package ${id} has a malformed manifest.json`, 'INVALID_PACKAGE')
  }
  const toolPaths = new Set<string>()
  try {
    const manifest = validateManifest(manifestJson, id)
    if (manifest.id !== id) {
      throw new PackageInstallError(`Package manifest id ${manifest.id} does not match registry id ${id}`, 'INVALID_PACKAGE')
    }
    // The registry entry's version claim must agree with the downloaded
    // manifest — otherwise the management card would report a version the
    // user did not actually get.
    if (manifest.version !== pkg.version) {
      throw new PackageInstallError(
        `Package manifest version ${manifest.version} does not match registry version ${pkg.version}`,
        'INVALID_PACKAGE',
      )
    }
    for (const tool of manifest.tools) toolPaths.add(tool.path)
    const sources: Record<string, string> = Object.create(null)
    for (const file of staged) {
      if (toolPaths.has(file.path)) sources[file.path] = new TextDecoder().decode(file.bytes)
    }
    validatePackage(manifest, sources, id)
  } catch (error) {
    if (error instanceof PackageInstallError) throw error
    throw new PackageInstallError(`Package ${id} is not a valid package: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_PACKAGE')
  }

  // SECURITY: the registry's own config.json is NEVER copied — a manifest
  // could ship `activation: "enabled"` and the package would activate
  // without the #102 on-site consent flow. Activation is always reset to
  // the disabled default here; enabling is exclusively the opt-in flow's job.
  const configIndex = staged.findIndex(file => file.path === 'config.json')
  const configBytes = new TextEncoder().encode(JSON.stringify(INSTALLER_DEFAULT_CONFIG) + '\n')
  if (configIndex >= 0) staged[configIndex] = { path: 'config.json', bytes: configBytes }
  else staged.push({ path: 'config.json', bytes: configBytes })

  // Serialize all mutations of one package id ACROSS CONTEXTS (the
  // management page, the background service worker): an install racing an
  // uninstall/opt-in enable would otherwise interleave remove/mkdir/write
  // and can leave the directory half-written. The extension's own
  // `withPackageLock` lease lives in the background's chrome.storage, so
  // every context sees it.
  return withPackageLock(id, async lockSignal => {
    // REMOVAL FENCE (finding: "Uninstalled package reappears"): a directory
    // that existed when the download started but is GONE under the lock was
    // removed by a concurrent uninstall that won the lock race — writing
    // the package back would resurrect what the user deleted. (A directory
    // that never existed is the normal first install; an INDETERMINATE
    // presence probe must NOT read as "removed" — a transient stat failure
    // is not evidence of a removal.)
    if (presenceBefore === true && await pathExists(provider, id) === false) {
      throw new PackageInstallError(
        `The install of ${id} was cancelled: the package was removed while it was being prepared`,
        'LOCK_LOST',
      )
    }
    // UNINSTALL-INTENT FENCE (finding: "Uninstalled packages return"): the
    // presence fence above only fires when the directory EXISTED before the
    // download. An install that started while the id was ABSENT, then raced
    // a create→uninstall sequence, sees `false` here and would otherwise
    // write the package back — undoing an explicit uninstall. When an
    // uninstall of THIS id happened after this install started, abort.
    if (hasUninstallIntentSince(id, startedAt)) {
      throw new PackageInstallError(
        `The install of ${id} was cancelled: the package was uninstalled while it was being prepared`,
        'LOCK_LOST',
      )
    }
    if (underLock) await underLock(lockSignal)
    await swapPackageIntoPlace(id, staged, provider, lockSignal)
    return { filesWritten: staged.length }
  })
}

/**
 * The swap itself: stage the new tree, then move it over the old install.
 * Every failure path keeps a usable package on the mount — see the inline
 * comments for the backup-preservation rules.
 */
async function swapPackageIntoPlace(
  id: string,
  staged: Array<{ path: string; bytes: Uint8Array }>,
  provider: FsProvider,
  lockSignal: AbortSignal,
): Promise<void> {
  // The replacement is written into a staging directory FIRST and only
  // swapped into place after EVERY write succeeded, so a failed write
  // never leaves the mount without a usable package:
  //   - with `rename` (the in-memory/local provider): the staging tree is
  //     renamed over the old one, and the old one is kept as a backup
  //     until the swap succeeded (rollback on failure);
  //   - without `rename` (the OPFS provider): the old tree is copied into a
  //     backup directory, the staging tree is copied into place, and the
  //     backup is restored if anything fails.
  // The staging/backup names are dot-prefixed: they are internal state,
  // not packages, and the mount listings skip dot-directories.
  const staging = `.${id}.installing`
  const backup = `.${id}.previous`
  const hasRename = typeof provider.rename === 'function'
  let backupPreserved = false
  // FENCING: every DESTRUCTIVE storage step below (the pre-swap
  // recovery/cleanup removes and each remove/copy in the no-rename swap)
  // checks the lease signal FIRST, so a step that STARTS after the lease was
  // lost never executes — a stale transaction must not mutate the package
  // directory the NEW owner now holds the lease for.
  const assertLeaseHeld = (): void => {
    if (lockSignal.aborted) {
      throw new PackageInstallError(
        `The install of ${id} was aborted: the package lock was lost mid-transaction`,
        'LOCK_LOST',
      )
    }
  }
  // The shared tree-copy/removal helpers take the signal directly, so a
  // step that STARTS after the lease was lost is fenced inside them too.
  try {
    assertLeaseHeld()
    await removeMissingOk(provider, staging, lockSignal)
    // SECURITY (critical, "Retry deletes last good package"): a PRIOR failed
    // replacement may have left `backup` behind holding the ONLY surviving
    // copy of the package (restoration failed there). If the live directory
    // exists but is NOT VERIFIED COMPLETE, the backup is the more
    // trustworthy copy and is restored instead. An INDETERMINATE stat
    // (transient/permission failure) must NOT read as "exists": that is
    // exactly how a retry skipped recovery and then deleted the preserved
    // backup. Abort instead — the backup survives untouched and the caller
    // can retry.
    const liveExists = await pathExists(provider, id)
    // The backup is probed REGARDLESS of the live directory: a previous
    // failed restore can leave an INCOMPLETE live directory AND the only
    // complete copy in the backup at the same time. Keying the probe on
    // `liveExists === false` made such a retry report "no backup", delete
    // the preserved copy during the pre-swap cleanup, and a later storage
    // failure then left only the partial package (finding: "Retry deletes
    // preserved package").
    const backupExists = await pathExists(provider, backup)
    if (liveExists === null || backupExists === null) {
      // The abort must also keep the backup out of the cleanup below — it
      // may be the only surviving copy.
      backupPreserved = true
      throw new PackageInstallError(
        `The state of ${id} on the mount could not be determined (stat failed); a preserved backup was kept and nothing was modified — retry`,
        'STORAGE_FAILED',
      )
    }
    // RECOVERY GATE: the backup is restored not only when the live tree is
    // MISSING but also when it is INCOMPLETE. A failed restore in a prior
    // transaction could leave a partially copied live directory while the
    // intact backup survived; trusting any existing live directory here
    // made the retry clear the backup — the only complete copy — after the
    // pre-swap cleanup below (finding: "Retry deletes preserved package").
    // A live directory that is not VERIFIED COMPLETE (finding: "Recovery
    // deletes the working backup" — a parseable manifest alone is not the
    // package) is not a usable install, so the backup wins.
    const liveIsComplete = liveExists ? await liveTreeIsComplete(provider, id) : false
    if ((!liveExists || !liveIsComplete) && backupExists) {
      assertLeaseHeld() // fence: do not recover/clear the backup after lease loss
      try {
        // A partial live tree must not survive under the restored one.
        await removeMissingOk(provider, id, lockSignal)
        await copyTree(provider, backup, id, lockSignal)
        // Recovered — the backup is now redundant.
        assertLeaseHeld() // fence the backup cleanup against lease loss
        await removeMissingOk(provider, backup, lockSignal)
      } catch {
        // Recovery failed: keep the backup and proceed WITHOUT deleting it
        // (the swap paths below tolerate its presence; the finally block
        // must not clear it either).
        backupPreserved = true
        throw new PackageInstallError(
          `Found a preserved backup of ${id} but could not restore it; the backup was kept at ${backup}`,
          'STORAGE_FAILED',
        )
      }
    }
    assertLeaseHeld() // fence: the backup clear is destructive
    await removeMissingOk(provider, backup, lockSignal)
    // Guard the WRITE LOOP: every staged write checks the lease signal
    // first, so a transaction whose lease expired stops writing before the
    // next file instead of finishing a swap the new lock owner is already
    // racing. The failure surfaces as LOCK_LOST through the lock wrapper.
    try {
      await provider.mkdir(staging, { recursive: true })
      for (const file of staged) {
        if (lockSignal.aborted) {
          throw new PackageInstallError(
            `The install of ${id} was aborted: the package lock was lost mid-transaction`,
            'LOCK_LOST',
          )
        }
        await provider.writeFile(`${staging}/${file.path}`, file.bytes)
        // FENCE after every awaited write: a write that lands after the
        // lease was lost would keep mutating the package directory the NEW
        // owner is already racing (finding: "Stale installs corrupt
        // packages") — stop before the next file instead.
        assertLeaseHeld()
      }
    } catch (error) {
      if (error instanceof PackageInstallError) throw error
      throw new PackageInstallError(`Failed to write package ${id} to storage: ${error instanceof Error ? error.message : String(error)}`, 'STORAGE_FAILED')
    }
    // All writes landed — swap the new tree in. FENCE the swap commit
    // itself: a lease lost while the last staged write was pending must not
    // rename under the new owner's lease — the swap is the transaction's
    // decisive mutation.
    if (lockSignal.aborted) {
      throw new PackageInstallError(
        `The install of ${id} was aborted: the package lock was lost mid-transaction`,
        'LOCK_LOST',
      )
    }
    if (hasRename) {
      let hadOld = false
      try {
        await provider.rename!(id, backup)
        // FENCE after the awaited rename (finding: "Stale installs corrupt
        // packages"): the read/await may have outlived the lease, and every
        // subsequent mutation must be abandoned once it has.
        assertLeaseHeld()
        hadOld = true
      } catch (error) {
        // No previous install — that is the normal first-install case.
        const e = error as { code?: string; name?: string }
        if (!(e.code === 'ENOENT' || e.name === 'NotFoundError')) throw error
      }
      try {
        await provider.rename!(staging, id)
        // FENCE after the awaited rename — same rule as above.
        assertLeaseHeld()
      } catch (renameError) {
        // Roll the old install back — the new tree failed to take over.
        // The rollback rename is fenced too: after lease loss the NEW owner
        // owns the directory and a stale rename must not fight it.
        assertLeaseHeld()
        if (hadOld) {
          try {
            await provider.rename!(backup, id)
            assertLeaseHeld() // fence after the awaited rollback rename
          } catch {
            // SECURITY (critical): restoration failed, so the backup now
            // holds the ONLY copy of the previously working package.
            // Preserving it beats deleting it: leave the backup directory
            // in place and report the rollback failure — the next install
            // of any package can still recover from it, and nothing the
            // user had is destroyed.
            backupPreserved = true
            throw new PackageInstallError(
              `Failed to write package ${id} to storage AND the previous install could not be restored; its backup was preserved at ${backup}`,
              'STORAGE_FAILED',
            )
          }
        }
        throw renameError
      }
      // Fence the backup clear: the swap landed but the lease may have been
      // lost while the last rename was pending — the stale transaction must
      // not delete the backup the NEW owner's recovery could still need
      // (finding: "Stale cleanup deletes new backup"). `removeMissingOk`
      // rechecks the lease immediately before the destructive mutation, so
      // a lease lost between the gate above and the removal still fences.
      await removeMissingOk(provider, backup, lockSignal)
    } else {
      // No rename support: copy the old tree aside, copy the new tree in,
      // and restore the copy if the swap fails.
      let hadOld: boolean
      try {
        hadOld = await copyTree(provider, id, backup, lockSignal)
      } catch (error) {
        // A backup that cannot be LISTED is a backup that cannot be
        // trusted — abort BEFORE the live tree is removed, so the old
        // package stays.
        throw new PackageInstallError(
          `Failed to back up package ${id} before replacement: ${error instanceof Error ? error.message : String(error)}`,
          'STORAGE_FAILED',
        )
      }
      try {
        assertLeaseHeld() // fence: removing the live tree is destructive
        await removeMissingOk(provider, id, lockSignal)
        try {
          assertLeaseHeld() // fence: the staged copy-in is destructive
          await copyTree(provider, staging, id, lockSignal)
        } catch (copyError) {
          // A LEASE-LOST abort is not a copy failure: do NOT run the
          // destructive rollback (remove + restore) for it — the transaction
          // stops here and the lock wrapper surfaces LOCK_LOST. The finally
          // block below still clears the staging dir; `backupPreserved`
          // stays false so the redundant backup copy is cleaned too.
          if (lockSignal.aborted) throw copyError
          if (!hadOld) {
            // First install: nothing to restore — remove the PARTIAL live
            // directory so the management UI never reports a half package.
            assertLeaseHeld() // fence the cleanup writes against lease loss
            await removeMissingOk(provider, id, lockSignal).catch(() => {})
            // Redundant backup of a FIRST install — nothing to restore over
            // — so `backupPreserved` stays false and the finally block may
            // clean it.
          } else {
            // ROLLBACK RULE: the old tree may only be restored INTO a clean
            // directory. Removing the partial live tree is part of the
            // rollback itself — swallowing its failure and copying over the
            // leftovers would let `copyTree` overwrite matching files while
            // keeping EXTRA files from the failed replacement, and the
            // backup cleanup would then delete the only clean copy: a
            // mixed, half-old half-new package (finding: "Failed rollback
            // can discard old files"). A failed removal PRESERVES the
            // backup and reports the rollback failure instead.
            try {
              assertLeaseHeld() // fence the rollback removal against lease loss
              await removeMissingOk(provider, id, lockSignal)
            } catch (cleanupError) {
              backupPreserved = true
              throw new PackageInstallError(
                `Failed to write package ${id} to storage AND the failed replacement could not be fully removed; the previous install was preserved at ${backup}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                'STORAGE_FAILED',
              )
            }
            assertLeaseHeld() // fence: the restore copy is destructive
            try {
              await copyTree(provider, backup, id, lockSignal)
            } catch (restoreError) {
              // SECURITY (critical, "Rollback failure deletes last copy"):
              // the restore itself can fail (a storage error mid-copy after
              // the partial live tree was removed). `backupPreserved` MUST
              // be set here: the backup is now the ONLY copy of the
              // previously working package, and a finally cleanup that
              // treated the restore as finished would delete it — leaving
              // neither the old package nor a complete replacement. The
              // quarantine precedent (the importOPFSBackup two-phase rule)
              // applies: never delete before the replacement is fully in
              // place. The next install's recovery gate restores the
              // backup over the partial live tree.
              backupPreserved = true
              throw new PackageInstallError(
                `Failed to write package ${id} to storage AND the previous install could not be restored; its backup was preserved at ${backup}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
                'STORAGE_FAILED',
              )
            }
          }
          throw copyError
        }
      } finally {
        // Fence the backup cleanup too: an aborted transaction must not
        // remove the backup after the lease moved on (the new owner could be
        // mid-restore from it). `lockSignal` is REQUIRED here — the
        // signal-less overload would run an UNFENCED destructive removal
        // that could delete the backup the NEW owner is using (finding:
        // "Stale cleanup deletes backup").
        if (!backupPreserved && !lockSignal.aborted) await removeMissingOk(provider, backup, lockSignal).catch(() => {})
      }
      await removeMissingOk(provider, backup, lockSignal)
    }
  } catch (error) {
    if (error instanceof PackageInstallError) throw error
    throw new PackageInstallError(`Failed to write package ${id} to storage: ${error instanceof Error ? error.message : String(error)}`, 'STORAGE_FAILED')
  } finally {
    // Never leak the staging directory on any failure path. The BACKUP is
    // only cleaned when it is provably no longer needed (the swap succeeded,
    // or the rollback restored it): when restoration FAILED the backup is
    // the only remaining copy of the working package and MUST survive. Both
    // cleanups are FENCED against lease loss — a stale transaction must not
    // delete the new owner's backup.
    // The fence is INSIDE `removeMissingOk`, not the flag read above: a
    // lease lost between checking `lockSignal.aborted` and the removal's
    // awaited mutation would let stale cleanup delete the staging dir or
    // the backup the NEW transaction is using (finding: "Stale cleanup
    // deletes new backup"). `removeMissingOk` rechecks the signal
    // immediately before its destructive mutation and throws instead.
    await removeMissingOk(provider, staging, lockSignal).catch(() => {})
    if (!backupPreserved) await removeMissingOk(provider, backup, lockSignal).catch(() => {})
  }
}

/** True when the path exists; `null` when the answer is INDETERMINATE. */
async function pathExists(provider: FsProvider, path: string): Promise<boolean | null> {
  try {
    await provider.stat(path)
    return true
  } catch (error) {
    const e = error as { code?: string; name?: string }
    if (e.code === 'ENOENT' || e.name === 'NotFoundError') return false
    return null // transient/permission failure — the answer is unknown
  }
}

/**
 * Conservative completeness check for a live package directory (finding:
 * "Recovery deletes the working backup", CRITICAL): a PARSEABLE manifest
 * alone is NOT a complete package. A restore that copied manifest.json
 * first and then failed before the rest of the tree would otherwise read
 * as "complete", and the retry would delete the backup holding the ONLY
 * complete copy of the package.
 *
 * The completeness reference is the VALID package manifest format —
 * `validateManifest` produces `{ id, version, description, tools }` and a
 * package manifest has NO `files` array (finding: "Recovery restores older
 * package": requiring `files` made every valid manifest read as
 * incomplete, so recovery always rolled the live install back to an older
 * backup). The manifest lists its tools with their file paths, so the tree
 * is complete only when the manifest parses INTO that format AND every
 * tool file exists on the live tree (the installer's own `config.json` is
 * tolerated as extra state). An INDETERMINATE read failure counts as
 * INCOMPLETE (fail closed: keep the backup).
 */
async function liveTreeIsComplete(provider: FsProvider, id: string): Promise<boolean> {
  let manifest: { tools?: unknown }
  try {
    const bytes = await provider.readFile(`${id}/manifest.json`)
    manifest = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return false
  }
  if (typeof manifest !== 'object' || manifest === null || !Array.isArray(manifest.tools)) return false
  for (const tool of manifest.tools) {
    const path = typeof tool === 'object' && tool !== null && typeof (tool as { path?: unknown }).path === 'string'
      ? (tool as { path: string }).path
      : undefined
    // A manifest with a nameless/invalid tool entry is not a valid package
    // manifest — treat the tree as incomplete.
    if (!path) return false
    // Normalize with the SAME rule the manifest validator applies (finding:
    // "Valid installs appear incomplete"): `validateManifest` accepts a
    // tool path beginning with `./` and records the NORMALIZED path, and
    // installation writes the normalized file. Stat-ing the RAW `./`-prefixed
    // path here hit the provider's path-traversal guard, the read failed,
    // and a perfectly valid live install was treated as incomplete — the
    // recovery gate then restored an OLDER preserved backup over it.
    let normalized: string
    try {
      normalized = toolSourcePath(path)
    } catch {
      return false
    }
    try {
      const stat = await provider.stat(`${id}/${normalized}`)
      if (stat.kind !== 'file') return false
    } catch {
      return false // missing OR unreadable — treat both as incomplete
    }
  }
  return true
}

/**
 * Throw LOCK_LOST when the transaction's lease is gone. Shared by the tree
 * copy and the fenced removals: after the lease is lost the NEW owner holds
 * the package directory, and a stale operation that keeps mutating alongside
 * it corrupts the package.
 */
function throwIfLeaseLost(lockSignal: AbortSignal | undefined, what: string): void {
  if (lockSignal?.aborted) {
    throw new PackageInstallError(
      `The operation was aborted: the package lock was lost mid-transaction during ${what}`,
      'LOCK_LOST',
    )
  }
}

/**
 * Copy a directory tree inside the provider (the OPFS provider exposes no
 * rename). Returns false when the source does not exist. A readdir that
 * fails for any OTHER reason throws — treating a listing error as "absent
 * source" would silently skip the backup and let a later failure delete the
 * only copy.
 *
 * Every recursive step checks `lockSignal` FIRST: after the lease is lost
 * the new owner holds the package directory, and a copy that keeps writing
 * alongside it would leave a partial, mixed tree (finding: "Concurrent
 * installs corrupt packages").
 */
async function copyTree(provider: FsProvider, from: string, to: string, lockSignal?: AbortSignal): Promise<boolean> {
  let entries: Array<{ name: string; kind: string }>
  try {
    entries = await provider.readdir(from)
  } catch (error) {
    const e = error as { code?: string; name?: string }
    if (e.code === 'ENOENT' || e.name === 'NotFoundError') return false
    throw error
  }
  throwIfLeaseLost(lockSignal, `the tree copy of ${from}`)
  await provider.mkdir(to, { recursive: true })
  for (const entry of entries) {
    const source = `${from}/${entry.name}`
    const target = `${to}/${entry.name}`
    if (entry.kind === 'directory') {
      await copyTree(provider, source, target, lockSignal)
    } else {
      // FENCE the read→write pair, not just the loop: a read that stays
      // pending until the lease is lost must not complete by writing into
      // the directory the NEW owner now holds (finding: "Stale installs
      // corrupt packages").
      const bytes = await provider.readFile(source)
      throwIfLeaseLost(lockSignal, `the tree copy of ${from}`)
      await provider.writeFile(target, bytes)
      // FENCE after the awaited write too: stop before the next entry once
      // the lease is gone (finding: "Stale installs corrupt packages").
      throwIfLeaseLost(lockSignal, `the tree copy of ${from}`)
    }
  }
  return true
}

/**
 * Remove a path, tolerating "does not exist" in BOTH error shapes: the
 * normalized `ENOENT` FsError and the raw File System Access
 * `NotFoundError` DOMException (the production OPFS provider). The removal
 * is fenced against lease loss — a stale transaction must not delete the
 * directory the NEW owner now holds the lease for.
 */
async function removeMissingOk(provider: FsProvider, path: string, lockSignal?: AbortSignal): Promise<void> {
  throwIfLeaseLost(lockSignal, `the removal of ${path}`)
  try {
    await provider.remove(path, { recursive: true })
  } catch (error) {
    const e = error as { code?: string; name?: string }
    if (e.code === 'ENOENT' || e.name === 'NotFoundError') return
    throw error
  }
}

/**
 * Remove an installed package: delete its directory on the mount. The
 * activation override (config.json) lives inside the directory, so it is
 * cleared by the same removal. Serialized with the SAME cross-context lock
 * as install.
 */
export async function uninstallPackage(packageId: string, provider: FsProvider): Promise<void> {
  // A package id is a directory name — a slash makes this a PATH, and the
  // recursive removal below would delete a SUBTREE inside another package
  // (`com.example.pkg/workflows`) instead of rejecting the invalid id.
  // normalizeProviderPath accepts slash-separated paths, so the explicit
  // slash check is the guard (finding: "Uninstall can delete package
  // subtrees"). Checked BEFORE the lock so an invalid id never holds or
  // waits on the lease at all.
  if (!packageId || packageId.includes('/')) {
    throw new PackageInstallError(`Invalid package id: ${packageId}`, 'INVALID_PACKAGE')
  }
  try {
    normalizeProviderPath(packageId)
  } catch {
    throw new PackageInstallError(`Invalid package id: ${packageId}`, 'INVALID_PACKAGE')
  }
  await withPackageLock(packageId, async lockSignal => {
    // Stop before mutating once the lease is gone — a removal executed
    // under the NEW owner's lease would delete the package it just
    // installed.
    if (lockSignal.aborted) {
      throw new PackageInstallError(
        `The removal of ${packageId} was aborted: the package lock was lost mid-transaction`,
        'LOCK_LOST',
      )
    }
    // UNINSTALL-INTENT record (finding: "Uninstalled packages return"):
    // recorded INSIDE the lock, before any mutation — an install that
    // started before this removal re-checks the record under its own lock
    // acquisition and aborts instead of resurrecting the package.
    recordUninstallIntent(packageId)
    try {
      await removeMissingOk(provider, packageId, lockSignal)
    } catch (error) {
      throw new PackageInstallError(`Failed to remove package ${packageId}: ${error instanceof Error ? error.message : String(error)}`, 'STORAGE_FAILED')
    }
    // Also remove a PRESERVED backup from a prior failed replacement
    // (finding: "Uninstalled packages reappear"): `uninstallPackage`
    // removing only the live directory left `.${id}.previous` behind, and
    // a later failed install restored that backup — the explicitly
    // uninstalled package reappeared. The user removed the PACKAGE, not
    // just its latest version, so internal state goes with it.
    await removeMissingOk(provider, `.${packageId}.previous`, lockSignal).catch(() => {})
  })
}

/** Enabling is exclusively the #102 opt-in flow's job — the installer never activates. */
export const INSTALLER_DEFAULT_CONFIG = { activation: 'disabled' as const }

/**
 * Fetch + validate a registry manifest under the same streaming byte cap as
 * package files — a hostile registry cannot stall the management page or
 * balloon its memory.
 *
 * The mirror fallback lives in `fetchRegistryManifest` (the caching client);
 * this helper is the uncached variant used by callers that want the raw
 * bytes under their own deadline, so it applies the same candidate list.
 */
export async function fetchRegistryManifestCapped(
  registry: PackageRegistry,
  fetchImpl: typeof fetch,
  timeoutMs: number = REGISTRY_FETCH_TIMEOUT_MS,
  preference?: MirrorPreference,
): Promise<import('./registry-client').RegistryManifest> {
  const load = async (candidate: string): Promise<import('./registry-client').RegistryManifest> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(candidate, { credentials: 'omit', cache: 'no-cache', signal: controller.signal })
      if (!response.ok) {
        throw new PackageInstallError(`Download failed for ${candidate}: HTTP ${response.status}`, 'DOWNLOAD_FAILED')
      }
      const bytes = await readBodyCapped(response, MAX_REGISTRY_MANIFEST_BYTES)
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      const { validateRegistryManifest } = await import('./registry-client')
      return validateRegistryManifest(parsed)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PackageInstallError(`Registry request timed out after ${timeoutMs / 1000}s: ${candidate}`, 'DOWNLOAD_FAILED')
      }
      if (error instanceof PackageInstallError) throw error
      throw new PackageInstallError(`Registry manifest could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_PACKAGE')
    } finally {
      clearTimeout(timer)
    }
  }
  const result = await fetchWithMirrorFallback(registry.manifestUrl, load, { preference })
  return result.value
}

/** Re-exported so callers can classify failures without importing two modules. */
export { RegistryError, isNotFoundError, mirrorCandidates, resolveMirrorPreference }
export type { MirrorPreference }
