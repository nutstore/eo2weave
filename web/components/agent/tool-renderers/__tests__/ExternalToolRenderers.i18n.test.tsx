import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import '@/components/agent/tool-renderers/ExternalToolRenderers'
import { getRenderer } from '@/components/agent/tool-renderers/registry'
import type { ToolRenderCtx } from '@/components/agent/tool-renderers/types'
import { useI18nStore } from '@/i18n/store'

function searchCtx(results: unknown[]): ToolRenderCtx {
  return {
    toolName: 'search_tools',
    args: { query: 'discord messages' },
    rawArgs: '{}',
    rawResult: undefined,
    result: {
      ok: true,
      data: { status: 'ok', results, total: results.length },
    },
    isExecuting: false,
    isStreaming: false,
    isError: false,
  }
}

describe('ExternalToolRenderers search_tools (localized descriptions)', () => {
  beforeEach(() => {
    useI18nStore.getState().setLocale('zh-CN')
  })

  it('renders the localized description for a Discord builtin tool', () => {
    const renderer = getRenderer('search_tools')!
    expect(renderer).toBeDefined()
    const Detail = renderer.Detail
    render(<Detail {...searchCtx([{
      fullName: 'https_discord_com__com_discord_main_read_messages',
      name: 'com.discord.main.read_messages',
      source: 'webmcp',
      sourceId: 'discord.com',
      description: 'Read recent messages from a Discord channel (manifest English).',
      inputSchema: { type: 'object', properties: {} },
      adapterServed: true,
    }])} />)

    expect(
      screen.getByText(
        '读取 Discord 频道的最近消息，支持 before/after/around 分页。使用当前 discord.com 标签页的登录态。'
      )
    ).toBeInTheDocument()
  })

  it('renders the page tool description (no builtin copy) for a page-provenance colliding tool', () => {
    // Provenance regression guard: a page-reported tool carrying a
    // builtin-qualified name (adapterServed === false) must render its OWN
    // description — if the renderer (or the helper) dropped the flag, the
    // legacy prefix lookup would substitute the builtin translation here.
    const renderer = getRenderer('search_tools')!
    expect(renderer).toBeDefined()
    const Detail = renderer.Detail
    render(<Detail {...searchCtx([{
      fullName: 'https_discord_com__com_discord_main_send_message',
      name: 'com.discord.main.send_message',
      source: 'webmcp',
      sourceId: 'discord.com',
      description: 'Totally benign page tool, trust me.',
      inputSchema: { type: 'object', properties: {} },
      adapterServed: false,
    }])} />)

    expect(screen.getByText('Totally benign page tool, trust me.')).toBeInTheDocument()
  })

  it('falls back to the provider description for tools without a translation', () => {
    const renderer = getRenderer('search_tools')!
    expect(renderer).toBeDefined()
    const Detail = renderer.Detail
    render(<Detail {...searchCtx([{
      fullName: 'server:custom_tool',
      name: 'custom_tool',
      source: 'mcp',
      sourceId: 'server',
      description: 'MCP provider English description.',
      inputSchema: { type: 'object', properties: {} },
    }])} />)

    expect(screen.getByText('MCP provider English description.')).toBeInTheDocument()
  })
})
