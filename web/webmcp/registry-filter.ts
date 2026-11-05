/**
 * Pure filter/match logic for the WebMCP packages registry section
 * (issue #187). Extracted from `WebMCPPackageRegistrySection.tsx` so it can
 * be unit-tested without React rendering.
 */

/** A tool entry cached from a package manifest preview. */
export interface PreviewTool {
  name: string
  description: string
}

/**
 * A package's cached tool list, stamped with the catalog version it was read
 * for. The stamp is what lets a refresh invalidate obsolete lists: cached
 * tools only match searches while their version is still the catalog's own
 * (finding: "Obsolete tools remain searchable").
 */
export interface IndexedTools {
  version: string
  tools: PreviewTool[]
}

/** Packages whose manifest was read during the tool-count pass, by key. */
export type ToolIndex = Map<string, IndexedTools>

/**
 * Minimum catalog size before the search input earns its place — the issue
 * design shows the input only when the total package count exceeds 5.
 */
export const SEARCH_MIN_PACKAGES = 5

/** Expanded tool list shows this many entries before the "More" expander. */
export const TOOL_PREVIEW_WINDOW = 8

/** Separator inside a tool-index key; cannot occur in a validated URL or id. */
const SEPARATOR = '\u0000'

/**
 * Composite section-level tool-index key: registries are user-added remote
 * catalogs, so different registries can publish the same package ID with
 * different tool lists — keying by package ID alone let one registry's list
 * overwrite the other's (round-6 finding: "Registries share tool results").
 * The NUL separator cannot occur in a validated https URL or package ID, so
 * the join is unambiguous (`https://a.example` + `owner/repo` cannot collide
 * with `https://a.example/owner` + `repo`) and a registry's entries can be
 * removed by prefix when it is removed.
 */
export function toolIndexKey(registryUrl: string, pkgId: string): string {
  return `${registryUrl}${SEPARATOR}${pkgId}`
}

/** Key prefix shared by every package of one registry. */
export function toolIndexPrefix(registryUrl: string): string {
  return `${registryUrl}${SEPARATOR}`
}

/**
 * Cached tools for a catalog entry, or `undefined` when nothing usable is
 * indexed for it. A list read for a DIFFERENT package version never matches:
 * the catalog entry changed, so the previous list describes tools the
 * package may no longer ship (finding: "Obsolete tools remain searchable").
 */
export function indexedTools(
  index: ToolIndex,
  registryUrl: string,
  pkg: { id: string; version: string },
): PreviewTool[] | undefined {
  const entry = index.get(toolIndexKey(registryUrl, pkg.id))
  return entry && entry.version === pkg.version ? entry.tools : undefined
}

/**
 * Drop index entries that no longer describe the registry's catalog: a
 * package removed from the manifest, or one whose version changed, must not
 * keep matching searches with its previous tool list (finding: "Obsolete
 * tools remain searchable"). Returns the input map when everything is live,
 * so the section's state identity stays stable.
 */
export function reconcileToolIndex(
  index: ToolIndex,
  registryUrl: string,
  packages: ReadonlyArray<{ id: string; version: string }>,
): ToolIndex {
  const prefix = toolIndexPrefix(registryUrl)
  const liveVersions = new Map(packages.map(pkg => [`${prefix}${pkg.id}`, pkg.version]))
  let changed = false
  const next = new Map(index)
  for (const [key, entry] of index) {
    if (!key.startsWith(prefix)) continue
    if (liveVersions.get(key) === entry.version) continue
    next.delete(key)
    changed = true
  }
  return changed ? next : index
}

/**
 * Aggregate cap on indexed tool names/descriptions. Each package manifest is
 * already bounded (MAX_PREVIEW_TOOLS), but the user can add many catalogs —
 * without an aggregate bound the section retains every tool of every added
 * registry (finding: "Search metadata grows without bound"). Whole
 * registries are evicted oldest-first (Map preserves insertion order) until
 * the index fits, which keeps the most recently added catalog searchable.
 */
export const MAX_INDEXED_TOOLS = 2_000

