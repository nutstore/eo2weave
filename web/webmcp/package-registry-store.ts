/**
 * Settings-side client for the WebMCP package registry installer
 * (issue #117, Tier 1).
 *
 * Wires the pure registry client + installer to the web app's VFS provider
 * for the `webmcp` mount — the extension-owned OPFS directory exposed through
 * the injected provider (`/external/webmcp/`, the same location the extension
 * adapter-validation recognizes). Registry catalogs are listed, one package
 * is installed at a time, and installed packages are matched against the
 * mount's directories to render the "installed" state.
 *
 * There is deliberately NO built-in registry URL: every registry is added by
 * the user (loose URL input). Registries added in this session are kept in
 * localStorage (with an in-memory fallback where storage is unavailable —
 * private mode) so the list survives reloads; manifests themselves stay in
 * the 5-minute in-memory cache of the registry client.
 */

import { providerRegistry } from '@/vfs/provider-registry'
import {
  fetchRegistryManifest,
  parseRegistryInput,
  invalidateRegistryCache,
  type PackageRegistry,
  type RegistryManifest,
  type RegistryManifestPackage,
} from '@/webmcp/package-registry-client'
import { installPackage, uninstallPackage } from '@/webmcp/package-installer'
import { getWebMCPBridge } from '@/webmcp/bridge-client'

const REGISTRIES_STORAGE_KEY = 'webmcp_package_registries'

interface StoredRegistry {
  input: string
  label: string
  rawBase: string
  manifestUrl: string
}

/**
 * In-memory mirror of the persisted registry list. When localStorage is
 * unavailable (private mode, storage quota) the session keeps working: a
 * registry the user just added stays listed until the tab closes instead of
 * silently vanishing (finding: "Registry addition disappears in private
 * mode").
 *
 * The mirror is DELTA-BASED (findings: "Concurrent registry additions
 * disappear" / "Removed registry reappears"): it records only the entries
 * THIS SESSION actually added (`sessionAdded`) and the manifest URLs it
 * removed (`sessionRemoved`), and replays the deltas over the persisted
 * list on every read. Storing the whole merged list would re-add entries a
 * peer tab removed after our last write; storing only the delta keeps a
 * removed entry removed:
 *   - read = persisted list, minus session removals, plus session additions;
 *   - write = the merged list (so persistence also converges).
 */
let sessionAdded: StoredRegistry[] | null = null
let sessionRemoved: Set<string> | null = null

/**
 * Cross-tab reconciliation (round-2 findings: "Concurrent registry edits are
 * lost" / "Peer removal is undone in another tab"): when a PEER tab writes
 * the persisted list, the `storage` event fires in this tab (it fires only
 * in tabs OTHER than the writer, so a tab never observes its own write).
 * Replaying our deltas over a list we have not reconciled would resurrect a
 * registry a peer removed (our `sessionAdded` is stale) — so a peer write
 * prunes every session addition that the peer's persisted list no longer
 * holds: if the peer's list still contains the entry, our delta stays; if
 * the peer removed it, the removal WINS and our stale addition is dropped.
 * The React layer re-reads via its own effect/state updates; the mirror is
 * corrected here so any LATER read converges to the peer's state plus this
 * session's still-valid deltas.
 */
function reconcileWithPersisted(): void {
  if (!sessionAdded?.length) return
  // Session-only mode (private browsing, quota failure): the persisted list
  // is permanently empty, so every absent URL would look like a peer
  // removal and our session additions would be pruned on the next read —
  // the registry the UI just reported as added would vanish (finding:
  // "Session-only registry disappears"). Reconciliation exists to resolve
  // peer-tab writes; with no persistent store there are no peer writes,
  // and the session additions are the source of truth.
  if (!storageAvailable()) return
  const persistedUrls = new Set(readPersistedRegistries().map(entry => entry.manifestUrl))
  sessionAdded = sessionAdded.filter(entry => persistedUrls.has(entry.manifestUrl))
  if (sessionAdded.length === 0) sessionAdded = null
}

let reconcileListenerInstalled = false
function ensureReconcileListener(): void {
  if (reconcileListenerInstalled || typeof window === 'undefined') return
  reconcileListenerInstalled = true
  window.addEventListener('storage', event => {
    if (event.storageArea !== localStorage || event.key !== REGISTRIES_STORAGE_KEY) return
    reconcileWithPersisted()
  })
}

