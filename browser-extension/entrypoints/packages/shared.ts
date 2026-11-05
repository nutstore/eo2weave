/**
 * Shared primitives for the merged WebMCP packages page (issue #193).
 *
 * The page draws three source sections (built-in / registry / mine) that
 * share one card shape; everything they have in common lives here so a card
 * cannot drift between sections. Plain DOM, like the rest of the extension.
 */

import {
  deleteManagedPackage,
  setManagedPackageConfig,
  type ManagedWebMCPPackage,
} from '../webmcp/package-client'

/** Provenance of a package — DERIVED from mounts + install records, never declared. */
export type PackageSource = 'builtin' | 'registry' | 'mine'

const NO_INSTALLS: ReadonlySet<string> = new Set()

export function t(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key as never, substitutions as never) || key
}

/**
 * Classify one package:
 *
 *   builtin-webmcp (read-only)              → builtin
 *   webmcp + install record (DIRECTORY)     → registry
 *   webmcp without an install record        → mine (user / agent authored)
 *
 * Ownership is decided by the INSTALL DIRECTORY, never by the manifest id: the
 * installer names a package directory after the id it installs, and
 * `listInstalledPackageIds` reports those directory names. A user- or
 * agent-authored package whose manifest merely DECLARES an id that an installed
 * registry package also uses therefore stays "mine" — it has its own directory
 * and its own delete action — instead of disappearing from "mine" and being
 * handed the registry row's uninstall action (which removes the registry
 * install, not the authored package, while the page claimed otherwise).
 *
 * A registry install is deliberately NOT mirrored into "mine": two views
 * offering the same disable switch could disagree about the package's state.
 */
export function classifyPackage(
  entry: Pick<ManagedWebMCPPackage, 'mount' | 'directory'>,
  installedDirectories: ReadonlySet<string> = NO_INSTALLS,
): PackageSource {
  if (entry.mount === 'builtin-webmcp') return 'builtin'
  return installedDirectories.has(entry.directory) ? 'registry' : 'mine'
}

const SOURCE_LABEL: Record<PackageSource, string> = {
  builtin: 'webmcpSourceChipBuiltin',
  registry: 'webmcpSourceChipRegistry',
  mine: 'webmcpSourceChipMine',
}

export function sourceChip(source: PackageSource): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `src src-${source}`
  chip.textContent = t(SOURCE_LABEL[source])
  return chip
}

/**
 * One section's error area. Each section owns its own box (issue #193): a
 * failing source must never blank the sections that loaded fine — the old
 * pages put both loads behind one page-level box.
 */
export interface ErrorBox {
  readonly element: HTMLElement
  show(error: unknown): void
  clear(): void
}

export function createErrorBox(host: HTMLElement): ErrorBox {
  const box = document.createElement('p')
  box.className = 'error'
  box.setAttribute('role', 'alert')
  box.hidden = true
  const text = document.createElement('span')
  const dismiss = document.createElement('span')
  dismiss.className = 'dismiss'
  dismiss.setAttribute('role', 'button')
  dismiss.setAttribute('tabindex', '0')
  dismiss.setAttribute('aria-label', t('webmcpPackagesDismissError'))
  dismiss.textContent = '✕'
  const clear = (): void => {
    box.hidden = true
    text.textContent = ''
  }
  dismiss.addEventListener('click', clear)
  dismiss.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); clear() }
  })
  box.append(text, dismiss)
  host.append(box)
  return {
    element: box,
    show(error) {
      text.textContent = error instanceof Error ? error.message : String(error)
      box.hidden = false
    },
    clear,
  }
}

export interface SectionShell {
  readonly root: HTMLElement
  readonly list: HTMLElement
  readonly error: ErrorBox
  /** Heading count; `summaryValue` fills the page-level source strip. */
  setCount(count: number, summaryValue?: number): void
  empty(key: string): void
}

/**
 * Build one section: heading (label + live count + hint), its own error box,
 * and the list container the section fills. `summary` is the matching count in
 * the page-level source strip.
 */
