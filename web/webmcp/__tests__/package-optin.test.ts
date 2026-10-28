import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findPackageOptInCandidate, toolIsReadOnly } from '../../../browser-extension/entrypoints/webmcp/package-optin'
import { createPackageOptInHandler } from '../../../browser-extension/entrypoints/webmcp/package-optin-handler'
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

  it('reports the matching package and its disabled activation', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      applicable: true,
      enabled: false,
      package: expect.objectContaining({ id: 'world.jmail.archive' }),
    }))
  })

  it('refuses the probe when the binding does not resolve', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => null })
    await handle({ type: 'webmcp_package_optin_status' }, respond)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'UNAUTHORIZED_TARGET' }))
  })

  it('enables the package and reloads the bound tab', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'world.jmail.archive' }, respond)
    expect(setBuiltinConfig).toHaveBeenCalledWith('world.jmail.archive', { activation: 'enabled' })
    expect(reload).toHaveBeenCalledWith(7)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, reloaded: true }))
  })

  it('rejects a package id that does not match the bound tab url', async () => {
    const respond = vi.fn()
    const handle = createPackageOptInHandler({ resolveBoundTab: async () => 7 })
    await handle({ type: 'webmcp_package_optin_enable', packageId: 'com.douban.movie' }, respond)
    expect(setBuiltinConfig).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: 'PACKAGE_MISMATCH' }))
  })
})
