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
  return readMountedWebMCPCatalog(await getWebMCPMounts())
}
/**
 * Builtin-only catalog read for the opt-in prompt: the user-mounted provider
 * (OPFS adapter storage) can fail to initialize independently, and a failing
 * USER mount must not hide healthy BUILTIN packages from the opt-in status
 * probe. The opt-in flow only ever offers/enables builtin packages, so it
 * reads this narrower catalog.
 */
export async function readBuiltinWebMCPCatalog() {
  return readMountedWebMCPCatalog([providerMount('builtin-webmcp', await getBuiltinStorage())])
}
export async function readEnabledWebMCPPackages() {
  const entries = await readWebMCPCatalog()
  const uriByPackage = new Map(entries.map(entry => [entry.package, entry.uri]))
  return activeWebMCPPackages(entries).map(pkg => ({ ...pkg, rootUri: uriByPackage.get(pkg)! }))
}