function storageAvailable(): boolean {
  try {
    const probe = '__webmcp_registry_probe__'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

function loadStoredRegistries(): StoredRegistry[] {
  ensureReconcileListener()
  // A peer tab may have written the list since our last read (its write does
  // not fire a storage event in ITS window, and our listener reconciles in
  // THIS one): prune session additions the peer's fresh persisted list no
  // longer holds BEFORE replaying deltas, so a peer removal is not undone by
  // our stale replay (finding: "Peer removal is undone in another tab").
  reconcileWithPersisted()
  const persisted = readPersistedRegistries()
  if (!sessionAdded && !sessionRemoved) return persisted
  const removed = sessionRemoved ?? new Set<string>()
  const added = sessionAdded ?? []
  // Replay: persisted entries survive unless removed in this session; this
  // session's additions are appended in their original order (replacing a
  // persisted entry with the same manifestUrl — a re-add after removal).
  const byUrl = new Map(persisted.filter(entry => !removed.has(entry.manifestUrl)).map(entry => [entry.manifestUrl, entry]))
  for (const entry of added) byUrl.set(entry.manifestUrl, entry)
  return [...byUrl.values()]
}

/**
 * Write the merged list WITHOUT touching the session deltas: `sessionAdded`
 * stays exactly the entries this session added (round-5 finding: "Removed
 * registries reappear" — copying the whole merged list in made the next
 * merge replay entries a peer tab had removed, resurrecting them).
 */
function saveStoredRegistries(registries: StoredRegistry[]): boolean {
  try {
    localStorage.setItem(REGISTRIES_STORAGE_KEY, JSON.stringify(registries))
    return true
  } catch {
    // localStorage unavailable (private mode) — the session mirror above
    // keeps the list usable for this tab; report the persistence gap so the
    // UI can tell the user the registry will not survive a reload.
    return false
  }
}

/** The raw persisted list, WITHOUT the session deltas replayed. */
function readPersistedRegistries(): StoredRegistry[] {
  try {
    const raw = localStorage.getItem(REGISTRIES_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as StoredRegistry[]) : []
  } catch {
    return []
  }
}

/** Registries added by the user this browser profile (order preserved). */
export function listRegistries(): PackageRegistry[] {
  return loadStoredRegistries().map(entry => ({
    rawBase: entry.rawBase,
    manifestUrl: entry.manifestUrl,
    label: entry.label,
  }))
}

/**
 * Whether the LAST write reached localStorage. False in private mode — the
 * UI surfaces this so the user knows the registry list is session-only.
 */
let lastWritePersisted = true
export function registriesPersisted(): boolean {
  return lastWritePersisted && storageAvailable()
}

/**
 * Parse a loose registry URL and persist it. Throws on unparseable input
 * (the raw `Error` message from `parseRegistryInput` is user-presentable).
 * The addition is MERGED against a FRESH persisted read taken immediately
 * before the write (round-5 finding: "Concurrent registry edits overwrite
 * each other"): two settings tabs editing the list concurrently each merge
 * into what is actually stored at write time, so the second write no longer
 * discards the first tab's edit with a stale full-list snapshot. The session
 * records the addition as a DELTA so a failed persistence write still keeps
 * it visible.
 */
export function addRegistry(input: string): PackageRegistry {
  const registry = parseRegistryInput(input)
  const stored: StoredRegistry = { input: input.trim(), label: registry.label, rawBase: registry.rawBase, manifestUrl: registry.manifestUrl }
  // Record the delta FIRST — the view must reflect the addition even when
  // the write below fails (private mode).
  sessionAdded = [...(sessionAdded ?? []).filter(entry => entry.manifestUrl !== stored.manifestUrl), stored]
  sessionRemoved?.delete(stored.manifestUrl)
  // Merge into the CURRENTLY persisted list, not the last snapshot this tab
  // wrote: a peer tab's concurrent addition (or removal) is preserved.
  const merged = readPersistedRegistries().filter(entry => entry.manifestUrl !== stored.manifestUrl)
  merged.push(stored)
  lastWritePersisted = saveStoredRegistries(merged)
  return registry
}

/**
 * Remove a registry from the list (installed packages are NOT uninstalled).
 * The removal is recorded as a session DELTA (finding: "Removed registry
 * reappears"): even when the persistence write fails and the persisted list
 * still contains the entry, later reads of THIS session exclude it instead
 * of resurrecting it from storage. The write merges against a FRESH
 * persisted read so a peer tab's concurrent edit survives ours (round-5
 * finding: "Concurrent registry edits overwrite each other").
 */
export function removeRegistry(manifestUrl: string): void {
  sessionRemoved = new Set([...(sessionRemoved ?? []), manifestUrl])
  sessionAdded = (sessionAdded ?? []).filter(entry => entry.manifestUrl !== manifestUrl)
  lastWritePersisted = saveStoredRegistries(readPersistedRegistries().filter(entry => entry.manifestUrl !== manifestUrl))
  invalidateRegistryCache()
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
    const provider = await providerRegistry.get(mount)
    const bytes = await provider.readFile(`${directory}/manifest.json`)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return 'INVALID'
    }
    // The manifest must carry a string id — a bare `{}` or a manifest with
    // a non-string id is not a package (finding: "Invalid directory offered
    // for uninstall" / "Malformed packages count as valid"). Full schema
    // validation stays the catalog's job; the id-shape check here keeps the
    // installer from treating arbitrary JSON as an installed package.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'INVALID'
    const id = (parsed as { id?: unknown }).id
    return typeof id === 'string' && id ? { id } : 'INVALID'
  } catch (error) {
    const code = (error as { code?: string }).code
    const name = (error as { name?: string }).name
    // A confirmed missing manifest (the directory holds no package) is
    // distinct from a TRANSIENT read failure (quota, OPFS hiccup) — the
    // collision check must fail closed on the latter (findings: "Transient
    // reads bypass collision checks" / "Unreadable manifests hide
    // collisions").
    if (code === 'ENOENT' || name === 'NotFoundError') return 'INVALID'
    return 'UNREADABLE'
  }
}

