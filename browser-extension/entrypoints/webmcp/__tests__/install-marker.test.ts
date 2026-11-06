/**
 * Provenance marker contract (issue #228): an install is identified by the
 * marker the installer writes, never by the directory shape. These cases pin
 * the two properties the classification depends on — a marker round-trips, and
 * anything that is not a current-schema marker reads as "no marker" so an
 * authored package can never be promoted to a registry install by accident.
 */
import { describe, expect, it } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import {
  INSTALL_MARKER_FILE,
  encodeInstallMarker,
  parseInstallMarker,
  readInstallMarker,
  type InstallMarker,
} from '../install-marker'

const MARKER: InstallMarker = {
  schemaVersion: 1,
  registryId: 'https://example.com/registry.json',
  packageId: 'com.example.pkg',
  version: '1.2.0',
  installedAt: '2026-11-06T00:00:00.000Z',
}

describe('install marker', () => {
  it('round-trips through encode/parse', () => {
    expect(parseInstallMarker(encodeInstallMarker(MARKER))).toEqual(MARKER)
  })

  it.each([
    ['malformed json', new TextEncoder().encode('{ not json')],
    ['a bare object', new TextEncoder().encode('{}')],
    ['an unknown schema', new TextEncoder().encode(JSON.stringify({ ...MARKER, schemaVersion: 2 }))],
    ['a missing package id', new TextEncoder().encode(JSON.stringify({ ...MARKER, packageId: '' }))],
    ['a null body', new TextEncoder().encode('null')],
  ])('rejects %s', (_label, bytes) => {
    expect(parseInstallMarker(bytes)).toBeNull()
  })

  it('reads the marker of a package directory', async () => {
    const provider = memoryProvider()
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile(`com.example.pkg/${INSTALL_MARKER_FILE}`, encodeInstallMarker(MARKER))
    expect(await readInstallMarker(provider, 'com.example.pkg')).toEqual(MARKER)
  })

  it('answers null for a directory without a marker', async () => {
    const provider = memoryProvider()
    await provider.mkdir('authored', { recursive: true })
    expect(await readInstallMarker(provider, 'authored')).toBeNull()
  })
})
