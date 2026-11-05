import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Settings-section behaviour for the WebMCP package registry installer
 * (issue #117 Tier 1). Covers the states the registry card must render:
 *   - the tool count comes from the package's OWN manifest (verified), not
 *     from the registry's claim;
 *   - an ENABLED package is labelled active, not inactive;
 *   - a late installed-id refresh never overwrites a newer one.
 */

const store = vi.hoisted(() => ({
  listRegistries: vi.fn(() => [] as unknown[]),
  listInstalledPackageIds: vi.fn(async () => new Set<string>()),
  readInstalledPackageActivation: vi.fn(async (_id: string) => 'disabled' as 'enabled' | 'disabled'),
  loadRegistryCatalog: vi.fn(async () => ({ packages: [] as unknown[] })),
  addRegistry: vi.fn(),
  removeRegistry: vi.fn(),
  installRegistryPackage: vi.fn(async () => ({ filesWritten: 1 })),
  uninstallRegistryPackage: vi.fn(async () => undefined),
}))

vi.mock('@/webmcp/package-registry-store', () => store)

import { WebMCPPackageRegistrySection } from '@/components/webmcp/WebMCPPackageRegistrySection'

const REGISTRY = {
  rawBase: 'https://raw.githubusercontent.com/owner/repo/main',
  manifestUrl: 'https://raw.githubusercontent.com/owner/repo/main/manifest.json',
  label: 'owner/repo',
}

const PKG = {
  id: 'com.example.pkg',
  version: '1.0.0',
  description: 'Example package.',
  // The registry CLAIMS two tools; the package manifest actually has one.
  toolCount: 2,
  files: [],
}

/**
 * t() renders the key so assertions can look for stable markers. The tool
 * count key keeps its `{count}` placeholder so the rendered count (the
 * VERIFIED manifest count) is visible in the text.
 */
const t = (key: string) => (key === 'settings.webmcpPackages.toolsCount' ? '{count} tools' : key)

/** Serve the package manifest.json (with `toolCount` tools) to the section. */
function serveManifest(toolCount = 1) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: PKG.id,
      version: PKG.version,
      description: PKG.description,
      tools: Array.from({ length: toolCount }, (_, i) => ({
        name: `tool_${i}`, description: `Tool ${i}`, urlRegex: '^https://example\\.com/.*$', path: `t${i}.js`,
      })),
    }),
  })))
}

