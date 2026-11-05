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

/** Packages whose manifest was read during the tool-count pass, by pkg id. */
export type ToolIndex = Map<string, PreviewTool[]>

/**
 * Minimum catalog size before the search input earns its place — the issue
 * design shows the input only when the total package count exceeds 5.
 */
export const SEARCH_MIN_PACKAGES = 5

/** Expanded tool list shows this many entries before the "More" expander. */
export const TOOL_PREVIEW_WINDOW = 8

/**
 * Composite section-level tool-index key: registries are user-added remote
 * catalogs, so different registries can publish the same package ID with
 * different tool lists — keying by package ID alone let one registry's list
 * overwrite the other's (round-6 finding: "Registries share tool results").
 * The NUL separator cannot occur in an https URL, so the join is unambiguous
 * and a registry's entries can be removed by prefix when it is removed.
 */
export function toolIndexKey(registryUrl: string, pkgId: string): string {
  return `${registryUrl}\u0000${pkgId}`
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
 */
export function packageMatchesFilter(
  pkg: { id: string; description: string },
  tools: PreviewTool[] | undefined,
  query: string,
): boolean {
  if (matchesQuery(pkg.id, query)) return true
  if (matchesQuery(pkg.description, query)) return true
  return (tools ?? []).some(
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
