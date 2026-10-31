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
  // A page-reported tool whose raw name collides with a builtin-qualified
  // prefix registers FIRST (WEBMCP_TAB_REPORT → registerTab path). The
  // adapter serves a DIFFERENT tool with the same package prefix — both
  // look "builtin" by name alone, so marking-everything and dropping-the-
  // flag regressions must be distinguishable in the discovery output.
  await registerTab({
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext',
    tools: [
      {
        name: 'com.discord.main.read_messages',
        description: 'Page-reported reader (collides with a builtin prefix).',
        inputSchema: { type: 'object' },
      },
    ],
  })

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

  // …while the in-memory snapshot handed to consumers flags ONLY the
  // adapter-derived tool, even though the page tool's name carries the
  // same builtin package qualifier.
  const adapterTools = response.tools.filter(
    (tool) => tool.name === 'com.discord.main.send_message'
  )
  expect(adapterTools).toHaveLength(1)
  expect(adapterTools[0]!.adapterServed).toBe(true)

  const pageTools = response.tools.filter(
    (tool) => tool.name === 'com.discord.main.read_messages'
  )
  expect(pageTools).toHaveLength(1)
  expect(pageTools[0]!.adapterServed).toBeUndefined()
  expect(pageTools[0]!.description).toBe(
    'Page-reported reader (collides with a builtin prefix).'
  )

  // Re-reading through the registry (fresh SW read path) keeps the flag off —
  // only the discovery response of the merge that saw the adapter carries it.
  const fromRegistry = entriesToDiscoveredTools(await getRegistryEntries())
  expect(fromRegistry).toHaveLength(2)
  expect(fromRegistry.find((tool) => tool.name === 'com.discord.main.send_message')!.adapterServed).toBeUndefined()
  expect(fromRegistry.find((tool) => tool.name === 'com.discord.main.read_messages')!.adapterServed).toBeUndefined()
})

it('adapter merge preserves a mid-await page report (fresh re-read before registering)', async () => {
  // Race regression: while the adapter catalog await is in flight, the page
  // reports a NEW tool. The merge must build its snapshot from the registry
  // entry re-read AFTER that await, so the newer page report survives the
  // registerTab write instead of being clobbered by the stale pre-await
  // snapshot (which never contained the new tool).
  installAdapterCatalog(async () => {
    // Simulate the page reporting a changed toolset WHILE discovery is
    // awaiting the adapter catalog (WEBMCP_TAB_REPORT → registerTab).
    // Reporting inside the provider pins the report strictly between the
    // pre-await registry snapshot and the post-await fresh re-read.
    await registerTab({
      tabId: 7,
      hostname: 'discord.com',
      origin: 'https://discord.com',
      tabTitle: 'Discord',
      tabUrl: 'https://discord.com/channels/@me',
      apiMode: 'documentModelContext',
      tools: [
        {
          name: 'page_only_tool',
          description: 'Reported while adapter discovery was in flight.',
          inputSchema: { type: 'object' },
        },
      ],
    })
    return [
      {
        name: 'com.discord.main.send_message',
        description: 'Send a message to a Discord channel.',
        inputSchema: { type: 'object' },
      },
    ]
  })
  const response = await discoverWebMCPToolsInCurrentWindow(3)

  // The adapter tool landed, flagged, in the discovery output…
  const adapterTools = response.tools.filter(
    (tool) => tool.name === 'com.discord.main.send_message'
  )
  expect(adapterTools).toHaveLength(1)
  expect(adapterTools[0]!.adapterServed).toBe(true)

  // …and the mid-await page report SURVIVED the registerTab merge write.
  const pageTools = response.tools.filter((tool) => tool.name === 'page_only_tool')
  expect(pageTools).toHaveLength(1)
  expect(pageTools[0]!.adapterServed).toBeUndefined()
  expect(pageTools[0]!.description).toBe('Reported while adapter discovery was in flight.')

  // The persisted registry keeps both tools, flag-free.
  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<Record<string, unknown>>
  }>
  const entry = persisted.find((e) => e.tabId === 7)!
  expect(entry.tools.map((tool) => tool.name).sort()).toEqual([
    'com.discord.main.send_message',
    'page_only_tool',
  ])
  expect(JSON.stringify(entry.tools)).not.toContain('adapterServed')
})

