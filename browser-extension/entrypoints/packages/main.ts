/**
 * Merged WebMCP packages page (issue #193).
 *
 * One page, three source sections: built-in (read-only mount), registry
 * (install records / catalogs), mine (rw mount without an install record).
 * The two data loads run INDEPENDENTLY: a failing source renders only its own
 * section's error — before the merge either failure blanked the whole page.
 */

import { listManagedPackages } from '../webmcp/package-client'
import { listRegistries } from '../webmcp/registry-client-page'
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
  const [packages, registries] = await Promise.allSettled([listManagedPackages(), listRegistries()])
  // A newer render started meanwhile — its state is the current one.
  if (current !== generation) return

  if (packages.status === 'fulfilled') builtin.render(packages.value)
  else builtin.fail(packages.reason)

  if (registries.status === 'fulfilled') registry.render(registries.value)
  else registry.fail(registries.reason)

  if (packages.status === 'fulfilled' && registries.status === 'fulfilled') {
    mine.render(packages.value, new Set(registries.value.installed))
  } else if (packages.status === 'rejected') {
    mine.fail(packages.reason)
  } else if (registries.status === 'rejected') {
    // "Mine" needs both: the catalog says what exists, the install records say
    // what a registry owns. Without them it must not claim registry installs.
    mine.fail(registries.reason)
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'webmcp_packages_changed' || message?.type === 'webmcpPackagesRegistryChanged') refresh()
})
window.addEventListener('focus', refresh)
refresh()
