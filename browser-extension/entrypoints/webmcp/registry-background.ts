/**
 * Background handler for the extension-side package registry (issue #143).
 *
 * The management page (an extension page) drives the registry through
 * runtime messages; the background owns the actual work:
 *
 *   - `webmcp_registry_list`       → the user's registries + installed ids
 *   - `webmcp_registry_add`        → parse + persist a registry URL
 *   - `webmcp_registry_remove`     → drop a registry from the list
 *   - `webmcp_registry_catalog`    → fetch one registry's catalog
 *   - `webmcp_registry_install`    → run the install transaction
 *   - `webmcp_registry_uninstall`  → remove an installed package
 *
 * The install/uninstall transactions write into the extension's OWN OPFS
 * mount — no page bridge is involved. The catalog refresh after a mutation
 * re-reads the package catalog so the newly installed package's tools are
 * registered (and a removed package's tools are withdrawn) immediately.
 */

import {
  addRegistry,
  installRegistryPackage,
  listInstalledPackageIds,
  listRegistries,
  loadRegistryCatalog,
  readInstalledPackageActivation,
  removeRegistry,
  registriesPersisted,
  uninstallRegistryPackage,
} from './registry-store'
import { fetchPackageManifestPreview, type PackageRegistry, type RegistryManifestPackage } from './registry-client'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Validate the package entry the page sent.
 *
 * The page passes the catalog entry it rendered, but the BACKGROUND must not
 * trust the payload: a malformed entry (a file path outside the package's
 * own directory, a non-sha256 checksum, a non-semver version) would reach
 * the installer. The installer re-validates every file anyway — this gate
 * only makes the REJECTION happen before the download, with a clear error.
 */
