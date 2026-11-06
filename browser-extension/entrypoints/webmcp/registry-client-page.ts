/**
 * Extension-page client for the WebMCP package registry (issue #143).
 *
 * The management page (an extension page) talks to the background through
 * runtime messages; this module is the typed wrapper around that channel.
 */

import type { PackageRegistry, RegistryManifest, RegistryManifestPackage } from './registry-client'

export interface RegistryListResult {
  registries: PackageRegistry[]
  /** Package ids currently installed on the `webmcp` mount. */
  installed: string[]
  /**
   * Directories carrying an install marker — the authoritative "installed
   * from a registry" set the packages page classifies on (issue #228).
   */
  installedDirectories?: string[]
  /** Activation state per installed package id. */
  activations: Record<string, 'enabled' | 'disabled'>
  /**
   * Installed ids whose activation could not be read. They are still installed
   * (so the row keeps its uninstall path) but their state is UNKNOWN — a
   * missing entry must never be rendered as `disabled`.
   */
  activationErrors?: string[]
  /** False when the registry list could not be persisted (session-only). */
  persisted: boolean
}

async function send<T>(message: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as (T & { ok?: boolean; error?: string }) | undefined
  if (!response?.ok) throw new Error(response?.error ?? 'Registry operation failed')
  return response
}

export async function listRegistries(): Promise<RegistryListResult> {
  return send<RegistryListResult>({ type: 'webmcp_registry_list' })
}

export async function addRegistry(input: string): Promise<PackageRegistry> {
  const result = await send<{ registry: PackageRegistry }>({ type: 'webmcp_registry_add', input })
  return result.registry
}

export async function removeRegistry(manifestUrl: string): Promise<void> {
  await send({ type: 'webmcp_registry_remove', manifestUrl })
}

export async function loadRegistryCatalog(registry: PackageRegistry, force = false): Promise<RegistryManifest> {
  const result = await send<{ manifest: RegistryManifest }>({ type: 'webmcp_registry_catalog', manifestUrl: registry.manifestUrl, force })
  return result.manifest
}

/**
 * Fetch one package's own manifest for the tool preview. The catalog's
 * `toolCount` is a publisher-provided claim; the preview verifies it AND
 * requires the manifest to agree with the catalog entry's id/version, so
 * the catalog entry rides along in the message.
 */
export async function previewRegistryPackage(
  registry: PackageRegistry,
  pkg: Pick<RegistryManifestPackage, 'id' | 'version' | 'description' | 'toolCount' | 'files'>,
): Promise<Array<{ name: string; description: string }>> {
  const result = await send<{ tools: Array<{ name: string; description: string }> }>({
    type: 'webmcp_registry_preview',
    manifestUrl: registry.manifestUrl,
    packageId: pkg.id,
    package: pkg,
  })
  return result.tools
}

export async function installRegistryPackage(registry: PackageRegistry, pkg: RegistryManifestPackage): Promise<{ filesWritten: number }> {
  const result = await send<{ filesWritten: number }>({
    type: 'webmcp_registry_install',
    manifestUrl: registry.manifestUrl,
    package: pkg,
  })
  return { filesWritten: result.filesWritten }
}

export async function uninstallRegistryPackage(packageId: string): Promise<void> {
  await send({ type: 'webmcp_registry_uninstall', packageId })
}

/**
 * Toggle one INSTALLED registry package's activation.
 *
 * An installed registry package is a package directory on the same `webmcp`
 * mount the "mine" section manages, and its `config.json` is the only
 * activation state, so this reuses the package-config message instead of
 * adding a registry operation: the install records the disabled default, and
 * the merged page has no other place to turn a registry package on (the
 * "mine" section excludes registry installs).
 */
export async function setRegistryPackageActivation(packageId: string, activation: 'enabled' | 'disabled'): Promise<void> {
  await send({ type: 'webmcp_packages_set_config', mount: 'webmcp', directory: packageId, config: { activation } })
}
