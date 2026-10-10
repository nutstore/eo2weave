import { FsError, normalizeProviderPath, type FsProvider } from '@creatorweave/fs-provider'

/** JSON encoding is an extension implementation detail, outside the public contract. */
export function createProviderHandler(storage: () => Promise<FsProvider>, changed: () => Promise<void>) {
  let mutations: Promise<unknown> = Promise.resolve()
  return async (message: Record<string, unknown>) => {
    const run = async () => {
      if (typeof message.path !== 'string') throw new FsError('EINVAL', 'Missing path')
      const path = normalizeProviderPath(message.path)
      const provider = await storage()
      switch (message.method) {
        case 'stat': return provider.stat(path)
        case 'readdir': return provider.readdir(path)
        case 'readFile': {
          const stat = await provider.stat(path)
          if ((stat.size ?? 0) > 32 * 1024 * 1024) throw new FsError('EINVAL', 'Extension file limit is 32 MiB')
          const bytes = await provider.readFile(path)
          if (bytes.length > 32 * 1024 * 1024) throw new FsError('EINVAL', 'Extension file limit is 32 MiB')
          const chunks: string[] = []
          for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
          return btoa(chunks.join(''))
        }
        case 'writeFile': {
          if (typeof message.content !== 'string' || message.content.length > Math.ceil(32 * 1024 * 1024 / 3) * 4) throw new FsError('EINVAL', 'Invalid file content')
          const bytes = Uint8Array.from(atob(message.content), char => char.charCodeAt(0))
          await provider.writeFile(path, bytes)
          break
        }
        case 'mkdir': await provider.mkdir(path, { recursive: message.recursive === true }); break
        case 'remove': await provider.remove(path, { recursive: message.recursive === true }); break
        default: throw new FsError('EINVAL', 'Unknown storage operation')
      }
      // The storage commit already succeeded. Catalog failures must not make
      // callers retry a committed mutation; the service withdraws stale routes.
      await changed().catch(error => console.warn('[WebMCP catalog]', error))
      return null
    }
    try {
      const mutating = ['writeFile', 'mkdir', 'remove'].includes(String(message.method))
      const pending = mutations.catch(() => {}).then(run)
      if (mutating) mutations = pending
      return { ok: true, value: await pending }
    } catch (error) {
      const e = error as { code?: string; name?: string; message?: string }
      const code = e.code ?? ({ NotFoundError: 'ENOENT', TypeMismatchError: 'ENOTDIR', NotAllowedError: 'EACCES', InvalidModificationError: 'ENOTEMPTY' } as Record<string, string>)[e.name ?? ''] ?? 'EIO'
      return { ok: false, code, error: e.message ?? String(error) }
    }
  }
}
