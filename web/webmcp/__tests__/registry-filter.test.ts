import { describe, expect, it } from 'vitest'
import {
  boundToolIndex,
  indexedTools,
  MAX_INDEXED_TOOLS,
  packageMatchesFilter,
  reconcileToolIndex,
  runPreviewPass,
  SEARCH_MIN_PACKAGES,
  toolIndexKey,
  toolIndexPrefix,
  toolMatchCount,
  toolWindow,
  TOOL_PREVIEW_WINDOW,
  type PreviewTool,
  type ToolIndex,
} from '@/webmcp/registry-filter'

const TOOLS: PreviewTool[] = [
  { name: 'create_issue', description: 'Create a GitHub issue' },
  { name: 'list_issues', description: 'List repository issues' },
  { name: 'send_notification', description: 'Send a notification to a channel' },
]

const PKG = { id: 'com.github.main', description: 'GitHub tools for repositories', version: '1.0.0' }

/** Index entry for PKG as read for its current catalog version. */
const ENTRY = { version: PKG.version, tools: TOOLS }

describe('packageMatchesFilter', () => {
  it('matches everything for an empty/whitespace query', () => {
    expect(packageMatchesFilter(PKG, ENTRY, '')).toBe(true)
    expect(packageMatchesFilter(PKG, ENTRY, '   ')).toBe(true)
  })

  it('matches the package id case-insensitively', () => {
    expect(packageMatchesFilter(PKG, ENTRY, 'GITHUB')).toBe(true)
    expect(packageMatchesFilter(PKG, ENTRY, 'hub.main')).toBe(true)
  })

  it('matches the package description', () => {
    expect(packageMatchesFilter(PKG, ENTRY, 'repositories')).toBe(true)
  })

  it('matches a cached TOOL name or description', () => {
    expect(packageMatchesFilter(PKG, ENTRY, 'notification')).toBe(true)
    expect(packageMatchesFilter(PKG, ENTRY, 'create_issue')).toBe(true)
  })

  it('rejects a query that hits nothing once the tools ARE indexed', () => {
    expect(packageMatchesFilter(PKG, ENTRY, 'notion')).toBe(false)
  })

  it('keeps a package whose preview has not landed yet visible', () => {
    // Finding: "Tool-only matches disappear" — with no index entry nothing is
    // known about the package's tools, so a tool-name query must not hide it.
    expect(packageMatchesFilter(PKG, undefined, 'notification')).toBe(true)
    expect(packageMatchesFilter(PKG, undefined, 'github')).toBe(true)
  })

  it('keeps a package visible while its indexed tools are for another version', () => {
    // Finding: "Obsolete tools remain searchable" — an entry read for an
    // older version cannot rule the package out; its re-read is pending.
    expect(packageMatchesFilter(PKG, { version: '0.9.0', tools: TOOLS }, 'notification')).toBe(true)
  })
})

describe('indexedTools', () => {
  const index: ToolIndex = new Map([[toolIndexKey('https://a.example/manifest.json', PKG.id), ENTRY]])

  it('returns the tools read for the current package version', () => {
    expect(indexedTools(index, 'https://a.example/manifest.json', PKG)).toBe(TOOLS)
  })

  it('ignores a list read for another package version', () => {
    expect(indexedTools(index, 'https://a.example/manifest.json', { id: PKG.id, version: '2.0.0' })).toBeUndefined()
  })

  it('ignores a package that is not indexed', () => {
    expect(indexedTools(index, 'https://b.example/manifest.json', PKG)).toBeUndefined()
    expect(indexedTools(index, 'https://a.example/manifest.json', { id: 'com.other', version: PKG.version })).toBeUndefined()
  })
})

