import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findPackageOptInCandidate, toolIsReadOnly } from '../../../browser-extension/entrypoints/webmcp/package-optin'
import { createPackageOptInHandler, CONSENT_TOKEN_MIN_AGE_MS } from '../../../browser-extension/entrypoints/webmcp/package-optin-handler'
import { readWebMCPCatalog } from '../../../browser-extension/entrypoints/webmcp/package-repository'
import { setBuiltinConfig } from '../../../browser-extension/entrypoints/webmcp/builtin-storage'
import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'

vi.mock('../../../browser-extension/entrypoints/webmcp/package-repository', () => ({ readWebMCPCatalog: vi.fn() }))
vi.mock('../../../browser-extension/entrypoints/webmcp/builtin-storage', () => ({ setBuiltinConfig: vi.fn() }))

const READ_ONLY_SOURCE = 'export default { inputSchema: {}, outputSchema: {}, tree: { type: "action", run: async () => { const t = await browser.eval("() => document.title"); return t; } }, result: () => ({}) }'
const WRITE_SOURCE = 'export default { inputSchema: {}, outputSchema: {}, tree: { type: "action", run: async () => { await browser.click("e1"); return "success"; } }, result: () => ({}) }'

function entry(overrides: Partial<WebMCPPackageEntry> = {}): WebMCPPackageEntry {
  return {
    directory: 'world.jmail.archive',
    mount: 'builtin-webmcp',
    uri: 'vfs://external/builtin-webmcp/world.jmail.archive/',
    access: 'read-only',
    config: {},
    activation: 'disabled',
    diagnostics: [],
    package: {
      manifest: {
        id: 'world.jmail.archive',
        version: '2.0.0',
        description: 'Archive email tools.',
        tools: [
          { name: 'read_page', description: 'Read a page snapshot.', urlRegex: '^https://jmail\\.world/.*$', path: 'workflows/read_page.js' },
          { name: 'search_emails', description: 'Search emails.', urlRegex: '^https://jmail\\.world/.*$', path: 'workflows/search_emails.js' },
        ],
      },
      sources: {
        'workflows/read_page.js': READ_ONLY_SOURCE,
        'workflows/search_emails.js': WRITE_SOURCE,
      },
    },
    ...overrides,
  }
}

describe('findPackageOptInCandidate', () => {
  it('matches a builtin package by tool urlRegex and reports the activation', () => {
    const candidate = findPackageOptInCandidate([entry()], 'https://jmail.world/messages')
    expect(candidate?.id).toBe('world.jmail.archive')
    expect(candidate?.activation).toBe('disabled')
    expect(candidate?.hostname).toBe('jmail.world')
    expect(candidate?.tools.map(tool => tool.name)).toEqual(['read_page', 'search_emails'])
  })

  it('returns null when no package hosts the url', () => {
    expect(findPackageOptInCandidate([entry()], 'https://example.com/')).toBeNull()
  })

  it('ignores user-mounted packages', () => {
    expect(findPackageOptInCandidate([entry({ mount: 'webmcp' })], 'https://jmail.world/')).toBeNull()
  })

  it('ignores packages with blocking diagnostics', () => {
    const broken = entry({ diagnostics: ['Invalid manifest'] })
    expect(findPackageOptInCandidate([broken], 'https://jmail.world/')).toBeNull()
  })

  it('marks read-only tools and write tools apart', () => {
    const candidate = findPackageOptInCandidate([entry()], 'https://jmail.world/')
    expect(candidate?.tools[0].readOnly).toBe(true)
    expect(candidate?.tools[1].readOnly).toBe(false)
  })

  it('prefers a DISABLED package over an enabled one with more matching tools', () => {
    const enabledBig = entry({
      directory: 'com.site.enabled',
      activation: 'enabled',
      package: {
        manifest: {
          id: 'com.site.enabled',
          version: '1.0.0',
          description: 'Enabled package with more matching tools.',
          tools: [
            { name: 'a', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'a.js' },
            { name: 'b', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'b.js' },
            { name: 'c', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'c.js' },
          ],
        },
        sources: { 'a.js': READ_ONLY_SOURCE, 'b.js': READ_ONLY_SOURCE, 'c.js': READ_ONLY_SOURCE },
      },
    })
    const disabledSmall = entry()
    const candidate = findPackageOptInCandidate(
      [enabledBig, disabledSmall],
      'https://jmail.world/',
    )
    // The prompt exists to offer disabled packages — it must not be shadowed
    // by an enabled package that happens to match more tools.
    expect(candidate?.id).toBe('world.jmail.archive')
    expect(candidate?.activation).toBe('disabled')
  })

  it('still prefers the package with the most tools when both are disabled', () => {
    const small = entry({ directory: 'com.site.small', package: {
      manifest: {
        id: 'com.site.small',
        version: '1.0.0',
        description: 'Small package.',
        tools: [
          { name: 'a', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'a.js' },
        ],
      },
      sources: { 'a.js': READ_ONLY_SOURCE },
    } })
    const candidate = findPackageOptInCandidate([small, entry()], 'https://jmail.world/')
    expect(candidate?.id).toBe('world.jmail.archive')
  })
})

