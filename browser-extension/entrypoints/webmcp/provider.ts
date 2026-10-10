import { announceProvider, FsError, type FsProvider } from '@creatorweave/fs-provider'

/** Extension-owned transport, hidden behind a provider injected into MAIN world. */
export function installWebMcpProvider(
  send: (type: string, payload: Record<string, unknown>) => Promise<{ ok?: boolean; value?: unknown; error?: string; code?: string }>,
): () => void {
  let alive = true
  const call = async (method: string, path: string, extra: Record<string, unknown> = {}) => {
    const response = await send('webmcp_provider_call', { method, path, ...extra })
    if (!response?.ok) throw Object.assign(new Error(response?.error ?? 'WebMCP storage unavailable'), { code: response?.code ?? 'ENOTCONN' })
    return response.value
  }
  const stop = announceProvider({
    version: 1, id: 'creatorweave.webmcp', name: 'WebMCP adapters', mountName: 'webmcp', isAlive: () => alive,
    factory() {
      const provider: FsProvider = {
        async stat(path) { return await call('stat', path) as Awaited<ReturnType<FsProvider['stat']>> },
        async readdir(path) { return await call('readdir', path) as Awaited<ReturnType<FsProvider['readdir']>> },
        async readFile(path) {
          const encoded = await call('readFile', path)
          if (typeof encoded !== 'string') throw new FsError('EINVAL', 'Invalid storage response')
          return Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
        },
        async writeFile(path, bytes) {
          if (bytes.length > 32 * 1024 * 1024) throw new FsError('EINVAL', 'Extension file limit is 32 MiB')
          const chunks: string[] = []
          for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
          await call('writeFile', path, { content: btoa(chunks.join('')) })
        },
        async mkdir(path, options) { await call('mkdir', path, { recursive: options?.recursive }) },
        async remove(path, options) { await call('remove', path, { recursive: options?.recursive }) },
      }
      return provider
    },
  })
  return () => { alive = false; stop() }
}
