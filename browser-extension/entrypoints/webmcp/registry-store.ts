/**
 * Extension-side registry store (issue #143).
 *
 * Owns the user's registry list (persisted in `chrome.storage.local`), the
 * catalog fetch per registry, and the install/uninstall transactions that
 * write into the extension's OWN OPFS mount (`getAdapterStorage()`).
 *
 * Nothing in this module goes through the page bridge: the extension origin
 * owns the adapter files, so an install is a direct OPFS write guarded by
 * the extension's own per-package lease (`package-lock.ts`).
 *
 * This is the extension-side replacement for the web app's
 * `web/webmcp/package-registry-store.ts` (issue #117).
 */

import type { FsProvider } from '@creatorweave/fs-provider'
import { getAdapterStorage } from './provider-storage'
import { readInstallMarker, type InstallMarker } from './install-marker'
import { getBuiltinStorage } from './builtin-storage'
import {
  fetchRegistryManifest,
  invalidateRegistryCache,
  parseRegistryInput,
  RegistryError,
  type PackageRegistry,
  type RegistryManifest,
  type RegistryManifestFile,
  type RegistryManifestPackage,
} from './registry-client'
import { installPackage, liveTreeIsComplete, sha256Hex, uninstallPackage } from './package-installer'

const REGISTRIES_STORAGE_KEY = 'webmcp_package_registries'

interface StoredRegistry {
  input: string
  label: string
  rawBase: string
  manifestUrl: string
}

/**
 * Whether the LAST write reached `chrome.storage.local`. False when the
 * storage is unavailable (quota, private mode) — the UI surfaces this so
 * the user knows the registry list is session-only.
 */
let lastWritePersisted = true

/** Registries the user added to this browser profile (order preserved). */
export async function listRegistries(): Promise<PackageRegistry[]> {
  const stored = await readPersistedRegistries()
  return stored.map(entry => ({
    rawBase: entry.rawBase,
    manifestUrl: entry.manifestUrl,
    label: entry.label,
  }))
}

/**
 * The raw persisted list. A malformed or missing entry list reads as empty
 * (the UI then shows "no registry added yet" instead of crashing). A
 * TRANSIENT storage READ failure propagates: converting it to an empty list
 * made the next mutation write that empty list back, erasing every saved
 * registry (finding: "Saved registries disappear").
 */
async function readPersistedRegistries(): Promise<StoredRegistry[]> {
  const stored = await chrome.storage.local.get(REGISTRIES_STORAGE_KEY)
  const parsed: unknown = stored?.[REGISTRIES_STORAGE_KEY]
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is StoredRegistry =>
    !!entry && typeof entry === 'object' &&
    typeof (entry as StoredRegistry).manifestUrl === 'string' &&
    typeof (entry as StoredRegistry).rawBase === 'string' &&
    typeof (entry as StoredRegistry).label === 'string')
}

/**
 * Registry-list mutations are serialized through ONE module-local promise
 * chain: `addRegistry`/`removeRegistry` read the whole stored list and write
 * a modified replacement, so two overlapping mutations from different
 * extension pages would otherwise lose one of the two edits (last writer
 * wins). The chain makes every read→modify→write sequence atomic with
 * respect to the other mutations in this context; a failure of one mutation
 * must not block the next, so the chain itself never carries a rejection.
 */
let registryMutations: Promise<unknown> = Promise.resolve()

function runRegistryMutation<T>(step: () => Promise<T>): Promise<T> {
  const gate = registryMutations.catch(() => {}).then(step)
  registryMutations = gate.catch(() => {})
  return gate
}

/**
 * Persist one mutation of the registry list. A failed write THROWS — the
 * caller (the background handler) surfaces it as `{ ok: false }` instead of
 * reporting success while `listRegistries` reads only persisted data and the
 * edit silently disappeared (finding: "Registry edits report false
 * success"). `lastWritePersisted` stays as the session-level flag the list
 * response reports.
 */