export function createSection(
  host: HTMLElement,
  spec: { id: string; headingKey: string; hintKey: string; summary?: HTMLElement },
): SectionShell {
  const root = document.createElement('section')
  root.className = 'section'
  root.id = spec.id
  const title = document.createElement('div')
  title.className = 'section-title'
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = t(spec.headingKey)
  const count = document.createElement('span')
  count.className = 'count'
  count.textContent = '0'
  const hint = document.createElement('span')
  hint.className = 'hint'
  hint.textContent = t(spec.hintKey)
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  title.append(label, count, hint, spacer)
  const error = createErrorBox(root)
  const list = document.createElement('div')
  list.className = 'list'
  root.append(title, list)
  host.append(root)
  return {
    root,
    list,
    error,
    setCount(value, summaryValue = value) {
      count.textContent = String(value)
      if (spec.summary) spec.summary.textContent = String(summaryValue)
    },
    empty(key) {
      list.replaceChildren()
      const placeholder = document.createElement('div')
      placeholder.className = 'empty'
      placeholder.textContent = t(key)
      list.append(placeholder)
    },
  }
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `btn ${className}`
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}

/** Tool chips per card — a bounded set keeps a 40-tool package scannable. */
const MAX_TOOL_CHIPS = 6

export interface ManagedCardOptions {
  source: PackageSource
  error: ErrorBox
  /** Re-run the page's data load after a mutation. */
  refresh: () => void
  /** Draw the delete action (the rw mount only — built-ins cannot be deleted). */
  deletable?: boolean
}

function toolChips(tools: Array<{ name: string; description: string }>): HTMLElement {
  const chips = document.createElement('div')
  chips.className = 'tools'
  for (const tool of tools.slice(0, MAX_TOOL_CHIPS)) {
    const chip = document.createElement('span')
    chip.className = 'tool-chip'
    chip.textContent = tool.name
    chip.title = tool.description
    chips.append(chip)
  }
  const hidden = tools.slice(MAX_TOOL_CHIPS)
  if (hidden.length) {
    const more = document.createElement('span')
    more.className = 'tool-chip tool-more'
    more.textContent = `+${hidden.length}`
    more.title = hidden.map(tool => tool.name).join('\n')
    chips.append(more)
  }
  return chips
}

/**
 * One managed package card (ported from the recipes page, issue #193): name +
 * source chip + version, description, tools, diagnostics, and the activation
 * toggle. Delete is opt-in because the built-in mount is read-only.
 */
export function buildManagedCard(entry: ManagedWebMCPPackage, options: ManagedCardOptions): HTMLElement {
  const enabled = entry.activation === 'enabled'
  const card = document.createElement('div')
  card.className = 'card pkg' + (enabled ? '' : ' disabled')
  const body = document.createElement('div')
  body.className = 'body'
  const titleLine = document.createElement('div')
  titleLine.className = 'title-line'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = entry.manifest?.id ?? entry.directory
  const tools = entry.manifest?.tools ?? []
  const host = document.createElement('div')
  host.className = 'host'
  host.textContent = [
    t('webmcpPackagesVersion', entry.manifest?.version ?? '—'),
    t('webmcpPackagesToolsCount', String(tools.length)),
  ].join(' · ')
  titleLine.append(name, sourceChip(options.source), host)
  const desc = document.createElement('div')
  desc.className = 'desc'
  desc.textContent = entry.manifest?.description ?? ''
  const path = document.createElement('div')
  path.className = 'source-path'
  path.textContent = entry.uri + 'config.json'
  body.append(titleLine, desc)
  if (tools.length) body.append(toolChips(tools))
  if (entry.diagnostics.length) {
    const diagnostic = document.createElement('div')
    diagnostic.className = 'diagnostic'
    diagnostic.textContent = `${t('webmcpPackageInvalid')}: ${entry.diagnostics.join('; ')}`
    body.append(diagnostic)
  }
  body.append(path)

  const toggle = document.createElement('input')
  toggle.type = 'checkbox'
  toggle.className = 'toggle'
  toggle.checked = enabled
  toggle.setAttribute('aria-label', `${t('webmcpPackageActivation')}: ${entry.directory}`)
  // A package whose manifest is broken (or that is missing) cannot be
  // enabled — a config.json-only diagnostic is still fixable by toggling.
  toggle.disabled = !enabled && (!entry.manifest || entry.diagnostics.some(error => !error.startsWith('config.json:')))
  toggle.addEventListener('change', async () => {
    toggle.disabled = true
    options.error.clear()
    try {
      await setManagedPackageConfig(entry, { activation: toggle.checked ? 'enabled' : 'disabled' })
      options.refresh()
    } catch (error) {
      toggle.checked = enabled
      toggle.disabled = false
      options.error.show(error)
    }
  })
  const actions = document.createElement('div')
  actions.className = 'actions'
  actions.append(toggle)
  if (options.deletable) {
    const remove = button(t('webmcpPackageDelete'), 'danger', async () => {
      if (!window.confirm(t('webmcpPackageDeleteConfirm', [entry.manifest?.id ?? entry.directory, entry.uri]))) return
      remove.disabled = true
      const toggleDisabled = toggle.disabled
      toggle.disabled = true
      options.error.clear()
      try {
        await deleteManagedPackage(entry)
        options.refresh()
      } catch (error) {
        remove.disabled = false
        toggle.disabled = toggleDisabled
        options.error.show(error)
      }
    })
    actions.append(remove)
  }
  card.append(body, actions)
  return card
}

