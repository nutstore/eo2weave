'use client'

/**
 * WebMCPPackageRegistrySection — settings section for the WebMCP package
 * registry installer (issue #117, Tier 1).
 *
 * Renders one card per user-added registry with its package catalog
 * (id / description / toolCount / version + install button). A collapsed
 * advanced row lets the user add a registry via the loose URL forms
 * (full GitHub URL / owner/repo shorthand / raw manifest URL).
 *
 * Installed packages show "Installed · inactive" — activation is
 * deliberately NOT possible from here: it happens through the #102 opt-in
 * flow (open the side panel on a matching site). Follows the existing
 * WebMCP settings-card visual language (bordered cards, tertiary text).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  addRegistry,
  registriesPersisted,
  installRegistryPackage,
  listInstalledPackageIds,
  listRegistries,
  loadRegistryCatalog,
  readInstalledPackageActivation,
  removeRegistry,
  uninstallRegistryPackage,
} from '@/webmcp/package-registry-store'
import { ADAPTER_PAGE_MARKER } from '@creatorweave/shared/webmcp-adapter-protocol'
import {
  boundToolIndex,
  indexedTools,
  MAX_PREVIEW_TOOLS,
  packageMatchesFilter,
  reconcileToolIndex,
  runPreviewPass,
  SEARCH_MIN_PACKAGES,
  toolIndexKey,
  toolIndexPrefix,
  toolMatchCount,
  toolWindow,
  type PreviewTool,
  type ToolIndex,
} from '@/webmcp/registry-filter'
import type { PackageRegistry, RegistryManifest, RegistryManifestPackage } from '@/webmcp/package-registry-client'

interface WebMCPPackageRegistrySectionProps {
  t: (key: string) => string
}

/** Bound for the section's own manifest.json preview fetches. */
const REGISTRY_PREVIEW_TIMEOUT_MS = 30_000

/**
 * Read a preview response under a byte cap (finding: "Registry bodies hang
 * or exhaust memory"; round-3: "Preview size cap buffers full response").
 * The cap is enforced WHILE the body streams — buffering `text()` first let
 * an oversized body exhaust page memory before the check ran, and the
 * fallback `json()` path had no cap at all. Test doubles without a
 * streaming body get the same limit applied to their buffered text.
 */
async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  // A declared content-length over the cap rejects before any body read.
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response exceeds the size limit (${maxBytes} bytes)`)
  }
  const reader = response.body?.getReader?.()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new Error(`Response exceeds the size limit (${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(merged))
  }
  // No streaming body (test doubles): cap the buffered text by its UTF-8
  // byte size, which is what the wire limit counts.
  if (typeof response.text === 'function') {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > maxBytes) {
      throw new Error(`Response exceeds the size limit (${maxBytes} bytes)`)
    }
    return JSON.parse(text)
  }
  return response.json()
}

function format(message: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    // Function replacement: `$&`-style sequences in error text (URLs) would
    // otherwise be expanded by String.replace.
    (text, [key, value]) => text.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value)),
    message,
  )
}


/**
 * Map a thrown error to a LOCALIZED message key (finding: "Error details
 * ignore selected locale" — raw English exception text interpolated into a
 * localized template stays English for every other locale). Known error
 * shapes get their own key; anything unknown falls back to a generic
 * localized failure message with the diagnostic text as a secondary detail.
 */
function errorKeyFor(message: string): { key: string; values?: Record<string, string> } {
  const m = message.toLowerCase()
  if (m.includes('timed out') || m.includes('timeout')) return { key: 'settings.webmcpPackages.errorTimeout' }
  if (m.includes('not found') || m.includes('http 404')) return { key: 'settings.webmcpPackages.errorNotFound' }
  if (m.includes('size limit') || m.includes('exceeds') || m.includes('too large')) return { key: 'settings.webmcpPackages.errorTooLarge' }
  if (m.includes('unreachable') || m.includes('network') || m.includes('failed to fetch')) return { key: 'settings.webmcpPackages.errorUnreachable' }
  if (m.includes('busy') || m.includes('in progress')) return { key: 'settings.webmcpPackages.errorBusy' }
  if (m.startsWith('cannot install')) return { key: 'settings.webmcpPackages.errorCollision', values: { detail: message } }
  return { key: 'settings.webmcpPackages.errorGeneric', values: { detail: message } }
}

/** Localized text for a thrown error (see `errorKeyFor`). */
function localizedError(t: (key: string) => string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const { key, values } = errorKeyFor(message)
  return values ? format(t(key), values) : t(key)
}

