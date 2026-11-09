/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * Based on MCP specification: https://spec.modelcontextprotocol.io/
 * Supports Streamable HTTP transport with JSON-RPC 2.0
 */

export type {
  JSONRPCRequest, CallToolRequestParams as MCPToolCallRequest,
  CallToolResult as MCPToolCallResult, Resource as MCPResourceDefinition,
  ReadResourceResult as MCPResourceContent, InitializeRequestParams as MCPInitializeParams,
  ClientCapabilities as MCPClientCapabilities, InitializeResult as MCPInitializeResult,
  ServerCapabilities as MCPServerCapabilities, ListToolsResult as MCPToolsListResult,
  ListResourcesResult as MCPResourcesListResult,
} from '@modelcontextprotocol/client'
import type { Tool, ServerCapabilities } from '@modelcontextprotocol/client'
export type JSONRPCResponse<T = unknown> = { jsonrpc: '2.0'; id: string | number; result?: T; error?: { code: number; message: string; data?: unknown } }
export type MCPToolDefinition = Tool & { _serverId?: string }
export type MCPToolInputSchema = Tool['inputSchema']

//=============================================================================
// MCP Server Configuration
//=============================================================================

export type MCPServerType = 'builtin' | 'user' | 'project'

export type MCPTransportType = 'streamable_http' | 'legacy_sse' | 'sse'

export interface MCPServerConfig {
  /** Unique server ID (user-defined, memorable format like "excel-analyzer") */
  id: string
  /** Display name */
  name: string
  /** Optional description */
  description?: string
  /** Server URL (HTTP endpoint for MCP SSE/Streamable HTTP) */
  url: string
  /** Transport type */
  transport: MCPTransportType
  protocolMode?: 'auto' | 'legacy'
  /** Whether this server is enabled */
  enabled: boolean
  /** Optional authentication token (Bearer) */
  token?: string
  /** Timeout in milliseconds (default 30000) */
  timeout?: number
  /** Retry count (default 3) */
  retryCount?: number
  /** Retry delay in milliseconds (default 1000) */
  retryDelay?: number
  /** Server type/category */
  type?: MCPServerType
  /** Optional environment variables (JSON object) */
  env?: Record<string, string>
  /** Session ID for persistent connections */
  sessionId?: string
}

//=============================================================================
// MCP Connection State
//=============================================================================

export type MCPConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MCPConnectionStatus {
  serverId: string
  state: MCPConnectionState
  error?: string
  lastConnected?: number
  tools?: MCPToolDefinition[]
  protocolVersion?: string
  capabilities?: ServerCapabilities
}

//=============================================================================
// MCP Client Events
//=============================================================================

export type MCPClientEventType =
  | 'connection:stateChange'
  | 'connection:error'
  | 'tools:updated'
  | 'tool:executed'
  | 'server:added'
  | 'server:removed'
  | 'server:updated'

export interface MCPClientEvent {
  type: MCPClientEventType
  serverId: string
  data?: unknown
  timestamp: number
}

export type MCPEventListener = (event: MCPClientEvent) => void

//=============================================================================
// Error Classes (exported as values for runtime use)
//=============================================================================

export class MCPError extends Error {
  constructor(
    message: string,
    public code: number,
    public serverId?: string
  ) {
    super(message)
    this.name = 'MCPError'
  }
}

export class MCPConnectionError extends MCPError {
  constructor(serverId: string, message: string) {
    super(message, -1, serverId)
    this.name = 'MCPConnectionError'
  }
}

export class MCPToolExecutionError extends MCPError {
  constructor(serverId: string, toolName: string, message: string) {
    super(`Tool ${toolName} failed: ${message}`, -32603, serverId)
    this.name = 'MCPToolExecutionError'
  }
}

//=============================================================================
// SEP-1306: Binary Mode Elicitation for File Uploads
//=============================================================================

export type ElicitationMode = 'form' | 'url' | 'binary'

export interface FileSchemaProperty {
  type: 'file'
  title?: string
  description?: string
  accept?: string[] // MIME types or extensions like [".xlsx", ".csv"]
  maxSize?: number
  multiple?: boolean
  required?: boolean
}

export interface ElicitationSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface UploadEndpoint {
  url: string
  method: 'POST' | 'PUT'
  uploadId: string
}

export interface BinaryElicitation {
  mode: 'binary'
  message: string
  requestedSchema: ElicitationSchema
  uploadEndpoints: Record<string, UploadEndpoint>
}

export interface FileMetadata {
  name: string
  size: number
  mimeType: string
  uploadId: string
  // Additional fields for tool usage
  file_id?: string
  download_url?: string
}

/** Normalize the former POST-stream label without reusing stale session IDs. */
export function normalizeMCPConfig(config: MCPServerConfig): MCPServerConfig {
  return { ...config, transport: config.transport === 'sse' ? 'streamable_http' : config.transport,
    protocolMode: config.protocolMode ?? 'auto', sessionId: undefined }
}