/**
 * Success feedback: a green toast pinned to the top of the page. It is NOT the
 * error alert (a success is not something to dismiss, and it must not shift
 * the layout) and it is page-level because an operation may be confirmed after
 * its section re-rendered.
 */
let successToastTimer: number | undefined
function dismissSuccess(): void {
  if (successToastTimer !== undefined) {
    window.clearTimeout(successToastTimer)
    successToastTimer = undefined
  }
  const toast = document.getElementById('successToast')
  if (!toast) return
  toast.classList.remove('visible')
  toast.setAttribute('aria-hidden', 'true')
}

function showSuccess(message: string, packageId?: string): void {
  let toast = document.getElementById('successToast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'successToast'
    toast.className = 'success-toast'
    toast.setAttribute('role', 'status')
    document.body.prepend(toast)
  }
  toast.textContent = message
  // role="status" stays in the accessibility tree while visually faded —
  // gate the region itself on visibility so a hidden toast is not announced.
  toast.setAttribute('aria-hidden', 'false')
  toast.classList.add('visible')
  if (successToastTimer !== undefined) window.clearTimeout(successToastTimer)
  successToastTimer = window.setTimeout(() => {
    toast?.classList.remove('visible')
    toast?.setAttribute('aria-hidden', 'true')
    successToastTimer = undefined
  }, 3500)
  successToastPackage = packageId
}

/**
 * Feedback tracking: the page has ONE toast but several per-package
 * operations may run concurrently. Each operation captures a PER-PACKAGE
 * generation at start; only the latest generation of the SAME package may
 * land feedback — another package's operation never invalidates it.
 */
const feedbackGenerations = new Map<string, number>()
export function nextFeedbackToken(packageId: string): string {
  const generation = (feedbackGenerations.get(packageId) ?? 0) + 1
  feedbackGenerations.set(packageId, generation)
  return `${packageId}#${generation}`
}

export function isFeedbackCurrent(token: string): boolean {
  const sep = token.lastIndexOf('#')
  return (feedbackGenerations.get(token.slice(0, sep)) ?? 0) === Number(token.slice(sep + 1))
}

/** The package the visible success toast is announcing. */
let successToastPackage: string | undefined

/** A stale op (a newer op on the SAME package started meanwhile) stays silent. */
export function showOperationSuccess(token: string, message: string): void {
  if (!isFeedbackCurrent(token)) return
  showSuccess(message, token.slice(0, token.lastIndexOf('#')))
}

/**
 * Removal completed: the toast announcing THIS package's earlier install must
 * go (it still claims the package is installed). An unrelated package's
 * confirmation is still true and stays up — the page has ONE toast, so only
 * the package that toast is actually announcing may take it down.
 */
export function showOperationRemoved(token: string): void {
  if (!isFeedbackCurrent(token)) return
  if (successToastPackage !== token.slice(0, token.lastIndexOf('#'))) return
  dismissSuccess()
  successToastPackage = undefined
}
