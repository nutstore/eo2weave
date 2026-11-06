/**
 * Catalog rejection transport (issue #239).
 *
 * The adapter catalog reports the packages it dropped; the packages page must
 * show THAT reason on the package's own card. These cases pin the join: a
 * reason reaches the entry with the matching manifest id, unmatched entries
 * stay untouched, and a malformed payload degrades to "no rejections" instead
 * of throwing the whole packages page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listManagedPackages, type ManagedWebMCPPackage } from '../package-client'

function stubCatalog(response: unknown): void {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue(response) } })
}

function entry(id: string): ManagedWebMCPPackage {
  return {
    directory: id,
    mount: 'webmcp',
    uri: `vfs://external/webmcp/${id}/`,
    access: 'read-write',
    config: null,
    activation: 'enabled',
    diagnostics: [],
    manifest: { id, version: '1.0.0', description: '', tools: [] },
  } as unknown as ManagedWebMCPPackage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listManagedPackages catalog rejections', () => {
  it('attaches each reason to the package it belongs to', async () => {
    stubCatalog({
      ok: true,
      entries: [entry('com.example.heavy'), entry('com.example.healthy')],
      userMountComplete: true,
      rejected: [{ id: 'com.example.heavy', reason: 'Package source exceeds the size limit' }],
    })

    const catalog = await listManagedPackages()
    expect(catalog.entries[0].catalogRejection).toBe('Package source exceeds the size limit')
    expect(catalog.entries[1].catalogRejection).toBeUndefined()
    expect(catalog.rejected).toEqual([
      { id: 'com.example.heavy', reason: 'Package source exceeds the size limit' },
    ])
  })

  it('ignores rejections that match no entry and malformed payloads', async () => {
    stubCatalog({
      ok: true,
      entries: [entry('com.example.healthy')],
      rejected: [{ id: 'com.example.gone', reason: 'Missing package id' }, { id: 42 }, null],
    })

    const catalog = await listManagedPackages()
    expect(catalog.entries[0].catalogRejection).toBeUndefined()
    expect(catalog.rejected).toEqual([{ id: 'com.example.gone', reason: 'Missing package id' }])
  })

  it('does not mark an accepted package when a duplicate id is rejected', async () => {
    // Two installed packages share a manifest id; the adapter keeps the first
    // and rejects the second as a duplicate. The reason cannot be attributed to
    // either directory, so neither card may claim to be excluded.
    stubCatalog({
      ok: true,
      entries: [entry('com.example.dup'), entry('com.example.dup')],
      rejected: [{ id: 'com.example.dup', reason: 'Duplicate package id: com.example.dup' }],
    })

    const catalog = await listManagedPackages()
    expect(catalog.entries.every(item => item.catalogRejection === undefined)).toBe(true)
    expect(catalog.rejected).toHaveLength(1)
  })

  it('reads a missing rejection list as none', async () => {
    stubCatalog({ ok: true, entries: [entry('com.example.healthy')] })

    const catalog = await listManagedPackages()
    expect(catalog.rejected).toEqual([])
    expect(catalog.userMountComplete).toBe(true)
  })
})
