export type WebMCPApiMode = 'documentModelContext'

export interface WebMCPToolDefinition {
  /** Canonical page origin (scheme + host + optional port). */
  origin: string
  /** Raw tool name registered by the page or adapter. */
  name: string
}

export interface WebMCPToolMeta {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  /**
   * SW-internal ownership marker (extension adapter catalog owns this tool
   * name on the tab). Set only by the SW's own registerTab merge call —
   * sanitizeTool whitelists fields, so page reports cannot set it. Stripped
   * before discovery output; never leaves the service worker.
   */
  adapterOwned?: boolean
}

export interface WebMCPDiscoveredTool extends WebMCPToolDefinition, WebMCPToolMeta {
  hostname: string
  fullName: string
  tabId: number
  tabTitle?: string
  tabUrl?: string
  discoveredAt: number
  apiMode: WebMCPApiMode
  /** Set by the SW adapter catalog merge; page-registered tools never carry it. */
  adapterServed?: boolean
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
  /** Exact browser tab selected by the caller after discovery. */
  targetTabId: number
  /** Expected page origin; the background verifies this against the live tab. */
  origin: string
  /** Raw WebMCP tool name; no schema-derived identity is involved. */
  toolName: string
  args?: Record<string, unknown>
  /** Opaque side-panel session binding used to authorize a target window. */
  binding?: string
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