/** True when the directory holds a readable manifest with a string id. */
async function directoryHasValidManifest(mount: string, directory: string): Promise<boolean> {
  const state = await readManifestId(mount, directory)
  return state !== 'INVALID' && state !== 'UNREADABLE'
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
 *      over (findings: "Malformed packages count as valid" / "Invalid
 *      directory offered for uninstall").
 *
 * Returns the conflicting package description, or null when the install may
 * proceed. A mount that cannot be LISTED — or a manifest that cannot be
 * READ for reasons other than absence (transient OPFS/quota failure) —
 * fails the check (fail closed): proceeding could create a duplicate
 * namespace or overwrite data we could not inspect (findings: "Unreadable
 * mount permits duplicate package" / "Transient reads bypass collision
 * checks" / "Unreadable manifests hide collisions").
 */
export async function findPackageIdCollision(packageId: string): Promise<string | null> {
  const mounts = ['webmcp', 'builtin-webmcp']
  for (const mount of mounts) {
    let entries: Array<{ name: string; kind: string }>
    let provider: Awaited<ReturnType<typeof providerRegistry.get>>
    try {
      provider = await providerRegistry.get(mount)
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
          // data it cannot interpret (finding: "Existing data is
          // overwritten").
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
 * Catalog-refresh notification to the extension background (finding:
 * "Uninstall leaves tools registered"): install/uninstall change the
 * EXTERNAL package directory the background's catalog reads, but nothing
 * else observes OPFS writes. Without this signal a removed package's tools
 * stay registered (and a fresh install's tools stay unregistered) until an
 * unrelated refresh. The bridge method is optional — older extensions and
 * tests without a bridge simply skip it (the in-tab UI refreshes itself
 * through the section's own state updates).
 *
 * Returns true when the background CONFIRMED the refresh (finding: "Refresh
 * failure leaves stale tools" — an `{ ok: false }` response was swallowed
 * and a failed refresh reported as success, silently leaving the old tool
 * catalog in place). Callers decide how to surface a `false` result; the
 * in-tab UI stays correct either way because it re-reads the mount itself.
 */
async function notifyBackgroundCatalogChanged(): Promise<boolean> {
  const bridge = getWebMCPBridge()
  if (!bridge?.webMCPPackagesChangedNotify) return false
  try {
    const result = await bridge.webMCPPackagesChangedNotify()
    return result?.ok === true
  } catch {
    // Extension context gone mid-operation — the next catalog refresh
    // picks the change up anyway.
    return false
  }
}

/**
 * Install one package from its manifest entry into the `webmcp` VFS mount.
 * Verifies every file's sha256 BEFORE writing anything (all-or-nothing).
 *
 * The id-collision check runs TWICE (finding: "Concurrent collision check
 * is bypassed"): once BEFORE the installer's lock (fast rejection with a
 * precise message) and once again INSIDE `installPackage`'s per-package
 * cross-context lock via `assertNoCollisionUnderLock` — two registries
 * concurrently first-installing the same id both pass the unlocked check,
 * then serialize on the lock; without the re-check the later install would
 * silently replace the earlier one.
 */
export async function installRegistryPackage(
  registry: PackageRegistry,
  pkg: RegistryManifestPackage,
): Promise<{ filesWritten: number; catalogRefreshed: boolean }> {
  const collision = await findPackageIdCollision(pkg.id)
  if (collision) {
    throw new Error(
      `Cannot install ${pkg.id}: ${collision}. Remove or rename it first — installing would replace it.`,
    )
  }
  const provider = await providerRegistry.get('webmcp')
  const result = await installPackage(registry, pkg, provider, undefined, async lockSignal => {
    // Runs while the installer holds the per-package cross-context lock.
    // `findPackageIdCollision` already allows the one legitimate shape
    // (the same package re-installed over itself), so ANY non-null result
    // here is a conflict that appeared or became visible after the
    // unlocked check — reject before anything is written. A lease lost
    // mid-check aborts the transaction the same way (finding: "Lost lease
    // does not stop mutations").
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
  // A rejected/failed refresh is SURFACED, not swallowed (finding: "Refresh
  // failure leaves stale tools"): the files are committed, but the
  // extension's tool catalog may still show the previous state until the
  // next refresh — the caller can tell the user instead of reporting a
  // fully clean success.
  const refreshed = await notifyBackgroundCatalogChanged()
  return { ...result, catalogRefreshed: refreshed }
}

/** Uninstall: remove the package directory from the `webmcp` mount. */
export async function uninstallRegistryPackage(packageId: string): Promise<{ catalogRefreshed: boolean }> {
  const provider = await providerRegistry.get('webmcp')
  await uninstallPackage(packageId, provider)
  const refreshed = await notifyBackgroundCatalogChanged()
  return { catalogRefreshed: refreshed }
}

/**
 * Directories currently present on the `webmcp` mount (= installed ids).
 * Dot-prefixed directories are internal installer state (staging/backup),
 * not packages, and are skipped. A directory WITHOUT a valid manifest is
 * also skipped: the settings UI must not offer install/uninstall actions
 * for data it cannot interpret (finding: "Existing data is overwritten" —
 * the actions half).
 */
export async function listInstalledPackageIds(): Promise<Set<string>> {
  try {
    const provider = await providerRegistry.get('webmcp')
    const entries = await provider.readdir('')
    const ids = new Set<string>()
    for (const entry of entries) {
      if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue
      if (await directoryHasValidManifest('webmcp', entry.name)) ids.add(entry.name)
    }
    return ids
  } catch {
    // Extension bridge unavailable / mount not announced — nothing installed.
    return new Set()
  }
}

/**
 * Activation state of one installed package, read from its `config.json` on
 * the mount (the same file the extension's opt-in enable writes). Absence of
 * a config (or of the package entirely) reads as disabled. The settings
 * section uses this to show "active" only for packages actually enabled via
 * the on-site opt-in flow.
 */
export async function readInstalledPackageActivation(packageId: string): Promise<'enabled' | 'disabled'> {
  try {
    const provider = await providerRegistry.get('webmcp')
    const bytes = await provider.readFile(`${packageId}/config.json`)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { activation?: unknown }
    return parsed.activation === 'enabled' ? 'enabled' : 'disabled'
  } catch {
    return 'disabled'
  }
}