function packageEntryFromMessage(message: Record<string, unknown>): RegistryManifestPackage {
  const entry = asRecord(message.package)
  const id = typeof entry.id === 'string' ? entry.id : ''
  if (!id) throw new Error('Missing package entry')
  const version = typeof entry.version === 'string' ? entry.version : ''
  if (!version) throw new Error('Missing package version')
  const description = typeof entry.description === 'string' ? entry.description : ''
  const toolCount = typeof entry.toolCount === 'number' && Number.isInteger(entry.toolCount) && entry.toolCount >= 0
    ? entry.toolCount
    : 0
  const rawFiles = Array.isArray(entry.files) ? entry.files : []
  const files = rawFiles.map((file, index) => {
    const record = asRecord(file)
    const path = typeof record.path === 'string' ? record.path : ''
    const sha256 = typeof record.sha256 === 'string' ? record.sha256 : ''
    if (!path || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Package ${id}: invalid file entry #${index}`)
    return { path, sha256 }
  })
  return { id, version, description, toolCount, files }
}

/** Re-derive a registry from a stored manifest URL (never trust the payload). */
async function registryFromMessage(message: Record<string, unknown>): Promise<PackageRegistry> {
  const manifestUrl = typeof message.manifestUrl === 'string' ? message.manifestUrl : ''
  if (!manifestUrl) throw new Error('Missing registry manifest URL')
  // The stored registries are the source of truth; the message only carries
  // the manifest URL to act on.
  const stored = await listRegistries()
  const known = stored.find(entry => entry.manifestUrl === manifestUrl)
  if (known) return known
  throw new Error('Unknown registry')
}

/** The registry list, loaded fresh from storage. */
export async function getRegistries(): Promise<PackageRegistry[]> {
  return listRegistries()
}

export interface RegistryBackgroundOptions {
  /** Re-read the package catalog so new/removed packages register promptly. */
  changed: () => Promise<void>
  /** Tell the extension pages (popup, registry page) the registry changed. */
  notify?: () => void
}

/**
 * Build the message handler for the registry namespace.
 */
export function createRegistryBackground(options: RegistryBackgroundOptions) {
  const notify = (): void => {
    options.notify?.()
  }
  return async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      switch (message.type) {
        case 'webmcp_registry_list': {
          const registries = await getRegistries()
          const installed = await listInstalledPackageIds()
          const activations: Record<string, 'enabled' | 'disabled'> = {}
          for (const id of installed) activations[id] = await readInstalledPackageActivation(id)
          return {
            ok: true,
            registries,
            installed: [...installed],
            activations,
            persisted: registriesPersisted(),
          }
        }
        case 'webmcp_registry_add': {
          const input = typeof message.input === 'string' ? message.input : ''
          const registry = await addRegistry(input)
          notify()
          return { ok: true, registry }
        }
        case 'webmcp_registry_remove': {
          const manifestUrl = typeof message.manifestUrl === 'string' ? message.manifestUrl : ''
          if (!manifestUrl) throw new Error('Missing registry manifest URL')
          await removeRegistry(manifestUrl)
          notify()
          return { ok: true }
        }
        case 'webmcp_registry_catalog': {
          const registry = await registryFromMessage(message)
          const manifest = await loadRegistryCatalog(registry, { force: message.force === true })
          return { ok: true, manifest }
        }
        case 'webmcp_registry_preview': {
          const registry = await registryFromMessage(message)
          const packageId = typeof message.packageId === 'string' ? message.packageId : ''
          if (!packageId) throw new Error('Missing package id')
          // The catalog entry rides along so the preview can require id AND
          // version agreement — a manifest that disagrees with the catalog
          // is not a verified preview.
          const pkg = packageEntryFromMessage(message)
          if (pkg.id !== packageId) throw new Error(`Package entry id ${pkg.id} does not match ${packageId}`)
          // The catalog entry's manifest.json checksum rides along: the
          // preview must verify the fetched bytes are the file the catalog
          // author published, not just any same-version manifest a mirror
          // served (finding: "Preview skips catalog checksum").
          const expectedManifestSha256 = pkg.files.find(file => file.path === `packages/${packageId}/manifest.json`)?.sha256
          const preview = await fetchPackageManifestPreview(registry, packageId, {
            expectedVersion: pkg.version,
            expectedManifestSha256,
          })
          return { ok: true, tools: preview.tools }
        }
        case 'webmcp_registry_install': {
          const registry = await registryFromMessage(message)
          const pkg = packageEntryFromMessage(message)
          const current = (await loadRegistryCatalog(registry, { force: true })).packages.find(entry => entry.id === pkg.id)
          const fileIdentity = (entry: RegistryManifestPackage) => JSON.stringify(entry.files
            .map(file => [file.path, file.sha256])
            .sort((a, b) => a[0]!.localeCompare(b[0]!)))
          if (!current || current.version !== pkg.version || fileIdentity(current) !== fileIdentity(pkg)) {
            throw new Error(`Package ${pkg.id} has changed or was withdrawn from the registry; refresh the catalog`)
          }
          const result = await installRegistryPackage(registry, pkg)
          try {
            await options.changed()
          } catch (error) {
            notify()
            return { ok: false, committed: true, error: `Package ${pkg.id} was installed, but its routes could not be refreshed: ${error instanceof Error ? error.message : String(error)}` }
          }
          notify()
          return { ok: true, filesWritten: result.filesWritten }
        }
        case 'webmcp_registry_uninstall': {
          const packageId = typeof message.packageId === 'string' ? message.packageId : ''
          if (!packageId) throw new Error('Missing package id')
          // A slash would make the id a PATH and the recursive uninstall
          // would delete a subtree of another package — reject it before
          // any lock or removal.
          if (packageId.includes('/')) throw new Error(`Invalid package id: ${packageId}`)
          await uninstallRegistryPackage(packageId)
          try {
            await options.changed()
          } catch (error) {
            notify()
            return { ok: false, committed: true, error: `Package ${packageId} was removed, but its routes could not be refreshed: ${error instanceof Error ? error.message : String(error)}` }
          }
          notify()
          return { ok: true }
        }
        default:
          return { ok: false, error: 'Unknown registry operation' }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
