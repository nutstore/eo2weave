import { validateManifest, validatePackage, type WebMCPPackage } from './webmcp-adapter'

export interface PackageFiles {
  readFile(path: string): Promise<string>
}

export async function readPackage(files: PackageFiles, directory: string): Promise<WebMCPPackage> {
  const root = directory.replace(/\/+$/, '')
  const id = root.split('/').pop()!
  const manifest = validateManifest(JSON.parse(await files.readFile(`${root}/manifest.json`)), id)
  const sources: Record<string, string> = Object.create(null)
  for (const tool of manifest.tools) sources[tool.path] = await files.readFile(`${root}/${tool.path}`)
  return validatePackage(manifest, sources, id)
}

/**
 * Invalid/incomplete packages are withdrawn as a whole. Snapshot-level limits
 * are enforced by the extension background when the snapshot is stored.
 */
export async function readPackageCatalog(
  files: PackageFiles & { directories(): Promise<string[]> },
): Promise<{ packages: WebMCPPackage[]; errors: string[] }> {
  const packages: WebMCPPackage[] = []
  const errors: string[] = []
  for (const directory of (await files.directories()).sort()) {
    try { packages.push(await readPackage(files, directory)) }
    catch (error) { errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { packages, errors }
}
