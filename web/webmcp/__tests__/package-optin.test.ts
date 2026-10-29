import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findPackageOptInCandidate, toolIsReadOnly } from '../../../browser-extension/entrypoints/webmcp/package-optin'
import { createPackageOptInHandler, CONSENT_TOKEN_MIN_AGE_MS, setConsentTokenEnforcementForTests } from '../../../browser-extension/entrypoints/webmcp/package-optin-handler'
import { readWebMCPCatalog, readWebMCPCatalogDetailed } from '../../../browser-extension/entrypoints/webmcp/package-repository'
import { setBuiltinConfig, readBuiltinConfig } from '../../../browser-extension/entrypoints/webmcp/builtin-storage'
import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'

vi.mock('../../../browser-extension/entrypoints/webmcp/package-repository', () => ({
  readBuiltinWebMCPCatalog: vi.fn(),
  readWebMCPCatalog: vi.fn(),
  readWebMCPCatalogDetailed: vi.fn(),
}))
vi.mock('../../../browser-extension/entrypoints/webmcp/builtin-storage', () => ({
  setBuiltinConfig: vi.fn(),
  readBuiltinConfig: vi.fn(),
  getBuiltinStorage: vi.fn(),
}))

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

  it('treats browser.goto navigation as read-only (a page read, not a write)', () => {
    // Finding: "Read-only tools are labeled writable" — browse_chart and
    // other navigation workflows were badged Write because goto looked like
    // an unknown mutating call.
    expect(
      toolIsReadOnly(
        'async run({ state, target }) { await browser.goto("https://movie.douban.com/chart", { tab: target.tabId }); return "success"; }',
      ),
    ).toBe(true)
  })

  it('treats internal workflow state writes as read-only', () => {
    // `state` is the workflow's OWN output channel, not page state.
    expect(toolIsReadOnly('async inspect({ state }) { state.result = { count: 1 }; return true; }')).toBe(true)
    expect(toolIsReadOnly('state["chart"] = rows; const t = document.title')).toBe(true)
  })

  it('still flags page writes alongside state writes', () => {
    // A state write must not whitewash a real page mutation in the same source.
    expect(toolIsReadOnly('state.result = page; page.title = "x"')).toBe(false)
  })
})

