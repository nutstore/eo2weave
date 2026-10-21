import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'
import type { FsProvider } from '@creatorweave/fs-provider'

let storage: Promise<FsProvider> | undefined
/** The extension origin owns adapter files; Web only sees a provider. */
export function getAdapterStorage(): Promise<FsProvider> {
  return storage ??= navigator.storage.getDirectory().then(root => root.getDirectoryHandle('webmcp', { create: true }))
    .then(fromFileSystemHandle).catch(error => { storage = undefined; throw error })
}
