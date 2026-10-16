export type WebMCPApiMode =
  | 'documentModelContext'
  | 'navigatorModelContext'
  | 'modelContextTesting'

export interface WebMCPToolMeta {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
}

export interface WebMCPDiscoveredTool extends WebMCPToolMeta {
  hostname: string
  groupKey: string
  toolsetSignature: string
  fullName: string
  tabId: number
  tabTitle?: string
  tabUrl?: string
  discoveredAt: number
  apiMode: WebMCPApiMode
}

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
  /** Resolved by the background from a trusted side-panel binding. */
  requiredTabId?: number
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