describe('createPackageOptInHandler', () => {
  const reload = vi.fn()
  const get = vi.fn()
  const alarmCreate = vi.fn()
  const alarmGetAll = vi.fn()
  const alarmClear = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    // resetAllMocks clears implementations — re-arm the chrome stubs.
    reload.mockResolvedValue(undefined)
    get.mockResolvedValue({ id: 7, url: 'https://jmail.world/messages' })
    alarmGetAll.mockResolvedValue([])
    alarmClear.mockResolvedValue(undefined)
    vi.stubGlobal('chrome', {
      tabs: { get, reload },
      // Recovery reloads are scheduled as DURABLE alarms (finding: "Reload
      // test leaves retry timers running") — no setTimeout chains to leak
      // into later tests; the stub records the scheduling instead.
      alarms: { create: alarmCreate, getAll: alarmGetAll, clear: alarmClear },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([entry()])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[entry()], { userMountComplete: true }])
    vi.mocked(setBuiltinConfig).mockResolvedValue(undefined)
    vi.mocked(readBuiltinConfig).mockResolvedValue({ activation: 'enabled' })
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

  it('rejects enable WITHOUT a consent token in strict mode (legacy path closed)', async () => {
    setConsentTokenEnforcementForTests('strict')
    try {
      const respond = vi.fn()
      const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
      await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive' }, respond)
      expect(setBuiltinConfig).not.toHaveBeenCalled()
      expect(reload).not.toHaveBeenCalled()
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
    } finally {
      setConsentTokenEnforcementForTests(null)
    }
  })

  it('accepts a tokenless enable via the LEGACY grace path and logs a warn (old extension compat)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const respond = vi.fn()
      const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
      await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive' }, respond)
      expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
      expect(reload).toHaveBeenCalledWith(7)
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, reloaded: true }))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain('[PackageOptIn] legacy enable (no consent token)')
      // The observability payload carries what migration stats need.
      const context = warn.mock.calls[0][1] as { packageId: string; timestamp: string; userAgent: string }
      expect(context.packageId).toBe('world.jmail.archive')
      expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(context.userAgent.length).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('STILL rejects a WRONG token in grace mode (present-but-bad token is tampering, not legacy)', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle(
      { type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: 'forged' },
      respond,
    )
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
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

  it('reports the package-WIDE tool count (multi-origin consent disclosure)', async () => {
    // Two tools match the tab URL, but the package ships a third tool for
    // another origin — enabling activates it too, so consent must disclose it.
    const multiOrigin = entry({
      package: {
        manifest: {
          id: 'world.jmail.archive',
          version: '2.0.0',
          description: 'Archive email tools.',
          tools: [
            { name: 'read_page', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'workflows/read_page.js' },
            { name: 'search_emails', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'workflows/search_emails.js' },
            { name: 'creator_stats', description: '', urlRegex: '^https://creator\\.jmail\\.world/.*$', path: 'workflows/read_page.js' },
          ],
        },
        sources: {
          'workflows/read_page.js': READ_ONLY_SOURCE,
          'workflows/search_emails.js': WRITE_SOURCE,
        },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([multiOrigin])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const body = respond.mock.calls[0][0] as { package: { tools: unknown[] }; totalTools: number }
    expect(body.package.tools).toHaveLength(2) // only the tab-matching tools listed
    expect(body.totalTools).toBe(3) // but the consent discloses the package-wide count
  })

  it('reports ENABLE_REVERTED when a concurrent disable undid the enable write', async () => {
    const { token } = await mintToken()
    // The verification read is SEQUENCED (finding: "Concurrent-disable test
    // accepts failed writes"): the first read proves the enable write
    // committed (a broken write would still read disabled and make this test
    // vacuous), later reads observe the concurrent disable winning.
    vi.mocked(readBuiltinConfig)
      .mockResolvedValueOnce({ activation: 'enabled' })
      .mockResolvedValue({ activation: 'disabled' })
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
    // The enable write carried the enabled activation — not just any write.
    expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
    // The reload happens BEFORE the final verification (finding: "Disabled
    // package reported enabled") so a disable racing the enable can never be
    // carried to the page unobserved; the verification then reports honestly.
    expect(reload).toHaveBeenCalledWith(7)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'ENABLE_REVERTED' }))
  })

  it('offers only DISABLED alternatives, each with its own package-bound consent token', async () => {
    const enabledSibling = entry({
      directory: 'com.douban.movie',
      activation: 'enabled',
      package: {
        manifest: {
          id: 'com.douban.movie',
          version: '1.0.0',
          description: 'Movie tools (already enabled).',
          tools: [{ name: 'list_movies', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'a.js' }],
        },
        sources: { 'a.js': READ_ONLY_SOURCE },
      },
    })
    const disabledSibling = entry({
      directory: 'com.douban.search',
      package: {
        manifest: {
          id: 'com.douban.search',
          version: '1.0.0',
          description: 'Douban search tools.',
          tools: [{ name: 'search_douban', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'a.js' }],
        },
        sources: { 'a.js': READ_ONLY_SOURCE },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([entry(), enabledSibling, disabledSibling])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([
      [entry(), enabledSibling, disabledSibling],
      { userMountComplete: true },
    ])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const body = respond.mock.calls[0][0] as {
      alternatives: Array<{ id: string; activation: string; consentToken?: string }>
    }
    // The enabled sibling must NOT be offered as an alternative (finding:
    // "Enabled sibling gets an opt-in prompt").
    expect(body.alternatives.map(item => item.id)).toEqual(['com.douban.search'])
    // …and each offered sibling carries a token bound to ITS OWN package id
    // (findings: "Sibling consent cannot complete" / "Sibling opt-in is
    // rejected").
    expect(typeof body.alternatives[0].consentToken).toBe('string')
    expect(body.alternatives[0].consentToken).not.toBe('')
  })

  it('enables a SIBLING candidate (not just the best candidate) when its own token is presented', async () => {
    const sibling = entry({
      directory: 'com.douban.search',
      package: {
        manifest: {
          id: 'com.douban.search',
          version: '1.0.0',
          description: 'Douban search tools.',
          tools: [{ name: 'search_douban', description: '', urlRegex: '^https://jmail\\.world/.*$', path: 'a.js' }],
        },
        sources: { 'a.js': READ_ONLY_SOURCE },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([entry(), sibling])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[entry(), sibling], { userMountComplete: true }])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const body = respond.mock.calls[0][0] as {
      package: { id: string }
      alternatives: Array<{ id: string; consentToken?: string }>
    }
    expect(body.package.id).toBe('world.jmail.archive') // primary wins the status probe
    const siblingToken = body.alternatives.find(item => item.id === 'com.douban.search')!.consentToken!
    await new Promise(resolve => setTimeout(resolve, CONSENT_TOKEN_MIN_AGE_MS + 50))

    const respond2 = vi.fn()
    await handle(
      { type: 'webmcp_package_optin_enable', packageId: 'com.douban.search', consentToken: siblingToken },
      respond2,
    )
    expect(setBuiltinConfig).toHaveBeenCalledWith('com.douban.search', { activation: 'enabled' })
    expect(reload).toHaveBeenCalledWith(7)
    expect(respond2).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it('refuses to enable from an INCOMPLETE catalog (user mount could not be listed)', async () => {
    const { token } = await mintToken()
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[entry()], { userMountComplete: false }])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'PACKAGE_CONFLICT' }))
  })

  it('rejects a package id that does not match the consent-bound package', async () => {
    const { token } = await mintToken()
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    // The token was minted for world.jmail.archive; presenting it for a
    // different package fails the token's package binding (finding: "Consent
    // transfers across packages") before any candidate matching happens.
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.douban.movie', consentToken: token }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'CONSENT_REQUIRED' }))
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

  it('still answers ok when the reload fails, and schedules a DURABLE recovery alarm (no setTimeout chain)', async () => {
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
      // The retry must survive service-worker suspension: a chrome.alarms
      // entry (durable), not an in-worker setTimeout chain that dies with
      // the worker (finding: "Recovery reload is lost" / "Reload test leaves
      // retry timers running" — a real-timer chain here would keep retrying
      // for 60s into later tests).
      expect(alarmCreate).toHaveBeenCalledTimes(1)
      expect(String(alarmCreate.mock.calls[0][0])).toContain('webmcp-optin-recovery:7:')
    } finally {
      warn.mockRestore()
    }
  })

  it('reports VERIFY_INCOMPLETE (not ENABLE_FAILED) when the post-write verification read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { token } = await mintToken()
      // The write and reload SUCCEED; only the verification read fails
      // (finding: "Enabled package reported failed" — ENABLE_FAILED here
      // would record a 1-day cooldown while the package is actually on).
      vi.mocked(readBuiltinConfig).mockRejectedValue(new Error('storage unavailable'))
      const respond = vi.fn()
      const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
      await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive', consentToken: token }, respond)
      expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
      expect(reload).toHaveBeenCalledWith(7)
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'VERIFY_INCOMPLETE' }))
    } finally {
      warn.mockRestore()
    }
  })
})
