import { FsError, normalizeProviderPath, type FsProvider } from './index'

/** Run at the storage origin. Passing a handle to another origin is not required. */
export function fromFileSystemHandle(root: FileSystemDirectoryHandle): FsProvider {
  const dir = async (path: string, create = false) => {
    let current = root
    for (const part of normalizeProviderPath(path).split('/').filter(Boolean)) {
      current = await current.getDirectoryHandle(part, { create })
    }
    return current
  }
  const parent = async (path: string, create = false) => {
    const parts = normalizeProviderPath(path).split('/').filter(Boolean)
    const name = parts.pop()
    if (!name) throw new FsError('EACCES', 'Operation requires a non-root path')
    return { dir: await dir(parts.join('/'), create), name }
  }
  const provider: FsProvider = {
    async stat(path) {
      if (!normalizeProviderPath(path)) return { kind: 'directory' }
      const p = await parent(path)
      try {
        const file = await (await p.dir.getFileHandle(p.name)).getFile()
        return { kind: 'file', size: file.size, mtime: file.lastModified }
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error
        await p.dir.getDirectoryHandle(p.name)
        return { kind: 'directory' }
      }
    },
    async readdir(path) {
      const entries = []
      for await (const [name, handle] of (await dir(path) as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
        entries.push({ name, kind: handle.kind })
      }
      return entries
    },
    async readFile(path) {
      const p = await parent(path)
      return new Uint8Array(await (await (await p.dir.getFileHandle(p.name)).getFile()).arrayBuffer())
    },
    async writeFile(path, content) {
      const p = await parent(path, true)
      const writable = await (await p.dir.getFileHandle(p.name, { create: true })).createWritable()
      try {
        await writable.write(content as Uint8Array<ArrayBuffer>)
        await writable.close()
      } catch (error) {
        await writable.abort().catch(() => {})
        throw error
      }
    },
    async mkdir(path, options) {
      const normalized = normalizeProviderPath(path)
      if (!normalized) return
      const p = await parent(normalized, options?.recursive === true)
      if (!options?.recursive) {
        try { await p.dir.getDirectoryHandle(p.name); throw new FsError('EEXIST', path) }
        catch (error) { if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error }
      }
      await p.dir.getDirectoryHandle(p.name, { create: true })
    },
    async remove(path, options) {
      const p = await parent(path)
      await p.dir.removeEntry(p.name, { recursive: options?.recursive })
    },
  }
  return provider
}
