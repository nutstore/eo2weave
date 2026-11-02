import { FsError, type FsProvider } from '@creatorweave/fs-provider'
import { activeWebMCPPackages, readMountedWebMCPCatalog, type WebMCPMount, type WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'
import { getAdapterStorage } from './provider-storage'
import { getBuiltinStorage } from './builtin-storage'

export function providerMount(name: string, provider: FsProvider): WebMCPMount {
  return {
    name, readOnly: provider.readOnly === true,
    files: {
      async directories() { return (await provider.readdir('')).filter(entry => entry.kind === 'directory').map(entry => entry.name) },
      async readFile(path) {
        try { return new TextDecoder().decode(await provider.readFile(path)) }
        catch (error) {
          // File System Access reports absence as a DOMException. Normalize it
          // at the provider boundary so the package parser stays storage-neutral.
          if ((error as { name?: string } | null)?.name === 'NotFoundError') throw new FsError('ENOENT', path)
          throw error
        }
      },
    },
  }
}
export async function getWebMCPMounts() {
  const [builtin, user] = await Promise.all([getBuiltinStorage(), getAdapterStorage()])
  return [providerMount('builtin-webmcp', builtin), providerMount('webmcp', user)]
}
export async function readWebMCPCatalog(): Promise<WebMCPPackageEntry[]> {
  // The USER mount may fail to initialize or list (OPFS unavailable, quota,
  // corrupted handle). A failed user mount must degrade to a builtin-only
  // catalog (logged) — letting it reject would clear every adapter route on
  // refresh (finding: "Enabled package tools remain unavailable") and hide
  // healthy builtin packages from the opt-in probe.
  const [entries] = await readWebMCPCatalogDetailed()
  return entries
}

/**
 * Catalog read WITH mount-completeness information. Identical to
 * `readWebMCPCatalog` but reports whether the user mount was omitted because
 * it could not be listed. Callers whose decision SAFETY depends on seeing
 * every package (the opt-in enable: a user-mounted twin sharing the builtin
 * candidate's manifest id must never be missed) must refuse to act on an
 * incomplete catalog instead of silently enabling a conflicting package
 * (finding: "Conflicting package activates without tools").
 */
export async function readWebMCPCatalogDetailed(): Promise<[WebMCPPackageEntry[], { userMountComplete: boolean }]> {
  const mounts: WebMCPMount[] = [providerMount('builtin-webmcp', await getBuiltinStorage())]
  try {
    const user = providerMount('webmcp', await getAdapterStorage())
    await user.files.directories()
    mounts.push(user)
  } catch (error) {
    console.warn('[WebMCP catalog] user package storage unavailable; serving builtin packages only:', error)
    return [await readMountedWebMCPCatalog(mounts), { userMountComplete: false }]
  }
  try {
    return [await readMountedWebMCPCatalog(mounts), { userMountComplete: true }]
  } catch (error) {
    // The preflight listing above succeeded, but `readMountedWebMCPCatalog`
    // lists the user mount AGAIN — and that second listing can fail even
    // when the first succeeded (transient OPFS / quota error). Letting it
    // reject would make the catalog refresh clear EVERY adapter route,
    // including healthy builtins (finding: "Transient listing failure
    // removes routes"). Degrade to the builtin-only read instead: a package
    // that momentarily cannot be listed is no worse than a mount that could
    // not be listed at all.
    console.warn('[WebMCP catalog] combined catalog read failed after a successful user-mount listing; serving builtin packages only:', error)
    const builtinOnly = mounts.slice(0, 1)
    return [await readMountedWebMCPCatalog(builtinOnly), { userMountComplete: false }]
  }
}
/**
 * Builtin-only catalog read. The combined `readWebMCPCatalog` already
 * degrades gracefully when the user mount fails; this narrower read remains
 * for callers that must not touch user storage at all.
 */
export async function readBuiltinWebMCPCatalog() {
  return readMountedWebMCPCatalog([providerMount('builtin-webmcp', await getBuiltinStorage())])
}
export async function readEnabledWebMCPPackages() {
  const entries = await readWebMCPCatalog()
  const uriByPackage = new Map(entries.map(entry => [entry.package, entry.uri]))
  return activeWebMCPPackages(entries).map(pkg => ({ ...pkg, rootUri: uriByPackage.get(pkg)! }))
}