interface RegistryCardProps {
  t: (key: string) => string
  registry: PackageRegistry
  installedIds: Set<string>
  /** Activation state per installed id (read from the package config). */
  activations: Map<string, 'enabled' | 'disabled'>
  busyId: string | null
  /** Cached tool lists per (registry, pkg) from the section (filled by readToolCount). */
  toolIndex: ToolIndex
  /** Section-level filter query; empty string shows everything. */
  filter: string
  /**
   * Cache a package's validated tool list in the section-level index
   * (issue #187). `generation` is the catalog-load epoch the read ran
   * against — the section drops writes from older generations so a stale
   * in-flight response can never overwrite newer tools (round-6: "Older
   * previews overwrite current tools"). `null` removes a stale entry
   * (failed re-preview).
   */
  onTools: (registryUrl: string, pkgId: string, version: string, generation: number, tools: PreviewTool[] | null) => void
  /**
   * Report this registry's current catalog (gates the search input and
   * lets the section reconcile its index against packages that were
   * removed or bumped to another version).
   */
  onCatalog: (registryUrl: string, packages: ReadonlyArray<{ id: string; version: string }>) => void
  onInstall: (registry: PackageRegistry, pkg: RegistryManifestPackage, verifiedToolCount: number) => Promise<boolean>
  onUninstall: (pkgId: string) => Promise<boolean>
  onRemoveRegistry: (registry: PackageRegistry) => void
}

