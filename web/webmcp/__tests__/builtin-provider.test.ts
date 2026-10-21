import { afterEach, expect, it, vi } from 'vitest'
import { providerRegistry, startProviderDiscovery } from '@/vfs/provider-registry'
import { resolveVfsTarget } from '@/agent/tools/vfs-resolver'
import { installWebMcpProvider } from '../../../browser-extension/entrypoints/webmcp/provider'
import { createProviderHandler } from '../../../browser-extension/entrypoints/webmcp/provider-handler'
import { getBuiltinStorage, setBuiltinConfig, BUILTIN_CONFIG_STORAGE_KEY } from '../../../browser-extension/entrypoints/webmcp/builtin-storage'
import { readMountedWebMCPCatalog } from '@creatorweave/shared/webmcp-package-catalog'
import { providerMount } from '../../../browser-extension/entrypoints/webmcp/package-repository'

const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()); providerRegistry.clear(); vi.unstubAllGlobals() })
function setup() {
  const data: Record<string, unknown> = { webmcp_enabled_recipes: { 'jmail-world': { enabledAt: 1 } } }
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(data, value) },
  } } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Builtin reads must use bundled source text') }))
  return data
}
it('exposes all four structured bundled packages and ignores legacy switches', async () => {
  setup()
  const provider = await getBuiltinStorage()
  const entries = await readMountedWebMCPCatalog([providerMount('builtin-webmcp', provider)])
  expect(entries).toHaveLength(4)
  expect(entries.every(entry => entry.activation === 'disabled' && !entry.diagnostics.length)).toBe(true)
  expect(entries.flatMap(entry => entry.package!.manifest.tools)).toHaveLength(44)
  for (const entry of entries) {
    expect((await provider.readdir(entry.directory)).map(item => item.name)).toContain('workflows')
    expect(JSON.parse(new TextDecoder().decode(await provider.readFile(`${entry.directory}/config.json`)))).toEqual({})
  }
  expect(fetch).not.toHaveBeenCalled()
})
it('keeps builtin source immutable while exposing persisted configuration changes', async () => {
  const data = setup()
  const provider = await getBuiltinStorage()
  const id = 'world.jmail.archive'
  await Promise.all([setBuiltinConfig(id, { activation: 'enabled' }), setBuiltinConfig('com.douban.movie', { activation: 'disabled' })])
  expect(Object.keys(data[BUILTIN_CONFIG_STORAGE_KEY] as object)).toHaveLength(2)
  expect(JSON.parse(new TextDecoder().decode(await provider.readFile(`${id}/config.json`)))).toEqual({ activation: 'enabled' })
  for (const mutate of [() => provider.writeFile(`${id}/config.json`, new Uint8Array()), () => provider.remove(id, { recursive: true }), () => provider.mkdir('new'), () => provider.rename!('a', 'b')])
    await expect(mutate()).rejects.toMatchObject({ code: 'EROFS' })
  await expect(provider.readFile('../manifest.json')).rejects.toMatchObject({ code: 'EINVAL' })
})
it('mounts builtin read-only and enforces it at both transport boundaries', async () => {
  setup()
  const refresh = vi.fn(async () => {})
  const handler = createProviderHandler(getBuiltinStorage, refresh)
  const send = vi.fn(async (_type: string, payload: Record<string, unknown>) => handler(payload))
  stops.push(startProviderDiscovery(), installWebMcpProvider(send))
  const target = await resolveVfsTarget('vfs://external/builtin-webmcp/world.jmail.archive/config.json', { directoryHandle: null }, 'read')
  expect((await target.backend.readFile(target.path)).content).toBeInstanceOf(Uint8Array)
  send.mockClear()
  await expect(target.backend.writeFile(target.path, new ArrayBuffer(0))).rejects.toMatchObject({ code: 'EROFS' })
  expect(send).not.toHaveBeenCalled()
  expect(await handler({ method: 'writeFile', path: 'world.jmail.archive/config.json', content: btoa('{}') })).toMatchObject({ ok: false, code: 'EROFS' })
  expect(refresh).not.toHaveBeenCalled()
})
