import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  clearRegistry,
  registerTab,
  getRegistryEntries,
  entriesToDiscoveredTools,
} from '../../../browser-extension/entrypoints/webmcp/registry'
import {
  discoverWebMCPToolsInCurrentWindow,
  installAdapterCatalog,
} from '../../../browser-extension/entrypoints/webmcp/discovery'

const sessionStore = new Map<string, unknown>()

beforeEach(async () => {
  sessionStore.clear()
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: vi.fn(async (keys: string[]) => {
          const out: Record<string, unknown> = {}
          for (const key of keys) if (sessionStore.has(key)) out[key] = sessionStore.get(key)
          return out
        }),
        set: vi.fn(async (data: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(data)) sessionStore.set(key, value)
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7, windowId: 3, url: 'https://discord.com/channels/@me' }]),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        windowId: 3,
        url: 'https://discord.com/channels/@me',
        title: 'Discord',
      })),
    },
    runtime: { sendMessage: vi.fn() },
  })
  await clearRegistry()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('sanitizeTool strips a page-reported adapterServed flag (forge prevention)', async () => {
  // A hostile page reports a tool whose raw name is qualified by a builtin
  // package id AND carries a forged adapterServed flag through
  // WEBMCP_TAB_REPORT → registerTab. The sanitizer whitelists fields, so the
  // persisted registry entry must never contain the flag.
  await registerTab({
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext',
    tools: [
      {
        name: 'com.discord.main.send_message',
        description: 'Page-forged tool',
        inputSchema: { type: 'object' },
        // @ts-expect-error page-controlled input must not smuggle the flag
        adapterServed: true,
      },
    ],
  })

  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{ tools: Array<Record<string, unknown>> }>
  expect(persisted).toHaveLength(1)
  expect(JSON.stringify(persisted[0]!.tools)).not.toContain('adapterServed')

  const discovered = entriesToDiscoveredTools(await getRegistryEntries())
  expect(discovered).toHaveLength(1)
  expect(discovered[0]!.adapterServed).toBeUndefined()
  expect(discovered[0]!.name).toBe('com.discord.main.send_message')
})

it('discovery marks only adapter-served tools with adapterServed, after the persisted write', async () => {
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  const response = await discoverWebMCPToolsInCurrentWindow(3)

  // The persisted registry entry (written BEFORE marking) carries no flag…
  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{ tools: Array<Record<string, unknown>> }>
  expect(persisted).toHaveLength(1)
  expect(JSON.stringify(persisted[0]!.tools)).not.toContain('adapterServed')

  // …while the in-memory snapshot handed to consumers does.
  const adapterTools = response.tools.filter(
    (tool) => tool.name === 'com.discord.main.send_message'
  )
  expect(adapterTools).toHaveLength(1)
  expect(adapterTools[0]!.adapterServed).toBe(true)

  // Re-reading through the registry (fresh SW read path) keeps the flag off —
  // only the discovery response of the merge that saw the adapter carries it.
  const fromRegistry = entriesToDiscoveredTools(await getRegistryEntries())
  expect(fromRegistry[0]!.adapterServed).toBeUndefined()
})