describe('toolIsReadOnly', () => {
  it('treats a pure page read as read-only', () => {
    expect(toolIsReadOnly(READ_ONLY_SOURCE)).toBe(true)
  })

  it('treats interaction commands as writes', () => {
    expect(toolIsReadOnly(WRITE_SOURCE)).toBe(false)
  })

  it('treats DOM mutations inside evaluated scripts as writes', () => {
    expect(toolIsReadOnly('await browser.eval("() => { document.querySelector(\'x\').click() }")')).toBe(false)
  })

  it('treats an empty source as a write (never claim read-only without evidence)', () => {
    expect(toolIsReadOnly('')).toBe(false)
  })
})

describe('createPackageOptInHandler', () => {
  const reload = vi.fn()
  const get = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    // resetAllMocks clears implementations — re-arm the chrome stubs.
    reload.mockResolvedValue(undefined)
    get.mockResolvedValue({ id: 7, url: 'https://jmail.world/messages' })
    vi.stubGlobal('chrome', {
      tabs: { get, reload },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([entry()])
    vi.mocked(setBuiltinConfig).mockResolvedValue(undefined)
  })

  /** Mint a fresh token through the status probe (mirrors the real flow). */
  async function mintToken(): Promise<{ token: string | undefined }> {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    // The token carries a minimum age (anti-scripted-chain defence): wait it
    // out so the happy-path tests mirror a human-paced confirm.
    await new Promise(resolve => setTimeout(resolve, CONSENT_TOKEN_MIN_AGE_MS + 50))
    return { token: respond.mock.calls[0][0].consentToken as string | undefined }
  }

  it('reports the matching package, its disabled activation and a consent token', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const body = respond.mock.calls[0][0] as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({
      ok: true,
      applicable: true,
      enabled: false,
      package: expect.objectContaining({ id: 'world.jmail.archive' }),
    }))
    expect(typeof body.consentToken).toBe('string')
    expect(body.consentToken).not.toBe('')
  })

  it('issues NO consent token when the matching package is already enabled', async () => {
    vi.mocked(readWebMCPCatalog).mockResolvedValue([entry({ activation: 'enabled' })])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    expect(respond.mock.calls[0][0]).toEqual(expect.objectContaining({
      ok: true,
      applicable: true,
      enabled: true,
      consentToken: undefined,
    }))
  })

  it('refuses the probe when the binding does not resolve', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => null })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'UNAUTHORIZED_TARGET' }))
  })

  it('rejects enable WITHOUT a consent token (scripted enable cannot bypass the modal)', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive' }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
  })

  it('rejects an UNKNOWN consent token', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle(
      { type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: 'forged' },
      respond,
    )
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
  })

  it('rejects a token used FASTER than a human could confirm (scripted chain)', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const token = (respond.mock.calls[0][0] as { consentToken: string }).consentToken
    // No wait — enable fires within the token's minimum age.
    await handle(
      { type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token },
      respond,
    )
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(respond.mock.calls[1][0]).toEqual(
      expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }),
    )
  })

  it('rejects a REPLAYED consent token (single use)', async () => {
    const { token } = await mintToken()
    expect(typeof token).toBe('string')
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toEqual(expect.objectContaining({ ok: true }))

    // Second use of the same token must fail — the token was consumed.
    const respond2 = vi.fn()
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond2)
    expect(setBuiltinConfig).toHaveBeenCalledTimes(1)
    expect(respond2).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
  })

  it('binds the consent token to the tab it was issued for', async () => {
    const respond = vi.fn()
    const statusHandler = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await statusHandler({ type: 'webmcp_package_optin_status' }, respond)
    const token = (respond.mock.calls[0][0] as { consentToken: string }).consentToken

    // Present the token against a DIFFERENT bound tab.
    const respond2 = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 9 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond2)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(respond2).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
  })

  it('enables the package and reloads the bound tab with a valid token', async () => {
    const { token } = await mintToken()
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
    expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
    expect(reload).toHaveBeenCalledWith(7)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, reloaded: true }))
  })

  it('rejects a package id that does not match the bound tab url', async () => {
    const { token } = await mintToken()
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.douban.movie', consentToken: token }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'PACKAGE_MISMATCH' }))
  })

  it('revalidates the LIVE tab url after reading the catalog and cancels on navigation', async () => {
    const { token } = await mintToken()
    // mintToken already consumed one tab.get (status probe, default mock).
    // Within THIS counting mock: call 1 = enable pre-check (old URL),
    // call 2 = post-catalog revalidation (NEW url — the tab navigated while
    // the catalog was read), so the pre-read candidate must be discarded.
    let call = 0
    get.mockImplementation(async () => {
      call += 1
      if (call <= 1) return { id: 7, url: 'https://jmail.world/messages' }
      return { id: 7, url: 'https://unrelated.example/' }
    })

    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'PACKAGE_MISMATCH' }))
  })

  it('still answers ok when the reload fails (the enable itself persisted)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { token } = await mintToken()
      reload.mockRejectedValue(new Error('Tab not found'))
      const respond = vi.fn()
      const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
      await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
      expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, reloaded: false }))
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
