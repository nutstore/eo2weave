import { describe, expect, it, vi } from 'vitest'

vi.mock('../package-repository', () => ({
  readWebMCPCatalog: async () => [{ directory: 'com.example.pkg', mount: 'webmcp', access: 'read-write', diagnostics: [], package: {} }],
}))
vi.mock('../package-lock', () => ({
  withPackageLock: async (_id: string, callback: (signal: AbortSignal) => Promise<unknown>) => callback(new AbortController().signal),
}))
vi.mock('../package-installer', () => ({ recordUninstallIntent: vi.fn() }))

import { createPackageManagement } from '../package-management'

describe('package management deletion', () => {
  it('removes the preserved backup under the same lock as the live package', async () => {
    const writes: string[] = []
    const manage = createPackageManagement(async message => {
      writes.push(String(message.path))
      return { ok: true }
    }, async () => {})
    const result = await manage({ type: 'webmcp_packages_delete', mount: 'webmcp', directory: 'com.example.pkg' })
    expect(result).toMatchObject({ ok: true })
    expect(writes).toEqual(['com.example.pkg', '.com.example.pkg.previous'])
  })

  it('reports failure when the preserved backup could not be removed', async () => {
    const manage = createPackageManagement(async message => message.path === '.com.example.pkg.previous'
      ? { ok: false, code: 'EACCES', error: 'Backup removal failed' }
      : { ok: true }, async () => {})
    const result = await manage({ type: 'webmcp_packages_delete', mount: 'webmcp', directory: 'com.example.pkg' })
    expect(result).toMatchObject({ ok: false, code: 'EACCES' })
  })

  it('succeeds when no preserved backup exists', async () => {
    const manage = createPackageManagement(async message => message.path === '.com.example.pkg.previous'
      ? { ok: false, code: 'ENOENT', error: 'Missing backup' }
      : { ok: true }, async () => {})
    const result = await manage({ type: 'webmcp_packages_delete', mount: 'webmcp', directory: 'com.example.pkg' })
    expect(result).toMatchObject({ ok: true })
  })
})
