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

it('reconciles removed adapter tools out of the stored registry on the next merge', async () => {
  // Sourcery regression guard: the merge used to start from every stored
  // tool and only ADD current adapter tools, so a package update that
  // removed or renamed a tool left the stale name advertised with no route
  // behind it. Adapter-owned names must be dropped when the current catalog
  // no longer lists them, while page-reported names survive untouched.
  const base = {
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext' as const,
  }
  // First scan: adapter serves two tools, the page reported one of its own.
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'com.discord.main.read_messages',
      description: 'Read recent messages from a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  await discoverWebMCPToolsInCurrentWindow(3)
  expect(
    (sessionStore.get('webmcp_tab_registry') as Array<{ tools: Array<{ name: string }> }>)[0]!
      .tools.map((tool) => tool.name).sort(),
  ).toEqual(['com.discord.main.read_messages', 'com.discord.main.send_message'])

  // Package update: the adapter no longer serves read_messages.
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  await discoverWebMCPToolsInCurrentWindow(3)

  const entry = (
    sessionStore.get('webmcp_tab_registry') as Array<{ tools: Array<{ name: string }> }>
  )[0]!
  // Removed adapter tool is reconciled away…
  expect(entry.tools.map((tool) => tool.name)).toEqual(['com.discord.main.send_message'])
  // …while a concurrently reported page tool would have survived. Verify
  // the reconciliation does not eat page-owned names either:
  await registerTab({
    ...base,
    tools: [
      { name: 'page_only_tool', description: 'Page-owned.', inputSchema: { type: 'object' } },
    ],
  })
  await discoverWebMCPToolsInCurrentWindow(3)
  const afterPageReport = (
    sessionStore.get('webmcp_tab_registry') as Array<{ tools: Array<{ name: string }> }>
  )[0]!
  expect(afterPageReport.tools.map((tool) => tool.name).sort()).toEqual([
    'com.discord.main.send_message',
    'page_only_tool',
  ])
})

it('a page cannot forge the adapter ownership marker through a tab report', async () => {
  // adapterOwned is SW-internal: it must only ever be set by the adapter
  // merge in discovery.ts. A hostile page reporting a forged marker via
  // WEBMCP_TAB_REPORT gets its field stripped by the field-whitelisting
  // sanitizer, and the marker must not survive a storage.session hydration
  // roundtrip either (it is rebuilt from the stored marker set, never taken
  // from the page payload).
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
        description: 'Page tool pretending to be adapter-owned.',
        inputSchema: { type: 'object' },
        // @ts-expect-error page-controlled input must not smuggle the marker
        adapterOwned: true,
      },
    ],
  })
  expect(
    JSON.stringify(sessionStore.get('webmcp_tab_registry')),
  ).not.toContain('adapterOwned')

  // Hydration roundtrip: rebuild the in-memory map from what the previous
  // scan persisted. The page never earned the marker, so reconciliation
  // must not treat this name as adapter-owned (a merge that stops serving
  // it must remove it, exactly as for genuinely adapter-owned names).
  installAdapterCatalog(async () => [])
  const response = await discoverWebMCPToolsInCurrentWindow(3)
  // No adapter tools → snapshot returns null → nothing rewritten; the entry
  // stays page-owned and the discovery output keeps the page description.
  expect(response.tools).toHaveLength(1)
  expect(response.tools[0]!.name).toBe('com.discord.main.send_message')
  expect(response.tools[0]!.description).toBe('Page tool pretending to be adapter-owned.')
})

it('an empty adapter catalog still reconciles stale adapter-owned names away', async () => {
  // Sourcery regression guard: with the !adapters.length early-return in
  // place, a tab whose adapter catalog became EMPTY after previously serving
  // tools never reached ownership reconciliation — the previously persisted
  // adapter-owned names stayed advertised with no route behind them. The
  // empty catalog must produce a registerTab write (empty adapterOwnedNames)
  // that drops them.
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  await discoverWebMCPToolsInCurrentWindow(3)
  expect(
    (sessionStore.get('webmcp_tab_registry') as Array<{ tabId: number; tools: Array<{ name: string }> }>)
      .find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name),
  ).toEqual(['com.discord.main.send_message'])

  // Package disabled/uninstalled: the catalog is now empty. The tab also
  // carries a page tool, which must NOT be reconciled away with the adapter
  // tools.
  await registerTab({
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext',
    tools: [
      { name: 'page_only_tool', description: 'Page-owned.', inputSchema: { type: 'object' } },
    ],
  })
  installAdapterCatalog(async () => [])
  await discoverWebMCPToolsInCurrentWindow(3)

  // The stale adapter tool is gone from the registry…
  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<{ name: string }>
  }>
  expect(persisted.find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name))
    .toEqual(['page_only_tool'])
  // …and from the discovery output, while the page tool on the same tab
  // survives untouched.
  expect(
    (await discoverWebMCPToolsInCurrentWindow(3)).tools.map((tool) => tool.name),
  ).toEqual(['page_only_tool'])
})