describe('reconcileToolIndex', () => {
  const REGISTRY = 'https://a.example/manifest.json'
  const OTHER = 'https://b.example/manifest.json'

  it('drops entries for packages that left the catalog', () => {
    const index: ToolIndex = new Map([
      [toolIndexKey(REGISTRY, 'kept'), ENTRY],
      [toolIndexKey(REGISTRY, 'removed'), ENTRY],
    ])
    const next = reconcileToolIndex(index, REGISTRY, [{ id: 'kept', version: '1.0.0' }])
    expect([...next.keys()]).toEqual([toolIndexKey(REGISTRY, 'kept')])
  })

  it('drops entries read for a superseded version', () => {
    const index: ToolIndex = new Map([[toolIndexKey(REGISTRY, 'pkg'), ENTRY]])
    expect(reconcileToolIndex(index, REGISTRY, [{ id: 'pkg', version: '2.0.0' }]).size).toBe(0)
  })

  it('keeps live entries and leaves other registries alone', () => {
    const index: ToolIndex = new Map([
      [toolIndexKey(REGISTRY, 'pkg'), ENTRY],
      [toolIndexKey(OTHER, 'pkg'), ENTRY],
    ])
    const next = reconcileToolIndex(index, REGISTRY, [{ id: 'pkg', version: '1.0.0' }])
    // Same map identity: nothing changed, so the section's state stays stable.
    expect(next).toBe(index)
    expect(next.size).toBe(2)
  })
})

describe('boundToolIndex', () => {
  const entry = (count: number) => ({
    version: '1.0.0',
    tools: Array.from({ length: count }, (_, i) => ({ name: `t${i}`, description: `Tool ${i}` })),
  })

  it('leaves an index under the cap untouched', () => {
    const index: ToolIndex = new Map([[toolIndexKey('https://a.example', 'pkg'), entry(3)]])
    expect(boundToolIndex(index, 10)).toBe(index)
    expect(MAX_INDEXED_TOOLS).toBeGreaterThan(0)
  })

  it('evicts the oldest registries whole until the retained tools fit', () => {
    // Finding: "Search metadata grows without bound" — 3 registries × 3 tools
    // with a cap of 6 keeps only the two most recently added catalogs.
    const index: ToolIndex = new Map([
      [toolIndexKey('https://oldest.example', 'pkg0'), entry(3)],
      [toolIndexKey('https://oldest.example', 'pkg1'), entry(3)],
      [toolIndexKey('https://middle.example', 'pkg0'), entry(3)],
      [toolIndexKey('https://newest.example', 'pkg0'), entry(3)],
    ])
    const next = boundToolIndex(index, 6)
    expect([...next.keys()]).toEqual([
      toolIndexKey('https://middle.example', 'pkg0'),
      toolIndexKey('https://newest.example', 'pkg0'),
    ])
  })

  it('keeps every entry of a registry it retains', () => {
    const index: ToolIndex = new Map([
      [toolIndexKey('https://a.example', 'pkg0'), entry(2)],
      [toolIndexKey('https://a.example', 'pkg1'), entry(2)],
    ])
    expect(boundToolIndex(index, 4).size).toBe(2)
  })
})

