/**
 * Registry section of the merged packages page (issue #193).
 *
 * Ported from the standalone `registry.html` entrypoint: the user's package
 * registries, each registry's catalog, and install / remove. The source
 * header card + divided package rows structure is unchanged — only the
 * section's error box is now its own (a failing registry load no longer
 * blanks the built-in / mine sections).
 */

import {
  addRegistry,
  installRegistryPackage,
  loadRegistryCatalog,
  previewRegistryPackage,
  removeRegistry,
  setRegistryPackageActivation,
  uninstallRegistryPackage,
  type RegistryListResult,
} from '../webmcp/registry-client-page'
import type { PackageRegistry, RegistryManifest, RegistryManifestPackage } from '../webmcp/registry-client'
import {
  button,
  createSection,
  isFeedbackCurrent,
  nextFeedbackToken,
  showOperationRemoved,
  showOperationSuccess,
  sourceChip,
  t,
} from './shared'

export interface RegistrySection {
  /** Render this section from a successful registry load. */
  render(state: RegistryListResult): void
  /** Render ONLY this section's error — the other sections stay usable. */
  fail(error: unknown): void
}

export function createRegistrySection(
  host: HTMLElement,
  refresh: () => void,
  summary?: HTMLElement,
): RegistrySection {
  const shell = createSection(host, {
    id: 'registry',
    headingKey: 'webmcpPackagesSectionRegistry',
    hintKey: 'webmcpPackagesSectionRegistryHint',
    summary,
  })

  /** Installed package ids + their activation state (from the background). */
  let installed = new Set<string>()
  let activations: Record<string, 'enabled' | 'disabled'> = {}
  /** The last successful load, so catalog/preview arrivals can redraw locally. */
  let lastState: RegistryListResult | undefined

  /** Catalogs already fetched, keyed by the registry's manifest URL. */
  const catalogs = new Map<string, RegistryManifest>()
  /** Manifest URLs whose catalog is currently being fetched (no re-entry). */
  const catalogLoads = new Set<string>()
  /**
   * Verified tool lists per catalog entry (from the package's own manifest),
   * keyed by `manifestUrl::packageId`. The catalog entry's `toolCount` is a
   * publisher-provided CLAIM; the preview fetches the real manifest.
   */
  const toolPreviews = new Map<string, Array<{ name: string; description: string }>>()
  const previewFailures = new Set<string>()
  /**
   * In-flight preview requests, keyed the same way. A completion triggers a
   * re-render, which would otherwise re-enter `loadToolPreview` for every
   * still-pending package and AMPLIFY the request count with each staggered
   * response — the in-flight promise is reused instead.
   *
   * The reuse window is EPOCH-SCOPED: a promise started under an older
   * catalog epoch is not handed out after a refresh bumps the epoch.
   */
  const previewInFlight = new Map<string, Promise<boolean>>()
  const previewInFlightEpoch = new Map<Promise<boolean>, number>()
  /**
   * Bumped on every refresh/removal of a registry's catalog. A catalog or
   * preview response that started under an OLDER epoch must not land: writing
   * it over refreshed state re-showed stale packages as current.
   */
  const catalogEpochs = new Map<string, number>()
  /** Registries whose auto-load FAILED (no automatic retry from render). */
  const catalogLoadFailures = new Set<string>()
  /**
   * Registries whose last FORCED refresh failed while a cached catalog is
   * still on screen. The cache is kept (it is better than nothing) but it is
   * STALE, and the card must not present it as a live connection.
   */
  const catalogRefreshFailures = new Set<string>()

  /**
   * True while the box shows a FAILED OPERATION (install / uninstall /
   * activation / add / forced refresh). An operation failure is NOT state: a
   * later successful load must not erase it before the user has read it.
   * Load failures and the session-only warning ARE derived from the last load
   * (and the current `persisted` flag), so `render` recomputes those.
   */
  let operationErrorShown = false

  function showOperationError(error: unknown): void {
    operationErrorShown = true
    shell.error.show(error)
  }

  /** An operation starts: its own feedback replaces whatever the box showed. */
  function clearBox(): void {
    operationErrorShown = false
    shell.error.clear()
  }

  function bumpCatalogEpoch(manifestUrl: string): void {
    catalogEpochs.set(manifestUrl, (catalogEpochs.get(manifestUrl) ?? 0) + 1)
  }

  /**
   * Load the tool preview for one package (best effort — never blocks the
   * card). Returns true when this call CHANGED the preview state, so the
   * caller knows a re-render is needed.
   */
  function loadToolPreview(registry: PackageRegistry, pkg: RegistryManifestPackage): Promise<boolean> {
    const key = `${registry.manifestUrl}::${pkg.id}`
    const currentEpoch = catalogEpochs.get(registry.manifestUrl) ?? 0
    const existing = previewInFlight.get(key)
    if (existing && (previewInFlightEpoch.get(existing) ?? currentEpoch) === currentEpoch) return existing
    const epoch = currentEpoch
    const work = (async (): Promise<boolean> => {
      if (toolPreviews.has(key) || previewFailures.has(key)) return false
      try {
        const tools = await previewRegistryPackage(registry, pkg)
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) !== epoch) return false
        toolPreviews.set(key, tools)
        return true
      } catch {
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) !== epoch) return false
        previewFailures.add(key)
        return false
      }
    })()
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

  /** Redraw from the last known state (catalog/preview arrivals). */
  function rerender(): void {
    if (lastState) render(lastState)
  }

  function buildRegistryCard(registry: PackageRegistry): HTMLElement {
    const card = document.createElement('div')
    card.className = 'card'
    const head = document.createElement('div')
    head.className = 'reg-head'
    // The dot reflects REAL connection state: loading = pulsing amber,
    // failed = red, connected = green. A CACHED catalog only counts as
    // connected if the last refresh did not fail — after a failed forced
    // refresh the rows below are the stale cache, not a live connection.
    const catalog = catalogs.get(registry.manifestUrl)
    const refreshFailed = catalogRefreshFailures.has(registry.manifestUrl)
    const dotState = refreshFailed
      ? 'failed'
      : catalog
        ? 'ok'
        : catalogLoads.has(registry.manifestUrl)
          ? 'loading'
          : catalogLoadFailures.has(registry.manifestUrl)
            ? 'failed'
            : 'ok'
    const dot = document.createElement('span')
    dot.className = `dot dot-${dotState}`
    if (dotState === 'loading') dot.title = t('webmcpPackagesRefreshing')
    if (refreshFailed) dot.title = t('webmcpPackagesCatalogStale')
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = registry.label
    const host = document.createElement('div')
    host.className = 'host'
    host.textContent = registry.manifestUrl
    const headSpacer = document.createElement('span')
    headSpacer.className = 'spacer'
    head.append(dot, name, host, headSpacer)

    const body = document.createElement('div')
    body.className = 'body'

    // Cached-but-unrevalidated catalog: say so, so the rows are not read as
    // the registry's current content.
    if (catalog && refreshFailed) {
      const stale = document.createElement('div')
      stale.className = 'desc stale'
      stale.textContent = t('webmcpPackagesCatalogStale')
      body.append(stale)
    }

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
        void loadToolPreview(registry, pkg).then(changed => { if (changed) rerender() })
        body.append(buildPackageRow(registry, pkg))
      }
    }

    const actions = document.createElement('div')
    actions.className = 'actions'
    const refreshButton = button(t('webmcpPackagesRefresh'), 'iconbtn', async () => {
      refreshButton.disabled = true
      refreshButton.textContent = t('webmcpPackagesRefreshing')
      // Invalidate in-flight catalog/preview work FIRST: anything that
      // started before this refresh belongs to the old registry state.
      bumpCatalogEpoch(registry.manifestUrl)
      catalogLoads.delete(registry.manifestUrl)
      catalogLoadFailures.delete(registry.manifestUrl)
      toolPreviews.clear()
      previewFailures.clear()
      // Keep the registry MARKED AS LOADING through the forced refresh — a
      // render() during the refresh must not start a new ordinary load that
      // could finish after this one and overwrite it with stale data.
      catalogLoads.add(registry.manifestUrl)
      const epoch = catalogEpochs.get(registry.manifestUrl) ?? 0
      try {
        clearBox()
        const manifest = await loadRegistryCatalog(registry, true)
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
          catalogs.set(registry.manifestUrl, manifest)
          catalogRefreshFailures.delete(registry.manifestUrl)
        }
      } catch (error) {
        // A superseded refresh (removal, re-add, another refresh) says nothing
        // about the CURRENT registry state — its failure must not land.
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
          catalogRefreshFailures.add(registry.manifestUrl)
          showOperationError(error)
        }
      } finally {
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) catalogLoads.delete(registry.manifestUrl)
        refreshButton.disabled = false
        refreshButton.textContent = t('webmcpPackagesRefresh')
        rerender()
      }
    })
    head.append(actions)
    actions.append(refreshButton)
    const remove = button(t('webmcpPackagesRemoveRegistry'), 'iconbtn', async () => {
      remove.disabled = true
      // Invalidate in-flight work for this registry BEFORE the removal lands:
      // a pending response would otherwise repopulate state for a registry
      // the user just removed.
      bumpCatalogEpoch(registry.manifestUrl)
      catalogLoads.delete(registry.manifestUrl)
      try {
        clearBox()
        await removeRegistry(registry.manifestUrl)
        catalogs.delete(registry.manifestUrl)
        catalogRefreshFailures.delete(registry.manifestUrl)
        clearToolPreviews(registry.manifestUrl)
      } catch (error) {
        showOperationError(error)
      } finally {
        refresh()
      }
    })
    actions.append(remove)
    card.append(head, body)
    return card
  }

  function buildPackageRow(registry: PackageRegistry, pkg: RegistryManifestPackage): HTMLElement {
    const row = document.createElement('div')
    row.className = 'pkg-row'
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
    const titleLine = document.createElement('div')
    titleLine.className = 'title-line'
    titleLine.append(name, sourceChip('registry'))
    body.append(titleLine, host, desc)

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
    // Status is a COMPACT inline pill on the id line — never a block element
    // that stretches to its container.
    const state = document.createElement('span')
    state.className = 'state' + (isEnabled ? ' active' : '')
    const stateDot = document.createElement('span')
    stateDot.className = 'dot'
    state.append(stateDot, isInstalled
      ? (isEnabled ? t('webmcpPackagesInstalledActive') : t('webmcpPackagesInstalledInactive'))
      : t('webmcpPackagesNotInstalled'))
    titleLine.append(state)
    // The enable hint is only meaningful for a package that is NOT enabled.
    if (isInstalled && !isEnabled) {
      const hint = document.createElement('div')
      hint.className = 'desc'
      hint.textContent = t('webmcpPackagesInstalledInactiveHint')
      body.append(hint)
    }

    const actions = document.createElement('div')
    actions.className = 'actions row'
    // Activation is part of the INSTALL, so the registry row owns the switch:
    // "mine" excludes registry installs and an install records the disabled
    // default, so without this toggle a freshly installed registry package
    // could never be turned on from the merged page.
    if (isInstalled) {
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.className = 'toggle'
      toggle.checked = isEnabled
      toggle.setAttribute('aria-label', `${t('webmcpPackageActivation')}: ${pkg.id}`)
      toggle.addEventListener('change', async () => {
        toggle.disabled = true
        clearBox()
        const token = nextFeedbackToken(pkg.id)
        try {
          const activation = toggle.checked ? 'enabled' : 'disabled'
          await setRegistryPackageActivation(pkg.id, activation)
          activations[pkg.id] = activation
        } catch (error) {
          // The write did not land: the switch must show the real state again.
          toggle.checked = isEnabled
          if (isFeedbackCurrent(token)) showOperationError(error)
        } finally {
          toggle.disabled = false
          refresh()
        }
      })
      actions.append(toggle)
    }
    // Repair (re-install over an existing package) is a recovery action, not a
    // primary one: it sits beside Remove as a quiet ghost button.
    const reinstall = async (btn: HTMLButtonElement): Promise<void> => {
      btn.disabled = true
      const previous = btn.textContent
      btn.textContent = t('webmcpPackagesInstalling')
      // Feedback token: a newer operation on this package invalidates this
      // one — its success must not announce an absent package.
      const token = nextFeedbackToken(pkg.id)
      try {
        clearBox()
        const result = await installRegistryPackage(registry, pkg)
        installed.add(pkg.id)
        activations[pkg.id] = 'disabled'
        // Success supersedes a stale failure: op A may have failed while op B
        // was still in flight, and B's completion must not leave A's red box
        // beside the green toast.
        clearBox()
        showOperationSuccess(token, t('webmcpPackagesInstallSuccess', [pkg.id, String(result.filesWritten)]))
      } catch (error) {
        if (isFeedbackCurrent(token)) showOperationError(error)
      } finally {
        btn.textContent = previous
        btn.disabled = false
        refresh()
      }
    }
    const install = button(isInstalled ? t('webmcpPackagesRepair') : t('webmcpPackagesInstall'), isInstalled ? 'ghost' : 'primary', async () => {
      await reinstall(install)
    })
    if (isInstalled) {
      const repair = button(t('webmcpPackagesRepair'), 'ghost', async () => {
        await reinstall(repair)
      })
      actions.append(repair)
      const uninstall = button(t('webmcpPackagesUninstall'), 'danger', async () => {
        uninstall.disabled = true
        const previous = uninstall.textContent
        uninstall.textContent = t('webmcpPackagesUninstalling')
        const token = nextFeedbackToken(pkg.id)
        try {
          clearBox()
          await uninstallRegistryPackage(pkg.id)
          // A toast still announcing this package's install would claim it is
          // installed after the user just removed it.
          showOperationRemoved(token)
        } catch (error) {
          if (isFeedbackCurrent(token)) showOperationError(error)
        } finally {
          uninstall.textContent = previous
          uninstall.disabled = false
          refresh()
        }
      })
      actions.append(uninstall)
    } else {
      actions.append(install)
    }
    row.append(body, actions)
    return row
  }

  /** Installed packages no loaded catalog lists (their registry was removed). */
  function buildOrphanRow(id: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'card pkg'
    const body = document.createElement('div')
    body.className = 'body'
    const titleLine = document.createElement('div')
    titleLine.className = 'title-line'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = id
    const state = document.createElement('span')
    state.className = 'state' + (activations[id] === 'enabled' ? '' : ' inactive')
    state.textContent = activations[id] === 'enabled'
      ? t('webmcpPackagesInstalledActive')
      : t('webmcpPackagesInstalledInactive')
    titleLine.append(name, sourceChip('registry'), state)
    const hint = document.createElement('div')
    hint.className = 'desc'
    hint.textContent = t('webmcpPackagesOrphanHint')
    body.append(titleLine, hint)
    const actions = document.createElement('div')
    actions.className = 'actions'
    const uninstall = button(t('webmcpPackagesUninstall'), 'danger', async () => {
      uninstall.disabled = true
      const previous = uninstall.textContent
      uninstall.textContent = t('webmcpPackagesUninstalling')
      const token = nextFeedbackToken(id)
      try {
        clearBox()
        await uninstallRegistryPackage(id)
        showOperationRemoved(token)
      } catch (error) {
        if (isFeedbackCurrent(token)) showOperationError(error)
      } finally {
        uninstall.textContent = previous
        uninstall.disabled = false
        refresh()
      }
    })
    actions.append(uninstall)
    row.append(body, actions)
    return row
  }

  function render(state: RegistryListResult): void {
    lastState = state
    installed = new Set(state.installed)
    activations = state.activations

    // Recompute the notice area from THIS state (findings: a recovered load
    // left its own failure on screen, and the session-only warning outlived the
    // persistence it warned about). A registry list that could not be persisted
    // reads back empty on the next load, so the user must know the list is
    // session-only — a NON-BLOCKING warning, never an operation failure, so it
    // does not dismiss the success toast. A failed OPERATION in the same box is
    // not state and stays until the user reads it.
    if (!operationErrorShown) {
      shell.error.clear()
      if (!state.persisted) shell.error.show(t('webmcpPackagesNotPersisted'))
    }

    // Drop the caches of registries the user removed: a catalog that outlives
    // its registry would keep that registry's package ids "known" (so an
    // install from it never became an orphan with an uninstall action) and a
    // re-added registry would show the old catalog without re-fetching.
    const configured = new Set(state.registries.map(registry => registry.manifestUrl))
    for (const manifestUrl of [...catalogs.keys()]) {
      if (configured.has(manifestUrl)) continue
      // Bump FIRST: a catalog request still in flight for this URL would
      // otherwise pass its epoch check and repopulate the cache we just dropped
      // (a registry removed here and re-added elsewhere would then show rows
      // from the old fetch).
      bumpCatalogEpoch(manifestUrl)
      catalogs.delete(manifestUrl)
      catalogLoadFailures.delete(manifestUrl)
      catalogRefreshFailures.delete(manifestUrl)
      catalogLoads.delete(manifestUrl)
      clearToolPreviews(manifestUrl)
    }

    const list = shell.list
    list.replaceChildren()
    shell.setCount(state.registries.length)
    if (!state.registries.length) {
      shell.empty('webmcpPackagesEmptyRegistry')
    } else {
      for (const registry of state.registries) {
        // Load the catalog for a registry the page has not seen yet, so a
        // registry added in a previous session shows its packages on open.
        // A FAILED auto-load is not retried here (the old page re-started the
        // same request on every render) — the Refresh button is the retry path.
        if (
          !catalogs.has(registry.manifestUrl) &&
          !catalogLoads.has(registry.manifestUrl) &&
          !catalogLoadFailures.has(registry.manifestUrl)
        ) {
          catalogLoads.add(registry.manifestUrl)
          const epoch = catalogEpochs.get(registry.manifestUrl) ?? 0
          void loadRegistryCatalog(registry)
            .then(manifest => {
              if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
                catalogs.set(registry.manifestUrl, manifest)
              }
            })
            .catch(error => {
              // A request superseded by a refresh / removal / re-add (epoch
              // bumped) says nothing about the CURRENT registry: recording it
              // would show a stale error and suppress the auto-load that is
              // legitimately due for the re-added registry.
              if ((catalogEpochs.get(registry.manifestUrl) ?? 0) !== epoch) return
              catalogLoadFailures.add(registry.manifestUrl)
              // Never REPLACE a failed operation the user has not read yet: the
              // card's red dot already carries this catalog failure, and the
              // section box is the only place an operation's detail appears.
              if (!operationErrorShown) shell.error.show(error)
            })
            .finally(() => {
              if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) catalogLoads.delete(registry.manifestUrl)
              rerender()
            })
        }
        list.append(buildRegistryCard(registry))
      }
    }

    // A catalog count for the summary strip: what can be installed right now.
    // Built from the CONFIGURED registries only — `catalogs` still holds
    // entries fetched for a registry that has since been removed, and those
    // ids must not count as "listed by a catalog" (below).
    const catalogIds = new Set<string>()
    for (const registry of state.registries) {
      const manifest = catalogs.get(registry.manifestUrl)
      if (manifest) for (const pkg of manifest.packages) catalogIds.add(pkg.id)
    }
    shell.setCount(state.registries.length, catalogIds.size)

    // Installed packages no catalog lists keep an uninstall path (a removed
    // registry must not strand them).
    const orphans = [...installed].filter(id => !catalogIds.has(id)).sort()
    for (const id of orphans) list.append(buildOrphanRow(id))
  }

  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = t('webmcpPackagesAddRegistryInputPlaceholder')
  const addButton = button(t('webmcpPackagesAddRegistryButton'), 'primary', () => void addSource())
  const addRow = document.createElement('div')
  addRow.className = 'add-row'
  addRow.append(input, addButton)
  const addHint = document.createElement('div')
  addHint.className = 'hint'
  addHint.textContent = t('webmcpPackagesAddRegistryHint')
  const addBox = document.createElement('div')
  addBox.className = 'add-box'
  addBox.append(addRow, addHint)
  shell.root.insertBefore(addBox, shell.list)

  async function addSource(): Promise<void> {
    const value = input.value.trim()
    if (!value) return
    addButton.disabled = true
    const previous = addButton.textContent
    addButton.textContent = t('webmcpPackagesAdding')
    try {
      clearBox()
      const registry = await addRegistry(value)
      // Fetch the catalog right away so the packages are visible without an
      // extra click. A failed auto-load of the SAME URL (re-added registry)
      // gets a fresh attempt — this is the explicit path.
      catalogLoadFailures.delete(registry.manifestUrl)
      catalogRefreshFailures.delete(registry.manifestUrl)
      // EPOCH GUARD: the re-add may race a refresh of the SAME URL still in
      // flight — store the catalog only when the epoch captured before the
      // fetch still matches.
      bumpCatalogEpoch(registry.manifestUrl)
      const epoch = catalogEpochs.get(registry.manifestUrl) ?? 0
      // THIS fetch owns the loading marker from here: the bump above invalidated
      // any in-flight auto-load for the same URL, and that request's `finally`
      // is epoch-guarded, so it will never clear the marker it set — without
      // taking it over here the card would pulse "refreshing" forever and no
      // automatic load would ever run again for this registry.
      catalogLoads.add(registry.manifestUrl)
      try {
        const manifest = await loadRegistryCatalog(registry)
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
          catalogs.set(registry.manifestUrl, manifest)
          catalogLoadFailures.delete(registry.manifestUrl)
          catalogRefreshFailures.delete(registry.manifestUrl)
        }
      } catch (error) {
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) {
          catalogLoadFailures.add(registry.manifestUrl)
          showOperationError(error)
        }
      } finally {
        if ((catalogEpochs.get(registry.manifestUrl) ?? 0) === epoch) catalogLoads.delete(registry.manifestUrl)
      }
      input.value = ''
    } catch (error) {
      showOperationError(error)
    } finally {
      addButton.textContent = previous
      addButton.disabled = false
      refresh()
    }
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void addSource()
    }
  })

  return {
    render,
    fail(error) {
      // A LOAD failure is state-derived: a later successful render clears it.
      operationErrorShown = false
      shell.error.show(error)
    },
  }
}
