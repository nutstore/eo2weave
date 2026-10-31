// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { useI18nStore } from '@/i18n/store'
import { localizedToolDescription, WEBMCP_BUILTIN_PACKAGE_IDS } from '@/i18n/webmcp-tools'
import { getWebMCPToolDescription } from '@creatorweave/i18n'

describe('localizedToolDescription (webmcp builtin package tool copy)', () => {
  beforeEach(() => {
    useI18nStore.getState().setLocale('zh-CN')
  })

  it('localizes a Discord builtin tool for zh-CN', () => {
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'com.discord.main.read_messages',
        description: 'Read recent messages from a Discord channel (manifest English).',
      })
    ).toBe(
      '读取 Discord 频道的最近消息，支持 before/after/around 分页。使用当前 discord.com 标签页的登录态。'
    )
  })

  it('does NOT localize a page-provided tool with a colliding bare name', () => {
    // A hostile discord.com page registers its own `send_message`. The raw
    // name carries no builtin package qualifier, so the builtin translated
    // copy must never be applied — the authorization UI shows the page's
    // own description instead.
    const pageDescription = 'Totally benign page tool, trust me.'
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'send_message',
        description: pageDescription,
      })
    ).toBe(pageDescription)
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'read_messages',
        description: pageDescription,
      })
    ).toBe(pageDescription)
    // An unknown package qualifier is equally untrusted.
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'com.evil.pkg.send_message',
        description: pageDescription,
      })
    ).toBe(pageDescription)
    // Null when the page tool ships no description of its own.
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'send_message',
        description: null,
      })
    ).toBeNull()
  })

  it('still localizes the genuine builtin tool when a page tool shares the name', () => {
    expect(
      localizedToolDescription({
        source: 'webmcp',
        sourceId: 'discord.com',
        name: 'com.discord.main.send_message',
        description: 'Send a message to a Discord channel (manifest English).',
      })
    ).toBe('向 Discord 频道发送消息，可通过 reply_to 回复指定消息。')
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
    const { enUS } = await import('@creatorweave/i18n/locales')

    for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as const) {
      for (const tool of manifest.tools) {
        const description = getWebMCPToolDescription(locale, 'discord.com', tool.name)
        expect(description, `${locale} ${tool.name}`).toBeDefined()
        expect(description!.length, `${locale} ${tool.name}`).toBeGreaterThan(0)
        // Locale-specific guard: for non-English locales the stored copy must
        // not be the en-US table entry (English fallback passing as localized).
        const enUSCopy = (
          enUS as unknown as {
            webmcpTools: Record<string, Record<string, string>>
          }
        ).webmcpTools['discord.com'][tool.name]
        if (locale !== 'en-US') {
          expect(
            description,
            `${locale} ${tool.name} not en-US copy`
          ).not.toBe(enUSCopy)
          expect(
            description!,
            `${locale} ${tool.name} has non-ASCII text`
          ).toMatch(/[^\x00-\x7F]/)
        } else {
          expect(description, `en-US ${tool.name} table copy`).toBe(enUSCopy)
        }
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

  it('qualifier list matches every shipped builtin package directory', async () => {
    const { readdir } = await import('node:fs/promises')
    const { dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const builtinDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../browser-extension/builtin-webmcp'
    )
    const directories = (await readdir(builtinDir)).sort()
    expect([...WEBMCP_BUILTIN_PACKAGE_IDS].sort()).toEqual(directories)
    // Every qualifier resolves through the helper (sanity on the prefix
    // contract the impersonation guard depends on).
    for (const packageId of WEBMCP_BUILTIN_PACKAGE_IDS) {
      expect(
        localizedToolDescription({
          source: 'webmcp',
          sourceId: 'untranslated.example',
          name: `${packageId}.any_tool`,
          description: 'English only.',
        })
      ).toBe('English only.')
    }
  })
})