describe('runPreviewPass', () => {
  it('stamps every queued read with the generation captured when it was scheduled', async () => {
    // Finding: "Old previews overwrite refreshed results" — a catalog refresh
    // that lands while a preview waits in the queue must not change the
    // generation that preview reports, or its stale response is accepted.
    let currentGeneration = 7
    const seen: number[] = []
    await runPreviewPass(['a', 'b', 'c'], currentGeneration, async (_item, generation) => {
      currentGeneration = 8
      seen.push(generation)
    })
    expect(seen).toEqual([7, 7, 7])
    expect(currentGeneration).toBe(8)
  })

  it('reads every package exactly once', async () => {
    const seen: string[] = []
    await runPreviewPass(['a', 'b', 'c', 'd', 'e'], 1, async (item: string) => {
      seen.push(item)
    })
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('runs at most the allowed number of reads at once', async () => {
    let inFlight = 0
    let peak = 0
    let gates: Array<() => void> = []
    const pass = runPreviewPass(['a', 'b', 'c', 'd'], 1, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>(resolve => { gates.push(resolve) })
      inFlight -= 1
    }, 2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(peak).toBe(2)
    // Release the first batch, then the queued remainder.
    gates.splice(0).forEach(release => release())
    await new Promise(resolve => setTimeout(resolve, 0))
    gates.splice(0).forEach(release => release())
    await pass
    expect(peak).toBe(2)
  })
})

describe('toolMatchCount', () => {
  it('counts only the tools matching the query', () => {
    expect(toolMatchCount(PKG, TOOLS, 'issue')).toBe(2)
    expect(toolMatchCount(PKG, TOOLS, 'notification')).toBe(1)
  })

  it('returns 0 when the package id/description itself matched (no double signal)', () => {
    expect(toolMatchCount(PKG, TOOLS, 'github')).toBe(0)
    expect(toolMatchCount(PKG, TOOLS, 'repositories')).toBe(0)
  })

  it('returns 0 without a tool index entry', () => {
    expect(toolMatchCount(PKG, undefined, 'issue')).toBe(0)
  })
})

describe('toolWindow', () => {
  const many: PreviewTool[] = Array.from({ length: 59 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool ${i}`,
  }))

  it('windows a long list to the first 8 plus a hidden count', () => {
    const { visible, hiddenCount } = toolWindow(many)
    expect(visible.length).toBe(TOOL_PREVIEW_WINDOW)
    expect(visible[0]!.name).toBe('tool_0')
    expect(hiddenCount).toBe(51)
    // Exact window content, not just the shape — a buggy `toolWindow` that
    // returns eight copies of tool_0 (or skips entries) must fail here
    // (round-6 finding: "Duplicate tools pass preview test").
    expect(visible).toEqual(many.slice(0, TOOL_PREVIEW_WINDOW))
    expect(new Set(visible.map(tool => tool.name)).size).toBe(TOOL_PREVIEW_WINDOW)
  })

  it('keeps a short list intact with nothing hidden', () => {
    const { visible, hiddenCount } = toolWindow(TOOLS)
    expect(visible).toEqual(TOOLS)
    expect(hiddenCount).toBe(0)
  })

  it('handles exactly 8 tools', () => {
    const eight = many.slice(0, 8)
    const { visible, hiddenCount } = toolWindow(eight)
    expect(visible.length).toBe(8)
    expect(hiddenCount).toBe(0)
  })
})

describe('SEARCH_MIN_PACKAGES', () => {
  it('shows search only when the catalog exceeds 5 packages', () => {
    expect(SEARCH_MIN_PACKAGES).toBe(5)
  })
})

describe('toolIndexKey', () => {
  it('separates registries that publish the same package ID', () => {
    // Round-6 finding "Registries share tool results": two user-added
    // registries can carry the same pkg id with different tool lists — the
    // key must keep their entries distinct.
    expect(toolIndexKey('https://a.example/manifest.json', 'com.example.pkg'))
      .not.toBe(toolIndexKey('https://b.example/manifest.json', 'com.example.pkg'))
    expect(toolIndexKey('https://a.example/manifest.json', 'com.example.pkg'))
      .toBe('https://a.example/manifest.json\u0000com.example.pkg')
  })

  it('keeps path-like registry/id pairs distinct', () => {
    // Realistic inputs: a package id that looks like a path segment cannot be
    // shifted into the registry half of the key, because the separator is a
    // NUL byte no validated URL or id contains. A plain "/" join WOULD
    // collide here — these pairs are exactly what the separator protects.
    expect(toolIndexKey('https://a.example', 'owner/repo'))
      .not.toBe(toolIndexKey('https://a.example/owner', 'repo'))
    expect(toolIndexKey('https://a.example/x.json', 'a.b'))
      .not.toBe(toolIndexKey('https://a.example', 'x.json/a.b'))
  })

  it('gives every package of one registry the same removable prefix', () => {
    const prefix = toolIndexPrefix('https://a.example/manifest.json')
    expect(toolIndexKey('https://a.example/manifest.json', 'pkg.one').startsWith(prefix)).toBe(true)
    expect(toolIndexKey('https://a.example/manifest', 'pkg.one').startsWith(prefix)).toBe(false)
  })
})
