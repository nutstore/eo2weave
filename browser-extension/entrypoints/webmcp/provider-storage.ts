import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'
import { readPackageCatalog } from '@creatorweave/shared/webmcp-adapter-files'
import type { FsProvider } from '@creatorweave/fs-provider'

let storage: Promise<FsProvider> | undefined
/** The extension origin owns adapter files; Web only sees a provider. */
export function getAdapterStorage(): Promise<FsProvider> {
  return storage ??= navigator.storage.getDirectory().then(root => root.getDirectoryHandle('webmcp', { create: true }))
    .then(fromFileSystemHandle).catch(error => { storage = undefined; throw error })
}

export async function readAdapterPackages() {
  const provider = await getAdapterStorage()
  const catalog = await readPackageCatalog({
    async directories() { return (await provider.readdir('')).filter(entry => entry.kind === 'directory').map(entry => entry.name) },
    async readFile(path) { return new TextDecoder().decode(await provider.readFile(path)) },
  })
  if (catalog.errors.length) console.warn('[WebMCP adapter files]', catalog.errors.join('\n'))
  return catalog.packages
}
