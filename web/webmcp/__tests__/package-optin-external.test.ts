import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPackageOptInCandidate } from '../../../browser-extension/entrypoints/webmcp/package-optin'
import {
  createPackageOptInHandler,
  CONSENT_TOKEN_MIN_AGE_MS,
} from '../../../browser-extension/entrypoints/webmcp/package-optin-handler'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
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

// The user mount (`getAdapterStorage`) is real OPFS in production; tests back
// it with a deterministic in-memory provider behind the same lazy-singleton
// seam so the enable write for EXTERNAL packages is exercised end to end.
let userStorage = memoryProvider()
vi.mock('../../../browser-extension/entrypoints/webmcp/provider-storage', () => ({
  getAdapterStorage: () => Promise.resolve(userStorage),
}))

import { readWebMCPCatalog, readWebMCPCatalogDetailed } from '../../../browser-extension/entrypoints/webmcp/package-repository'

const READ_ONLY_SOURCE = 'export default { inputSchema: {}, outputSchema: {}, tree: { type: "action", run: async () => { const t = await browser.eval("() => document.title"); return t; } }, result: () => ({}) }'

const DISCORD_MANIFEST = {
  id: 'com.discord.main',
  version: '0.1.0',
  description: 'Discord tools.',
  tools: [
    { name: 'read_messages', description: 'Read messages.', urlRegex: '^https://discord\\.com/.*$', path: 'workflows/read_messages.js' },
  ],
}

/** A registry-installed package living on the custom `webmcp` mount. */
function externalEntry(overrides: Partial<WebMCPPackageEntry> = {}): WebMCPPackageEntry {
  return {
    directory: 'com.discord.main',
    mount: 'webmcp',
    uri: 'vfs://external/webmcp/com.discord.main/',
    access: 'read-write',
    config: {},
    activation: 'disabled',
    diagnostics: [],
    package: {
      manifest: DISCORD_MANIFEST,
      sources: { 'workflows/read_messages.js': READ_ONLY_SOURCE },
    },
    ...overrides,
  }
}

describe('opt-in candidates — external packages (issue #117 Tier 1)', () => {
  it('matches an installed external package by tool urlRegex', () => {
    const candidate = findPackageOptInCandidate([externalEntry()], 'https://discord.com/channels/1/2')
    expect(candidate).not.toBeNull()
    expect(candidate?.id).toBe('com.discord.main')
    expect(candidate?.mount).toBe('webmcp')
    expect(candidate?.activation).toBe('disabled')
    expect(candidate?.tools.map(tool => tool.name)).toEqual(['read_messages'])
  })

  it('labels an external read-only tool as read-only', () => {
    const candidate = findPackageOptInCandidate([externalEntry()], 'https://discord.com/')
    expect(candidate?.tools[0].readOnly).toBe(true)
  })

  it('still prefers a disabled package over an enabled one across mounts', () => {
    const builtinEnabled = externalEntry({
      directory: 'com.builtin.enabled',
      mount: 'builtin-webmcp',
      activation: 'enabled',
      package: {
        manifest: { ...DISCORD_MANIFEST, id: 'com.builtin.enabled', tools: DISCORD_MANIFEST.tools },
        sources: { 'workflows/read_messages.js': READ_ONLY_SOURCE },
      },
    })
    const candidate = findPackageOptInCandidate([builtinEnabled, externalEntry()], 'https://discord.com/')
    expect(candidate?.id).toBe('com.discord.main')
    expect(candidate?.activation).toBe('disabled')
  })

  it('never offers an external package with blocking diagnostics', () => {
    const broken = externalEntry({ diagnostics: ['Invalid manifest'] })
    expect(findPackageOptInCandidate([broken], 'https://discord.com/')).toBeNull()
  })
})

