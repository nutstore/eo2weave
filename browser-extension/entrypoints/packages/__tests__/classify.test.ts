/**
 * Source classification matrix for the merged packages page (issue #193).
 *
 * The three sections are DERIVED from `classifyPackage`, so this table is the
 * whole contract: mount (`builtin-webmcp` vs `webmcp`) × install record
 * (present vs absent), including the manifest-less package whose directory is
 * the only identity available.
 */

import { describe, expect, it } from 'vitest'
import { classifyPackage, type PackageSource } from '../shared'

interface Case {
  name: string
  mount: 'builtin-webmcp' | 'webmcp'
  directory: string
  manifestId: string | null
  installed: string[]
  expected: PackageSource
}

const cases: Case[] = [
  {
    name: 'built-in mount, install record for the same id',
    mount: 'builtin-webmcp',
    directory: 'com.example.builtin',
    manifestId: 'com.example.builtin',
    installed: ['com.example.builtin'],
    expected: 'builtin',
  },
  {
    name: 'built-in mount, no install record',
    mount: 'builtin-webmcp',
    directory: 'com.example.builtin',
    manifestId: 'com.example.builtin',
    installed: [],
    expected: 'builtin',
  },
  {
    name: 'webmcp mount, install record',
    mount: 'webmcp',
    directory: 'com.example.registry',
    manifestId: 'com.example.registry',
    installed: ['com.example.registry'],
    expected: 'registry',
  },
  {
    name: 'webmcp mount, no install record',
    mount: 'webmcp',
    directory: 'com.example.mine',
    manifestId: 'com.example.mine',
    installed: ['com.example.registry'],
    expected: 'mine',
  },
  {
    name: 'webmcp mount, unreadable manifest, install record by directory',
    mount: 'webmcp',
    directory: 'com.example.broken',
    manifestId: null,
    installed: ['com.example.broken'],
    expected: 'registry',
  },
  {
    name: 'webmcp mount, unreadable manifest, no install record',
    mount: 'webmcp',
    directory: 'com.example.broken',
    manifestId: null,
    installed: [],
    expected: 'mine',
  },
]

describe('classifyPackage', () => {
  it.each(cases)('$name → $expected', ({ mount, directory, manifestId, installed, expected }) => {
    const entry = {
      mount,
      directory,
      manifest: manifestId === null ? null : { id: manifestId },
    } as Parameters<typeof classifyPackage>[0]
    expect(classifyPackage(entry, new Set(installed))).toBe(expected)
  })

  it('treats a missing install-record set as "no registries installed"', () => {
    const entry = { mount: 'webmcp', directory: 'com.example.mine', manifest: { id: 'com.example.mine' } } as Parameters<typeof classifyPackage>[0]
    expect(classifyPackage(entry)).toBe('mine')
  })
})
