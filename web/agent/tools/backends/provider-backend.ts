import { FsError, normalizeProviderPath, type FsProvider } from '@creatorweave/fs-provider'
import { providerRegistry, type ProviderRegistry } from '@/vfs/provider-registry'
import type { VfsBackend, VfsDirEntry, VfsReadOptions, VfsReadResult } from '../vfs-backend'

/** All external mounts share this adapter. No extension API or protocol enters Web. */
export class ProviderBackend implements VfsBackend {
  readonly label = 'provider' as const
  constructor(private mountName: string, private registry: ProviderRegistry = providerRegistry) {}
  private async provider(write = false): Promise<FsProvider> {
    const provider = await this.registry.get(this.mountName)
    if (write && provider.readOnly) throw new FsError('EROFS', this.mountName)
    return provider
  }
  async stat(path: string) { return (await this.provider()).stat(normalizeProviderPath(path)) }
  async mkdir(path: string, options?: { recursive?: boolean }) {
    await (await this.provider(true)).mkdir(normalizeProviderPath(path), options)
  }
  async readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult> {
    const content = await (await this.provider()).readFile(normalizeProviderPath(path))
    if (!(content instanceof Uint8Array)) throw new FsError('EINVAL', 'Provider returned non-binary content')
    return { content: options?.encoding === 'text' ? new TextDecoder().decode(content) : content,
      size: content.byteLength, mimeType: 'application/octet-stream', source: this.mountName }
  }
  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) :
      new Uint8Array(content instanceof Blob ? await content.arrayBuffer() : content)
    await (await this.provider(true)).writeFile(normalizeProviderPath(path), bytes)
  }
  async listDir(path: string): Promise<VfsDirEntry[]> {
    const p = normalizeProviderPath(path)
    const entries = await (await this.provider()).readdir(p)
    const names = new Set<string>()
    return entries.map(entry => {
      if (!entry.name || normalizeProviderPath(entry.name) !== entry.name || entry.name.includes('/') ||
        names.has(entry.name) || (entry.kind !== 'file' && entry.kind !== 'directory')) {
        throw new FsError('EINVAL', 'Invalid provider directory entry')
      }
      names.add(entry.name)
      return { ...entry, path: p ? `${p}/${entry.name}` : entry.name }
    })
  }
  async deleteFile(path: string) { await (await this.provider(true)).remove(normalizeProviderPath(path)) }
  async deleteDir(path: string) {
    const deletedFiles: string[] = [], deletedDirs: string[] = []
    const collect = async (p: string) => {
      for (const entry of await this.listDir(p)) {
        if (entry.kind === 'file') deletedFiles.push(entry.path)
        else { await collect(entry.path); deletedDirs.push(entry.path) }
      }
    }
    const p = normalizeProviderPath(path)
    await collect(p)
    await (await this.provider(true)).remove(p, { recursive: true })
    deletedDirs.push(p)
    return { deletedFiles, deletedDirs }
  }
  async exists(path: string) {
    try { await this.stat(path); return true }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' || (error as { name?: string }).name === 'NotFoundError') return false
      throw error
    }
  }
}

/** Synthetic namespace root; only the host owns its children. */
export class ProvidersRootBackend implements VfsBackend {
  readonly label = 'provider' as const
  async stat(path = '') {
    if (!path) return { kind: 'directory' as const }
    const [name, ...parts] = path.split('/')
    return new ProviderBackend(name).stat(parts.join('/'))
  }
  async listDir(path = ''): Promise<VfsDirEntry[]> {
    if (path) {
      const [name, ...parts] = path.split('/')
      return (await new ProviderBackend(name).listDir(parts.join('/'))).map(entry => ({ ...entry, path: `${name}/${entry.path}` }))
    }
    return providerRegistry.names().map(name => ({ name, path: name, kind: 'directory' }))
  }
  async readFile(path = '', options?: VfsReadOptions): Promise<VfsReadResult> {
    if (!path) throw new FsError('EISDIR', 'external')
    const [name, ...parts] = path.split('/')
    return new ProviderBackend(name).readFile(parts.join('/'), options)
  }
  async writeFile(): Promise<void> { throw new FsError('EACCES', 'Cannot modify mount registry') }
  async deleteFile(): Promise<void> { throw new FsError('EACCES', 'Cannot modify mount registry') }
}
