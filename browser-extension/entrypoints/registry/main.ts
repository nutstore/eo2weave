/**
 * Site packages (registry) management page — extension side (issue #143).
 *
 * The page lists the user's package registries, browses each registry's
 * catalog, and installs / removes site packages. Every operation runs in
 * the BACKGROUND: the packages live in the extension's own OPFS mount, so
 * nothing here goes through the page bridge.
 *
 * The copy comes from the ported `webmcpPackages` strings (chrome.i18n
 * flat keys); the web app's nested `packages/i18n` locale files stay as the
 * text source.
 */

import {
  addRegistry,
  installRegistryPackage,
  listRegistries,
  loadRegistryCatalog,
  previewRegistryPackage,
  removeRegistry,
  uninstallRegistryPackage,
} from '../webmcp/registry-client-page'
import type { PackageRegistry, RegistryManifest, RegistryManifestPackage } from '../webmcp/registry-client'

function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key as never, substitutions as never) || key
}

const errorBox = document.getElementById('pageError') as HTMLParagraphElement
const errorText = document.getElementById('pageErrorText') as HTMLSpanElement
const errorDismiss = document.getElementById('pageErrorDismiss') as HTMLSpanElement

function showError(error: unknown): void {
  errorText.textContent = error instanceof Error ? error.message : String(error)
  errorBox.hidden = false
}
function clearError(): void {
  errorBox.hidden = true
  errorText.textContent = ''
}
function dismissError(): void {
  clearError()
}
errorDismiss.addEventListener('click', dismissError)
errorDismiss.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); dismissError() }
})

for (const [id, key] of [
  ['pageTitle', 'webmcpPackagesTitle'],
  ['pageSubtitle', 'webmcpPackagesDescription'],
  ['registryTitle', 'webmcpPackagesRegistryLabel'],
  ['registryHint', 'webmcpPackagesAddRegistryHint'],
  ['installedTitle', 'webmcpPackagesInstalledTitle'],
  ['pageNote', 'webmcpPackagesMirrorNote'],
] as const) {
  document.getElementById(id)!.textContent = t(key)
}
// The static <title> in index.html is English-only; keep the browser tab
// localized like the rest of the page.
document.title = t('webmcpPackagesPageTabTitle')
const registryInput = document.getElementById('registryInput') as HTMLInputElement
registryInput.placeholder = t('webmcpPackagesAddRegistryInputPlaceholder')
document.getElementById('registryAdd')!.textContent = t('webmcpPackagesAddRegistryButton')

/** Installed package ids + their activation state (from the background). */
let installed = new Set<string>()
let activations: Record<string, 'enabled' | 'disabled'> = {}

/** Catalogs already fetched, keyed by the registry's manifest URL. */
const catalogs = new Map<string, RegistryManifest>()

/** Manifest URLs whose catalog is currently being fetched (no re-entry). */
const catalogLoads = new Set<string>()

/**
 * Verified tool lists per catalog entry (from the package's own manifest),
 * keyed by `manifestUrl::packageId`.
 *
 * The catalog entry's `toolCount` is a publisher-provided CLAIM; the
 * preview fetches the real manifest. A package whose preview failed keeps
 * the claimed count and is marked UNVERIFIED.
 */
const toolPreviews = new Map<string, Array<{ name: string; description: string }>>()
const previewFailures = new Set<string>()
/**
 * In-flight preview requests, keyed the same way. A completion triggers a
 * full re-render, which would otherwise re-enter `loadToolPreview` for
 * every still-pending package and AMPLIFY the request count with each
 * staggered response — the in-flight promise is reused instead (finding:
 * "Tool previews multiply requests").
 *
 * The reuse window is EPOCH-SCOPED (finding: "Refreshed preview stays
 * unverified"): a promise started under an older catalog epoch is NOT
 * handed out after a refresh bumps the epoch — its stale result is dropped
 * internally, and reusing it for the refreshed card would leave the
 * refreshed render with no live preview (the tool count stayed unverified
 * until yet another render). A post-refresh render therefore starts a NEW
 * preview for the refreshed catalog.
 */
