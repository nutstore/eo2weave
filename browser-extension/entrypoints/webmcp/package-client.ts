import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'
import type { WebMCPPackageManifest } from '@creatorweave/shared/webmcp-adapter'
import type { WebMCPConfig } from '@creatorweave/shared/webmcp-config'
export type ManagedWebMCPPackage = Omit<WebMCPPackageEntry, 'package'> & { manifest: WebMCPPackageManifest | null }

export interface ManagedPackageCatalog {
  entries: ManagedWebMCPPackage[]
  /**
   * False when the writable user mount could not be listed, so `entries` is
   * builtin-only. "Mine" must not read that as "no packages" — the section is
   * unavailable, not empty.
   */
  userMountComplete: boolean
}

export async function listManagedPackages(): Promise<ManagedPackageCatalog> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_list' })
  if (!response?.ok) throw new Error(response?.error ?? 'Package catalog unavailable')
  return { entries: response.entries, userMountComplete: response.userMountComplete !== false }
}
export async function setManagedPackageConfig(entry: ManagedWebMCPPackage, config: WebMCPConfig): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_set_config', mount: entry.mount, directory: entry.directory, config })
  if (!response?.ok) throw new Error(response?.error ?? 'Configuration update failed')
}

export async function deleteManagedPackage(entry: ManagedWebMCPPackage): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_delete', mount: entry.mount, directory: entry.directory })
  if (!response?.ok) throw new Error(response?.error ?? 'Package deletion failed')
}
