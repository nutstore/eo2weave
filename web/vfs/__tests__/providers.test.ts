import { afterEach, describe, expect, it, vi } from 'vitest'
import { announceProvider, listenForProviders, FsError, type ProviderRegistration } from '@creatorweave/fs-provider'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { ProviderRegistry, providerRegistry } from '../provider-registry'
import { resolveVfsTarget } from '@/agent/tools/vfs-resolver'
import { lsExecutor } from '@/agent/tools/ls.tool'
import { searchExecutor } from '@/agent/tools/search.tool'
import { readExecutor } from '@/agent/tools/read.tool'
import { getReadStateKey } from '@/agent/tools/read-state'
import { WorkerVfsBridgeFs } from '@/agent/tools/bash-worker/worker-vfs-bridge'
import { handleVfsRpc } from '@/agent/tools/bash-worker/vfs-rpc-handler'
import type { ToolContext } from '@/agent/tools/tool-types'

const context: ToolContext = { directoryHandle: null, workspaceId: null, projectId: null, currentAgentId: 'default' }
const registration = (mountName: string, factory: ProviderRegistration['factory'] = () => memoryProvider()): ProviderRegistration => ({
  version: 1, id: `test.${mountName}`, name: mountName, mountName, factory, isAlive: () => true,
})
const stops: Array<() => void> = []
afterEach(() => { providerRegistry.clear(); stops.splice(0).forEach(stop => stop()) })

describe('provider discovery and lifecycle', () => {
  it.each([true, false])('discovers either load order (provider first: %s)', providerFirst => {
    const target = new EventTarget(), receive = vi.fn(), r = registration('memory')
    if (providerFirst) stops.push(announceProvider(r, target))
    stops.push(listenForProviders(receive, target))
    if (!providerFirst) stops.push(announceProvider(r, target))
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ mountName: 'memory' }))
  })
  it('shares concurrent factory initialization and rejects collisions', async () => {
    const registry = new ProviderRegistry(), provider = memoryProvider()
    const factory = vi.fn(async () => provider)
    registry.register(registration('memory', factory))
    registry.register(registration('memory', factory))
    expect(await Promise.all([registry.get('memory'), registry.get('memory')])).toEqual([provider, provider])
    expect(factory).toHaveBeenCalledOnce()
    expect(() => registry.register(registration('memory'))).toThrow('EEXIST')
  })
  it('disposes late factory results after mount replacement', async () => {
    const registry = new ProviderRegistry(), stale = { ...memoryProvider(), dispose: vi.fn() }
    let resolve!: (value: typeof stale) => void
    let alive = true
    registry.register({ ...registration('memory'), factory: () => new Promise(done => { resolve = done }), isAlive: () => alive })
    const pending = registry.get('memory')
    await Promise.resolve()
    alive = false
    registry.register(registration('memory'))
    resolve(stale)
    await expect(pending).rejects.toThrow('ENOTCONN')
    expect(stale.dispose).toHaveBeenCalledOnce()
    expect(await registry.get('memory')).toBeDefined()
  })
  it('retries failed initialization, but ordinary file errors do not rebuild the provider', async () => {
    const registry = new ProviderRegistry(), provider = memoryProvider()
    const factory = vi.fn().mockRejectedValueOnce(new Error('not ready')).mockResolvedValue(provider)
    registry.register(registration('memory', factory))
    await expect(registry.get('memory')).rejects.toThrow('not ready')
    await expect((await registry.get('memory')).readFile('missing')).rejects.toThrow('ENOENT')
    expect(await registry.get('memory')).toBe(provider)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})

