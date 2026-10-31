import type {
  WebMCPDiscoveredTool,
  WebMCPHostCatalog,
  WebMCPRegisteredTool,
  WebMCPTabInstance,
} from './types'

function instanceKey(tool: WebMCPDiscoveredTool): string {
  return `${tool.origin}\u0000${tool.name}\u0000${tool.tabId}`
}

export function dedupeDiscoveredInstances(
  tools: WebMCPDiscoveredTool[],
): WebMCPDiscoveredTool[] {
  const deduped = new Map<string, WebMCPDiscoveredTool>()

  for (const tool of tools) {
    const key = instanceKey(tool)
    const existing = deduped.get(key)
    if (!existing || tool.discoveredAt > existing.discoveredAt) {
      deduped.set(key, tool)
    }
  }

  return Array.from(deduped.values())
}

export function buildTabs(tools: WebMCPDiscoveredTool[]): WebMCPTabInstance[] {
  const tabs = new Map<number, WebMCPTabInstance>()

  for (const tool of tools) {
    const existing = tabs.get(tool.tabId)
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt, tool.discoveredAt)
      if (!existing.title && tool.tabTitle) existing.title = tool.tabTitle
      if (!existing.url && tool.tabUrl) existing.url = tool.tabUrl
      // A tab's route key rotates when the page re-registers its tools, so
      // keep whichever instance is the most recent one.
      if (
        tool.groupKey &&
        tool.groupKey !== existing.groupKey &&
        tool.discoveredAt >= existing.lastSeenAt
      ) {
        existing.groupKey = tool.groupKey
      }
      continue
    }

    tabs.set(tool.tabId, {
      tabId: tool.tabId,
      title: tool.tabTitle || '',
      url: tool.tabUrl || '',
      lastSeenAt: tool.discoveredAt,
      groupKey: tool.groupKey,
    })
  }

  return Array.from(tabs.values()).sort((a, b) => {
    if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt
    return a.tabId - b.tabId
  })
}

function buildRegisteredTools(
  tools: WebMCPDiscoveredTool[],
): WebMCPRegisteredTool[] {
  const grouped = new Map<string, WebMCPDiscoveredTool[]>()

  for (const tool of tools) {
    const key = `${tool.origin}\u0000${tool.name}`
    const existing = grouped.get(key)
    if (existing) existing.push(tool)
    else grouped.set(key, [tool])
  }

  return Array.from(grouped.values())
    .map((instances) => {
      const representative = [...instances].sort((a, b) => {
        if (b.discoveredAt !== a.discoveredAt) return b.discoveredAt - a.discoveredAt
        return a.tabId - b.tabId
      })[0]!
      return {
        origin: representative.origin,
        name: representative.name,
        description: representative.description,
        inputSchema: representative.inputSchema,
        annotations: representative.annotations,
        hostname: representative.hostname,
        fullName: representative.fullName,
        apiMode: representative.apiMode,
        adapterServed: representative.adapterServed,
        tabs: buildTabs(instances),
        discoveredAt: Math.max(...instances.map((instance) => instance.discoveredAt)),
      }
    })
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
}

export function buildHostCatalog(
  tools: WebMCPDiscoveredTool[],
): Record<string, WebMCPHostCatalog> {
  const hostTools = new Map<string, WebMCPDiscoveredTool[]>()
  for (const tool of tools) {
    const existing = hostTools.get(tool.hostname)
    if (existing) existing.push(tool)
    else hostTools.set(tool.hostname, [tool])
  }

  const result: Record<string, WebMCPHostCatalog> = {}
  for (const [hostname, instances] of hostTools) {
    result[hostname] = {
      hostname,
      registeredTools: buildRegisteredTools(instances),
      tabs: buildTabs(instances),
      lastDiscoveredAt: Math.max(...instances.map((instance) => instance.discoveredAt)),
    }
  }

  return result
}
