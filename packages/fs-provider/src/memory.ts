import { FsError, normalizeProviderPath, type FsProvider, type FsStat } from './index'

/** Deterministic reference provider, also useful for host integration tests. */
export function memoryProvider(): FsProvider {
  const entries = new Map<string, { data?: Uint8Array; mtime: number }>([['', { mtime: 0 }]])
  const get = (path: string) => {
    const p = normalizeProviderPath(path)
    const entry = entries.get(p)
    if (!entry) throw new FsError('ENOENT', p)
    return entry
  }
  const parent = (path: string) => path.split('/').slice(0, -1).join('/')
  const directory = (path: string) => {
    if (get(path).data) throw new FsError('ENOTDIR', path)
  }
  const stat = (path: string): FsStat => {
    const e = get(path)
    return { kind: e.data ? 'file' : 'directory', size: e.data?.length ?? 0, mtime: e.mtime }
  }
  const provider: FsProvider = {
    async stat(path) { return stat(path) },
    async readdir(path) {
      const p = normalizeProviderPath(path)
      directory(p)
      return [...entries.keys()].filter(key => key && parent(key) === p)
        .map(key => ({ name: key.split('/').pop()!, ...stat(key) }))
    },
    async readFile(path) {
      const e = get(path)
      if (!e.data) throw new FsError('EISDIR', path)
      return e.data.slice()
    },
    async writeFile(path, data) {
      const p = normalizeProviderPath(path)
      if (!p || (entries.has(p) && !get(p).data)) throw new FsError('EISDIR', p)
      await provider.mkdir(parent(p), { recursive: true })
      entries.set(p, { data: data.slice(), mtime: Date.now() })
    },
    async mkdir(path, options) {
      const p = normalizeProviderPath(path)
      if (!p) return
      if (entries.has(p)) {
        directory(p)
        if (!options?.recursive) throw new FsError('EEXIST', p)
        return
      }
      if (options?.recursive) await provider.mkdir(parent(p), options)
      else directory(parent(p))
      entries.set(p, { mtime: Date.now() })
    },
    async remove(path, options) {
      const p = normalizeProviderPath(path)
      if (!p) throw new FsError('EACCES', 'Cannot remove provider root')
      get(p)
      const children = [...entries.keys()].filter(key => key.startsWith(p + '/'))
      if (children.length && !options?.recursive) throw new FsError('ENOTEMPTY', p)
      for (const child of children) entries.delete(child)
      entries.delete(p)
    },
    async rename(from, to) {
      const src = normalizeProviderPath(from), dest = normalizeProviderPath(to)
      get(src)
      if (src === dest) return
      if (!src || !dest || dest.startsWith(src + '/')) throw new FsError('EINVAL', 'Invalid move')
      directory(parent(dest))
      if (entries.has(dest)) throw new FsError('EEXIST', dest)
      const moved = [...entries].filter(([key]) => key === src || key.startsWith(src + '/'))
      for (const [key, value] of moved) { entries.delete(key); entries.set(dest + key.slice(src.length), value) }
    },
  }
  return provider
}
