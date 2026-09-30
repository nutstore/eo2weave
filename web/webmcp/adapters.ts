import { validateAdapter, validateAdapterSnapshot, type WebMCPAdapter } from '@creatorweave/shared/webmcp-adapter'

export interface AdapterFiles {
  readFile(path: string): Promise<string>
}

export async function readAdapter(files: AdapterFiles, directory: string): Promise<WebMCPAdapter> {
  const root = directory.replace(/\/$/, '')
  const [metadata, source] = await Promise.all([
    files.readFile(`${root}/tool.json`), files.readFile(`${root}/index.js`),
  ])
  return validateAdapter(JSON.parse(metadata), source)
}

/** Invalid/incomplete packages are omitted so stale registrations are withdrawn. */
export async function readAdapterCatalog(
  files: AdapterFiles & { directories(): Promise<string[]> },
): Promise<{ adapters: WebMCPAdapter[]; errors: string[] }> {
  const adapters: WebMCPAdapter[] = []
  const errors: string[] = []
  for (const directory of (await files.directories()).sort()) {
    try { adapters.push(await readAdapter(files, directory)) }
    catch (error) { errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  // Conflicting names are rejected together rather than resolved by directory order.
  const counts = new Map<string, number>()
  for (const adapter of adapters) {
    const key = `${adapter.origin}/${adapter.name}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const unique = adapters.filter(adapter => {
    const key = `${adapter.origin}/${adapter.name}`
    if (counts.get(key) === 1) return true
    errors.push(`Duplicate adapter: ${key}`)
    return false
  })
  return { adapters: validateAdapterSnapshot(unique), errors }
}
