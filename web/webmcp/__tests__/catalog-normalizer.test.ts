import { describe, expect, it } from 'vitest'
import { buildHostCatalog } from '../catalog-normalizer'
import type { WebMCPDiscoveredTool } from '../types'

function discoveredTool(
  tabId: number,
  tabUrl: string,
  discoveredAt: number,
): WebMCPDiscoveredTool {
  return {
    origin: 'https://www.xiaohongshu.com',
    name: 'like_feed',
    description: 'Like the current feed',
    inputSchema: { type: 'object' },
    hostname: 'www.xiaohongshu.com',
    fullName: 'https_www_xiaohongshu_com__like_feed',
    tabId,
    tabTitle: `Xiaohongshu ${tabId}`,
    tabUrl,
    discoveredAt,
    apiMode: 'documentModelContext',
  }
}

describe('WebMCP catalog identity', () => {
  it('groups by origin and raw name while retaining every runtime tab', () => {
    const catalog = buildHostCatalog([
      discoveredTool(12, 'https://www.xiaohongshu.com/explore/one', 100),
      discoveredTool(27, 'https://www.xiaohongshu.com/explore/two', 200),
    ])

    expect(catalog['www.xiaohongshu.com'].registeredTools).toHaveLength(1)
    expect(catalog['www.xiaohongshu.com'].registeredTools[0]).toMatchObject({
      origin: 'https://www.xiaohongshu.com',
      name: 'like_feed',
      tabs: [
        { tabId: 27 },
        { tabId: 12 },
      ],
    })
  })

  it('keeps the legacy route key per tab and rotates it to the newest instance', () => {
    const withKey = (tabId: number, discoveredAt: number, groupKey: string) => ({
      ...discoveredTool(tabId, `https://www.xiaohongshu.com/explore/${tabId}`, discoveredAt),
      groupKey,
    })

    const catalog = buildHostCatalog([
      withKey(12, 100, 'host_signature_v1'),
      withKey(12, 200, 'host_signature_v2'),
      withKey(27, 150, 'host_signature_v1'),
    ])

    const tabs = catalog['www.xiaohongshu.com'].registeredTools[0].tabs
    expect(tabs.find((tab) => tab.tabId === 12)?.groupKey).toBe('host_signature_v2')
    expect(tabs.find((tab) => tab.tabId === 27)?.groupKey).toBe('host_signature_v1')
  })

  it('keeps adapter provenance per tab when same-origin tabs collide on a tool name', () => {
    // Sourcery regression guard: buildRegisteredTools used to copy
    // adapterServed from the grouped representative onto the whole tool.
    // When an older tab is adapter-served and a NEWER tab (the
    // representative, by discoveredAt) runs a page-provided implementation
    // of the same raw name, the canonical flag must not leak onto the page
    // tab — the auth UI must show the page description for that tab's
    // instance, and vice versa.
    const build = (tabId: number, discoveredAt: number, adapterServed?: boolean) => ({
      ...discoveredTool(tabId, `https://www.xiaohongshu.com/explore/${tabId}`, discoveredAt),
      ...(adapterServed === undefined ? {} : { adapterServed }),
    })

    const catalog = buildHostCatalog([
      // Older adapter-served tab, newer page-provided tab → page tab wins
      // the representative slot and must NOT inherit adapter provenance.
      build(12, 100, true),
      build(27, 200, false),
    ])
    const grouped = catalog['www.xiaohongshu.com'].registeredTools[0]
    expect(grouped.adapterServed).toBe(false)
    expect(grouped.tabs.find((tab) => tab.tabId === 12)?.adapterServed).toBe(true)
    expect(grouped.tabs.find((tab) => tab.tabId === 27)?.adapterServed).toBe(false)

    // Mirror case: the representative is adapter-served, the other tab is
    // page-provided — the page tab still carries its own provenance.
    const flipped = buildHostCatalog([
      build(12, 100, false),
      build(27, 200, true),
    ])
    const flippedGroup = flipped['www.xiaohongshu.com'].registeredTools[0]
    expect(flippedGroup.adapterServed).toBe(true)
    expect(flippedGroup.tabs.find((tab) => tab.tabId === 12)?.adapterServed).toBe(false)
    expect(flippedGroup.tabs.find((tab) => tab.tabId === 27)?.adapterServed).toBe(true)
  })
})
