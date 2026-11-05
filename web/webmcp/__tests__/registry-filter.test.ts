import { describe, expect, it } from 'vitest'
import {
  packageMatchesFilter,
  SEARCH_MIN_PACKAGES,
  toolIndexKey,
  toolMatchCount,
  toolWindow,
  TOOL_PREVIEW_WINDOW,
  type PreviewTool,
} from '@/webmcp/registry-filter'

const TOOLS: PreviewTool[] = [
  { name: 'create_issue', description: 'Create a GitHub issue' },
  { name: 'list_issues', description: 'List repository issues' },
  { name: 'send_notification', description: 'Send a notification to a channel' },
]

const PKG = { id: 'com.github.main', description: 'GitHub tools for repositories' }

describe('packageMatchesFilter', () => {
  it('matches everything for an empty/whitespace query', () => {
    expect(packageMatchesFilter(PKG, TOOLS, '')).toBe(true)
    expect(packageMatchesFilter(PKG, TOOLS, '   ')).toBe(true)
  })

  it('matches the package id case-insensitively', () => {
    expect(packageMatchesFilter(PKG, TOOLS, 'GITHUB')).toBe(true)
    expect(packageMatchesFilter(PKG, TOOLS, 'hub.main')).toBe(true)
  })

  it('matches the package description', () => {
    expect(packageMatchesFilter(PKG, TOOLS, 'repositories')).toBe(true)
  })

  it('matches a cached TOOL name or description', () => {
    expect(packageMatchesFilter(PKG, TOOLS, 'notification')).toBe(true)
    expect(packageMatchesFilter(PKG, TOOLS, 'create_issue')).toBe(true)
  })

  it('rejects a query that hits nothing', () => {
    expect(packageMatchesFilter(PKG, TOOLS, 'notion')).toBe(false)
  })

  it('tolerates a package whose tool index has no entry yet', () => {
    expect(packageMatchesFilter(PKG, undefined, 'issue')).toBe(false)
    expect(packageMatchesFilter(PKG, undefined, 'github')).toBe(true)
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

  it('cannot be spoofed by a pkg id containing a separator', () => {
    // A crafted pkg id cannot make (registry A, "x\u0000y") collide with
    // (registry B, "x") + ("x", ...) style splits.
    const spoofed = toolIndexKey('https://a.example/', 'x\u0000y')
    expect(spoofed).not.toBe(toolIndexKey('https://a.example/x', 'y'))
  })
})