async function writePersistedRegistries(entries: StoredRegistry[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [REGISTRIES_STORAGE_KEY]: entries })
    lastWritePersisted = true
  } catch (error) {
    lastWritePersisted = false
    throw new RegistryError(
      `The registry list could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Parse a loose registry URL and persist it. Throws on unparseable input
 * (the `RegistryError` message is user-presentable) and when the list
 * cannot be read or written.
 */
export async function addRegistry(input: string): Promise<PackageRegistry> {
  const registry = parseRegistryInput(input)
  const stored: StoredRegistry = {
    input: input.trim(),
    label: registry.label,
    rawBase: registry.rawBase,
    manifestUrl: registry.manifestUrl,
  }
  return runRegistryMutation(async () => {
    const merged = (await readPersistedRegistries()).filter(entry => entry.manifestUrl !== stored.manifestUrl)
    merged.push(stored)
    await writePersistedRegistries(merged)
    return registry
  })
}

/**
 * Remove a registry from the list (installed packages are NOT uninstalled).
 * Throws when the list cannot be read or written.
 */
export async function removeRegistry(manifestUrl: string): Promise<void> {
  await runRegistryMutation(async () => {
    const remaining = (await readPersistedRegistries()).filter(entry => entry.manifestUrl !== manifestUrl)
    await writePersistedRegistries(remaining)
  })
  invalidateRegistryCache()
}

/** Whether the registry list survived a write to `chrome.storage.local`. */
export function registriesPersisted(): boolean {
  return lastWritePersisted
}

/** Fetch the catalog of one registry (5-min cache; `force` re-fetches). */
export async function loadRegistryCatalog(
  registry: PackageRegistry,
  options?: { force?: boolean },
): Promise<RegistryManifest> {
  return fetchRegistryManifest(registry, options)
}

/** True when a directory on the mount holds a VALID package manifest. */
async function readManifestId(mount: string, directory: string): Promise<{ id: string } | 'INVALID' | 'UNREADABLE'> {
  try {
    const provider = await getMountProvider(mount)
    const bytes = await provider.readFile(`${directory}/manifest.json`)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return 'INVALID'
    }
    // The manifest must carry a string id — a bare `{}` or a manifest with a
    // non-string id is not a package. Full schema validation stays the
    // catalog's job; the id-shape check here keeps the installer from
    // treating arbitrary JSON as an installed package.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'INVALID'
    const id = (parsed as { id?: unknown }).id
    return typeof id === 'string' && id ? { id } : 'INVALID'
  } catch (error) {
    const code = (error as { code?: string }).code
    const name = (error as { name?: string }).name
    // A confirmed missing manifest (the directory holds no package) is
    // distinct from a TRANSIENT read failure (quota, OPFS hiccup) — the
    // collision check must fail closed on the latter.
    if (code === 'ENOENT' || name === 'NotFoundError') return 'INVALID'
    return 'UNREADABLE'
  }
}

async function getMountProvider(mount: string): Promise<FsProvider> {
  if (mount === 'builtin-webmcp') {
    // The builtin mount is a read-only resource provider; the collision
    // check only READS it.
    return getBuiltinStorage()
  }
  return getAdapterStorage()
}

/**
 * Reject an install whose package id collides with an EXISTING package.
 *
 * A registry package id doubles as the directory name on the mount, so a
 * collision would silently delete (and replace) a builtin package, another
 * installed package, or a user-created package. The catalog then marks the
 * survivors as conflicting and the colliding package becomes unusable.
 *
 * Four distinct collisions are checked across BOTH mounts:
 *   1. the target directory already exists and holds a DIFFERENT package
 *      (its manifest id differs from the incoming one);
 *   2. the target directory exists but holds NO readable manifest — it is
 *      nonetheless OCCUPIED (user data the installer must not erase);
 *   3. another directory on any mount already publishes the SAME manifest
 *      id (duplicate namespace — the catalog would withdraw both);
 *   4. another directory holds an INVALID manifest (a bare `{}` or an id
 *      disagreeing with the directory name) — occupied, not installable
 *      over.
 *
 * When `expectedVersion` is given, an existing directory that already holds
 * the SAME id on the target mount is only accepted when its manifest
 * version matches: two concurrent first installs of the same id both pass
 * the unlocked check, then serialize on the package lock — without the
 * version agreement the under-lock check would read the winner's freshly
 * written manifest as "a reinstall of the same package" and the loser
 * would silently replace it (finding: "Concurrent installs replace
 * packages"). The manifest's id agrees with the directory name here (the
 * install validation enforces it), so the version is the discriminator.
 *
 * A version match alone is NOT enough (finding: "Same-version installs
 * replace different contents"): two overlapping installs of the same
 * id AND version with DIFFERENT contents both pass a version-only check
 * and the later transaction silently replaces the earlier package. When
 * `expectedContentFingerprint` is given, the on-disk package must hash to
 * the same whole-content digest (EVERY catalog-listed file, not just the
 * manifest — finding: "Same version replaces different package contents":
 * two registries can ship the same id+version with identical manifests but
 * different tool sources, and a manifest-only checksum let the later
 * install pass and replace the earlier package's files) — content the
 * catalog author did not publish is never overwritten by a same-version
 * install.
 *
 * Returns the conflicting package description, or null when the install may
 * proceed. A mount that cannot be LISTED — or a manifest that cannot be
 * READ for reasons other than absence — fails the check (fail closed).
 */
export async function findPackageIdCollision(
  packageId: string,
  expectedVersion?: string,
  expectedContentFingerprint?: string,
  collisionFingerprintFiles?: RegistryManifestFile[],
): Promise<string | null> {
  const mounts = ['webmcp', 'builtin-webmcp']
  for (const mount of mounts) {
    let entries: Array<{ name: string; kind: string }>
    let provider: FsProvider
    try {
      provider = await getMountProvider(mount)
      entries = await provider.readdir('')
    } catch {
      // Fail closed: a mount we cannot inspect may already hold the id.
      return `The ${mount} storage could not be inspected; try again later`
    }
    for (const entry of entries) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue
      const state = await readManifestId(mount, entry.name)
      if (state === 'UNREADABLE') {
        // A manifest we cannot READ may be the very id being installed —
        // refusing beats installing a duplicate namespace.
        return `The manifest of ${entry.name} on ${mount} could not be read; try again later`
      }
      const manifestId = state === 'INVALID' ? null : state.id
      if (!manifestId) {
        if (entry.name === packageId) {
          if (mount === 'webmcp' && await hasPreservedBackup(provider, packageId)) continue
          // The target directory exists but holds no valid manifest —
          // treat it as occupied anyway: the installer must never delete
          // data it cannot interpret.
          return `${entry.name} on ${mount} already exists but is not a valid package; remove or rename it first`
        }
        // An invalid directory under a DIFFERENT name cannot collide by id,
        // but it may still be user data — it just cannot be matched by id.
        continue
      }
      if (entry.name === packageId) {
        // The target directory already exists.
        if (manifestId !== packageId) {
          return `${entry.name} on ${mount} already holds the package ${manifestId}`
        }
        if (mount !== 'webmcp') {
          // Same id on ANOTHER mount (a builtin): installing it here would
          // create a duplicate namespace and the catalog would withdraw
          // BOTH packages.
          return `${entry.name} on ${mount} already publishes the package id ${manifestId}`
        }
        // Same directory on the target mount with the same id — usually a
        // re-install of the very same package, which is allowed. With an
        // expected version, a DIFFERENT manifest version means another
        // install transaction already replaced the directory between our
        // unlocked check and this under-lock one — not a reinstall of what
        // we downloaded. Reject so the stale transaction cannot overwrite
        // the newer install.
        if (expectedVersion !== undefined) {
          const installedVersion = await readManifestVersion(mount, entry.name)
          if (installedVersion === 'UNREADABLE') {
            return `The manifest of ${entry.name} on ${mount} could not be read; try again later`
          }
          if (installedVersion !== expectedVersion) {
            if (mount === 'webmcp' && await hasPreservedBackup(provider, packageId)) {
              const fingerprint = await readInstalledPackageFingerprint(mount, packageId, collisionFingerprintFiles ?? [])
              if (fingerprint === 'INVALID' && !await liveTreeIsComplete(provider, packageId)) continue
            }
            return `${entry.name} on ${mount} already holds version ${installedVersion ?? 'unknown'} of this package`
          }
          // Same id AND same version: the CONTENTS decide (finding: "Same
          // version installs replace different contents"). Two overlapping
          // installs of the same id+version with different files would
          // otherwise pass this check and the later one silently replace
          // the earlier package. The WHOLE-CONTENT fingerprint (every
          // catalog-listed file) is the reference — the on-disk package
          // must hash to the same value for this to count as a genuine
          // reinstall; a manifest-only checksum was not enough because a
          // manifest does not hash its own file contents (finding: "Same
          // version replaces different package contents").
          if (expectedContentFingerprint !== undefined) {
            const installedFingerprint = await readInstalledPackageFingerprint(mount, packageId, collisionFingerprintFiles ?? [])
            if (installedFingerprint === 'UNREADABLE') {
              return `The files of ${entry.name} on ${mount} could not be read; try again later`
            }
            if (installedFingerprint !== expectedContentFingerprint) {
              if (installedFingerprint === 'INVALID' && await hasPreservedBackup(provider, packageId)) continue
              return `${entry.name} on ${mount} already holds version ${expectedVersion} with different contents (content fingerprint ${installedFingerprint === 'INVALID' ? 'unavailable' : installedFingerprint}); uninstall it first if you want to replace it`
            }
          }
        }
        continue
      }
      if (manifestId === packageId) {
        return `${entry.name} on ${mount} already publishes the package id ${manifestId}`
      }
    }
  }
  return null
}

async function hasPreservedBackup(provider: FsProvider, packageId: string): Promise<boolean> {
  const backup = `.${packageId}.previous`
  try {
    const stat = await provider.stat(backup)
    if (stat.kind !== 'directory') return false
  } catch (error) {
    const missing = error as { code?: string; name?: string }
    if (missing.code === 'ENOENT' || missing.name === 'NotFoundError') return false
    throw error
  }
  return liveTreeIsComplete(provider, backup, packageId)
}

/**
 * The version recorded in a directory's manifest, with the same
 * three-state read contract as `readManifestId`.
 */
async function readManifestVersion(mount: string, directory: string): Promise<string | 'INVALID' | 'UNREADABLE'> {
  try {
    const provider = await getMountProvider(mount)
    const bytes = await provider.readFile(`${directory}/manifest.json`)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'INVALID'
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version ? version : 'INVALID'
  } catch (error) {
    const code = (error as { code?: string }).code
    const name = (error as { name?: string }).name
    if (code === 'ENOENT' || name === 'NotFoundError') return 'INVALID'
    return 'UNREADABLE'
  }
}

/**
 * A SHORT digest over every catalog-listed file of an installed package —
 * the CONTENT fingerprint of a same-version reinstall.
 *
 * The manifest.json checksum alone is not one (finding: "Same version
 * replaces different package contents"): two registries can ship the same
 * id+version with BYTE-IDENTICAL manifests but different tool sources —
 * the manifest does not hash its own file contents — so a manifest-only
 * comparison let the later install pass the collision check and silently
 * replace the earlier package's files. Hashing every catalog-listed file
 * binds the fingerprint to the whole package the catalog author published.
 *
 * The ENCODING must be identical to `registryPackageFingerprint`'s (finding:
 * "Identical installs look different"): that side hashes each catalog
 * file's sha256 DIGEST bytes, so this side hashes each installed file's
 * OWN sha256 digest (not the raw file bytes) — hashing the raw bytes
 * produced digests that never matched the expected side, and every
 * same-version reinstall of an identical package was rejected as "different
 * contents". Deterministic file order, an unambiguous `path:32:` header and
 * a 0x separator keep the digest collision-free.
 *
 * The installer-managed `config.json` is EXCLUDED from BOTH sides (finding:
 * "Identical config packages conflict"): the installer never copies the
 * catalog's config.json — it writes the disabled default (activation is
 * exclusively the opt-in flow's job) — so the catalog's config checksum
 * cannot describe the on-disk file, and including it made an otherwise
 * identical reinstall read as a conflict.
 *
 * `expectedFiles` carries the incoming catalog's file list (the reference
 * path set); the installed tree is read at exactly those paths — an
 * installed package missing one of them reads as a fingerprint mismatch
 * ('INVALID'), a TRANSIENT read failure as 'UNREADABLE' (fail closed).
 */
async function readInstalledPackageFingerprint(mount: string, packageId: string, expectedFiles: RegistryManifestFile[]): Promise<string | 'INVALID' | 'UNREADABLE'> {
  const provider = await getMountProvider(mount)
  const files = [...expectedFiles]
    .filter(file => file.path !== `packages/${packageId}/config.json`)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const parts: Uint8Array[] = []
  for (const file of files) {
    const local = file.path.replace(/^packages\/[^/]+\//, '')
    try {
      const bytes = await provider.readFile(`${packageId}/${local}`)
      // Hash the file's own sha256 digest — the same encoding as the
      // expected side (see above).
      const digestHex = await sha256Hex(bytes)
      const digest = new Uint8Array(digestHex.length / 2)
      for (let index = 0; index < digest.length; index++) digest[index] = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16)
      const header = new TextEncoder().encode(`${file.path}:${digest.length}:`)
      parts.push(header, digest, new Uint8Array([0]))
    } catch (error) {
      const code = (error as { code?: string }).code
      const name = (error as { name?: string }).name
      if (code === 'ENOENT' || name === 'NotFoundError') return 'INVALID'
      return 'UNREADABLE'
    }
  }
  return hashFingerprintParts(parts)
}

/**
 * The incoming catalog entry's content fingerprint, over the same
 * deterministic encoding as `readInstalledPackageFingerprint` — but from
 * the catalog's EXPECTED sha256 per file, so the comparison never needs to
 * hash the incoming downloads again (the installer verified them already).
 *
 * The installer-managed `config.json` is excluded here too — see
 * `readInstalledPackageFingerprint` (finding: "Identical config packages
 * conflict").
 */
async function registryPackageFingerprint(packageId: string, files: RegistryManifestFile[]): Promise<string> {
  const sorted = [...files]
    .filter(file => file.path !== `packages/${packageId}/config.json`)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const parts: Uint8Array[] = []
  for (const file of sorted) {
    const sha = file.sha256.toLowerCase()
    const hexBytes = new Uint8Array(sha.length / 2)
    for (let index = 0; index < hexBytes.length; index++) hexBytes[index] = Number.parseInt(sha.slice(index * 2, index * 2 + 2), 16)
    const header = new TextEncoder().encode(`${file.path}:${hexBytes.length}:`)
    parts.push(header, hexBytes, new Uint8Array([0]))
  }
  return hashFingerprintParts(parts)
}

/** sha256 over the fingerprint's concatenated parts (shared encoding tail). */
async function hashFingerprintParts(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return sha256Hex(merged)
}

/**
 * Whether the package directory is currently PRESENT on the mount.
 * `null` when the answer is INDETERMINATE (a transient stat failure).
 *
 * The install flow probes the mount BEFORE the download and re-checks
 * INSIDE the lock: a directory that existed before but is gone under the
 * lock was removed by a concurrent uninstall — the install must not
 * resurrect it (finding: "Uninstalled package reappears").
 */
async function presenceOfInstalledPackage(packageId: string): Promise<boolean | null> {
  const provider = await getAdapterStorage()
  try {
    await provider.stat(packageId)
    return true
  } catch (error) {
    const code = (error as { code?: string }).code
    const name = (error as { name?: string }).name
    if (code === 'ENOENT' || name === 'NotFoundError') return false
    return null
  }
}

/**
 * Install one package from its manifest entry into the extension's `webmcp`
 * mount. Verifies every file's sha256 BEFORE writing anything
 * (all-or-nothing).
 *
 * The id-collision check runs TWICE: once BEFORE the installer's lock (fast
 * rejection with a precise message) and once again INSIDE the lock — two
 * concurrent first installs of the same id both pass the unlocked check,
 * then serialize on the lock; without the re-check the later install would
 * silently replace the earlier one.
 */
export async function installRegistryPackage(
  registry: PackageRegistry,
  pkg: RegistryManifestPackage,
): Promise<{ filesWritten: number }> {
  // The WHOLE-CONTENT fingerprint (every catalog-listed file) doubles as the
  // same-version reinstall check below — the manifest checksum alone was not
  // enough because a manifest does not hash its own file contents (finding:
  // "Same version replaces different package contents").
  const contentFingerprint = await registryPackageFingerprint(pkg.id, pkg.files)
  // Probe the mount BEFORE the download (finding: "Uninstalled package
  // reappears"): the presence bit fences a download that outlives the
  // user's uninstall — a directory that existed now but is gone under the
  // lock means a concurrent removal won the race and the install must not
  // write the package back. An INDETERMINATE probe (null) falls through to
  // the under-lock re-check.
  const presenceBefore = await presenceOfInstalledPackage(pkg.id)
  const collision = await findPackageIdCollision(pkg.id)
  if (collision) {
    throw new Error(
      `Cannot install ${pkg.id}: ${collision}. Remove or rename it first — installing would replace it.`,
    )
  }
  const provider = await getAdapterStorage()
  return installPackage(registry, pkg, provider, { presenceBefore }, async lockSignal => {
    // Runs while the installer holds the per-package cross-context lock.
    // `findPackageIdCollision` already allows the one legitimate shape
    // (the same package re-installed over itself), so ANY non-null result
    // here is a conflict that appeared or became visible after the
    // unlocked check — reject before anything is written. The expected
    // version makes "same id" strict: a concurrent install that already
    // swapped a different version into the directory is a conflict, not
    // a reinstall.
    if (lockSignal.aborted) {
      throw new Error(`The install of ${pkg.id} was aborted: the package lock was lost mid-transaction`)
    }
    // REMOVAL FENCE (finding: "Uninstalled package reappears"): a directory
    // that existed before the download but is GONE under the lock was
    // removed by a concurrent uninstall that won the lock race — the
    // installer aborts such a transaction before writing. Only a
    // CONFIRMED pre-download presence gates here: `false` is the normal
    // first install, and an INDETERMINATE probe is not evidence of a
    // removal (the collision check below fails closed on unreadable
    // state anyway).
    if (presenceBefore === true) {
      const presenceUnderLock = await presenceOfInstalledPackage(pkg.id)
      if (presenceUnderLock === false) {
        throw new Error(`The install of ${pkg.id} was cancelled: the package was removed while it was being prepared`)
      }
    }
    const underLock = await findPackageIdCollision(pkg.id, pkg.version, contentFingerprint, pkg.files)
    if (underLock) {
      throw new Error(
        `Cannot install ${pkg.id}: ${underLock}. Remove or rename it first — installing would replace it.`,
      )
    }
  })
}

/** Uninstall: remove the package directory from the `webmcp` mount. */
export async function uninstallRegistryPackage(packageId: string): Promise<void> {
  const provider = await getAdapterStorage()
  await uninstallPackage(packageId, provider)
}

/**
 * Directories currently present on the `webmcp` mount (= installed ids).
 * Dot-prefixed directories are internal installer state (staging/backup),
 * not packages, and are skipped. A directory WITHOUT a valid manifest is
 * also skipped: the management UI must not offer install/uninstall actions
 * for data it cannot interpret. The reported id is the manifest's own id —
 * the package's identity — but ONLY when it agrees with the directory name
 * (the id doubles as the directory name; a manifest claiming another id is
 * exactly the mismatch the collision check refuses, and reporting it under
 * the directory name would make the matching registry package appear not
 * installed while installing it is rejected).
 *
 * THROWS when the mount itself cannot be listed: mapping a listing failure
 * to an empty set made the management page report every installed package
 * as missing while the files were untouched (finding: "Storage errors hide
 * installed state"). The background handler surfaces the error instead.
 *
 * A package whose manifest cannot be READ transiently does not disappear
 * from the list either (finding: "Installed packages disappear from the
 * list"): silently omitting it made the page offer Install for a package
 * that was present while `findPackageIdCollision` refused that install —
 * the user could neither see nor manage it. The directory NAME is a
 * package id by construction (the installer only ever creates id-named
 * directories), so the id is reported from the directory name.
 *
 * That report is per-PACKAGE, not per-call: a single unreadable manifest no
 * longer rejects the whole list (finding: "Unreadable manifests block
 * registry data"). Rejecting it did show the truth about the installed set,
 * but it also took down the registry section AND "mine" for every other
 * package — one bad local directory blanked the page. Callers that need to
 * distinguish a possibly-misattributed id can compare the manifest id; the
 * registry install record that would settle it durably is the planned
 * storage work, not a read-path guess.
 */
/**
 * Installed packages on the `webmcp` mount, derived from install markers only
 * (issue #228). One mount listing answers both questions the page needs:
 *
 * - `ids` — packages the registry section may act on (activation, repair,
 *   remove) and match against a catalog entry
 * - `directories` — the directories that carry provenance; `classifyPackage`
 *   sends everything else to "mine"
 *
 * A package installed before markers existed carries none and reads as
 * authored. That direction is deliberate: the page must never offer an
 * uninstall action for something it cannot prove it installed (finding:
 * "Authored packages get uninstall controls").
 *
 * A marker names its own directory or it is a copy that cannot be trusted for
 * targeting — a `packageId` that differs from the directory is skipped rather
 * than letting Remove point at a different package (finding: "Uninstall
 * targets another directory").
 *
 * An UNREADABLE marker keeps the directory on the installed side: storage
 * cannot prove it was authored, and hiding an install exposes it to reinstall
 * collisions. Its id falls back to the directory name.
 */
export interface InstalledPackages {
  ids: Set<string>
  directories: Set<string>
}

export async function listInstalledPackages(provider?: FsProvider): Promise<InstalledPackages> {
  const mount = provider ?? await getAdapterStorage()
  const entries = await mount.readdir('')
  const ids = new Set<string>()
  const directories = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue
    let marker: InstallMarker | null
    try {
      marker = await readInstallMarker(mount, entry.name)
    } catch {
      directories.add(entry.name)
      ids.add(entry.name)
      continue
    }
    if (!marker || marker.packageId !== entry.name) continue
    directories.add(entry.name)
    ids.add(marker.packageId)
  }
  return { ids, directories }
}

/**
 * Activation state of one installed package, read from its `config.json` on
 * the mount (the same file the extension's opt-in enable writes). Absence
 * of a config (or of the package entirely) reads as disabled.
 *
 * THROWS on a read failure that is NOT a confirmed absence: mapping a
 * transient config-read error to `disabled` made the management page
 * report an ENABLED package as inactive (finding: "Storage errors hide
 * installed state").
 */
export async function readInstalledPackageActivation(packageId: string): Promise<'enabled' | 'disabled'> {
  let bytes: Uint8Array
  try {
    const provider = await getAdapterStorage()
    bytes = await provider.readFile(`${packageId}/config.json`)
  } catch (error) {
    const code = (error as { code?: string }).code
    const name = (error as { name?: string }).name
    if (code === 'ENOENT' || name === 'NotFoundError') return 'disabled'
    throw error
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { activation?: unknown }
    return parsed.activation === 'enabled' ? 'enabled' : 'disabled'
  } catch {
    // A corrupt config reads as disabled — the opt-in flow rewrites it.
    return 'disabled'
  }
}
