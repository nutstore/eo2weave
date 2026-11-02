export type WebMCPApiMode = 'documentModelContext'

export interface WebMCPToolDefinition {
  /** Canonical page origin (scheme + host + optional port). */
  origin: string
  /** Raw tool name registered by the page or adapter. */
  name: string
}

export interface WebMCPDiscoveredTool extends WebMCPToolDefinition {
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  hostname: string
  /** Provider-safe call_tool name derived from origin + raw tool name. */
  fullName: string
  tabId: number
  tabTitle?: string
  tabUrl?: string
  discoveredAt: number
  apiMode: WebMCPApiMode
  /** Extension-side per-host authorization flag (annotated by background) */
  hostEnabled?: boolean
  /**
   * Legacy route key (`hostname_<toolsetSignature>`) reported by extension
   * <= 1.1.7, which routes invocations by key instead of by origin + raw
   * tool name. Absent on newer extensions.
   */
  groupKey?: string
}

export type WebMCPDiscoveredToolInstance = WebMCPDiscoveredTool

export interface WebMCPDiscoverResponse {
  ok: boolean
  tools: WebMCPDiscoveredTool[]
  scannedTabs: number
  discoveredTabs: number
  discoveredAt: number
  error?: string
}

export interface WebMCPInvokeRequest {
  targetTabId: number
  origin: string
  toolName: string
  args?: Record<string, unknown>
  binding?: string
  /**
   * Legacy routing fields for extension <= 1.1.7, which resolves the target
   * tab by `groupKey` + `fullToolName` instead of by origin + raw tool name.
   * Newer extensions ignore them; sending both keeps one web app working
   * with either extension generation.
   */
  groupKey?: string
  fullToolName?: string
  preferredTabId?: number
}

export interface WebMCPPluginDownloadPlan {
  transferId: string
  downloadUrl: string
  savePath: string
  fileName: string
  originalResult: Record<string, unknown>
}

export interface WebMCPPluginDownloadStartFrame {
  type: 'start'
  transferId: string
  fileName: string
  mimeType: string
  totalChunks: number
  totalChars: number
  savePath: string
}

export interface WebMCPPluginDownloadChunkFrame {
  type: 'chunk'
  transferId: string
  index: number
  data: string
}

export interface WebMCPPluginDownloadEndFrame {
  type: 'end'
  transferId: string
}

export interface WebMCPPluginDownloadErrorFrame {
  type: 'error'
  transferId: string
  errorCode: string
  message: string
}

export type WebMCPPluginDownloadFrame =
  | WebMCPPluginDownloadStartFrame
  | WebMCPPluginDownloadChunkFrame
  | WebMCPPluginDownloadEndFrame
  | WebMCPPluginDownloadErrorFrame

export interface WebMCPInvokeResponse {
  ok: boolean
  origin: string
  hostname: string
  toolName: string
  tabId?: number
  apiMode?: WebMCPApiMode
  result?: unknown
  pluginDownloadPlan?: WebMCPPluginDownloadPlan
  errorCode?: string
  error?: string
}

export interface WebMCPTabInstance {
  tabId: number
  title: string
  url: string
  lastSeenAt: number
  /**
   * Legacy route key of the tab's toolset. Kept per tab because the key
   * covers a host's whole toolset signature, so two tabs exposing the same
   * tool can carry different keys.
   */
  groupKey?: string
}

export interface WebMCPRegisteredTool {
  origin: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  hostname: string
  fullName: string
  apiMode: WebMCPApiMode
  tabs: WebMCPTabInstance[]
  discoveredAt: number
}

export interface WebMCPHostCatalog {
  hostname: string
  registeredTools: WebMCPRegisteredTool[]
  tabs: WebMCPTabInstance[]
  lastDiscoveredAt: number
}

export interface WebMCPBridge {
  ready: boolean
  webMCPDiscover: (options?: { force?: boolean; binding?: string }) => Promise<WebMCPDiscoverResponse>
  webMCPInvoke: (payload: WebMCPInvokeRequest) => Promise<WebMCPInvokeResponse>
  /** Extension-side authorization state (storage.local is the source of truth) */
  webMCPGetAuthorization?: () => Promise<{
    ok: boolean
    enabledByHost?: Record<string, boolean>
    error?: string
  }>
  webMCPPluginDownloadStream?: (payload: {
    transferId: string
    downloadUrl: string
    savePath: string
    fileName: string
  }) => AsyncIterable<WebMCPPluginDownloadFrame> & { cancel: () => void }
  webMCPPluginDownloadFinalize?: (payload: {
    transferId: string
    savedPath: string
  }) => Promise<{ ok: boolean; transferId?: string; error?: string }>
  /** Cross-context package-transaction lock (extension ≥ this build only). */
  webMCPPackageLock?: (
    packageId: string,
    action: 'acquire' | 'heartbeat' | 'release',
    owner?: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; owner?: string; code?: string; error?: string }>
  /** Announce an external-package install/uninstall so the background refreshes its catalog (extension ≥ this build only). */
  webMCPPackagesChangedNotify?: () => Promise<{ ok: boolean; error?: string }>
}