describe('handle-free providers through the existing tool entrypoints', () => {
  it.each(['memory', 'second'])('supports %s without adding any tool routing', async name => {
    const provider = memoryProvider()
    await provider.writeFile('src/a.ts', new TextEncoder().encode('hello provider\n'))
    await provider.writeFile('node_modules/hidden.ts', new TextEncoder().encode('hello hidden'))
    providerRegistry.register(registration(name, () => provider))
    const uri = `vfs://external/${name}`
    const target = await resolveVfsTarget(`${uri}/src/a.ts`, context, 'read')
    expect(target.backend.getDirectoryHandle).toBeUndefined()
    expect(JSON.parse(await readExecutor({ path: `${uri}/src/a.ts` }, { ...context }))).toMatchObject({ ok: true })
    const list = JSON.parse(await lsExecutor({ path: uri }, { ...context }))
    expect(list).toMatchObject({ ok: true })
    expect(JSON.stringify(list)).toContain('src/a.ts')
    expect(JSON.stringify(list)).not.toContain('hidden.ts')
    const glob = await lsExecutor({ path: uri, pattern: '**/*.ts' }, { ...context })
    expect(glob).toContain('src/a.ts')
    expect(glob).not.toContain('hidden.ts')
    const search = JSON.parse(await searchExecutor({ path: uri, query: 'hello' }, { ...context }))
    expect(search, JSON.stringify(search)).toMatchObject({ ok: true })
    expect(JSON.stringify(search)).toContain('src/a.ts')
    expect(JSON.stringify(search)).not.toContain('hidden.ts')
  })
  it('keeps mount identities distinct and rejects old paths and traversal', async () => {
    const first = await resolveVfsTarget('vfs://external/a/x', context, 'read')
    const second = await resolveVfsTarget('vfs://external/b/x', context, 'read')
    expect(getReadStateKey(first)).not.toBe(getReadStateKey(second))
    await expect(resolveVfsTarget('vfs://webmcp/x', context, 'read')).rejects.toThrow('Unsupported')
    await expect(resolveVfsTarget('vfs://external/a/../x', context, 'read')).rejects.toThrow('Path cannot include')
  })
  it('narrows glob scans to static prefixes and preserves scoped glob paths', async () => {
    const provider = memoryProvider()
    await provider.writeFile('src/a.ts', new Uint8Array([65]))
    await provider.writeFile('unrelated/b.ts', new Uint8Array([66]))
    const readdir = vi.spyOn(provider, 'readdir')
    providerRegistry.register(registration('narrow', () => provider))
    const prefix = JSON.parse(await lsExecutor({ path: 'vfs://external/narrow', pattern: 'src/*.ts' }, context))
    expect(prefix.data).toEqual([{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }])
    expect(readdir.mock.calls.map(([path]) => path)).toEqual(['src'])
    const scoped = JSON.parse(await lsExecutor({ path: 'vfs://external/narrow/src', pattern: '*.ts' }, context))
    expect(scoped.data).toEqual(prefix.data)
    const missing = JSON.parse(await lsExecutor({ path: 'vfs://external/narrow', pattern: 'missing/*.ts' }, context))
    expect(missing).toMatchObject({ ok: true, data: [] })
  })
  it('enforces read-only providers and rejects invalid directory entries', async () => {
    providerRegistry.register(registration('readonly', () => ({ ...memoryProvider(), readOnly: true })))
    const readOnly = await resolveVfsTarget('vfs://external/readonly/a', context, 'write')
    await expect(readOnly.backend.writeFile('a', 'x')).rejects.toThrow('EROFS')
    providerRegistry.register(registration('broken', () => ({ ...memoryProvider(), readdir: async () => [{ name: '..', kind: 'directory' }] })))
    const broken = await resolveVfsTarget('vfs://external/broken', context, 'list', { allowEmptyPath: true })
    await expect(broken.backend.listDir('')).rejects.toThrow('EINVAL')
  })
  it('supports mkdir, byte-preserving copy and removal through the real bash RPC handler', async () => {
    const a = memoryProvider(), b = memoryProvider()
    providerRegistry.register(registration('a', () => a))
    providerRegistry.register(registration('b', () => b))
    const fs = new WorkerVfsBridgeFs(req => handleVfsRpc(req, {
      workspaceId: null, projectId: null, currentAgentId: 'default', readOnly: false, restrictAgentCoreFiles: false,
    }))
    await fs.mkdir('/external/a/empty', { recursive: true })
    expect((await a.stat('empty')).kind).toBe('directory')
    await fs.writeFile('/external/a/bytes.bin', new Uint8Array([0, 255, 128, 1]), { encoding: 'binary' })
    await fs.cp('/external/a/bytes.bin', '/external/b/copy.bin')
    expect(await b.readFile('copy.bin')).toEqual(new Uint8Array([0, 255, 128, 1]))
    expect(await fs.readdir('/external')).toEqual(['a', 'b'])
    await fs.rm('/external/b/copy.bin')
    await expect(b.stat('copy.bin')).rejects.toBeInstanceOf(FsError)
    const denied = await handleVfsRpc({ type: 'vfs', rpcId: 1, method: 'writeFile', path: 'vfs://external/a/x', content: 'x' }, {
      workspaceId: null, projectId: null, currentAgentId: 'default', readOnly: true, restrictAgentCoreFiles: false,
    })
    expect(denied.ok).toBe(false)
  })
  it('preserves empty directories in cross-mount copies and stops a move on copy failure', async () => {
    const a = memoryProvider(), b = memoryProvider()
    providerRegistry.register(registration('a', () => a))
    providerRegistry.register(registration('b', () => b))
    const fs = new WorkerVfsBridgeFs(req => handleVfsRpc(req, {
      workspaceId: null, projectId: null, currentAgentId: 'default', readOnly: false, restrictAgentCoreFiles: false,
    }))
    await a.mkdir('tree/empty', { recursive: true })
    await fs.cp('/external/a/tree', '/external/b/copied', { recursive: true })
    expect((await b.stat('copied/empty')).kind).toBe('directory')
    await a.writeFile('tree/file.bin', new Uint8Array([255]))
    vi.spyOn(b, 'writeFile').mockRejectedValueOnce(new FsError('EACCES', 'Destination denied'))
    await expect(fs.mv('/external/a/tree', '/external/b/moved')).rejects.toThrow('EACCES')
    expect(await a.readFile('tree/file.bin')).toEqual(new Uint8Array([255]))
    expect((await a.stat('tree/empty')).kind).toBe('directory')
  })
  it('preserves append bytes and does not convert provider read errors into overwrites', async () => {
    const provider = memoryProvider()
    providerRegistry.register(registration('append', () => provider))
    const fs = new WorkerVfsBridgeFs(req => handleVfsRpc(req, {
      workspaceId: null, projectId: null, currentAgentId: 'default', readOnly: false, restrictAgentCoreFiles: false,
    }))
    await provider.writeFile('a.bin', new Uint8Array([255, 128]))
    await fs.appendFile('/external/append/a.bin', new Uint8Array([0, 129]), { encoding: 'binary' })
    expect(await provider.readFile('a.bin')).toEqual(new Uint8Array([255, 128, 0, 129]))
    vi.spyOn(provider, 'readFile').mockRejectedValueOnce(new FsError('EACCES', 'Read denied'))
    const write = vi.spyOn(provider, 'writeFile')
    await expect(fs.appendFile('/external/append/a.bin', 'lost')).rejects.toThrow('EACCES')
    expect(write).not.toHaveBeenCalled()
    vi.spyOn(provider, 'remove').mockRejectedValueOnce(new FsError('EROFS', 'Remove denied'))
    await expect(fs.rm('/external/append/a.bin', { force: true })).rejects.toThrow('EROFS')
  })
})
