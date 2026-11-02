import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import { createProviderHandler } from '../../../browser-extension/entrypoints/webmcp/provider-handler'
import { createPackageManagement } from '../../../browser-extension/entrypoints/webmcp/package-management'
import { readWebMCPCatalog } from '../../../browser-extension/entrypoints/webmcp/package-repository'
import { setBuiltinConfig } from '../../../browser-extension/entrypoints/webmcp/builtin-storage'
import { pkg } from './fixtures'
vi.mock('../../../browser-extension/entrypoints/webmcp/package-repository', () => ({ readWebMCPCatalog: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/builtin-storage', () => ({ setBuiltinConfig: vi.fn() }))
const entry = { directory: pkg.manifest.id, mount: 'webmcp', uri: 'vfs://external/webmcp/com.example.tools/', access: 'read-write' as const, config: {}, activation: 'disabled' as const, diagnostics: [], package: pkg }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(readWebMCPCatalog).mockResolvedValue([entry])
  // The management handler holds the cross-context package lease (round 3:
  // "Management mutations bypass package lock") — chrome.storage.local backs
  // it; a real map keeps acquire/heartbeat/release working in tests.
  const data = new Map<string, unknown>()
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) }),
      remove: vi.fn(async (key: string) => { data.delete(key) }),
    } },
  })
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })
it('toggles user config through the same storage commit/refresh path as Web file tools', async () => {
  const storage = memoryProvider()
  const refresh = vi.fn(async () => {})
  const manage = createPackageManagement(createProviderHandler(async () => storage, refresh), refresh)
  expect(await manage({ type: 'webmcp_packages_set_config', mount: 'webmcp', directory: entry.directory, config: { activation: 'enabled' } })).toEqual({ ok: true })
  expect(JSON.parse(new TextDecoder().decode(await storage.readFile(`${entry.directory}/config.json`)))).toEqual({ activation: 'enabled' })
  expect(refresh).toHaveBeenCalledOnce()
  expect(setBuiltinConfig).not.toHaveBeenCalled()
})
it('uses the private config store for read-only packages without writing the mounted tree', async () => {
  vi.mocked(readWebMCPCatalog).mockResolvedValue([{ ...entry, mount: 'builtin-webmcp', access: 'read-only' }])
  const write = vi.fn(), refresh = vi.fn(async () => {})
  const manage = createPackageManagement(write, refresh)
  expect(await manage({ type: 'webmcp_packages_set_config', mount: 'builtin-webmcp', directory: entry.directory, config: { activation: 'enabled' } })).toEqual({ ok: true })
  expect(setBuiltinConfig).toHaveBeenCalledWith(entry.directory, { activation: 'enabled' })
  expect(write).not.toHaveBeenCalled()
  expect(refresh).toHaveBeenCalledOnce()
})
it('lists invalid packages and diagnostics without loading source into the page response', async () => {
  vi.mocked(readWebMCPCatalog).mockResolvedValue([entry, { ...entry, directory: 'broken', package: null, diagnostics: ['Missing manifest.json'] }])
  const manage = createPackageManagement(vi.fn(), vi.fn())
  const result = await manage({ type: 'webmcp_packages_list' })
  expect(result).toMatchObject({ ok: true, entries: [{ manifest: pkg.manifest }, { directory: 'broken', diagnostics: ['Missing manifest.json'] }] })
  expect(JSON.stringify(result)).not.toContain('sources')
})
it('rejects traversal, booleans, missing packages and invalid enables without committing', async () => {
  const write = vi.fn(), refresh = vi.fn()
  const manage = createPackageManagement(write, refresh)
  for (const message of [
    { directory: '../escape', config: {} },
    { directory: entry.directory, config: { activation: true } },
    { directory: 'missing', config: {} },
  ]) expect(await manage({ type: 'webmcp_packages_set_config', mount: 'webmcp', ...message })).toMatchObject({ ok: false })
  vi.mocked(readWebMCPCatalog).mockResolvedValue([{ ...entry, package: null, diagnostics: ['Invalid manifest'] }])
  expect(await manage({ type: 'webmcp_packages_set_config', mount: 'webmcp', directory: entry.directory, config: { activation: 'enabled' } })).toMatchObject({ ok: false })
  expect(write).not.toHaveBeenCalled()
  expect(refresh).not.toHaveBeenCalled()
})

it('acknowledges persisted builtin config even if catalog refresh fails', async () => {
  vi.mocked(readWebMCPCatalog).mockResolvedValue([{ ...entry, mount: 'builtin-webmcp', access: 'read-only' }])
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const manage = createPackageManagement(vi.fn(), async () => { throw new Error('Host disconnected') })
    expect(await manage({ type: 'webmcp_packages_set_config', mount: 'builtin-webmcp', directory: entry.directory, config: { activation: 'disabled' } })).toEqual({ ok: true })
    expect(setBuiltinConfig).toHaveBeenCalledOnce()
  } finally { warn.mockRestore() }
})

it('recursively deletes user packages and refreshes the catalog', async () => {
  const storage = memoryProvider()
  await storage.writeFile(`${entry.directory}/nested/tool.js`, new TextEncoder().encode('source'))
  const refresh = vi.fn(async () => {})
  const manage = createPackageManagement(createProviderHandler(async () => storage, refresh), refresh)
  expect(await manage({ type: 'webmcp_packages_delete', mount: 'webmcp', directory: entry.directory })).toEqual({ ok: true, value: null })
  await expect(storage.stat(entry.directory)).rejects.toThrow()
  expect(refresh).toHaveBeenCalledOnce()
})
it('rejects builtin deletion, traversal and missing packages without writing', async () => {
  const write = vi.fn()
  const manage = createPackageManagement(write, vi.fn())
  for (const directory of ['../escape', '', 'missing']) {
    expect(await manage({ type: 'webmcp_packages_delete', mount: 'webmcp', directory })).toMatchObject({ ok: false })
  }
  vi.mocked(readWebMCPCatalog).mockResolvedValue([{ ...entry, mount: 'builtin-webmcp', access: 'read-only' }])
  expect(await manage({ type: 'webmcp_packages_delete', mount: 'builtin-webmcp', directory: entry.directory })).toMatchObject({ ok: false, code: 'EROFS' })
  expect(write).not.toHaveBeenCalled()
})