const previewInFlight = new Map<string, Promise<boolean>>()
/** The catalog epoch each in-flight preview was started under (keyed by promise). */
const previewInFlightEpoch = new Map<Promise<boolean>, number>()

/**
 * Bumped on every refresh/removal/reset of a registry's catalog. A catalog
 * or preview response that started under an OLDER epoch must not land:
 * writing it over the refreshed state re-showed stale packages as current
 * and stale previews as verified (finding: "Refreshes accept stale
 * registry data"). Previews key on `${manifestUrl}::${packageId}`, which
 * a refresh of the SAME registry reuses — the epoch is what disambiguates.
 */
const catalogEpochs = new Map<string, number>()

function bumpCatalogEpoch(manifestUrl: string): void {
  catalogEpochs.set(manifestUrl, (catalogEpochs.get(manifestUrl) ?? 0) + 1)
}

/** Registries whose auto-load FAILED (no automatic retry from render). */
const catalogLoadFailures = new Set<string>()

/**
 * Load the tool preview for one package (best effort — never blocks the
 * card).
 *
 * Returns true when this call CHANGED the preview state (so the caller
 * knows a re-render is needed). A cached preview or a recorded failure
 * returns false — otherwise the re-render would loop forever.
 */
function loadToolPreview(registry: PackageRegistry, pkg: RegistryManifestPackage): Promise<boolean> {
  const key = `${registry.manifestUrl}::${pkg.id}`
  // Reuse only a promise from the CURRENT epoch: after a refresh bumped the
  // epoch the old promise's result is dropped internally (stale-epoch guard
  // below) — reusing it for the refreshed card left the refreshed render
  // without a preview and the tool count unverified (finding: "Refreshed
  // preview stays unverified").
  const currentEpoch = catalogEpochs.get(registry.manifestUrl) ?? 0
  const existing = previewInFlight.get(key)
  if (existing && (previewInFlightEpoch.get(existing) ?? currentEpoch) === currentEpoch) return existing
  // The epoch at START: a refresh/removal of this registry while the
  // preview is in flight bumps it, and the stale result is dropped.
  const epoch = currentEpoch
  const work = (async (): Promise<boolean> => {
    if (toolPreviews.has(key) || previewFailures.has(key)) return false
    try {
      const tools = await previewRegistryPackage(registry, pkg)
      // A refresh or removal happened meanwhile — the response belongs to
      // the OLD registry state. Drop it (finding: "Refreshes accept stale
      // registry data"): re-recording it would re-mark tools verified that
      // the refreshed catalog no longer publishes.
      if ((catalogEpochs.get(registry.manifestUrl) ?? 0) !== epoch) return false
      toolPreviews.set(key, tools)
      return true
    } catch {
      if ((catalogEpochs.get(registry.manifestUrl) ?? 0) !== epoch) return false
      previewFailures.add(key)
      return false
    }
  })()
  // Reuse window: while `work` is pending the SAME promise is handed out;
  // once settled it is removed so a re-render can re-enter for a package
  // whose epoch changed (the stale-epoch path above returns false without
  // recording, so the next render retries under the new epoch).
  const promise = work.finally(() => {
    if (previewInFlight.get(key) === promise) previewInFlight.delete(key)
    previewInFlightEpoch.delete(promise)
  })
  previewInFlight.set(key, promise)
  previewInFlightEpoch.set(promise, epoch)
  return promise
}

