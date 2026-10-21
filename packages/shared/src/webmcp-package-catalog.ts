import { readPackage, type PackageFiles } from './webmcp-adapter-files'
import type { WebMCPPackage } from './webmcp-adapter'
import { parseWebMCPConfig, resolveWebMCPConfig, type WebMCPConfig, type WebMCPActivation } from './webmcp-config'

/** Parsing depends on mounted file semantics, never on OPFS or extension resources. */
export interface WebMCPMount {
  name: string
  readOnly: boolean
  files: PackageFiles & { directories(): Promise<string[]> }
}
export interface WebMCPPackageEntry {
  directory: string
  mount: string
  uri: string
  access: 'read-only' | 'read-write'
  config: WebMCPConfig | null
  activation: WebMCPActivation | null
  diagnostics: string[]
  package: WebMCPPackage | null
}

export async function readMountedWebMCPCatalog(mounts: WebMCPMount[]): Promise<WebMCPPackageEntry[]> {
  const entries: WebMCPPackageEntry[] = []
  for (const mount of mounts) {
    for (const directory of (await mount.files.directories()).sort()) {
      const entry: WebMCPPackageEntry = {
        directory, mount: mount.name, uri: `vfs://external/${mount.name}/${directory}/`,
        access: mount.readOnly ? 'read-only' : 'read-write', config: null, activation: null, diagnostics: [], package: null,
      }
      try {
        let config: unknown = {}
        try { config = JSON.parse(await mount.files.readFile(`${directory}/config.json`)) }
        catch (error) { if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error }
        entry.config = parseWebMCPConfig(config)
        entry.activation = resolveWebMCPConfig(entry.config).activation
      } catch (error) { entry.diagnostics.push(`config.json: ${error instanceof Error ? error.message : String(error)}`) }
      try { entry.package = await readPackage(mount.files, directory) }
      catch (error) { entry.diagnostics.push(error instanceof Error ? error.message : String(error)) }
      entries.push(entry)
    }
  }
  const identities = new Map<string, WebMCPPackageEntry[]>()
  for (const entry of entries) if (entry.package) {
    const id = entry.package.manifest.id
    identities.set(id, [...(identities.get(id) ?? []), entry])
  }
  for (const [id, conflicting] of identities) if (conflicting.length > 1)
    for (const entry of conflicting) entry.diagnostics.push(`Duplicate package namespace: ${id}; choose a unique package id`)
  return entries
}

export function activeWebMCPPackages(entries: WebMCPPackageEntry[]): WebMCPPackage[] {
  return entries.flatMap(entry => entry.activation === 'enabled' && !entry.diagnostics.length && entry.package ? [entry.package] : [])
}
