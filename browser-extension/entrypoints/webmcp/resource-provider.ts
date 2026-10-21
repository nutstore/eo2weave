import { FsError, normalizeProviderPath, type FsProvider, type FsStat } from '@creatorweave/fs-provider'

/** A generic read-only filesystem over indexed resources. */
export function createResourceProvider(paths: string[], read: (path: string) => Promise<Uint8Array>): FsProvider {
  const files = new Set(paths.map(normalizeProviderPath))
  const directories = new Set([''])
  for (const path of files) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'))
  }
  const readFile = async (value: string) => {
    const path = normalizeProviderPath(value)
    if (directories.has(path)) throw new FsError('EISDIR', path)
    if (!files.has(path)) throw new FsError('ENOENT', path)
    return read(path)
  }
  const stat = async (value: string): Promise<FsStat> => {
    const path = normalizeProviderPath(value)
    if (directories.has(path)) return { kind: 'directory' }
    return { kind: 'file', size: (await readFile(path)).length }
  }
  const deny = async () => { throw new FsError('EROFS', 'Read-only resource filesystem') }
  return {
    readOnly: true, stat, readFile,
    async readdir(value) {
      const path = normalizeProviderPath(value)
      if (!directories.has(path)) {
        if (files.has(path)) throw new FsError('ENOTDIR', path)
        throw new FsError('ENOENT', path)
      }
      const prefix = path ? path + '/' : ''
      return [...new Set([...files, ...directories])].filter(candidate => candidate.startsWith(prefix) && candidate !== path && !candidate.slice(prefix.length).includes('/'))
        .sort().map(candidate => ({ name: candidate.slice(prefix.length), kind: directories.has(candidate) ? 'directory' as const : 'file' as const }))
    },
    writeFile: deny, mkdir: deny, remove: deny, rename: deny,
  }
}
