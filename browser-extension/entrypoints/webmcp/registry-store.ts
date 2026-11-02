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
import { getBuiltinStorage } from './builtin-storage'
import {
  fetchRegistryManifest,
  invalidateRegistryCache,
  parseRegistryInput,
  RegistryError,
  type PackageRegistry,
  type RegistryManifest,
  type RegistryManifestPackage,
} from './registry-client'
import { installPackage, uninstallPackage } from './package-installer'

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
 * Returns the conflicting package description, or null when the install may
 * proceed. A mount that cannot be LISTED — or a manifest that cannot be
 * READ for reasons other than absence — fails the check (fail closed).
 */
export async function findPackageIdCollision(packageId: string): Promise<string | null> {
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
        // Same directory on the target mount with the same id — a
        // re-install of the very same package, which is allowed.
        continue
      }
      if (manifestId === packageId) {
        return `${entry.name} on ${mount} already publishes the package id ${manifestId}`
      }
    }
  }
  return null
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
  const collision = await findPackageIdCollision(pkg.id)
  if (collision) {
    throw new Error(
      `Cannot install ${pkg.id}: ${collision}. Remove or rename it first — installing would replace it.`,
    )
  }
  const provider = await getAdapterStorage()
  return installPackage(registry, pkg, provider, undefined, async lockSignal => {
    // Runs while the installer holds the per-package cross-context lock.
    // `findPackageIdCollision` already allows the one legitimate shape
    // (the same package re-installed over itself), so ANY non-null result
    // here is a conflict that appeared or became visible after the
    // unlocked check — reject before anything is written.
    if (lockSignal.aborted) {
      throw new Error(`The install of ${pkg.id} was aborted: the package lock was lost mid-transaction`)
    }
    const underLock = await findPackageIdCollision(pkg.id)
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
 * for data it cannot interpret.
 */
export async function listInstalledPackageIds(): Promise<Set<string>> {
  try {
    const provider = await getAdapterStorage()
    const entries = await provider.readdir('')
    const ids = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue
      const state = await readManifestId('webmcp', entry.name)
      if (state !== 'INVALID' && state !== 'UNREADABLE') ids.add(entry.name)
    }
    return ids
  } catch {
    // OPFS unavailable — nothing installed.
    return new Set()
  }
}

/**
 * Activation state of one installed package, read from its `config.json` on
 * the mount (the same file the extension's opt-in enable writes). Absence
 * of a config (or of the package entirely) reads as disabled.
 */
export async function readInstalledPackageActivation(packageId: string): Promise<'enabled' | 'disabled'> {
  try {
    const provider = await getAdapterStorage()
    const bytes = await provider.readFile(`${packageId}/config.json`)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { activation?: unknown }
    return parsed.activation === 'enabled' ? 'enabled' : 'disabled'
  } catch {
    return 'disabled'
  }
}
