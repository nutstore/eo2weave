import { describe, expect, it } from 'vitest'
import {
  CW_WEBAPP_ORIGIN_CN,
  CW_WEBAPP_ORIGIN_COM,
  CW_WEBAPP_ORIGIN_LEGACY,
  isTrustedCreatorWeaveSenderUrl,
  isSidePanelBindingId,
} from '@creatorweave/shared'

describe('page action extension authorization', () => {
  it('allows only the exact eo2weave production, legacy, and local development origins', () => {
    expect(isTrustedCreatorWeaveSenderUrl(`${CW_WEBAPP_ORIGIN_CN}/`)).toBe(true)
    expect(isTrustedCreatorWeaveSenderUrl(`${CW_WEBAPP_ORIGIN_COM}/side-panel`)).toBe(true)
    // Legacy origin stays trusted during the migration window.
    expect(isTrustedCreatorWeaveSenderUrl(`${CW_WEBAPP_ORIGIN_LEGACY}/`)).toBe(true)
    expect(isTrustedCreatorWeaveSenderUrl('http://localhost:5173/side-panel')).toBe(true)
  })

  it('trusts loopback dev origins on any port (localhost / 127.0.0.1 / [::1])', () => {
    // Dev servers auto-increment or use custom ports — the loopback family
    // is trusted regardless of port.
    expect(isTrustedCreatorWeaveSenderUrl('http://localhost:3000/side-panel')).toBe(true)
    expect(isTrustedCreatorWeaveSenderUrl('http://127.0.0.1:8787/')).toBe(true)
    expect(isTrustedCreatorWeaveSenderUrl('http://[::1]:5173/')).toBe(true)
  })

  it('still rejects non-loopback hosts even with the dev port', () => {
    // LAN IPs / lookalike hostnames / subdomain tricks are NOT loopback.
    expect(isTrustedCreatorWeaveSenderUrl('http://192.168.1.5:5173/')).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl('http://localhost.attacker.example:5173/')).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl('http://localhost:5173.attacker.example/')).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl('https://evil.example/')).toBe(false)
  })

  it('rejects missing and lookalike sender URLs', () => {
    expect(isTrustedCreatorWeaveSenderUrl(undefined)).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl(`${CW_WEBAPP_ORIGIN_LEGACY}.attacker.example`)).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl(`https://evil.example/${CW_WEBAPP_ORIGIN_LEGACY}`)).toBe(false)
    expect(isTrustedCreatorWeaveSenderUrl(`${CW_WEBAPP_ORIGIN_LEGACY}:444`)).toBe(false)
  })

  it('accepts only opaque UUID side-panel bindings sent from session state', () => {
    expect(isSidePanelBindingId('7e30f3b0-d790-4d42-9e05-8f3d38e90be4')).toBe(true)
    expect(isSidePanelBindingId('12')).toBe(false)
    expect(isSidePanelBindingId(undefined)).toBe(false)
  })
})
