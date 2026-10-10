import { afterEach, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { providerRegistry } from '../provider-registry'
import { handleVfsRpc } from '@/agent/tools/bash-worker/vfs-rpc-handler'
import { WorkerVfsBridgeFs } from '@/agent/tools/bash-worker/worker-vfs-bridge'
import type { FsProvider } from '@creatorweave/fs-provider'

const config = {
  workspaceId: null, projectId: null, currentAgentId: 'default', readOnly: false, restrictAgentCoreFiles: false,
}
const register = (mountName: string, provider: FsProvider) => providerRegistry.register({
  version: 1, id: `test.${mountName}`, name: mountName, mountName, factory: () => provider, isAlive: () => true,
})
afterEach(() => providerRegistry.clear())

it.each(['cp', 'mv'] as const)('rejects %s into itself or descendants before any mutation', async method => {
  const storage = memoryProvider()
  await storage.writeFile('src/file.bin', new Uint8Array([0, 255]))
  const provider = {
    ...storage,
    mkdir: vi.fn(storage.mkdir).mockRejectedValue(new Error('Unexpected directory mutation')),
    writeFile: vi.fn(storage.writeFile), remove: vi.fn(storage.remove),
  }
  register('copy', provider)
  const fs = new WorkerVfsBridgeFs(req => handleVfsRpc(req, config))
  for (const dest of ['src', 'src/copy', 'src/copy/deep', 'src/../src/copy']) {
    await expect(fs[method]('/external/copy/src', `/external/copy/${dest}`, { recursive: true }))
      .rejects.toThrow('EINVAL: cannot recursively copy a path into itself')
  }
  expect(provider.mkdir).not.toHaveBeenCalled()
  expect(provider.writeFile).not.toHaveBeenCalled()
  expect(provider.remove).not.toHaveBeenCalled()
  expect(await storage.readdir('src')).toEqual([expect.objectContaining({ name: 'file.bin' })])
})

it('rejects copying a mount root into its own child through the host RPC', async () => {
  const storage = memoryProvider()
  const mkdir = vi.fn(storage.mkdir).mockRejectedValue(new Error('Unexpected directory mutation'))
  register('root', { ...storage, mkdir })
  const result = await handleVfsRpc({ type: 'vfs', rpcId: 1, method: 'cp',
    path: 'vfs://external/root/', dest: 'vfs://external/root/copy', recursive: true }, config)
  expect(result).toMatchObject({ ok: false, error: 'EINVAL: cannot recursively copy a path into itself' })
  expect(mkdir).not.toHaveBeenCalled()
})

it('preserves sibling and cross-mount directory copies', async () => {
  const a = memoryProvider(), b = memoryProvider()
  await a.mkdir('src/empty', { recursive: true })
  await a.writeFile('src/file.bin', new Uint8Array([0, 255]))
  register('a', a)
  register('b', b)
  const fs = new WorkerVfsBridgeFs(req => handleVfsRpc(req, config))
  await fs.cp('/external/a/src', '/external/a/src-copy', { recursive: true })
  expect(await a.readFile('src-copy/file.bin')).toEqual(new Uint8Array([0, 255]))
  expect(await a.stat('src-copy/empty')).toMatchObject({ kind: 'directory' })
  const result = await handleVfsRpc({ type: 'vfs', rpcId: 2, method: 'cp',
    path: 'vfs://external/a/src', dest: 'vfs://external/b/src/copy', recursive: true }, config)
  expect(result).toMatchObject({ ok: true })
  expect(await b.readFile('src/copy/file.bin')).toEqual(new Uint8Array([0, 255]))
  expect(await b.stat('src/copy/empty')).toMatchObject({ kind: 'directory' })
})