/** Trim `index` to at most `max` indexed tools; same map when already under. */
export function boundToolIndex(index: ToolIndex, max: number = MAX_INDEXED_TOOLS): ToolIndex {
  let total = 0
  for (const entry of index.values()) total += entry.tools.length
  if (total <= max) return index
  const next = new Map(index)
  for (const key of index.keys()) {
    if (total <= max) break
    const prefix = toolIndexPrefix(key.slice(0, key.indexOf(SEPARATOR)))
    for (const [candidate, entry] of next) {
      if (!candidate.startsWith(prefix)) continue
      total -= entry.tools.length
      next.delete(candidate)
    }
  }
  return next
}

/**
 * Case-insensitive substring match: does `query` occur in `text`?
 * An empty/whitespace query matches everything.
 */
export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return text.toLowerCase().includes(needle)
}

/**
 * Decide whether a package card stays visible under the user's filter.
 * A package matches when the query hits its id, its description, or any
 * cached tool's name/description (the tool index is filled by the same
 * manifest pass that verifies tool counts — zero extra requests).
 *
 * A package with NO usable index entry — its preview is still pending, or it
 * failed to load — stays visible: its tools are unknown, so hiding it would
 * silently drop tool-only matches (finding: "Tool-only matches disappear").
 * A list indexed for the CURRENT version that does not match is hidden.
 */
export function packageMatchesFilter(
  pkg: { id: string; description: string; version: string },
  entry: IndexedTools | undefined,
  query: string,
): boolean {
  if (matchesQuery(pkg.id, query)) return true
  if (matchesQuery(pkg.description, query)) return true
  if (entry === undefined || entry.version !== pkg.version) return true
  return entry.tools.some(
    tool => matchesQuery(tool.name, query) || matchesQuery(tool.description, query),
  )
}

/**
 * Number of cached tools of this package whose name/description match the
 * query — the "matches N tools" hint count. Tool hits only count when the
 * package id/description do NOT match (otherwise every package whose id
 * contains the query would also report its full tool count as a hit).
 */
export function toolMatchCount(
  pkg: { id: string; description: string },
  tools: PreviewTool[] | undefined,
  query: string,
): number {
  if (matchesQuery(pkg.id, query) || matchesQuery(pkg.description, query)) return 0
  return (tools ?? []).filter(
    tool => matchesQuery(tool.name, query) || matchesQuery(tool.description, query),
  ).length
}

/**
 * Upper bound on previewed/indexed tools per package — mirrors the package
 * validator's 1–100 tool limit (`validateManifest` in
 * `@creatorweave/shared/webmcp-adapter`): a manifest listing more tools is
 * an invalid package and fails its preview instead of rendering or indexing
 * an unbounded row list (the 512 KiB preview byte cap bounds the BODY, not
 * the row count).
 */
export const MAX_PREVIEW_TOOLS = 100

/**
 * Concurrent manifest-preview fetch cap (finding: "Large catalogs overload
 * settings"): the section reads one manifest per package to verify tool
 * counts — a huge catalog must not launch every request at once.
 */
export const PREVIEW_CONCURRENCY = 6

/**
 * Run the preview pass with a bounded number of concurrent reads. The
 * catalog `generation` is captured ONCE, when the pass is scheduled, and
 * handed to every read: a request that sits in this queue through a catalog
 * refresh keeps the generation it was scheduled under, so its response is
 * rejected by the section's staleness gate instead of being stamped with the
 * refreshed one (finding: "Old previews overwrite refreshed results").
 */
export async function runPreviewPass<T>(
  items: readonly T[],
  generation: number,
  read: (item: T, generation: number) => Promise<void>,
  concurrency: number = PREVIEW_CONCURRENCY,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await read(item, generation)
    }
  })
  await Promise.all(workers)
}

/**
 * Window the COLLAPSED tool preview: the first `TOOL_PREVIEW_WINDOW`
 * entries up front plus a "More (N total)" expander for the rest. The
 * EXPANDED view deliberately renders the full catalog — windowing again
 * behind the expander would make the hidden entries unreachable.
 */
export function toolWindow(tools: PreviewTool[]): { visible: PreviewTool[]; hiddenCount: number } {
  return {
    visible: tools.slice(0, TOOL_PREVIEW_WINDOW),
    hiddenCount: Math.max(0, tools.length - TOOL_PREVIEW_WINDOW),
  }
}
