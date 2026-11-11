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
