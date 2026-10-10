import { afterEach, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { providerRegistry, startProviderDiscovery } from '@/vfs/provider-registry'
import { installWebMcpProvider } from '../../../browser-extension/entrypoints/webmcp/provider'
import { createProviderHandler } from '../../../browser-extension/entrypoints/webmcp/provider-handler'
import { resolveVfsTarget } from '@/agent/tools/vfs-resolver'

const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()); providerRegistry.clear() })

it('runs the extension-owned transport behind a provider without Web knowing the protocol', async () => {
  const storage = memoryProvider(), refresh = vi.fn(async () => {})
  const handler = createProviderHandler(async () => storage, refresh)
  stops.push(startProviderDiscovery())
  stops.push(installWebMcpProvider(async (_type, payload) => handler(payload)))
  const target = await resolveVfsTarget('vfs://external/webmcp/pkg/a.bin', { directoryHandle: null }, 'write')
  const bytes = new Uint8Array([0, 255, 128, 65])
  await target.backend.writeFile(target.path, bytes.buffer)
  expect(await storage.readFile('pkg/a.bin')).toEqual(bytes)
  expect((await target.backend.readFile(target.path)).content).toEqual(bytes)
  expect(refresh).toHaveBeenCalledOnce()
  await target.backend.deleteFile(target.path)
  await expect(storage.stat('pkg/a.bin')).rejects.toThrow('ENOENT')
})

it('validates paths and operations before writing storage or refreshing catalogs', async () => {
  const storage = memoryProvider(), refresh = vi.fn(async () => {})
  const handler = createProviderHandler(async () => storage, refresh)
  expect(await handler({ method: 'writeFile', path: '../x', content: '' })).toMatchObject({ ok: false, code: 'EINVAL' })
  expect(await handler({ method: 'eval', path: '' })).toMatchObject({ ok: false, code: 'EINVAL' })
  expect(refresh).not.toHaveBeenCalled()
})

it('acknowledges a committed write even when catalog refresh fails', async () => {
  const storage = memoryProvider()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const handler = createProviderHandler(async () => storage, async () => { throw new Error('catalog unavailable') })
    expect(await handler({ method: 'writeFile', path: 'a', content: btoa('saved') })).toEqual({ ok: true, value: null })
    expect(new TextDecoder().decode(await storage.readFile('a'))).toBe('saved')
    expect(warn).toHaveBeenCalledOnce()
  } finally { warn.mockRestore() }
})
