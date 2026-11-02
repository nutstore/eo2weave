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
