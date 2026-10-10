export type WebMCPApiMode = 'documentModelContext'

export interface WebMCPDiscoveredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  hostname: string
  groupKey: string
  toolsetSignature: string
  fullName: string
  tabId: number
  tabTitle?: string
  tabUrl?: string
  discoveredAt: number
  apiMode: WebMCPApiMode
  /** Extension-side per-host authorization flag (annotated by background) */
  hostEnabled?: boolean
  /** Extension-side per-group authorization flag (annotated by background) */
  groupEnabled?: boolean
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
  groupKey: string
  fullToolName: string
  args?: Record<string, unknown>
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
  hostname: string
  toolName: string
  fullToolName: string
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
}

export interface WebMCPRegisteredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  hostname: string
  groupKey: string
  toolsetSignature: string
  fullName: string
  apiMode: WebMCPApiMode
  representativeTabId: number
  representativeTabTitle?: string
  representativeTabUrl?: string
  discoveredAt: number
}

export interface WebMCPToolGroupCatalog {
  groupKey: string
  hostname: string
  toolsetSignature: string
  displayName: string
  registeredTools: WebMCPRegisteredTool[]
  tabs: WebMCPTabInstance[]
  lastDiscoveredAt: number
}

export interface WebMCPHostCatalog {
  hostname: string
  groups: WebMCPToolGroupCatalog[]
  lastDiscoveredAt: number
}

export interface WebMCPBridge {
  ready: boolean
  webMCPDiscover: (options?: { force?: boolean }) => Promise<WebMCPDiscoverResponse>
  webMCPInvoke: (payload: WebMCPInvokeRequest) => Promise<WebMCPInvokeResponse>
  /** Extension-side authorization state (storage.local is the source of truth) */
  webMCPGetAuthorization?: () => Promise<{
    ok: boolean
    enabledByHost?: Record<string, boolean>
    enabledByGroup?: Record<string, boolean>
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
}
