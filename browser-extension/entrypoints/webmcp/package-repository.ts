import { FsError, type FsProvider } from '@creatorweave/fs-provider'
import { activeWebMCPPackages, readMountedWebMCPCatalog, type WebMCPMount } from '@creatorweave/shared/webmcp-package-catalog'
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
export async function readWebMCPCatalog() {
  // The USER mount may fail to initialize or list (OPFS unavailable, quota,
  // corrupted handle). A failed user mount must degrade to a builtin-only
  // catalog (logged) — letting it reject would clear every adapter route on
  // refresh (finding: "Enabled package tools remain unavailable") and hide
  // healthy builtin packages from the opt-in probe.
  const mounts: WebMCPMount[] = [providerMount('builtin-webmcp', await getBuiltinStorage())]
  try {
    const user = providerMount('webmcp', await getAdapterStorage())
    await user.files.directories()
    mounts.push(user)
  } catch (error) {
    console.warn('[WebMCP catalog] user package storage unavailable; serving builtin packages only:', error)
  }
  return readMountedWebMCPCatalog(mounts)
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
