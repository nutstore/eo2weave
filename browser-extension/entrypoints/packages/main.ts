/**
 * Merged WebMCP packages page (issue #193).
 *
 * One page, three source sections: built-in (read-only mount), registry
 * (install records / catalogs), mine (rw mount without an install record).
 * The data loads run INDEPENDENTLY: a failing source renders only its own
 * section's error — before the merge either failure blanked the whole page.
 */

import { listManagedPackages, readAdapterDiagnostics, type ManagedWebMCPPackage } from '../webmcp/package-client'
import { listRegistries, type RegistryListResult } from '../webmcp/registry-client-page'
import { createBuiltinSection } from './builtin-section'
import { createDiagnosticsSection } from './diagnostics-section'
import { createMineSection } from './mine-section'
import { createPackageSearch } from './package-search'
import { createRegistrySection } from './registry-section'
import { SECTION_LOAD_TIMEOUT_MS, t, withTimeout } from './shared'

for (const [id, key] of [
  ['pageTitle', 'webmcpPackagesPageTitle'],
  ['pageSubtitle', 'webmcpPackagesPageSubtitle'],
  ['pageNote', 'webmcpPackagesPageNote'],
  ['summaryBuiltinLabel', 'webmcpPackagesSectionBuiltin'],
  ['summaryRegistryLabel', 'webmcpPackagesSectionRegistry'],
  ['summaryMineLabel', 'webmcpPackagesSectionMine'],
] as const) {
  document.getElementById(id)!.textContent = t(key)
}
// The static <title> is English-only; keep the tab localized like the page.
document.title = t('webmcpPackagesPageTabTitle')

const searchInput = document.getElementById('packageSearch') as HTMLInputElement
searchInput.placeholder = t('webmcpPackagesSearchPlaceholder')
searchInput.setAttribute('aria-label', t('webmcpPackagesSearchPlaceholder'))
const searchClear = document.getElementById('packageSearchClear') as HTMLButtonElement
searchClear.textContent = t('webmcpPackagesSearchClear')
const search = createPackageSearch(
  searchInput,
  searchClear,
  document.getElementById('packageSearchStatus')!,
  (matched, total) => {
    const count = t('webmcpPackagesSearchResults', [String(matched), String(total)])
    return matched ? count : `${count} · ${t('webmcpPackagesSearchNoResults')}`
  },
)

const builtin = createBuiltinSection(
  document.getElementById('builtinSection')!,
  refresh,
  document.getElementById('summaryBuiltin')!,
  search,
)
const registry = createRegistrySection(
  document.getElementById('registrySection')!,
  refresh,
  document.getElementById('summaryRegistry')!,
  search,
)
const mine = createMineSection(
  document.getElementById('mineSection')!,
  refresh,
  document.getElementById('summaryMine')!,
  search,
)
const diagnostics = createDiagnosticsSection(document.getElementById('diagnosticsSection')!)

let generation = 0
/** Last time a full load was kicked off (focus throttling below). */
let lastRefreshAt = 0

function refresh(): void {
  lastRefreshAt = Date.now()
  void renderAll()
}

async function renderAll(): Promise<void> {
  const current = ++generation
  // Each section renders the moment ITS source settles: awaiting both spends a
  // slow (or hanging) request as a blank section for the other, healthy source.
  // "Mine" needs both — the catalog says what exists, the install records say
  // what a registry owns — so it is drawn by whichever of the two arrives
  // second (or fails first). The generation guard is checked per arrival, so a
  // superseded render still lands nothing.
  let packages: ManagedWebMCPPackage[] | undefined
  /** False when the user mount could not be listed (builtin-only catalog). */
  let userMountComplete = true
  let registries: RegistryListResult | undefined

  const packagesSettled = withTimeout(
    listManagedPackages(),
    SECTION_LOAD_TIMEOUT_MS,
    'webmcpPackagesLoadTimeout',
  ).then(
    catalog => {
      packages = catalog.entries
      userMountComplete = catalog.userMountComplete
      if (current !== generation) return
      builtin.render(catalog.entries)
      if (registries) mine.render(catalog.entries, new Set(registries.installedDirectories ?? []), { userMountComplete })
    },
    error => {
      if (current !== generation) return
      builtin.fail(error)
      mine.fail(error)
    },
  )

  const registriesSettled = withTimeout(
    listRegistries(),
    SECTION_LOAD_TIMEOUT_MS,
    'webmcpPackagesLoadTimeout',
  ).then(
    result => {
      registries = result
      if (current !== generation) return
      registry.render(result)
      if (packages) mine.render(packages, new Set(result.installedDirectories ?? []), { userMountComplete })
    },
    error => {
      if (current !== generation) return
      registry.fail(error)
      // Without the install records "mine" must not claim a registry install
      // is authored (it would offer a delete the registry section owns).
      mine.fail(error)
    },
  )

  const diagnosticsSettled = withTimeout(
    readAdapterDiagnostics(),
    SECTION_LOAD_TIMEOUT_MS,
    'webmcpPackagesLoadTimeout',
  ).then(
    result => {
      if (current !== generation) return
      diagnostics.render(result)
    },
    error => {
      if (current !== generation) return
      diagnostics.fail(error)
    },
  )

  await Promise.allSettled([packagesSettled, registriesSettled, diagnosticsSettled])
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'webmcp_packages_changed' || message?.type === 'webmcpPackagesRegistryChanged') refresh()
})
/**
 * Refocusing the tab must not restart the whole load. Every focus used to
 * re-list the catalog, re-fetch every registry and rebuild every row — with a
 * 50-package catalog that is a visible stall each time the user comes back to
 * the page (switching tabs made it feel permanently slow). Explicit refresh
 * paths (package-change messages, the per-registry Refresh button) still run
 * immediately; only the focus nudge is throttled.
 */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000
window.addEventListener('focus', () => {
  if (Date.now() - lastRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return
  refresh()
})
refresh()