function RegistryCard({ t, registry, installedIds, activations, busyId, toolIndex, filter, onTools, onCatalog, onInstall, onUninstall, onRemoveRegistry }: RegistryCardProps) {
  const [manifest, setManifest] = useState<RegistryManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  /**
   * Tool count per package id + version, taken from the package's OWN
   * manifest.json (the file the extension validates). The registry's
   * `toolCount` is a publisher-provided claim and may disagree with the
   * package contents — the verified count is shown instead so the catalog
   * never misleads.
   */
  const [verifiedToolCounts, setVerifiedToolCounts] = useState<Map<string, { count: number; version: string }>>(new Map())
  /** Packages whose preview manifest could not be read (count shown as unverified). */
  const [unverifiedCounts, setUnverifiedCounts] = useState<Set<string>>(new Set())
  void unverifiedCounts

  const load = useCallback(async (force: boolean) => {
    setRefreshing(true)
    setError(null)
    try {
      setManifest(await loadRegistryCatalog(registry, { force }))
      catalogGeneration.current += 1
    } catch (err) {
      setError(localizedError(t, err))
    } finally {
      setRefreshing(false)
    }
  }, [registry])

  /**
   * Catalog-load epoch. Every completed `loadRegistryCatalog` bumps it; the
   * generated `onTools` closure stamps writes with the value live when the
   * preview REQUEST started, so a manifest read that races a refresh (starts
   * before, resolves after the newer generation's write) is dropped by the
   * section instead of overwriting fresh tools (round-6: "Older previews
   * overwrite current tools").
   */
  const catalogGeneration = useRef(0)

  useEffect(() => {
    void load(false)
  }, [load])

  // Report the catalog so the section can gate the search input (issue #187)
  // and reconcile its tool index against the current packages.
  useEffect(() => {
    if (manifest) onCatalog(registry.manifestUrl, manifest.packages)
  }, [manifest, registry.manifestUrl, onCatalog])

  /** Read one package's manifest.json and record its real tool count. */
  const readToolCount = useCallback(async (pkgId: string, version: string, generation: number) => {
    try {
      const { registryFileUrl, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES } = await import('@/webmcp/package-registry-client')
      const response = await fetch(registryFileUrl(registry, `packages/${pkgId}/manifest.json`), {
        credentials: 'omit',
        // Same bound as every other registry request (finding: "Registry
        // bodies hang or exhaust memory") — a stalled or oversized package
        // manifest must not hang the settings page.
        signal: AbortSignal.timeout(REGISTRY_PREVIEW_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await readJsonCapped(response, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES) as { id?: unknown; version?: unknown; tools?: unknown }
      if (!Array.isArray(data.tools)) throw new Error('The package manifest lists no tools')
      // The count is only VERIFIED for the catalog entry the preview was
      // requested for (round-5 finding: "Stale preview count appears
      // verified"): a CDN or proxy serving a manifest of a DIFFERENT id or
      // version must not have its tool count recorded under the current
      // catalog version — it would be shown as verified in the card and the
      // install confirmation for a package the user never previewed.
      if (data.id !== pkgId || data.version !== version) {
        throw new Error('The preview manifest does not match the catalog entry')
      }
      const tools = (data.tools as unknown[]).filter(isPreviewTool)
      // Same tool-count bound as the package validator (round-7: "Expanded
      // previews render unbounded tool rows"): the 512 KiB byte cap bounds
      // the manifest BODY, not the row count — a catalog carrying thousands
      // of minimal tool entries is an invalid package, and its extra rows
      // must not reach the DOM or the search index.
      if (tools.length > MAX_PREVIEW_TOOLS) throw new Error('The package manifest lists too many tools')
      const count = tools.length
      // Cache the tool list for the section-level search (issue #187): the
      // same manifest pass that verifies the count also feeds the tool-name
      // filter — the data was fetched and thrown away before. The request's
      // catalog-generation stamp lets the section drop a manifest read that
      // raced a refresh, so an older response can never overwrite the tools
      // the newer catalog recorded (round-6: "Older previews overwrite
      // current tools").
      onTools(registry.manifestUrl, pkgId, version, generation, tools)
      // Record the count TOGETHER with the catalog version it was verified
      // for (round-3 finding: "Refresh shows stale tool count"): a catalog
      // refresh that bumps the version drops the stale entry immediately,
      // so the card and the install confirmation cannot act on a count
      // read for an older package version.
      setUnverifiedCounts(previous => {
        if (!previous.has(pkgId)) return previous
        const next = new Set(previous)
        next.delete(pkgId)
        return next
      })
      setVerifiedToolCounts(previous => {
        const next = new Map(previous)
        next.set(pkgId, { count, version })
        return next
      })
    } catch {
      // Preview failed (finding: "Failed preview shows claimed count"): the
      // registry's claim must NOT keep masquerading as a verified count —
      // record the failure so the UI shows the count as unverified.
      setUnverifiedCounts(previous => {
        if (previous.has(pkgId)) return previous
        const next = new Set(previous)
        next.add(pkgId)
        return next
      })
      setVerifiedToolCounts(previous => {
        if (!previous.has(pkgId)) return previous
        const next = new Map(previous)
        next.delete(pkgId)
        return next
      })
      // Drop any tool-index entry the earlier version recorded (round-6:
      // "Removed tool lists consume memory") — keeping it would both leak
      // the array and keep matching searches against stale tools.
      // A null write only clears a SAME-generation entry (round-7: "Failed
      // count read deletes tools"): if the expanded card preview already
      // stored a valid list for this generation, this failure must not
      // delete it — pass generation - 1 so the staleness gate rejects the
      // removal while an equal-or-newer write exists.
      onTools(registry.manifestUrl, pkgId, version, Math.max(0, generation - 1), null)
    }
  }, [registry, onTools])

  useEffect(() => {
    // Bound concurrent preview fetches (finding: "Large catalogs overwhelm
    // settings"): at most PREVIEW_CONCURRENCY manifest requests run at once;
    // the rest queue behind them. The catalog generation is captured HERE,
    // when the work is scheduled, and travels with every queued read: a
    // preview that waited through a refresh keeps its older stamp, so the
    // section rejects its response instead of letting it overwrite the
    // refreshed tools (finding: "Old previews overwrite refreshed results").
    void runPreviewPass(
      manifest?.packages ?? [],
      catalogGeneration.current,
      (pkg, generation) => readToolCount(pkg.id, pkg.version, generation),
    )
  }, [manifest, readToolCount])

  /** Verified count for the CURRENT catalog version, else null (unverified). */
  const verifiedCountOf = useCallback((pkg: RegistryManifestPackage): number | null => {
    const verified = verifiedToolCounts.get(pkg.id)
    return verified && verified.version === pkg.version ? verified.count : null
  }, [verifiedToolCounts])

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 shrink-0 text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{registry.label}</div>
          <div className="truncate font-mono text-xs text-tertiary">{registry.manifestUrl}</div>
        </div>
        <button
          type="button"
          className="rounded p-1.5 text-tertiary hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-700"
          disabled={refreshing}
          title={t('settings.webmcpPackages.refresh')}
          onClick={() => void load(true)}
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-tertiary hover:bg-neutral-100 dark:hover:bg-neutral-700"
          title={t('settings.webmcpPackages.removeRegistry')}
          onClick={() => onRemoveRegistry(registry)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{format(t('settings.webmcpPackages.loadFailed'), { error })}</span>
        </div>
      )}

      {manifest && manifest.packages.length === 0 && (
        <div className="mt-2 text-xs text-tertiary">{t('settings.webmcpPackages.noPackages')}</div>
      )}

      <div className="mt-2 space-y-2">
        {manifest?.packages.filter(pkg => packageMatchesFilter(pkg, toolIndex.get(toolIndexKey(registry.manifestUrl, pkg.id)), filter)).map((pkg) => {
          const installed = installedIds.has(pkg.id)
          const busy = busyId === pkg.id
          const expanded = expandedId === pkg.id
          // The verified count (from the package manifest) wins over the
          // registry's claim — but only while it matches the CURRENT catalog
          // version and the preview actually succeeded (findings: "Failed
          // preview shows claimed count" / "Refresh shows stale tool
          // count"). An unverified count falls back to the claim and is
          // marked as such so the user never confirms an install against a
          // number presented as verified.
          const verifiedCount = verifiedCountOf(pkg)
          const toolCount = verifiedCount ?? pkg.toolCount
          const countUnverified = verifiedCount === null
          const active = installed && activations.get(pkg.id) === 'enabled'
          // "matches N tools" hint (issue #187): shown only when the query
          // hit this package's TOOLS rather than its id/description.
          const toolMatches = toolMatchCount(pkg, indexedTools(toolIndex, registry.manifestUrl, pkg), filter)
          return (
            <div key={pkg.id} className="rounded-md border border-neutral-200 p-2.5 dark:border-neutral-700">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  className="mt-0.5 rounded p-0.5 text-tertiary hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : pkg.id)}
                >
                  {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs font-medium">{pkg.id}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-tertiary">{pkg.description}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-tertiary">
                    <span>
                      {format(t('settings.webmcpPackages.toolsCount'), { count: toolCount })}
                      {countUnverified ? ` ${t('settings.webmcpPackages.toolsCountUnverified')}` : ''}
                    </span>
                    <span>·</span>
                    <span>{format(t('settings.webmcpPackages.version'), { version: pkg.version })}</span>
                  </div>
                  {toolMatches > 0 && (
                    <div className="mt-0.5 text-xs text-tertiary">
                      {format(t('settings.webmcpPackages.matchesTools'), { count: toolMatches })}
                    </div>
                  )}
                  {installed && (
                    <div className="mt-1.5">
                      <span className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-tertiary dark:border-neutral-600">
                        <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                        {active ? t('settings.webmcpPackages.installedActive') : t('settings.webmcpPackages.installedInactive')}
                      </span>
                      {/* The "enable it" hint only makes sense while the
                          package is still inactive. */}
                      {!active && (
                        <div className="mt-1 text-xs text-tertiary">{t('settings.webmcpPackages.installedInactiveHint')}</div>
                      )}
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  {installed ? (
                    <button
                      type="button"
                      className="rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                      disabled={busy}
                      onClick={() => void onUninstall(pkg.id)}
                    >
                      {busy ? t('settings.webmcpPackages.uninstalling') : t('settings.webmcpPackages.uninstall')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void onInstall(registry, pkg, verifiedCount ?? Number.NaN)}
                    >
                      {busy ? t('settings.webmcpPackages.installing') : t('settings.webmcpPackages.install')}
                    </button>
                  )}
                </div>
              </div>
              {expanded && manifest && (
                <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-700">
                  <ToolCatalogPreview registry={registry} pkg={pkg} tools={indexedTools(toolIndex, registry.manifestUrl, pkg) ?? null} onTools={onTools} generation={catalogGeneration.current} t={t} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Expandable per-package tool list. Tool names/descriptions come from the
 * package's own manifest.json — fetched through the same raw base with the
 * registry client (read-only, no credentials).
 *
 * Every entry is validated BEFORE it reaches state (round-5 finding:
 * "Malformed preview crashes settings"): the remote manifest is untrusted
 * input, and a `null` or non-object entry used to be dereferenced during
 * render, throwing and taking the whole settings section down. A manifest
 * without well-formed tool entries renders the unavailable-preview
 * fallback instead.
 */

function isPreviewTool(value: unknown): value is PreviewTool {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as PreviewTool).name === 'string' && (value as PreviewTool).name !== '' &&
    typeof (value as PreviewTool).description === 'string'
  )
}

function ToolCatalogPreview({ registry, pkg, tools, onTools, generation, t }: { registry: PackageRegistry; pkg: RegistryManifestPackage; tools: PreviewTool[] | null; onTools: (registryUrl: string, pkgId: string, version: string, generation: number, tools: PreviewTool[] | null) => void; generation: number; t: (key: string) => string }) {
  const [expanded, setExpanded] = useState(false)
  const [fetched, setFetched] = useState<PreviewTool[] | null>(null)

  useEffect(() => {
    // Section-level cache hit (issue #187): the readToolCount pass already
    // fetched this manifest — reuse its tools instead of a second request.
    if (tools !== null) {
      setFetched(null)
      return
    }
    let disposed = false
    void (async () => {
      try {
        const { registryFileUrl, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES } = await import('@/webmcp/package-registry-client')
        const response = await fetch(registryFileUrl(registry, `packages/${pkg.id}/manifest.json`), {
          credentials: 'omit',
          signal: AbortSignal.timeout(REGISTRY_PREVIEW_TIMEOUT_MS),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await readJsonCapped(response, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES) as { id?: unknown; version?: unknown; tools?: unknown }
        // Keep only well-formed entries; anything else (null, a number, a
        // nameless object) makes the preview unavailable rather than crash.
        const validated = Array.isArray(data.tools) ? data.tools.filter(isPreviewTool) : []
        // Same tool-count bound as `readToolCount` (round-7: "Expanded
        // previews render unbounded tool rows") — the expanded branch
        // renders the whole list, so an oversized array must fail the
        // preview instead of stalling the settings page.
        if (validated.length > MAX_PREVIEW_TOOLS) throw new Error('The package manifest lists too many tools')
        // The entry is only recorded for the catalog entry the preview was
        // requested for — same identity rule as `readToolCount` (a proxy
        // serving a different package's manifest must not poison the index).
        if (data.id !== pkg.id || data.version !== pkg.version) throw new Error('The preview manifest does not match the catalog entry')
        if (!disposed) {
          // A successful fallback fetch feeds the SECTION-level index too
          // (round-6: "Fetched preview remains unsearchable") — a tool the
          // expanded card can show must also be findable by the filter, and
          // this reuses the same single write path (no second cache). The
          // fetch started under the CURRENT catalog generation, which is
          // exactly the stamp the section's staleness gate expects here.
          onTools(registry.manifestUrl, pkg.id, pkg.version, generation, validated)
          setFetched(validated)
        }
      } catch {
        if (!disposed) setFetched([])
      }
    })()
    return () => { disposed = true }
  }, [registry, pkg.id, pkg.version, tools, onTools, generation])

  const catalog = tools ?? fetched
  if (catalog === null) return <div className="text-xs text-tertiary">…</div>
  if (catalog.length === 0) return <div className="text-xs text-tertiary">—</div>
  // The window only applies to the COLLAPSED preview (round-6 High:
  // "More tools stay hidden") — once the user expands, they asked for the
  // whole catalog; windowing again behind the "More" button would make the
  // hidden entries unreachable.
  const { visible, hiddenCount } = expanded
    ? { visible: catalog, hiddenCount: 0 }
    : toolWindow(catalog)
  return (
    <div>
      <ul className={`space-y-1 ${expanded ? 'max-h-56 overflow-y-auto' : ''}`}>
        {visible.map(tool => (
          <li key={tool.name} className="flex items-baseline gap-2 text-xs">
            <span className="shrink-0 font-mono text-tertiary">{tool.name}</span>
            <span className="truncate text-tertiary">{tool.description}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="mt-1 text-xs text-tertiary hover:text-primary"
          onClick={() => setExpanded(true)}
        >
          {format(t('settings.webmcpPackages.moreTools'), { count: catalog.length })}
        </button>
      )}
    </div>
  )
}

export function WebMCPPackageRegistrySection({ t }: WebMCPPackageRegistrySectionProps) {
  const [registries, setRegistries] = useState<PackageRegistry[]>([])
  /** Live mirror of `registries` for listeners that must not re-subscribe. */
  const registriesRef = useRef<PackageRegistry[]>([])
  const [installedIds, setInstalledIds] = useState<Set<string>>(new Set())
  /** Activation state per installed id, read from the package config. */
  const [activations, setActivations] = useState<Map<string, 'enabled' | 'disabled'>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmPkg, setConfirmPkg] = useState<{
    registry: PackageRegistry
    pkg: RegistryManifestPackage
    /** Tool count VERIFIED from the package manifest (NaN when unverified). */
    verifiedToolCount: number
  } | null>(null)
  /**
   * Refresh generation. Two overlapping refreshes can resolve out of order;
   * an older read must never overwrite a newer one, or an installed package
   * would appear uninstalled and could be installed a second time.
   */
  const refreshGeneration = useRef(0)
  /** Section-level search (issue #187): filter text shared by all cards. */
  const [filter, setFilter] = useState('')
  /**
   * Validated tool lists, keyed by registry + package (round-6:
   * "Registries share tool results" — two registries may publish the same
   * package ID; keying by ID alone let one registry's list overwrite the
   * other's). Filled by each card's preview pass; entries are removed when
   * the version goes stale or the registry goes away.
   */
  const [toolIndex, setToolIndex] = useState<ToolIndex>(new Map())
  /**
   * Latest accepted request generation per index key (round-6: "Older
   * previews overwrite current tools"). Overlapping requests resolve out of
   * order — a manifest read started before a catalog refresh must never
   * overwrite the entry the newer generation recorded, so writes from an
   * older generation (and stale removals) are dropped here.
   */
  const toolGenerations = useRef<Map<string, number>>(new Map())

  /**
   * Registries that were removed while this section was mounted. Their
   * in-flight manifest reads must not recreate the deleted tool-index
   * entries (round-7: "Removed previews repopulate cache"); the tombstone
   * is dropped when the registry is added again.
   */
  const removedRegistries = useRef<Set<string>>(new Set())

  const handleTools = useCallback((registryUrl: string, pkgId: string, version: string, generation: number, tools: PreviewTool[] | null) => {
    const key = toolIndexKey(registryUrl, pkgId)
    // A write for a REMOVED registry is dropped outright (round-7: "Removed
    // previews repopulate cache"): the manifest read was still in flight
    // when the registry was removed and must not recreate its entries.
    if (removedRegistries.current.has(registryUrl)) return
    const seen = toolGenerations.current.get(key) ?? 0
    if (generation < seen) return
    toolGenerations.current.set(key, generation)
    setToolIndex(previous => {
      const cached = previous.get(key)
      if (tools === null) {
        if (!cached) return previous
        const next = new Map(previous)
        next.delete(key)
        return next
      }
      // Same version and same content → same state: keeps the Map identity
      // stable so the cards' memo/effect chains do not re-run for repeated
      // previews. Content equality, not length equality — a refresh can
      // change tool names/descriptions without changing the count (round-6:
      // "Updated tools stay stale").
      if (
        cached &&
        cached.version === version &&
        cached.tools.length === tools.length &&
        cached.tools.every((tool, i) => tool.name === tools[i]!.name && tool.description === tools[i]!.description)
      ) {
        return previous
      }
      const next = new Map(previous)
      next.set(key, { version, tools })
      // Aggregate bound (finding: "Search metadata grows without bound"):
      // whole registries are evicted oldest-first once the retained tool
      // metadata exceeds the cap. Their generation marks go with them.
      const bounded = boundToolIndex(next)
      if (bounded !== next) {
        for (const mark of toolGenerations.current.keys()) {
          if (!bounded.has(mark)) toolGenerations.current.delete(mark)
        }
      }
      return bounded
    })
  }, [])

  /** Total catalog size across registries — gates the search input. */
  const packageCounts = useRef<Map<string, number>>(new Map())

  const recalcTotalPackages = () => {
    setTotalPackages([...packageCounts.current.values()].reduce((sum, count) => sum + count, 0))
  }

  /**
   * Report one registry's catalog: its size gates the search input, and the
   * package list reconciles the tool index so packages that were removed or
   * bumped to another version stop matching searches (finding: "Obsolete
   * tools remain searchable").
   */
  const handleCatalog = useCallback((registryUrl: string, packages: ReadonlyArray<{ id: string; version: string }>) => {
    packageCounts.current.set(registryUrl, packages.length)
    recalcTotalPackages()
    setToolIndex(previous => reconcileToolIndex(previous, registryUrl, packages))
  }, [])

  /**
   * Forget everything one registry contributed to the search state
   * (round-6: "Removed catalogs inflate totals" + "Removed tool lists
   * consume memory"; round-7: "Removed catalogs stay counted") — a
   * retained package count keeps the search input visible for a catalog
   * that no longer exists, and retained tool arrays keep leaking memory
   * while every search keeps scanning them.
   */
  const forgetRegistrySearchState = useCallback((registryUrl: string) => {
    packageCounts.current.delete(registryUrl)
    recalcTotalPackages()
    const prefix = toolIndexPrefix(registryUrl)
    // The generation high-water marks go WITH the index entries (round-7:
    // "Re-added tools stay unsearchable"): a registry removed and re-added
    // at the same URL gets a fresh RegistryCard whose generation starts at
    // 0 — retained marks would make `handleTools` reject its preview
    // writes until the new card caught up, leaving it unsearchable.
    for (const key of toolGenerations.current.keys()) {
      if (key.startsWith(prefix)) toolGenerations.current.delete(key)
    }
    // The registry itself is tombstoned (round-7: "Removed previews
    // repopulate cache"): a manifest read that was still in flight when
    // the registry was removed must not recreate the deleted entries. The
    // tombstone is dropped as soon as the registry is present again.
    removedRegistries.current.add(registryUrl)
    setToolIndex(previous => {
      let changed = false
      const next = new Map(previous)
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])

  const [totalPackages, setTotalPackages] = useState(0)

  // The search input only renders while the total exceeds the threshold;
  // with the input hidden there is no way to clear an active query, and it
  // would keep silently filtering the cards (round-6: "Hidden search keeps
  // filtering") — drop the filter as soon as the input unmounts.
  const showSearch = totalPackages > SEARCH_MIN_PACKAGES
  useEffect(() => {
    if (!showSearch && filter !== '') setFilter('')
  }, [showSearch, filter])

  const refreshInstalled = useCallback(async () => {
    const generation = refreshGeneration.current + 1
    refreshGeneration.current = generation
    const ids = await listInstalledPackageIds()
    const states = await Promise.all([...ids].map(async id => [id, await readInstalledPackageActivation(id)] as const))
    // A stale read (an older generation that resolved last) is dropped.
    if (refreshGeneration.current !== generation) return
    setInstalledIds(ids)
    setActivations(new Map(states))
  }, [])

  useEffect(() => {
    setRegistries(listRegistries())
    void refreshInstalled()
  }, [refreshInstalled])

  useEffect(() => {
    registriesRef.current = registries
  }, [registries])

  useEffect(() => {
    // Another settings tab may add or remove a registry while this section
    // stays mounted (finding: "Registry list stays stale across tabs"): the
    // store's reconciliation state updates on the storage event, but this
    // component's `registries` state does not — reload both the registry
    // list and the installed state when the persisted list changes.
    // The storage event fires only in tabs OTHER than the writer; the
    // writer updates its own state through its action handlers.
    const listener = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key === 'webmcp_package_registries') {
        const previousUrls = new Set(registriesRef.current.map(r => r.manifestUrl))
        const nextRegistries = listRegistries()
        setRegistries(nextRegistries)
        void refreshInstalled()
        // The writer tab's removal handler does not run HERE, so this
        // section's search state must be reconciled against the updated
        // list (round-7: "Removed catalogs stay counted"): drop the
        // removed registries' package counts (the search-input gate) and
        // tool-index/generation entries (memory + stale matches), exactly
        // as the local removal handler does.
        const nextUrls = new Set(nextRegistries.map(r => r.manifestUrl))
        for (const url of previousUrls) {
          if (!nextUrls.has(url)) forgetRegistrySearchState(url)
        }
        // A registry that is present again is no longer tombstoned — its
        // previews must be able to write to the index again.
        for (const url of nextUrls) removedRegistries.current.delete(url)
      }
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, [refreshInstalled, forgetRegistrySearchState])

  useEffect(() => {
    // The side-panel opt-in flow enables packages OUTSIDE this section. The
    // background announces every catalog change with `webmcp_packages_changed`
    // to extension pages AND to tabs, where the webmcp.content relay
    // rebroadcasts it as a `packages-changed` window event — page JS cannot
    // receive chrome.runtime broadcasts directly, so the window event is the
    // only channel that reaches this section (finding: "Activation badge
    // stays stale"; the earlier chrome.runtime listener was dead code).
    const listener = (event: MessageEvent) => {
      const data = event.data as { [key: string]: unknown; kind?: unknown } | null
      if (
        event.source === window &&
        data?.[ADAPTER_PAGE_MARKER] === true &&
        data.kind === 'packages-changed'
      ) {
        void refreshInstalled()
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [refreshInstalled])

  const handleAdd = async () => {
    if (!input.trim()) return
    setAdding(true)
    setAddError(null)
    try {
      const registry = addRegistry(input)
      const added = listRegistries()
      // A registry that is added again is no longer tombstoned — its
      // previews must be able to write to the index again (round-7: "Re-added
      // tools stay unsearchable").
      for (const entry of added) removedRegistries.current.delete(entry.manifestUrl)
      setRegistries(added)
      if (!registriesPersisted()) {
        // Private mode / storage failure: the registry lives in the session
        // mirror only — keep the form open and say so instead of letting the
        // addition silently vanish on reload (finding: "Registry addition
        // disappears in private mode").
        setAddError(format(t('settings.webmcpPackages.addSessionOnly'), { label: registry.label }))
        setAdding(false)
        return
      }
      setInput('')
      setAddOpen(false)
      void registry
    } catch (err) {
      setAddError(localizedError(t, err))
    } finally {
      setAdding(false)
    }
  }

  const handleInstall = async (registry: PackageRegistry, pkg: RegistryManifestPackage): Promise<boolean> => {
    setBusyId(pkg.id)
    try {
      const result = await installRegistryPackage(registry, pkg)
      await refreshInstalled()
      // Finding: "Refresh failure leaves stale tools" — a background refresh
      // the extension did NOT confirm must not render as a fully clean
      // install: the files are committed, but the extension's tool catalog
      // may lag until the next refresh. Surface it through the same inline
      // error channel (non-fatal for the flow).
      setActionError(result.catalogRefreshed
        ? null
        : t('settings.webmcpPackages.catalogRefreshUnavailable'))
      setConfirmPkg(null)
      return true
    } catch (error) {
      setActionError(localizedError(t, error))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const handleUninstall = async (pkgId: string): Promise<boolean> => {
    setBusyId(pkgId)
    try {
      const result = await uninstallRegistryPackage(pkgId)
      await refreshInstalled()
      setActionError(result.catalogRefreshed
        ? null
        : t('settings.webmcpPackages.catalogRefreshUnavailable'))
      return true
    } catch (error) {
      setActionError(localizedError(t, error))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const handleRemoveRegistry = (registry: PackageRegistry) => {
    removeRegistry(registry.manifestUrl)
    setRegistries(listRegistries())
    // Forget everything only this registry contributed (round-6: "Removed
    // catalogs inflate totals" + "Removed tool lists consume memory";
    // round-7: "Re-added tools stay unsearchable" / "Removed previews
    // repopulate cache").
    forgetRegistrySearchState(registry.manifestUrl)
  }

  const hasRegistries = useMemo(() => registries.length > 0, [registries.length])

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-semibold">{t('settings.webmcpPackages.title')}</div>
        <div className="mt-0.5 text-xs text-tertiary">{t('settings.webmcpPackages.description')}</div>
        {actionError && (
          <button
            type="button"
            className="mt-1.5 flex items-start gap-1.5 text-left text-xs text-red-600 dark:text-red-400"
            onClick={() => setActionError(null)}
            title={t('settings.webmcpPackages.dismissError')}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{format(t('settings.webmcpPackages.actionFailed'), { error: actionError })}</span>
          </button>
        )}
      </div>

      {showSearch && (
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('settings.webmcpPackages.searchPlaceholder')}
          className="w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600"
        />
      )}

      {!hasRegistries && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-tertiary dark:border-neutral-700">
          {t('settings.webmcpPackages.noRegistries')}
        </div>
      )}

      {registries.map(registry => (
        <RegistryCard
          key={registry.manifestUrl}
          t={t}
          registry={registry}
          installedIds={installedIds}
          activations={activations}
          busyId={busyId}
          toolIndex={toolIndex}
          filter={filter}
          onTools={handleTools}
          onCatalog={handleCatalog}
          onInstall={(reg, pkg, verifiedCount) => {
            // The confirmation discloses the count VERIFIED from the package
            // manifest (finding: "Confirmation shows wrong tool count") — an
            // unreadable manifest passes NaN and the confirmation states the
            // count could not be verified instead of quoting the claim.
            setConfirmPkg({ registry: reg, pkg, verifiedToolCount: verifiedCount })
            return Promise.resolve(true)
          }}
          onUninstall={handleUninstall}
          onRemoveRegistry={handleRemoveRegistry}
        />
      ))}

      {/*
        Installed-packages inventory (round-3 finding: "Removing registry
        hides uninstall action"): removal deliberately leaves installed
        packages in place, but the registry cards above are the ONLY place
        uninstall buttons were rendered — remove the registry and its
        packages became unremovable until the user re-added it. This
        inventory lists every installed package directly from the mount,
        independent of any registry, so uninstall stays reachable.
      */}
      {installedIds.size > 0 && (
        <div className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
          <div className="text-xs font-semibold">{t('settings.webmcpPackages.installedTitle')}</div>
          <div className="mt-2 space-y-1.5">
            {[...installedIds].sort().map(pkgId => {
              const busy = busyId === pkgId
              const active = activations.get(pkgId) === 'enabled'
              return (
                <div key={pkgId} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs font-medium">{pkgId}</div>
                    <span className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2 py-0.5 text-xs text-tertiary dark:border-neutral-600">
                      <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                      {active ? t('settings.webmcpPackages.installedActive') : t('settings.webmcpPackages.installedInactive')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-red-300 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                    disabled={busy}
                    onClick={() => void handleUninstall(pkgId)}
                  >
                    {busy ? t('settings.webmcpPackages.uninstalling') : t('settings.webmcpPackages.uninstall')}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Collapsed advanced option: add a custom package repository */}
      <div className="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 p-2.5 text-xs text-tertiary"
          aria-expanded={addOpen}
          onClick={() => setAddOpen(open => !open)}
        >
          {addOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Plus className="h-3.5 w-3.5" />
          {t('settings.webmcpPackages.addRegistryTitle')}
        </button>
        {addOpen && (
          <div className="px-2.5 pb-2.5">
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('settings.webmcpPackages.addRegistryInputPlaceholder')}
              className="w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none dark:border-neutral-600"
              onKeyDown={(event) => { if (event.key === 'Enter') void handleAdd() }}
            />
            <div className="mt-1.5 text-xs text-tertiary">{t('settings.webmcpPackages.addRegistryHint')}</div>
            {addError && <div className="mt-1.5 text-xs text-red-600 dark:text-red-400">{format(t('settings.webmcpPackages.addFailed'), { error: addError })}</div>}
            <button
              type="button"
              className="mt-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={adding || !input.trim()}
              onClick={() => void handleAdd()}
            >
              {adding ? t('settings.webmcpPackages.adding') : t('settings.webmcpPackages.addRegistryButton')}
            </button>
          </div>
        )}
      </div>

      {/* Install confirmation — discloses what will be downloaded and the inactive-by-default semantics */}
      {confirmPkg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
            <div className="text-sm font-semibold">
              {format(t('settings.webmcpPackages.confirmInstallTitle'), { id: confirmPkg.pkg.id })}
            </div>
            <div className="mt-2 text-xs text-tertiary">
              {Number.isNaN(confirmPkg.verifiedToolCount)
                // The preview manifest could not be read (finding: "Failed
                // preview shows claimed count") — say so instead of showing
                // the registry's claim as if it were verified.
                ? t('settings.webmcpPackages.confirmInstallBodyUnverified')
                : format(t('settings.webmcpPackages.confirmInstallBody'), { count: confirmPkg.verifiedToolCount })}
            </div>
            {actionError && (
              <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                {format(t('settings.webmcpPackages.actionFailed'), { error: actionError })}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-xs text-tertiary hover:bg-neutral-100 dark:hover:bg-neutral-700"
                onClick={() => setConfirmPkg(null)}
              >
                {t('settings.webmcpPackages.confirmInstallCancel')}
              </button>
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={busyId !== null}
                onClick={() => { void handleInstall(confirmPkg.registry, confirmPkg.pkg) }}
              >
                {busyId ? t('settings.webmcpPackages.installing') : t('settings.webmcpPackages.confirmInstallConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