describe('opt-in handler — external package on-site enable (issue #117 Tier 1)', () => {
  const reload = vi.fn()
  const get = vi.fn()

  const enablePath = 'com.discord.main/config.json'

  /** Seed the user mount with the package the catalog reports as installed. */
  async function seedInstalledPackage(provider: ReturnType<typeof memoryProvider>): Promise<void> {
    await provider.mkdir('com.discord.main', { recursive: true })
    await provider.writeFile('com.discord.main/manifest.json', new TextEncoder().encode(JSON.stringify(DISCORD_MANIFEST)))
    await provider.writeFile(enablePath, new TextEncoder().encode(JSON.stringify({ activation: 'disabled' })))
  }

  beforeEach(() => {
    vi.resetAllMocks()
    userStorage = memoryProvider()
    reload.mockResolvedValue(undefined)
    get.mockResolvedValue({ id: 7, url: 'https://discord.com/channels/1/2' })
    vi.stubGlobal('chrome', {
      tabs: { get, reload },
      alarms: { create: vi.fn(), getAll: vi.fn(async () => []), clear: vi.fn() },
      // The user-mount enable bounces a sentinel through storage.local so the
      // adapter background's onChanged listener refreshes the catalog.
      // storage.local backs the cross-context package lease (the enable
      // path now holds the lease while writing); a real map lets the lock
      // acquire/heartbeat/release cycle run for real in tests.
      storage: { local: (() => {
        const data = new Map<string, unknown>()
        return {
          get: vi.fn(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
          set: vi.fn(async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) data.set(k, v) }),
          remove: vi.fn(async (key: string) => { data.delete(key) }),
        }
      })() },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([externalEntry()])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[externalEntry()], { userMountComplete: true }])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Mint a token through the status probe, then wait out the minimum age. */
  async function mintToken(): Promise<string> {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const token = (respond.mock.calls[0][0] as { consentToken?: string }).consentToken
    expect(typeof token).toBe('string')
    await new Promise(resolve => setTimeout(resolve, CONSENT_TOKEN_MIN_AGE_MS + 50))
    return token as string
  }

  it('status probe reports an EXTERNAL disabled package with a consent token', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    const body = respond.mock.calls[0][0] as Record<string, unknown>
    expect(body).toEqual(expect.objectContaining({
      ok: true,
      applicable: true,
      enabled: false,
      package: expect.objectContaining({ id: 'com.discord.main', mount: 'webmcp' }),
    }))
    expect(typeof body.consentToken).toBe('string')
  })

  it('enable writes activation:enabled into the EXTERNAL package config on the user mount', async () => {
    // The package directory exists on the user mount (the presence
    // revalidation before the write passes).
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toEqual(expect.objectContaining({ ok: true, packageId: 'com.discord.main' }))

    // The write landed on the USER mount (the same file package-management
    // reads) — not in the builtin override storage.
    const stored = JSON.parse(new TextDecoder().decode(await userStorage.readFile(enablePath)))
    expect(stored).toEqual({ activation: 'enabled' })
    // The storage sentinel was bounced (finding: "External tools stay
    // unregistered"): the adapter background learns about the OPFS config
    // write ONLY through this chrome.storage.local handshake — a write that
    // stops sending it would leave the tools unregistered while the test
    // still passed on the config.json assertion above.
    const sentinelKey = `webmcp_user_package_config_com.discord.main`
    const setKeys = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls.map(call => Object.keys(call[0] ?? {})).flat()
    expect(setKeys).toContain(sentinelKey)
    const removeKeys = (chrome.storage.local.remove as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0])
    expect(removeKeys).toContain(sentinelKey)
  })

  it('enable verifies against the user-mount config after the write', async () => {
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    // A concurrent disable commits AFTER the enable write (e.g. the package
    // management page raced the enable): the write itself succeeds, but the
    // post-reload verification read observes the disabled config and the
    // handler must NOT report success (finding: "Verification is not
    // tested" — this test fails the moment the post-reload verification is
    // removed or skipped, because then the response is ok:true).
    const wrapped = await userStorage
    userStorage = {
      ...wrapped,
      readFile: async (path: string) => {
        const bytes = await wrapped.readFile(path)
        if (path === enablePath) return new TextEncoder().encode(JSON.stringify({ activation: 'disabled' }))
        return bytes
      },
    } as typeof wrapped
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'ENABLE_REVERTED' })
    expect(reload).toHaveBeenCalled()
  })

  it('refuses to enable when the package was UNINSTALLED after the status probe (no resurrected directory)', async () => {
    // Token minted while the package was still installed...
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    // ...then uninstall removed the directory before the enable landed.
    await userStorage.remove('com.discord.main', { recursive: true })
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'PACKAGE_UNINSTALLED' })
    // The activation write never happened — the provider would have
    // recreated the directory for config.json (finding: "Uninstall races
    // can recreate packages").
    await expect(userStorage.stat('com.discord.main')).rejects.toThrow()
  })

  it('rejects the enable when the package was REPLACED under the same id after the status probe (stale consent)', async () => {
    // High finding: "Stale consent enables replaced tools" — the consent
    // token is bound to the FINGERPRINT (manifest version + tool manifest)
    // of the package the user saw, not just its id.
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    // A different package is installed under the SAME id before the user
    // confirms: new version, different tool.
    const replacedManifest = {
      ...DISCORD_MANIFEST,
      version: '9.9.9',
      tools: [
        { name: 'send_messages', description: 'Send messages.', urlRegex: '^https://discord\\.com/.*$', path: 'workflows/send_messages.js' },
      ],
    }
    const replacedEntry = externalEntry({
      package: {
        manifest: replacedManifest,
        sources: { 'workflows/send_messages.js': READ_ONLY_SOURCE },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([replacedEntry])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[replacedEntry], { userMountComplete: true }])
    await userStorage.writeFile(
      'com.discord.main/manifest.json',
      new TextEncoder().encode(JSON.stringify(replacedManifest)),
    )

    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'CONSENT_REQUIRED' })
    // The stale consent never reached the config: the package is still
    // disabled and the replacement's tools stay off.
    const stored = JSON.parse(new TextDecoder().decode(await userStorage.readFile(enablePath)))
    expect(stored).toEqual({ activation: 'disabled' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('rejects a token bound to a package whose SOURCE changed (fingerprint covers workflow bytes)', async () => {
    // Finding: "Changed packages reuse old consent" — the fingerprint is
    // bound to more than manifest version + tool names/paths: the ACTUAL
    // source bytes and the urlRegex rules. A repackage with the same
    // version/names but a changed workflow source must not reuse consent.
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    const swappedSource = externalEntry({
      package: {
        manifest: DISCORD_MANIFEST,
        sources: { 'workflows/read_messages.js': `${READ_ONLY_SOURCE} // tampered` },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([swappedSource])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[swappedSource], { userMountComplete: true }])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'CONSENT_REQUIRED' })
    // The stale consent never reached the config: the package is still
    // disabled and the tampered source's tools stay off.
    const stored = JSON.parse(new TextDecoder().decode(await userStorage.readFile(enablePath)))
    expect(stored).toEqual({ activation: 'disabled' })
  })

  it('rejects the enable when the package was REPLACED between the fingerprint check and the write', async () => {
    // Finding: "Replacement receives old consent" — a fresh catalog read
    // right before the activation write recomputes the fingerprint; a
    // replacement installed after the main check must not receive the old
    // consent (PACKAGE_MISMATCH), and nothing is written.
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    const replacedManifest = {
      ...DISCORD_MANIFEST,
      version: '9.9.9',
    }
    const replacedEntry = externalEntry({
      package: {
        manifest: replacedManifest,
        sources: { 'workflows/read_messages.js': READ_ONLY_SOURCE },
      },
    })
    // The FIRST detailed read (token check) still sees the original; the
    // SECOND (pre-write re-check) sees the replacement.
    vi.mocked(readWebMCPCatalogDetailed)
      .mockResolvedValueOnce([[externalEntry()], { userMountComplete: true }])
      .mockResolvedValueOnce([[replacedEntry], { userMountComplete: true }])
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'PACKAGE_MISMATCH' })
    // The stale consent never reached the config.
    const stored = JSON.parse(new TextDecoder().decode(await userStorage.readFile(enablePath)))
    expect(stored).toEqual({ activation: 'disabled' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('cleans up an orphaned config.json when an uninstall removes the directory during the enable write', async () => {
    // Finding: "Uninstall leaves a phantom package" — the provider recreates
    // missing parents for config.json, so a write racing an uninstall must
    // roll the orphaned file back instead of leaving a directory holding
    // ONLY activation state.
    await seedInstalledPackage(userStorage)
    const token = await mintToken()
    // The manifest exists for the call-site's presence stat and the write
    // path's pre-write stat, but is GONE for the post-write re-stat — as if
    // an uninstall removed the directory right after our config.json write.
    const wrapped = await userStorage
    let manifestStats = 0
    userStorage = {
      ...wrapped,
      stat: async (path: string) => {
        if (path === 'com.discord.main/manifest.json') {
          manifestStats += 1
          if (manifestStats >= 3) {
            const err = new Error('not found')
            ;(err as { code?: string }).code = 'ENOENT'
            throw err
          }
        }
        return wrapped.stat(path)
      },
    } as typeof wrapped
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'PACKAGE_UNINSTALLED' })
    // The orphaned config.json was removed — no phantom package remains.
    await expect(userStorage.readFile(enablePath)).rejects.toThrow()
    // The sentinel bounce never fired (the write did not stick). The
    // cross-context lock legitimately writes its own lease keys through
    // storage.local — only the SENTINEL must stay absent.
    const sentinelWrites = (chrome.storage.local.set as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => Object.keys(call[0] ?? {}).some(k => k.startsWith('webmcp_user_package_config_')))
    expect(sentinelWrites).toEqual([])
  })

  it('rejects a consent token minted for ANOTHER package (protocol identical across mounts)', async () => {
    const other = externalEntry({
      directory: 'com.other.pkg',
      package: {
        manifest: { ...DISCORD_MANIFEST, id: 'com.other.pkg' },
        sources: { 'workflows/read_messages.js': READ_ONLY_SOURCE },
      },
    })
    vi.mocked(readWebMCPCatalog).mockResolvedValue([externalEntry(), other])
    vi.mocked(readWebMCPCatalogDetailed).mockResolvedValue([[externalEntry(), other], { userMountComplete: true }])

    const respond0 = vi.fn()
    const handle0 = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle0({ type: 'webmcp_package_optin_status' }, respond0)
    const token = (respond0.mock.calls[0][0] as { consentToken?: string }).consentToken as string
    await new Promise(resolve => setTimeout(resolve, CONSENT_TOKEN_MIN_AGE_MS + 50))

    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    // Token was minted for com.discord.main; using it for com.other.pkg fails.
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.other.pkg', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'CONSENT_REQUIRED' })
  })

  it('rejects the enable when the external package no longer matches the tab URL', async () => {
    const token = await mintToken()
    // The tab navigated away from the package's supported site.
    get.mockResolvedValue({ id: 7, url: 'https://example.com/other' })
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main', consentToken: token }, respond)
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'PACKAGE_MISMATCH' })
  })

  it('REFUSES a tokenless enable of an EXTERNAL package even in grace mode (round 3)', async () => {
    // Round-3 finding "External activation skips consent": the tokenless
    // grace path is a compat shim for pre-token BUILTIN clients — external
    // packages never had a legacy caller, so a page must not be able to
    // activate its own installed package without a consent token.
    await seedInstalledPackage(userStorage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const respond = vi.fn()
      const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
      await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.discord.main' }, respond)
      expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, errorCode: 'CONSENT_REQUIRED' })
      // Nothing was written and the tab was not reloaded.
      const stored = JSON.parse(new TextDecoder().decode(await userStorage.readFile(enablePath)))
      expect(stored).toEqual({ activation: 'disabled' })
      expect(reload).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
