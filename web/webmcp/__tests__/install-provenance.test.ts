import { describe, expect, it } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import {
  encodeInstallMarker,
  INSTALL_MARKER_FILE,
  parseInstallMarker,
  readInstallMarker,
  readInstallMarkerState,
} from '../install-provenance'

/**
 * The web side's install provenance marker (issue #231) — the same contract
 * the extension records (issues #228/#230). Pure parse/read logic only; the
 * three-way read contract decides what the settings section may treat as a
 * registry install.
 */

const MARKER = {
  schemaVersion: 1 as const,
  registryId: 'https://example.com/manifest.json',
  packageId: 'com.example.pkg',
  version: '1.0.0',
  installedAt: '2026-11-06T00:00:00.000Z',
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('parseInstallMarker', () => {
  it('accepts a current-schema marker', () => {
    expect(parseInstallMarker(bytes(JSON.stringify(MARKER)))).toEqual(MARKER)
  })

  it('rejects malformed JSON', () => {
    expect(parseInstallMarker(bytes('{not json'))).toBeNull()
  })

  it('rejects a wrong schemaVersion', () => {
    expect(parseInstallMarker(bytes(JSON.stringify({ ...MARKER, schemaVersion: 2 })))).toBeNull()
  })

  it('rejects missing or empty required fields', () => {
    for (const field of ['registryId', 'packageId'] as const) {
      const missing = { ...MARKER }
      delete missing[field]
      expect(parseInstallMarker(bytes(JSON.stringify(missing)))).toBeNull()
      const empty = { ...MARKER, [field]: '' }
      expect(parseInstallMarker(bytes(JSON.stringify(empty)))).toBeNull()
    }
    // version/installedAt must be strings (absence rejected); the extension
    // contract does not require them to be non-empty.
    expect(parseInstallMarker(bytes(JSON.stringify({ ...MARKER, installedAt: 5 })))).toBeNull()
  })
})

describe('readInstallMarkerState', () => {
  it('reads an ok marker', async () => {
    const provider = memoryProvider()
    await provider.writeFile('com.example.pkg/.webmcp-install.json', encodeInstallMarker(MARKER))
    const state = await readInstallMarkerState(provider, 'com.example.pkg')
    expect(state).toEqual({ kind: 'ok', marker: MARKER })
    expect(INSTALL_MARKER_FILE).toBe('.webmcp-install.json')
  })

  it('reads an absent marker as authored', async () => {
    const provider = memoryProvider()
    await provider.mkdir('com.example.pkg', { recursive: true })
    const state = await readInstallMarkerState(provider, 'com.example.pkg')
    expect(state.kind).toBe('absent')
    expect(await readInstallMarker(provider, 'com.example.pkg')).toBeNull()
  })

  it('reads a malformed marker as invalid, not absent', async () => {
    const provider = memoryProvider()
    await provider.mkdir('com.example.pkg', { recursive: true })
    await provider.writeFile('com.example.pkg/.webmcp-install.json', bytes('{}'))
    const state = await readInstallMarkerState(provider, 'com.example.pkg')
    expect(state.kind).toBe('invalid')
  })
})
