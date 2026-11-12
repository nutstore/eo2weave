import { describe, expect, it } from 'vitest'
import { deriveWebmcpAvailability } from '../availability'

describe('deriveWebmcpAvailability', () => {
  it('reports host-disabled when the global switch is off, even with tools', () => {
    expect(
      deriveWebmcpAvailability({ globalEnabled: false, hostEnabled: true, toolCount: 3 })
    ).toBe('host-disabled')
  })

  it('reports host-disabled when this site is not authorized', () => {
    expect(
      deriveWebmcpAvailability({ globalEnabled: true, hostEnabled: false, toolCount: 0 })
    ).toBe('host-disabled')
  })

  it('reports ok when tools resolved', () => {
    expect(
      deriveWebmcpAvailability({ globalEnabled: true, hostEnabled: true, toolCount: 2 })
    ).toBe('ok')
  })

  it('reports unavailable when nothing resolved on an authorized site', () => {
    expect(
      deriveWebmcpAvailability({ globalEnabled: true, hostEnabled: true, toolCount: 0 })
    ).toBe('unavailable')
  })
})

const diagnosticInput = {
  globalEnabled: true, hostEnabled: true, toolCount: 0,
  tabId: 7, url: 'https://example.com/articles',
  diagnostics: {
    catalogStatus: 'ready' as const, rejected: [],
    tabs: [{ tabId: 7, url: 'https://example.com/articles', adapterCount: 0, toolCount: 0, rejectedPackageIds: [] as string[] }],
  },
}

it('distinguishes an unmatched URL from a matched package with no tools', () => {
  expect(deriveWebmcpAvailability(diagnosticInput)).toBe('no-matching-package')
  expect(deriveWebmcpAvailability({ ...diagnosticInput, diagnostics: {
    ...diagnosticInput.diagnostics,
    tabs: [{ ...diagnosticInput.diagnostics.tabs[0], adapterCount: 1 }],
  } })).toBe('package-empty')
})

it('reports a rejected package only when it matches this tab URL', () => {
  const rejected = [{ id: 'com.example.bad', reason: 'Invalid source' }]
  expect(deriveWebmcpAvailability({ ...diagnosticInput, diagnostics: {
    ...diagnosticInput.diagnostics, rejected,
  } })).toBe('no-matching-package')
  expect(deriveWebmcpAvailability({ ...diagnosticInput, diagnostics: {
    ...diagnosticInput.diagnostics, rejected,
    tabs: [{ ...diagnosticInput.diagnostics.tabs[0], rejectedPackageIds: ['com.example.bad'] }],
  } })).toBe('package-rejected')
})

it('reports an actual failed catalog refresh, while available tools remain usable', () => {
  const failed = { ...diagnosticInput, diagnostics: { ...diagnosticInput.diagnostics, catalogStatus: 'failed' as const } }
  expect(deriveWebmcpAvailability(failed)).toBe('catalog-refresh-failed')
  expect(deriveWebmcpAvailability({ ...failed, toolCount: 1 })).toBe('ok')
})

it('does not diagnose a new URL from a previous page or a loading catalog', () => {
  expect(deriveWebmcpAvailability({ ...diagnosticInput, url: 'https://example.com/elsewhere' })).toBe('unavailable')
  expect(deriveWebmcpAvailability({ ...diagnosticInput, diagnostics: {
    ...diagnosticInput.diagnostics, catalogStatus: 'loading' as const,
  } })).toBe('unavailable')
})
