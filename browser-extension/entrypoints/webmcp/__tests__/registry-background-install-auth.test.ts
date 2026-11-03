import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  loadRegistryCatalog: vi.fn(),
  installRegistryPackage: vi.fn(),
}))
vi.mock('../registry-store', () => ({
  listRegistries: async () => [{ manifestUrl: 'https://raw.githubusercontent.com/owner/repo/main/manifest.json', rawBase: 'https://raw.githubusercontent.com/owner/repo/main', label: 'owner/repo' }],
  loadRegistryCatalog: store.loadRegistryCatalog,
  installRegistryPackage: store.installRegistryPackage,
}))

import { createRegistryBackground } from '../registry-background'

const registryUrl = 'https://raw.githubusercontent.com/owner/repo/main/manifest.json'
const packageEntry = {
  id: 'com.example.pkg',
  version: '1.0.0',
  description: 'Example',
  toolCount: 1,
  files: [{ path: 'packages/com.example.pkg/manifest.json', sha256: 'a'.repeat(64) }],
}

describe('registry install authorization', () => {
  beforeEach(() => {
    store.loadRegistryCatalog.mockReset()
    store.installRegistryPackage.mockReset()
    store.installRegistryPackage.mockResolvedValue({ filesWritten: 1 })
  })

  it('rejects a package whose hashes no longer match the canonical catalog', async () => {
    store.loadRegistryCatalog.mockResolvedValue({ packages: [{ ...packageEntry, files: [{ ...packageEntry.files[0], sha256: 'b'.repeat(64) }] }] })
    const handle = createRegistryBackground({ changed: async () => {} })
    const response = await handle({ type: 'webmcp_registry_install', manifestUrl: registryUrl, package: packageEntry })
    expect(response).toMatchObject({ ok: false })
    expect(String(response.error)).toMatch(/changed or was withdrawn/)
    expect(store.loadRegistryCatalog).toHaveBeenCalledWith(expect.anything(), { force: true })
    expect(store.installRegistryPackage).not.toHaveBeenCalled()
  })

  it('installs a package that still matches the fresh canonical catalog', async () => {
    store.loadRegistryCatalog.mockResolvedValue({ packages: [packageEntry] })
    const handle = createRegistryBackground({ changed: async () => {} })
    const response = await handle({ type: 'webmcp_registry_install', manifestUrl: registryUrl, package: packageEntry })
    expect(response).toMatchObject({ ok: true, filesWritten: 1 })
    expect(store.installRegistryPackage).toHaveBeenCalledOnce()
  })
})