it('same-name page + adapter tool keeps the page tool when the adapter drops it', async () => {
  // Sourcery regression guard: the adapter loop used to REPLACE the merged
  // entry on a same-name collision AND mark it adapter-owned. When a later
  // catalog update removed the adapter tool, reconciliation then removed the
  // (now adapter-owned) name — killing the page tool until the page
  // re-reported its toolset. The page tool must survive both transitions.
  const base = {
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext' as const,
  }
  await registerTab({
    ...base,
    tools: [
      {
        name: 'com.discord.main.send_message',
        description: 'Page-provided implementation of the colliding name.',
        inputSchema: { type: 'object' },
      },
    ],
  })

  // Adapter ALSO serves the same raw name (collides with the page tool).
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  const withAdapter = await discoverWebMCPToolsInCurrentWindow(3)
  // Route truth is unaffected while the adapter serves the name…
  const routed = withAdapter.tools.find((tool) => tool.name === 'com.discord.main.send_message')!
  expect(routed.description).toBe('Page-provided implementation of the colliding name.')

  // …but the PERSISTED entry must keep the page tool, unmarked — so removing
  // the adapter tool later cannot take the page tool down with it.
  installAdapterCatalog(async () => [])
  await discoverWebMCPToolsInCurrentWindow(3)
  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<{ name: string; description?: string }>
  }>
  expect(persisted.find((entry) => entry.tabId === 7)!.tools).toEqual([
    {
      name: 'com.discord.main.send_message',
      description: 'Page-provided implementation of the colliding name.',
      inputSchema: { type: 'object' },
      annotations: undefined,
    },
  ])
})

it('a page report never strips adapter-owned tools', async () => {
  // Sourcery regression guard: registerTab used to REPLACE the tab entry
  // with the page report's tools. After discovery persisted adapter tools
  // for the tab, a WEBMCP_TAB_REPORT toolset change made those adapter tools
  // vanish until the next adapter merge. Page reports must merge onto the
  // existing adapter-owned set instead.
  const base = {
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext' as const,
  }
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  await discoverWebMCPToolsInCurrentWindow(3)
  expect(
    (sessionStore.get('webmcp_tab_registry') as Array<{ tabId: number; tools: Array<{ name: string }> }>)
      .find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name),
  ).toEqual(['com.discord.main.send_message'])

  // The page reports a NEW toolset (adding its own tool) — it does not
  // mention the adapter tool at all.
  await registerTab({
    ...base,
    tools: [
      { name: 'page_new_tool', description: 'Freshly registered by the page.', inputSchema: { type: 'object' } },
    ],
  })
  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<{ name: string; description?: string }>
  }>
  expect(
    persisted.find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name).sort(),
  ).toEqual(['com.discord.main.send_message', 'page_new_tool'])

  // The discovery output keeps advertising the adapter tool…
  const response = await discoverWebMCPToolsInCurrentWindow(3)
  expect(response.tools.find((tool) => tool.name === 'com.discord.main.send_message')).toBeTruthy()
  expect(response.tools.find((tool) => tool.name === 'page_new_tool')).toBeTruthy()
})

it('an empty page report keeps adapter-owned tools and drops page tools', async () => {
  // A page unregistering ALL its tools must not deregister the adapter tools
  // (they are still served by the SW catalog), but the tab entry must not
  // keep advertising page tools the page just removed either.
  const base = {
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext' as const,
  }
  installAdapterCatalog(async () => [
    {
      name: 'com.discord.main.send_message',
      description: 'Send a message to a Discord channel.',
      inputSchema: { type: 'object' },
    },
  ])
  await discoverWebMCPToolsInCurrentWindow(3)
  await registerTab({
    ...base,
    tools: [
      { name: 'page_temp_tool', description: 'Transient page tool.', inputSchema: { type: 'object' } },
    ],
  })
  await registerTab({ ...base, tools: [] })

  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<{ name: string }>
  }>
  expect(persisted.find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name))
    .toEqual(['com.discord.main.send_message'])
})

it('a page report landing between the fresh re-read and registerTab survives the merge write', async () => {
  // Sourcery regression guard: getFreshRegistryEntryForTab can STILL go stale
  // — a WEBMCP_TAB_REPORT may land after it returns but before registerTab
  // runs. registerTab now merges against the LIVE entry, so the newly
  // reported tool must not be clobbered by the stale snapshot.
  const base = {
    tabId: 7,
    hostname: 'discord.com',
    origin: 'https://discord.com',
    tabTitle: 'Discord',
    tabUrl: 'https://discord.com/channels/@me',
    apiMode: 'documentModelContext' as const,
  }
  await registerTab({
    ...base,
    tools: [
      { name: 'page_old_tool', description: 'Reported before discovery.', inputSchema: { type: 'object' } },
    ],
  })
  installAdapterCatalog(async () => {
    // Pin the report strictly AFTER getFreshRegistryEntryForTab has read the
    // old entry: the provider await sits between the fresh re-read and the
    // registerTab write in discovery.ts.
    await registerTab({
      ...base,
      tools: [
        { name: 'page_old_tool', description: 'Reported before discovery.', inputSchema: { type: 'object' } },
        { name: 'page_midawait_tool', description: 'Reported after the fresh re-read.', inputSchema: { type: 'object' } },
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

  const persisted = sessionStore.get('webmcp_tab_registry') as Array<{
    tabId: number
    tools: Array<{ name: string; description?: string }>
  }>
  expect(
    persisted.find((entry) => entry.tabId === 7)!.tools.map((tool) => tool.name).sort(),
  ).toEqual(['com.discord.main.send_message', 'page_midawait_tool', 'page_old_tool'])
  expect(
    response.tools.find((tool) => tool.name === 'page_midawait_tool')!.description,
  ).toBe('Reported after the fresh re-read.')
})