beforeEach(() => {
  vi.resetAllMocks()
  store.listRegistries.mockReturnValue([REGISTRY])
  store.listInstalledPackageIds.mockResolvedValue(new Set())
  store.readInstalledPackageActivation.mockResolvedValue('disabled')
  store.loadRegistryCatalog.mockResolvedValue({ packages: [PKG] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebMCPPackageRegistrySection', () => {
  it('shows the VERIFIED tool count from the package manifest, not the registry claim', async () => {
    serveManifest(1)
    render(<WebMCPPackageRegistrySection t={t} />)

    await waitFor(() => expect(screen.getByText('com.example.pkg')).toBeTruthy())
    // The registry claims 2 tools; the package manifest has exactly 1.
    await waitFor(() => expect(screen.getByText(/1 tools/)).toBeTruthy())
    expect(screen.queryByText(/2 tools/)).toBeNull()
  })

  it('labels an ENABLED installed package as active and drops the enable hint', async () => {
    serveManifest(1)
    store.listInstalledPackageIds.mockResolvedValue(new Set([PKG.id]))
    store.readInstalledPackageActivation.mockResolvedValue('enabled')
    render(<WebMCPPackageRegistrySection t={t} />)

    // The badge appears in BOTH the registry card and the installed-packages
    // inventory (which lists installed packages independently of any
    // registry), so match all occurrences.
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.installedActive').length).toBeGreaterThan(0))
    expect(screen.queryByText('settings.webmcpPackages.installedInactive')).toBeNull()
    expect(screen.queryByText('settings.webmcpPackages.installedInactiveHint')).toBeNull()
  })

  it('labels a DISABLED installed package as inactive and keeps the enable hint', async () => {
    serveManifest(1)
    store.listInstalledPackageIds.mockResolvedValue(new Set([PKG.id]))
    store.readInstalledPackageActivation.mockResolvedValue('disabled')
    render(<WebMCPPackageRegistrySection t={t} />)

    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.installedInactive').length).toBeGreaterThan(0))
    expect(screen.getByText('settings.webmcpPackages.installedInactiveHint')).toBeTruthy()
    expect(screen.queryByText('settings.webmcpPackages.installedActive')).toBeNull()
  })

  it('ignores a STALE installed-id refresh that resolves after a newer one', async () => {
    serveManifest(1)
    // The FIRST read (mount effect) resolves LAST with the OLD (empty) set;
    // the SECOND read (triggered by the install below) resolves first with
    // the new set. The stale result must be dropped, otherwise the package
    // would appear uninstalled and could be installed again.
    let resolveFirst: (value: Set<string>) => void = () => {}
    let call = 0
    store.listInstalledPackageIds.mockImplementation(() => {
      call += 1
      if (call === 1) {
        return new Promise<Set<string>>(resolve => { resolveFirst = resolve })
      }
      return Promise.resolve(new Set([PKG.id]))
    })
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByText('com.example.pkg')).toBeTruthy())

    // Install the package — this triggers the SECOND (newer) refresh.
    fireEvent.click(screen.getByText('settings.webmcpPackages.install'))
    await waitFor(() => expect(screen.getByText('settings.webmcpPackages.confirmInstallConfirm')).toBeTruthy())
    fireEvent.click(screen.getByText('settings.webmcpPackages.confirmInstallConfirm'))

    // The newer read landed: the package is shown as installed (the badge
    // appears in both the registry card and the installed-packages
    // inventory).
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.installedInactive').length).toBeGreaterThan(0))
    // The stale read finishes now — it must NOT wipe the installed state.
    resolveFirst(new Set())
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(screen.getAllByText('settings.webmcpPackages.installedInactive').length).toBeGreaterThan(0)
  })

  it('shows the count as UNVERIFIED and drops the claim when the preview FAILS (round 3)', async () => {
    // Finding: "Failed preview shows claimed count" — a failing preview
    // (HTTP error) must not leave the registry's claim displayed as if it
    // were verified: the card marks the count unverified and the install
    // confirmation says the count could not be verified.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    render(<WebMCPPackageRegistrySection t={t} />)

    await waitFor(() => expect(screen.getByText('com.example.pkg')).toBeTruthy())
    // The registry's claim is still shown (it is the only number available)
    // but is explicitly marked unverified — for THIS package the preview
    // failed, so the marker must appear.
    await waitFor(() => expect(screen.getByText(/toolsCountUnverified/)).toBeTruthy())
    // Install opens the confirmation, which must NOT present the claim as
    // a verified count.
    fireEvent.click(screen.getByText('settings.webmcpPackages.install'))
    await waitFor(() => expect(screen.getByText('settings.webmcpPackages.confirmInstallBodyUnverified')).toBeTruthy())
    expect(screen.queryByText(/confirmInstallBody\)/)).toBeNull()
  })

  it('keeps uninstall reachable for installed packages AFTER the registry is removed (round 3)', async () => {
    // Finding: "Removing registry hides uninstall action" — the installed-
    // packages inventory lists packages from the MOUNT, independent of any
    // registry, so removing the registry cannot strand its installed
    // packages without an uninstall button.
    serveManifest(1)
    store.listInstalledPackageIds.mockResolvedValue(new Set([PKG.id]))
    // removeRegistry must actually drop the registry from the catalog list —
    // the real store does, and the inventory below must survive it.
    store.removeRegistry.mockImplementation(() => store.listRegistries.mockReturnValue([]))
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.installedInactive').length).toBeGreaterThan(0))

    // Remove the registry: the catalog cards disappear, but the inventory
    // (rendered from the mount, not the catalog) keeps its uninstall action.
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.removeRegistry'))
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.uninstall').length).toBe(1))
    // The uninstall button in the inventory remains and works.
    const uninstallButtons = screen.getAllByText('settings.webmcpPackages.uninstall')
    expect(uninstallButtons.length).toBeGreaterThan(0)
    fireEvent.click(uninstallButtons[0]!)
    await waitFor(() => expect(store.uninstallRegistryPackage).toHaveBeenCalledWith(PKG.id))
  })

  it('drops a cached tool count whose version no longer matches the refreshed catalog (round 3)', async () => {
    // Finding: "Refresh shows stale tool count" — a count verified for an
    // older catalog version must not survive a version bump: between the
    // refresh and the new preview, the card shows the count as unverified
    // instead of the stale number.
    serveManifest(3)
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByText('3 tools')).toBeTruthy())

    // The registry publishes a new catalog version for the same package.
    store.loadRegistryCatalog.mockResolvedValue({ packages: [{ ...PKG, version: '2.0.0' }] })
    // The next preview (for the new version) has not resolved yet — the
    // stale 3-tools count must not be presented as verified.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.refresh'))
    await waitFor(() => expect(screen.getByText(/toolsCountUnverified/)).toBeTruthy())
    expect(screen.queryByText(/3 tools/)).toBeNull()
  })
})