/** Drop the preview cache entries of one registry (its catalog changed). */
function clearToolPreviews(manifestUrl: string): void {
  for (const key of [...toolPreviews.keys()]) if (key.startsWith(`${manifestUrl}::`)) toolPreviews.delete(key)
  for (const key of [...previewFailures]) if (key.startsWith(`${manifestUrl}::`)) previewFailures.delete(key)
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn ${className}`
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
}

function buildRegistryCard(registry: PackageRegistry): HTMLElement {
  const card = document.createElement('div')
  card.className = 'card'
  const body = document.createElement('div')
  body.className = 'body'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = registry.label
  const host = document.createElement('div')
  host.className = 'host'
  host.textContent = registry.manifestUrl
  body.append(name, host)

  const catalog = catalogs.get(registry.manifestUrl)
  if (!catalog) {
    const hint = document.createElement('div')
    hint.className = 'desc'
    hint.textContent = catalogLoads.has(registry.manifestUrl)
      ? t('webmcpPackagesRefreshing')
      : t('webmcpPackagesNoPackages')
    body.append(hint)
  } else if (!catalog.packages.length) {
    const hint = document.createElement('div')
    hint.className = 'desc'
    hint.textContent = t('webmcpPackagesNoPackages')
    body.append(hint)
  } else {
    for (const pkg of catalog.packages) {
      // The tool preview arrives after the card was drawn; re-render only
      // when the preview actually CHANGED something (a cached preview
      // returns false, so this cannot loop).
      void loadToolPreview(registry, pkg).then(changed => { if (changed) void render() })
      body.append(buildPackageRow(registry, pkg))
    }
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  const refresh = button(t('webmcpPackagesRefresh'), '', async () => {
    refresh.disabled = true
    refresh.textContent = t('webmcpPackagesRefreshing')
    // Invalidate in-flight catalog/preview work FIRST (finding: "Refreshes
    // accept stale registry data"): anything that started before this
    // refresh belongs to the old registry state and must not land.
    bumpCatalogEpoch(registry.manifestUrl)
    catalogLoads.delete(registry.manifestUrl)
    catalogLoadFailures.delete(registry.manifestUrl)
    toolPreviews.clear()
    previewFailures.clear()
    const epoch = catalogEpochs.get(registry.manifestUrl) ?? 0
    try {
      clearError()
      const manifest = await loadRegistryCatalog(registry, true)
      // Another refresh/removal started while ours was in flight — ours is
      // now the stale one and must not overwrite the newer state.
      if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
        catalogs.set(registry.manifestUrl, manifest)
      }
    } catch (error) {
      showError(error)
    } finally {
      refresh.disabled = false
      refresh.textContent = t('webmcpPackagesRefresh')
      await render()
    }
  })
  actions.append(refresh)
  const remove = button(t('webmcpPackagesRemoveRegistry'), 'danger', async () => {
    remove.disabled = true
    // Invalidate in-flight catalog/preview work for this registry BEFORE
    // the removal lands (finding: "Refreshes accept stale registry data") —
    // a pending catalog/preview response would otherwise repopulate state
    // for a registry the user just removed.
    bumpCatalogEpoch(registry.manifestUrl)
    catalogLoads.delete(registry.manifestUrl)
    try {
      clearError()
      await removeRegistry(registry.manifestUrl)
      catalogs.delete(registry.manifestUrl)
      // The registry may be re-added at the same URL with a changed
      // manifest — drop ITS preview cache entries (not every registry's),
      // or the re-added cards would show stale tools as verified. The epoch
      // bump above already invalidated everything in flight.
      clearToolPreviews(registry.manifestUrl)
    } catch (error) {
      showError(error)
    } finally {
      await render()
    }
  })
  actions.append(remove)
  card.append(body, actions)
  return card
}

function buildPackageRow(registry: PackageRegistry, pkg: RegistryManifestPackage): HTMLElement {
  const row = document.createElement('div')
  row.className = 'card'
  const body = document.createElement('div')
  body.className = 'body'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = pkg.id
  const host = document.createElement('div')
  host.className = 'host'
  host.textContent = t('webmcpPackagesVersion', pkg.version)
  const desc = document.createElement('div')
  desc.className = 'desc'
  desc.textContent = pkg.description
  body.append(name, host, desc)

  // The tool count: the VERIFIED count from the package's own manifest when
  // the preview succeeded, otherwise the publisher's CLAIM (marked
  // unverified). The install verifies the manifest for real.
  const previewKey = `${registry.manifestUrl}::${pkg.id}`
  const preview = toolPreviews.get(previewKey)
  const count = document.createElement('div')
  count.className = 'desc'
  count.textContent = preview
    ? t('webmcpPackagesToolsCount', String(preview.length))
    : `${t('webmcpPackagesToolsCount', String(pkg.toolCount))} ${t('webmcpPackagesToolsCountUnverified')}`
  body.append(count)
  if (preview?.length) {
    const chips = document.createElement('div')
    chips.className = 'tools'
    for (const tool of preview) {
      const chip = document.createElement('span')
      chip.className = 'tool-chip'
      chip.textContent = tool.name
      chip.title = tool.description
      chips.append(chip)
    }
    body.append(chips)
  }

  const isInstalled = installed.has(pkg.id)
  const isEnabled = isInstalled && activations[pkg.id] === 'enabled'
  const state = document.createElement('div')
  state.className = 'state' + (isEnabled ? '' : ' inactive')
  state.textContent = isInstalled
    ? (isEnabled ? t('webmcpPackagesInstalledActive') : t('webmcpPackagesInstalledInactive'))
    : ''
  body.append(state)
  // The enable hint is only meaningful for a package that is NOT enabled —
  // an enabled package showing "open the side panel to enable" contradicted
  // the card's own active badge.
  if (isInstalled && !isEnabled) {
    const hint = document.createElement('div')
    hint.className = 'desc'
    hint.textContent = t('webmcpPackagesInstalledInactiveHint')
    body.append(hint)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (isInstalled) {
    const uninstall = button(t('webmcpPackagesUninstall'), 'danger', async () => {
      uninstall.disabled = true
      const previous = uninstall.textContent
      uninstall.textContent = t('webmcpPackagesUninstalling')
      try {
        clearError()
        await uninstallRegistryPackage(pkg.id)
      } catch (error) {
        showError(error)
      } finally {
        uninstall.textContent = previous
        uninstall.disabled = false
        await render()
      }
    })
    actions.append(uninstall)
  } else {
    const install = button(t('webmcpPackagesInstall'), 'primary', async () => {
      install.disabled = true
      const previous = install.textContent
      install.textContent = t('webmcpPackagesInstalling')
      try {
        clearError()
        const result = await installRegistryPackage(registry, pkg)
        installed.add(pkg.id)
        activations[pkg.id] = 'disabled'
        showSuccess(t('webmcpPackagesInstallSuccess', [pkg.id, String(result.filesWritten)]))
      } catch (error) {
        showError(error)
      } finally {
        install.textContent = previous
        install.disabled = false
        await render()
      }
    })
    actions.append(install)
  }
  row.append(body, actions)
  return row
}

/** A success message rendered in the same box as errors (it is dismissed too). */
function showSuccess(message: string): void {
  errorText.textContent = message
  errorBox.hidden = false
  errorBox.style.color = '#2d8a4e'
  errorBox.style.background = '#f0fdf4'
  errorBox.style.borderColor = '#bbf7d0'
  window.setTimeout(() => {
    errorBox.style.color = ''
    errorBox.style.background = ''
    errorBox.style.borderColor = ''
  }, 0)
}

let generation = 0

async function render(): Promise<void> {
  const current = ++generation
  const state = await listRegistries()
  if (current !== generation) return
  installed = new Set(state.installed)
  activations = state.activations

  // A registry list that could not be persisted (chrome.storage.local
  // unavailable) reads back empty on the next load — silently redrawing it
  // made a just-added registry disappear without explanation. The user
  // must know the list is session-only.
  if (!state.persisted) {
    showError(new Error(t('webmcpPackagesNotPersisted')))
  }

  const registryList = document.getElementById('registryList')!
  registryList.replaceChildren()
  if (!state.registries.length) {
    const placeholder = document.createElement('div')
    placeholder.className = 'empty'
    placeholder.textContent = t('webmcpPackagesNoRegistries')
    registryList.append(placeholder)
  } else {
    for (const registry of state.registries) {
      // Load the catalog for a registry the page has not seen yet, so a
      // registry added in a previous session shows its packages on open
      // (without a separate click). The load is best effort — a registry
      // that is unreachable shows its error, not an empty page.
      //
      // A registry whose auto-load FAILED is NOT retried here (finding:
      // "Failed catalogs retry indefinitely"): the failure left the catalog
      // absent, so every render re-started the same request forever. The
      // failure is remembered and the explicit Refresh button (which clears
      // the flag) is the retry path.
      if (
        !catalogs.has(registry.manifestUrl) &&
        !catalogLoads.has(registry.manifestUrl) &&
        !catalogLoadFailures.has(registry.manifestUrl)
      ) {
        catalogLoads.add(registry.manifestUrl)
        const epoch = catalogEpochs.get(registry.manifestUrl) ?? 0
        void loadRegistryCatalog(registry)
          .then(manifest => {
            // A refresh/removal raced this auto-load — the response belongs
            // to the old registry state (finding: "Refreshes accept stale
            // registry data").
            if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
              catalogs.set(registry.manifestUrl, manifest)
            }
          })
          .catch(error => {
            catalogLoadFailures.add(registry.manifestUrl)
            showError(error)
          })
          .finally(() => { catalogLoads.delete(registry.manifestUrl); void render() })
      }
      registryList.append(buildRegistryCard(registry))
    }
  }

  const installedList = document.getElementById('installedList')!
  installedList.replaceChildren()
  if (!installed.size) {
    const placeholder = document.createElement('div')
    placeholder.className = 'empty'
    placeholder.textContent = t('webmcpPackagesNoPackages')
    installedList.append(placeholder)
  } else {
    for (const id of [...installed].sort()) {
      const row = document.createElement('div')
      row.className = 'card'
      const body = document.createElement('div')
      body.className = 'body'
      const name = document.createElement('div')
      name.className = 'name'
      name.textContent = id
      const state_ = document.createElement('div')
      state_.className = 'state' + (activations[id] === 'enabled' ? '' : ' inactive')
      state_.textContent = activations[id] === 'enabled'
        ? t('webmcpPackagesInstalledActive')
        : t('webmcpPackagesInstalledInactive')
      body.append(name, state_)
      const actions = document.createElement('div')
      actions.className = 'actions'
      const uninstall = button(t('webmcpPackagesUninstall'), 'danger', async () => {
        uninstall.disabled = true
        const previous = uninstall.textContent
        uninstall.textContent = t('webmcpPackagesUninstalling')
        try {
          clearError()
          await uninstallRegistryPackage(id)
        } catch (error) {
          showError(error)
        } finally {
          uninstall.textContent = previous
          uninstall.disabled = false
          await render()
        }
      })
      actions.append(uninstall)
      row.append(body, actions)
      installedList.append(row)
    }
  }
}

document.getElementById('registryAdd')!.addEventListener('click', async () => {
  const addButton = document.getElementById('registryAdd') as HTMLButtonElement
  const input = registryInput.value.trim()
  if (!input) return
  addButton.disabled = true
  const previous = addButton.textContent
  addButton.textContent = t('webmcpPackagesAdding')
  try {
    clearError()
    const registry = await addRegistry(input)
    // Fetch the catalog right away so the packages are visible without an
    // extra click. A failed auto-load of the SAME URL (re-added registry)
    // gets a fresh attempt — this is the explicit path.
    catalogLoadFailures.delete(registry.manifestUrl)
    try {
      const manifest = await loadRegistryCatalog(registry)
      catalogs.set(registry.manifestUrl, manifest)
    } catch (error) {
      showError(error)
    }
    registryInput.value = ''
  } catch (error) {
    showError(error)
  } finally {
    addButton.textContent = previous
    addButton.disabled = false
    await render()
  }
})

registryInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault()
    ;(document.getElementById('registryAdd') as HTMLButtonElement).click()
  }
})

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'webmcp_packages_changed' || message?.type === 'webmcpPackagesRegistryChanged') void render().catch(showError)
})
window.addEventListener('focus', () => void render().catch(showError))
void render().catch(showError)
