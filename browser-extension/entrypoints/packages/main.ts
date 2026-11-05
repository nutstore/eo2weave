/**
 * Merged WebMCP packages page (issue #193).
 *
 * One page, three source sections: built-in (read-only mount), registry
 * (install records / catalogs), mine (rw mount without an install record).
 * The two data loads run INDEPENDENTLY: a failing source renders only its own
 * section's error — before the merge either failure blanked the whole page.
 */

import { listManagedPackages, type ManagedWebMCPPackage } from '../webmcp/package-client'
import { listRegistries, type RegistryListResult } from '../webmcp/registry-client-page'
import { createBuiltinSection } from './builtin-section'
import { createMineSection } from './mine-section'
import { createRegistrySection } from './registry-section'
import { t } from './shared'

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

const builtin = createBuiltinSection(
  document.getElementById('builtinSection')!,
  refresh,
  document.getElementById('summaryBuiltin')!,
)
const registry = createRegistrySection(
  document.getElementById('registrySection')!,
  refresh,
  document.getElementById('summaryRegistry')!,
)
const mine = createMineSection(
  document.getElementById('mineSection')!,
  refresh,
  document.getElementById('summaryMine')!,
)

let generation = 0

function refresh(): void {
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
  let registries: RegistryListResult | undefined

  const packagesSettled = listManagedPackages().then(
    entries => {
      packages = entries
      if (current !== generation) return
      builtin.render(entries)
      if (registries) mine.render(entries, new Set(registries.installed))
    },
    error => {
      if (current !== generation) return
      builtin.fail(error)
      mine.fail(error)
    },
  )

  const registriesSettled = listRegistries().then(
    result => {
      registries = result
      if (current !== generation) return
      registry.render(result)
      if (packages) mine.render(packages, new Set(result.installed))
    },
    error => {
      if (current !== generation) return
      registry.fail(error)
      // Without the install records "mine" must not claim a registry install
      // is authored (it would offer a delete the registry section owns).
      mine.fail(error)
    },
  )

  await Promise.allSettled([packagesSettled, registriesSettled])
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'webmcp_packages_changed' || message?.type === 'webmcpPackagesRegistryChanged') refresh()
})
window.addEventListener('focus', refresh)
refresh()