/**
 * Round-6 Sourcery findings on the #187 registry-search feature. Shared
 * helpers: a fetch stub that serves per-URL manifest bodies (real-shaped:
 * read through `response.text()` + JSON.parse, with id/version identity
 * fields), and gated promises for out-of-order previews.
 */
const REG_A = {
  rawBase: 'https://raw.githubusercontent.com/owner/repo-a/main',
  manifestUrl: 'https://raw.githubusercontent.com/owner/repo-a/main/manifest.json',
  label: 'owner/repo-a',
}
const REG_B = {
  rawBase: 'https://raw.githubusercontent.com/owner/repo-b/main',
  manifestUrl: 'https://raw.githubusercontent.com/owner/repo-b/main/manifest.json',
  label: 'owner/repo-b',
}

function manifestOf(pkgId: string, version: string, tools: Array<{ name: string; description: string }>) {
  return { id: pkgId, version, tools }
}

function gate<T>() {
  let release: (value: T) => void = () => {}
  const promise = new Promise<T>(resolve => { release = resolve })
  return { promise, release }
}

/** Serve per-rawBase manifest bodies; a handler returning null = HTTP 500. */
function stubFetchByHandler(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const body = await handler(String(input))
    if (body === null) return { ok: false, status: 500 }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }))
}

function catalogOf(registry: typeof REG_A, count: number, version: string, _toolName?: string) {
  return {
    packages: Array.from({ length: count }, (_, i) => ({
      id: `${registry.label}.pkg${i}`,
      version,
      description: `Package ${i} of ${registry.label}.`,
      toolCount: 1,
      files: [],
    })),
  }
}

function previewUrlFor(registry: typeof REG_A, pkgId: string) {
  return `${registry.rawBase}/packages/${pkgId}/manifest.json`
}

