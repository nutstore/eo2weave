import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'
import type { WebMCPPackageManifest } from '@creatorweave/shared/webmcp-adapter'
import type { WebMCPConfig } from '@creatorweave/shared/webmcp-config'
export type ManagedWebMCPPackage = Omit<WebMCPPackageEntry, 'package'> & {
  manifest: WebMCPPackageManifest | null
  /**
   * Why the ADAPTER catalog dropped this package (issue #239). An installed,
   * enabled package whose routes were rejected still shows as active here —
   * activation is read from config.json — so without this the page looks
   * healthy while none of the package's tools exist.
   */
  catalogRejection?: string
}

/** A package the adapter catalog dropped, with the validation error. */
export interface RejectedPackage {
  id: string
  reason: string
}

export interface ManagedPackageCatalog {
  entries: ManagedWebMCPPackage[]
  /**
   * False when the writable user mount could not be listed, so `entries` is
   * builtin-only. "Mine" must not read that as "no packages" — the section is
   * unavailable, not empty.
   */
  userMountComplete: boolean
  /** Packages present on disk but absent from the adapter catalog. */
  rejected: RejectedPackage[]
}

function readRejections(value: unknown): RejectedPackage[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is RejectedPackage =>
      !!item && typeof item === 'object' &&
      typeof (item as RejectedPackage).id === 'string' &&
      typeof (item as RejectedPackage).reason === 'string',
  )
}

export async function listManagedPackages(): Promise<ManagedPackageCatalog> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_list' })
  if (!response?.ok) throw new Error(response?.error ?? 'Package catalog unavailable')
  const rejected = readRejections(response.rejected)
  // Attach the reason to the entry it belongs to, so cards render it without
  // any section needing to know the catalog exists. Rejection ids are manifest
  // ids; a package whose manifest could not be read is reported as `#<index>`
  // and already carries its own diagnostics.
  const reasonById = new Map(rejected.map(item => [item.id, item.reason]))
  const entries = (response.entries as ManagedWebMCPPackage[]).map(entry => {
    const reason = reasonById.get(entry.manifest?.id ?? entry.directory)
    return reason === undefined ? entry : { ...entry, catalogRejection: reason }
  })
  return { entries, userMountComplete: response.userMountComplete !== false, rejected }
}
export async function setManagedPackageConfig(entry: ManagedWebMCPPackage, config: WebMCPConfig): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_set_config', mount: entry.mount, directory: entry.directory, config })
  if (!response?.ok) throw new Error(response?.error ?? 'Configuration update failed')
}

export async function deleteManagedPackage(entry: ManagedWebMCPPackage): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'webmcp_packages_delete', mount: entry.mount, directory: entry.directory })
  if (!response?.ok) throw new Error(response?.error ?? 'Package deletion failed')
}
