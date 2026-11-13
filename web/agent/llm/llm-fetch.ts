import { createExtensionFetch, getMCPNetworkBridge, type MCPNetworkBridge } from '@/mcp/extension-fetch'
import { getProviderConfig, getProvidersByCategory } from '@/agent/providers/types'

const RESPONSE_HEADERS_TIMEOUT_MS = 5 * 60 * 1000

export function createLlmFetch(
  directFetch: typeof fetch,
  getBridge: () => MCPNetworkBridge | undefined = getMCPNetworkBridge,
): typeof fetch {
  return (input, init) => {
    const bridge = getBridge()
    if (bridge?.ready && bridge.mcpNetworkCapabilities?.version === 2 && typeof bridge.mcpNetworkFetch === 'function') {
      // Select the transport once. Never retry a dispatched request through
      // the browser: the upstream may already have accepted a paid generation.
      return createExtensionFetch(RESPONSE_HEADERS_TIMEOUT_MS, () => bridge)(input, init)
    }
    return directFetch(input, init)
  }
}

export const llmFetch = createLlmFetch((input, init) => globalThis.fetch(input, init))

const installedWrappers = new WeakSet<typeof fetch>()
const resolvedBaseUrls = new Set<string>()

function isWithinBase(url: URL, baseUrl: string): boolean {
  try {
    const base = new URL(baseUrl)
    const path = base.pathname.replace(/\/+$/, '')
    return url.origin === base.origin && (url.pathname === path || url.pathname.startsWith(`${path}/`))
  } catch {
    return false
  }
}

function isSdkGenerationRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (method.toUpperCase() !== 'POST') return false
  let url: URL
  try {
    url = new URL(input instanceof Request ? input.url : String(input))
  } catch {
    return false
  }
  // Only SDK generation endpoints need interception. Discovery and auxiliary
  // calls use llmFetch explicitly; website assets and tools keep normal fetch.
  if (!/\/(?:chat\/completions|responses|messages)$/.test(url.pathname) &&
      !/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(url.pathname)) return false

  for (const base of resolvedBaseUrls) {
    if (isWithinBase(url, base)) return true
  }
  // Read the registry at dispatch time so asynchronously restored custom and
  // gateway providers work without reinstalling the wrapper.
  return Object.values(getProvidersByCategory()).flat().some(({ type }) => {
    if (type === 'codex-oauth') return false
    const base = getProviderConfig(type)?.baseURL
    return !!base && isWithinBase(url, base)
  })
}

/**
 * pi-ai's native SDK handlers have no injectable fetch option. Permanently
 * route their known generation endpoints, preserving concurrent requests and
 * the existing Codex OAuth wrapper in the captured fallback chain.
 */
export function installLlmBridgeFetch(baseUrl?: string): void {
  if (baseUrl) resolvedBaseUrls.add(baseUrl)
  if (installedWrappers.has(globalThis.fetch)) return
  const directFetch = globalThis.fetch.bind(globalThis)
  const sdkFetch = createLlmFetch(directFetch)
  const wrapped: typeof fetch = (input, init) => isSdkGenerationRequest(input, init)
    ? sdkFetch(input, init)
    : directFetch(input, init)
  installedWrappers.add(wrapped)
  globalThis.fetch = wrapped
}