describe('WebMCPPackageRegistrySection round-6 findings', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    store.listInstalledPackageIds.mockResolvedValue(new Set())
    store.readInstalledPackageActivation.mockResolvedValue('disabled')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the FULL tool catalog once the preview is EXPANDED (High: more tools stay hidden)', async () => {
    store.listRegistries.mockReturnValue([REG_A])
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 1, '1.0.0', 'tool_0'))
    const pkgId = `${REG_A.label}.pkg0`
    const tools = Array.from({ length: 59 }, (_, i) => ({ name: `tool_${i}`, description: `Tool ${i}` }))
    stubFetchByHandler(url => (url === previewUrlFor(REG_A, pkgId) ? manifestOf(pkgId, '1.0.0', tools) : null))
    const { container } = render(<WebMCPPackageRegistrySection t={t} />)

    await waitFor(() => expect(screen.getByText(pkgId)).toBeTruthy())
    // Collapsed: the window hides everything past tool_7.
    expect(screen.queryByText('tool_58')).toBeNull()
    // Expand the card, then the tool list itself (the "More (N total)"
    // expander — the exact control the finding says loses the tail).
    fireEvent.click(container.querySelector('button[aria-expanded="false"]')!)
    const more = await waitFor(() => screen.getByText('settings.webmcpPackages.moreTools'))
    fireEvent.click(more)
    // Expanded: the whole catalog is reachable — last tool included, and no
    // second "More" expander (the window must not re-apply behind it).
    await waitFor(() => expect(screen.getByText('tool_58')).toBeTruthy())
    expect(screen.queryByText('settings.webmcpPackages.moreTools')).toBeNull()
  })

  it('keys the tool index per REGISTRY so same-id packages do not share results', async () => {
    // Round-6: "Registries share tool results" — two registries may publish
    // the same package ID with different tool lists.
    const pkgId = 'com.example.shared'
    store.listRegistries.mockReturnValue([REG_A, REG_B])
    // The search input only renders above SEARCH_MIN_PACKAGES total packages
    // — give each registry enough siblings for the filter to appear.
    const siblings = (label: string) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `${label}.filler${i}`,
        version: '1.0.0',
        description: `Filler package ${i} of ${label}.`,
        toolCount: 1,
        files: [],
      }))
    store.loadRegistryCatalog.mockImplementation((async (registry: { label: string }) => ({
      packages: [
        { id: pkgId, version: '1.0.0', description: 'Shared id.', toolCount: 1, files: [] },
        ...siblings(registry.label),
      ],
    })) as unknown as typeof store.loadRegistryCatalog)
    stubFetchByHandler(url => {
      if (url === previewUrlFor(REG_A, pkgId)) return manifestOf(pkgId, '1.0.0', [{ name: 'alpha_tool', description: 'Alpha' }])
      if (url === previewUrlFor(REG_B, pkgId)) return manifestOf(pkgId, '1.0.0', [{ name: 'beta_tool', description: 'Beta' }])
      return null
    })
    const { container } = render(<WebMCPPackageRegistrySection t={t} />)

    await waitFor(() => expect(screen.getAllByText('1 tools').length).toBe(2))
    // Search 'alpha' must match ONLY registry A's card; 'beta' only B's.
    const searchbox = screen.getByRole('searchbox')
    fireEvent.change(searchbox, { target: { value: 'alpha_tool' } })
    await waitFor(() => expect(container.textContent!.match(/com\.example\.shared/g)!.length).toBe(1))
    expect(container.textContent).toContain('settings.webmcpPackages.matchesTools')
    fireEvent.change(searchbox, { target: { value: 'beta_tool' } })
    await waitFor(() => expect(container.textContent!.match(/com\.example\.shared/g)!.length).toBe(1))
    fireEvent.change(searchbox, { target: { value: 'alpha_tool' } })
    await waitFor(() => expect(container.textContent!.match(/com\.example\.shared/g)!.length).toBe(1))
    expect(container.textContent).toContain('settings.webmcpPackages.matchesTools')
  })

  it('updates stale tool CONTENT even when the count stays the same', async () => {
    // Round-6: "Updated tools stay stale" — equal-length lists must still be
    // compared by content.
    store.listRegistries.mockReturnValue([REG_A])
    const catalog = catalogOf(REG_A, 20, '1.0.0', 'unused')
    store.loadRegistryCatalog.mockResolvedValue(catalog)
    let renamed = false
    stubFetchByHandler(url => {
      const match = url.match(/packages\/(.+)\/manifest\.json/)
      if (!match) return null
      const name = renamed ? `shared_new_${match[1]}` : `shared_old_${match[1]}`
      return manifestOf(match[1]!, '1.0.0', [{ name, description: 'Shared tool' }])
    })
    const { container } = render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeTruthy())
    // Each manifest carries exactly 1 tool → the verified count is "1 tools"
    // on all 20 cards once the preview pass finishes.
    await waitFor(() => expect(screen.getAllByText('1 tools').length).toBe(20))

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shared_old' } })
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.matchesTools').length).toBe(20))

    // Same count, same version — only the tool NAMES change.
    renamed = true
    // A fresh catalog OBJECT on refresh: the card's manifest state must
    // change identity for the preview effect to re-run (same-object resolves
    // bail out in React).
    store.loadRegistryCatalog.mockResolvedValue({
      packages: catalog.packages.map(p => ({ ...p })),
    })
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.refresh'))
    await waitFor(() => expect(screen.getAllByText('1 tools').length).toBe(20))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shared_old' } })
    // The old names are gone from the index — no card reports a tool hit.
    await waitFor(() => expect(screen.queryByText('settings.webmcpPackages.matchesTools')).toBeNull())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shared_new' } })
    await waitFor(() => expect(screen.getAllByText('settings.webmcpPackages.matchesTools').length).toBe(20))
    expect(container).toBeTruthy()
  })

  it('hides a package again once its cached tool index entry is dropped by a FAILED re-preview', async () => {
    store.listRegistries.mockReturnValue([REG_A])
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 1, '1.0.0', 'tool_0'))
    const pkgId = `${REG_A.label}.pkg0`
    stubFetchByHandler(url => (url === previewUrlFor(REG_A, pkgId)
      ? manifestOf(pkgId, '1.0.0', [{ name: 'tool_0', description: 'Tool zero' }])
      : null))
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByText('1 tools')).toBeTruthy())

    // Expand: the index entry is live, tool_0 renders from the cache.
    fireEvent.click(screen.getByRole('button', { name: '' }))
    await waitFor(() => expect(screen.getByText('tool_0')).toBeTruthy())

    // The re-preview after refresh fails → the index entry must be dropped
    // (round-6: "Removed tool lists consume memory"), so the expanded
    // preview falls back to its own fetch, which fails too → empty.
    stubFetchByHandler(() => null)
    // A fresh catalog OBJECT for the refresh (identity change re-runs the
    // preview pass — same-object resolves bail out in React).
    store.loadRegistryCatalog.mockResolvedValue({
      packages: [{ id: pkgId, version: '1.0.0', description: 'D.', toolCount: 1, files: [] }],
    })
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.refresh'))
    // The count flips to the UNVERIFIED claim (marked as such) once the
    // re-preview has failed.
    await waitFor(() => expect(screen.getByText(/toolsCountUnverified/)).toBeTruthy())
    // And the cached tool list is gone from the index — the expanded preview
    // no longer renders the stale tool_0.
    await waitFor(() => expect(screen.queryByText('tool_0')).toBeNull())
  })

  it('recomputes totals and clears the filter when a registry removal hides the search input', async () => {
    // Round-6: "Removed catalogs inflate totals" + "Hidden search keeps
    // filtering" — removal must forget the count, and the hidden input must
    // not keep an invisible filter applied.
    store.listRegistries.mockReturnValue([REG_A])
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 20, '1.0.0', 'tool_0'))
    stubFetchByHandler(url => {
      const match = url.match(/packages\/(.+)\/manifest\.json/)
      return match ? manifestOf(match[1]!, '1.0.0', [{ name: 'tool_0', description: 'Tool zero' }]) : null
    })
    store.removeRegistry.mockImplementation(() => store.listRegistries.mockReturnValue([]))
    const { container } = render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'owner/repo-a.pkg15' } })
    await waitFor(() => expect(screen.queryByText('owner/repo-a.pkg0')).toBeNull())

    fireEvent.click(screen.getByTitle('settings.webmcpPackages.removeRegistry'))
    // Input gone with only 0 packages left…
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull())
    // …and the filter was cleared WITH it: with no registries there are no
    // cards, but the totals must not stay inflated either — the inventory
    // path below proves the section still renders sanely. Re-add a small
    // catalog: if the stale count (20) were retained, the input would
    // reappear for a 1-package catalog.
    store.listRegistries.mockReturnValue([REG_A])
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 1, '1.0.0', 'tool_0'))
    fireEvent.click(screen.getByText('settings.webmcpPackages.addRegistryTitle'))
    fireEvent.change(screen.getByPlaceholderText('settings.webmcpPackages.addRegistryInputPlaceholder'), { target: { value: REG_A.manifestUrl } })
    fireEvent.click(screen.getByText('settings.webmcpPackages.addRegistryButton'))
    await waitFor(() => expect(screen.getByText('owner/repo-a.pkg0')).toBeTruthy())
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(container.textContent).toContain('owner/repo-a.pkg0')
  })

  it('keeps a search visible-clearable filter and drops it when the catalog shrinks', async () => {
    // Round-6: "Hidden search keeps filtering" — catalog shrink below the
    // threshold hides the input; the active query must go with it.
    store.listRegistries.mockReturnValue([REG_A])
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 20, '1.0.0', 'tool_0'))
    stubFetchByHandler(url => {
      const match = url.match(/packages\/(.+)\/manifest\.json/)
      return match ? manifestOf(match[1]!, '1.0.0', [{ name: 'tool_0', description: 'Tool zero' }]) : null
    })
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeTruthy())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'owner/repo-a.pkg15' } })
    await waitFor(() => expect(screen.queryByText('owner/repo-a.pkg0')).toBeNull())

    // Refresh against a shrunken catalog (3 packages, same versions).
    store.loadRegistryCatalog.mockResolvedValue(catalogOf(REG_A, 3, '1.0.0', 'tool_0'))
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.refresh'))
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull())
    // Filter cleared: the previously hidden pkg0 is visible again.
    await waitFor(() => expect(screen.getByText('owner/repo-a.pkg0')).toBeTruthy())
    expect(screen.getByText('owner/repo-a.pkg2')).toBeTruthy()
  })

  it('drops a STALE preview response that resolves after a newer catalog load', async () => {
    // Round-6: "Older previews overwrite current tools" — the generation
    // guard must keep an older generation's late response out of the index.
    store.listRegistries.mockReturnValue([REG_A])
    const catalogV1 = catalogOf(REG_A, 20, '1.0.0', 'tool_0')
    store.loadRegistryCatalog.mockResolvedValue(catalogV1)
    const stale = gate<{ id: string; version: string; tools: Array<{ name: string; description: string }> }>()
    const pkg0 = `${REG_A.label}.pkg0`
    let refreshed = false
    stubFetchByHandler(url => {
      const match = url.match(/packages\/(.+)\/manifest\.json/)
      if (!match) return null
      if (match[1] === pkg0 && !refreshed) return stale.promise
      if (match[1] === pkg0 && refreshed) {
        return manifestOf(pkg0, '2.0.0', [{ name: 'fresh_tool', description: 'Fresh tool' }])
      }
      return manifestOf(match[1]!, '1.0.0', [{ name: `tool_${match[1]}`, description: 'Tool' }])
    })
    render(<WebMCPPackageRegistrySection t={t} />)
    await waitFor(() => expect(screen.getByRole('searchbox')).toBeTruthy())

    // Refresh: catalog v2 for pkg0 (only its version changes). The new
    // preview (fresh generation) resolves quickly; the OLD generation's
    // preview for pkg0 is still parked on the gate.
    refreshed = true
    const catalogV2 = {
      packages: catalogV1.packages.map((p, i) => (i === 0 ? { ...p, version: '2.0.0' } : p)),
    }
    store.loadRegistryCatalog.mockResolvedValue(catalogV2)
    fireEvent.click(screen.getByTitle('settings.webmcpPackages.refresh'))
    // The refresh re-ran the preview pass: pkg0's version bump drops its
    // verified count (verified for 1.0.0) — the OTHER 19 stay verified while
    // pkg0's second preview is in flight.
    await waitFor(() => expect(screen.getAllByText('1 tools').length).toBe(19))
    // Release the stale response AFTER the fresh generation landed.
    stale.release(manifestOf(pkg0, '1.0.0', [{ name: 'stale_tool', description: 'Stale tool' }]))
    await new Promise(resolve => setTimeout(resolve, 50))

    // The fresh tool is searchable; the stale tool must NOT match.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fresh_tool' } })
    await waitFor(() => expect(screen.getByText('settings.webmcpPackages.matchesTools')).toBeTruthy())
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'stale_tool' } })
    await waitFor(() => expect(screen.queryByText('settings.webmcpPackages.matchesTools')).toBeNull())
  })
})
