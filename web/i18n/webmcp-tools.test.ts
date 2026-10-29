// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useI18nStore } from '@/i18n/store'
import { localizedToolDescription } from '@/i18n/webmcp-tools'

describe('localizedToolDescription (webmcp builtin package tool copy)', () => {
  beforeEach(() => {
    useI18nStore.getState().setLocale('zh-CN')
  })

  it('localizes a Discord builtin tool for zh-CN', () => {
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'read_messages',
        description: 'Read recent messages from a Discord channel (manifest English).',
      })
    ).toBe(
      '读取 Discord 频道的最近消息，支持 before/after/around 分页。使用当前 discord.com 标签页的登录态。'
    )
  })

  it('falls back to the provider English text for tools with no translation', () => {
    useI18nStore.getState().setLocale('ja-JP')
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'example.com',
        name: 'unknown_tool',
        description: '  Provider English description.  ',
      })
    ).toBe('Provider English description.')
  })

  it('localizes every Discord tool in all four locales (parity with the manifest tool set)', async () => {
    const { builtinResources } = await import(
      '../../browser-extension/entrypoints/webmcp/builtin-resources'
    )
    const manifest = JSON.parse(
      builtinResources['com.discord.main/manifest.json']
    ) as { tools: Array<{ name: string }> }
    const { getWebMCPToolDescription } = await import('@creatorweave/i18n')

    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const) {
      for (const tool of manifest.tools) {
        const description = getWebMCPToolDescription(locale, 'discord.com', tool.name)
        expect(description, `${locale} ${tool.name}`).toBeDefined()
        expect(description!.length, `${locale} ${tool.name}`).toBeGreaterThan(0)
      }
    }
  })

  it('returns the provider text unchanged for MCP tools (no localization path)', () => {
    useI18nStore.getState().setLocale('zh-CN')
    const description = 'MCP server English description.'
    expect(
      localizedToolDescription({
        source: 'mcp',
        sourceId: 'github',
        name: 'create_issue',
        description,
      })
    ).toBe(description)
  })
})
