import { normalizeMCPConfig } from './mcp-types'
import type { MCPInvocationContext, MCPInvocation } from './task-types'
/**
 * MCP Manager
 *
 * High-level lifecycle management for MCP (Model Context Protocol) servers.
 * Integrates with:
 * - MCPRepository for persistent storage
 * - MCPClientService for server communication
 * - ToolRegistry for tool registration (future)
 *
 * This layer handles:
 * - Server configuration CRUD operations
 * - Connection lifecycle management
 * - Tool discovery and caching
 * - Health checking
 * - System prompt generation
 */

import type {
  MCPServerConfig,
  MCPConnectionStatus,
  MCPToolDefinition,
  MCPServerType,
  MCPInitializeResult,
  MCPClientEvent,
  MCPEventListener,
} from './mcp-types'
import { MCPConnectionError, MCPToolExecutionError } from './mcp-types'
import { getMCPRepository, type StoredMCPServer } from '../sqlite/repositories/mcp.repository'
import { getMCPClient } from '../services/mcp-client.service'

//=============================================================================
// Extended Connection Status (with cached tools)
//=============================================================================

export interface MCPManagerConnectionStatus extends MCPConnectionStatus {
  /** Cached tool definitions from discovery */
  tools?: MCPToolDefinition[]
  /** Server configuration snapshot */
  config?: MCPServerConfig
  /** Last health check timestamp */
  lastHealthCheck?: number
}

//=============================================================================
// MCP Manager Configuration
//=============================================================================

export interface MCPManagerConfig {
  /** Auto-connect on startup */
  autoConnect?: boolean
  /** Health check interval in milliseconds (0 = disabled) */
  healthCheckInterval?: number
  /** Retry failed connections */
  retryOnFailure?: boolean
}

//=============================================================================
// MCP Manager Class
//=============================================================================

export class MCPManager {
  private repository = getMCPRepository()
  private client = getMCPClient()
  private config: Required<MCPManagerConfig>

  /** Connection state cache */
  private connectionCache: Map<string, MCPManagerConnectionStatus> = new Map()

  /** Event listeners */
  private listeners: Map<string, Set<MCPEventListener>> = new Map()

  /** Health check timer */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null

  /** Initialization state */
  private initialized = false

  //===========================================================================
  // Construction
  //===========================================================================

  constructor(config: MCPManagerConfig = {}) {
    this.config = {
      autoConnect: config.autoConnect ?? true,
      healthCheckInterval: config.healthCheckInterval ?? 0,
      retryOnFailure: config.retryOnFailure ?? true,
    }

    // Forward events from MCPClientService
    this.client.on('connection:stateChange', this.handleClientEvent.bind(this))
    this.client.on('tools:updated', this.handleClientEvent.bind(this))
    this.client.on('tool:executed', this.handleClientEvent.bind(this))
  }

  //===========================================================================
  // Initialization
  //===========================================================================

  /**
   * Initialize the manager - load servers from storage
   */
  private initialization?: Promise<void>

  initialize(): Promise<void> {
    return this.initialization ??= this.load().catch(error => { this.initialization = undefined; throw error })
  }

  private async load(): Promise<void> {
    if (this.initialized) {
      return
    }

    console.log('[MCPManager] Initializing...')

    // Load all servers from storage
    const servers = await this.repository.findAll()
    console.log(`[MCPManager] Loaded ${servers.length} servers from storage`)

    // Register all servers with the client
    for (const server of servers) {
      this.client.addServer(this.toClientConfig(server))

      // Initialize connection cache
      this.connectionCache.set(server.id, {
        serverId: server.id,
        state: 'disconnected',
        config: this.toClientConfig(server),
      })
    }

    // Auto-connect enabled servers if configured
    if (this.config.autoConnect) {
      await this.connectAllEnabled()
    }

    // Start health check timer if configured
    if (this.config.healthCheckInterval > 0) {
      this.startHealthCheck()
    }

    this.initialized = true
    console.log('[MCPManager] Initialization complete')
    if (typeof window !== 'undefined') void import('./task-manager').then(module => module.getMCPTaskManager().initialize()).catch(error => console.error('[MCP Tasks] Restore failed', error))
  }

  //===========================================================================
  // Server Configuration Management
  //===========================================================================

  /**
   * Add a new MCP server
   */
  async addServer(config: MCPServerConfig): Promise<void> {
    // Validate server ID format
    const validation = this.repository.validateServerId(config.id)
    if (!validation.valid) {
      throw new Error(`Invalid server ID: ${validation.error}`)
    }

    // Check for duplicate ID
    const existing = await this.repository.findById(config.id)
    if (existing) {
      throw new Error(`Server ID already exists: ${config.id}`)
    }

    // Create stored config with timestamps
    const now = Date.now()
    const storedConfig: StoredMCPServer = {
      ...config,
      transport: config.transport === 'sse' ? 'streamable_http' : config.transport ?? 'streamable_http',
      timeout: config.timeout ?? 30000,
      retryCount: config.retryCount ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      type: config.type ?? 'user',
      createdAt: now,
      updatedAt: now,
    }

    // Save to storage
    await this.repository.save(storedConfig)

    // Register with client
    this.client.addServer(this.toClientConfig(storedConfig))

    // Initialize connection cache
    this.connectionCache.set(config.id, {
      serverId: config.id,
      state: 'disconnected',
      config: this.toClientConfig(storedConfig),
    })

    console.log(`[MCPManager] Added server: ${config.id}`)

    this.emit({
      type: 'server:added',
      serverId: config.id,
      data: storedConfig,
      timestamp: now,
    })
  }

  /**
   * Update an existing MCP server
   */
  async updateServer(serverId: string, updates: Partial<MCPServerConfig>): Promise<void> {
    const existing = await this.repository.findById(serverId)
    if (!existing) {
      throw new Error(`Server not found: ${serverId}`)
    }

    // Validate ID if being changed
    if (updates.id && updates.id !== serverId) {
      const validation = this.repository.validateServerId(updates.id)
      if (!validation.valid) {
        throw new Error(`Invalid server ID: ${validation.error}`)
      }
    }

    // Disconnect if currently connected
    if (this.connectionCache.get(serverId)?.state === 'connected') {
      this.disconnect(serverId)
    }

    // Update in storage
    await this.repository.update(serverId, updates)

    // Get updated config
    const updated = await this.repository.findById(serverId)
    if (!updated) {
      return
    }

    // Update client
    const clientConfig = this.toClientConfig(updated)
    this.client.addServer(clientConfig)

    // Update cache
    const cached = this.connectionCache.get(serverId)
    if (cached) {
      cached.config = clientConfig
    }

    console.log(`[MCPManager] Updated server: ${serverId}`)

    this.emit({
      type: 'server:updated',
      serverId,
      data: updated,
      timestamp: Date.now(),
    })
  }

  /**
   * Remove an MCP server
   */
  async removeServer(serverId: string): Promise<void> {
    // Disconnect if connected
    this.disconnect(serverId)

    // Remove from client
    this.client.removeServer(serverId)

    // Remove from storage
    await this.repository.delete(serverId)

    // Clear cache
    this.connectionCache.delete(serverId)

    console.log(`[MCPManager] Removed server: ${serverId}`)

    this.emit({
      type: 'server:removed',
      serverId,
      timestamp: Date.now(),
    })
  }

  /**
   * Get a server configuration
   */
  getServer(serverId: string): MCPServerConfig | undefined {
    return this.connectionCache.get(serverId)?.config
  }

  /**
   * Get all server configurations
   */
  getAllServers(): MCPServerConfig[] {
    return Array.from(this.connectionCache.values())
      .map((s) => s.config)
      .filter((s): s is MCPServerConfig => s !== undefined)
  }

  /**
   * Get enabled servers only
   */
  getEnabledServers(): MCPServerConfig[] {
    return this.getAllServers().filter((s) => s.enabled)
  }

  /**
   * Validate a server ID format
   */
  validateServerId(serverId: string): { valid: boolean; error?: string } {
    return this.repository.validateServerId(serverId)
  }

  /**
   * Get servers by type
   */
  getServersByType(type: MCPServerType): MCPServerConfig[] {
    return this.getAllServers().filter((s) => s.type === type)
  }

  /**
   * Set server enabled status
   */
  async setEnabled(serverId: string, enabled: boolean): Promise<void> {
    const server = this.connectionCache.get(serverId)
    if (!server?.config) {
      throw new Error(`Server not found: ${serverId}`)
    }

    // Disconnect if disabling
    if (!enabled && server.state === 'connected') {
      this.disconnect(serverId)
    }

    // Update in storage
    await this.repository.setEnabled(serverId, enabled)

    // Update cache
    server.config.enabled = enabled
    this.client.addServer(server.config)

    console.log(`[MCPManager] ${enabled ? 'Enabled' : 'Disabled'} server: ${serverId}`)
  }

  //===========================================================================
  // Connection Management
  //===========================================================================

  /**
   * Connect to a specific MCP server
   */
  async connect(serverId: string): Promise<MCPInitializeResult> {
    const server = this.connectionCache.get(serverId)
    if (!server?.config) {
      throw new Error(`Server not found: ${serverId}`)
    }

    if (!server.config.enabled) {
      throw new Error(`Server is disabled: ${serverId}`)
    }

    console.log(`[MCPManager] Connecting to ${serverId}...`)

    // Update cache state
    server.state = 'connecting'

    try {
      // Connect via client
      const result = await this.client.connect(serverId)

      // Update cache with connection info
      const status = this.client.getConnectionStatus(serverId)
      if (status) {
        Object.assign(server, {
          state: status.state,
          error: status.error,
          lastConnected: status.lastConnected,
          tools: status.tools,
        })
      }

      console.log(`[MCPManager] Connected to ${serverId}`)

      return result
    } catch (error) {
      server.state = 'error'
      server.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * Disconnect from a specific MCP server
   */
  disconnect(serverId: string): void {
    const server = this.connectionCache.get(serverId)
    if (!server) {
      return
    }

    this.client.disconnect(serverId)
    server.state = 'disconnected'
    server.lastConnected = undefined

    console.log(`[MCPManager] Disconnected from ${serverId}`)
  }

  /**
   * Connect to all enabled servers
   */
  async connectAllEnabled(): Promise<Map<string, MCPInitializeResult>> {
    const results = new Map<string, MCPInitializeResult>()
    const enabled = this.getEnabledServers()

    console.log(`[MCPManager] Connecting to ${enabled.length} enabled servers...`)

    for (const server of enabled) {
      try {
        const result = await this.connect(server.id)
        results.set(server.id, result)
      } catch (error) {
        console.error(`[MCPManager] Failed to connect to ${server.id}:`, error)
        if (!this.config.retryOnFailure) {
          continue
        }
      }
    }

    return results
  }

  /**
   * Auto-connect any enabled servers that are not yet connected.
   *
   * Safe to call repeatedly — skips servers that are already connected
   * or currently connecting. Individual connection failures are caught
   * and logged so one bad server does not block the rest.
   */
  async connectUnconnectedEnabled(): Promise<number> {
    const enabled = this.getEnabledServers()
    let connected = 0

    for (const server of enabled) {
      const cache = this.connectionCache.get(server.id)
      if (cache?.state === 'connected' || cache?.state === 'connecting') {
        continue
      }

      try {
        await this.connect(server.id)
        connected++
      } catch (error) {
        console.warn(`[MCPManager] Auto-connect failed for ${server.id}:`, error)
      }
    }

    if (connected > 0) {
      console.log(`[MCPManager] Auto-connected ${connected} server(s)`)
    }

    return connected
  }

  /**
   * Disconnect from all servers
   */
  disconnectAll(): void {
    for (const serverId of this.connectionCache.keys()) {
      this.disconnect(serverId)
    }
  }

  //===========================================================================
  // Connection Status
  //===========================================================================

  /**
   * Get connection status for a server
   */
  getConnectionStatus(serverId: string): MCPManagerConnectionStatus | undefined {
    return this.connectionCache.get(serverId)
  }

  /**
   * Get all connection statuses
   */
  getAllConnectionStatuses(): MCPManagerConnectionStatus[] {
    return Array.from(this.connectionCache.values())
  }

  /**
   * Get connected servers only
   */
  getConnectedServers(): MCPServerConfig[] {
    return this.getAllServers().filter((s) => this.connectionCache.get(s.id)?.state === 'connected')
  }

  //===========================================================================
  // Tool Discovery
  //===========================================================================

  /**
   * Discover tools from a specific server
   */
  async discoverTools(serverId: string): Promise<MCPToolDefinition[]> {
    const server = this.connectionCache.get(serverId)
    if (!server?.config) {
      throw new Error(`Server not found: ${serverId}`)
    }

    console.log(`[MCPManager] Discovering tools from ${serverId}...`)

    const tools = await this.client.discoverTools(serverId)

    // Cache tools
    server.tools = tools

    console.log(`[MCPManager] Discovered ${tools.length} tools from ${serverId}`)

    return tools
  }

  /**
   * Get all tools from all connected servers
   */
  getAllTools(): Map<string, MCPToolDefinition[]> {
    const result = new Map<string, MCPToolDefinition[]>()

    for (const [serverId, status] of this.connectionCache) {
      if (status.state === 'connected' && status.tools) {
        result.set(serverId, status.tools)
      }
    }

    return result
  }

  //===========================================================================
  // Tool Execution
  //===========================================================================

  /**
   * Execute a tool on a specific server
   *
   * @param serverId - The MCP server ID
   * @param toolName - The tool name
   * @param args - Tool arguments
   * @param onProgress - Optional callback for task progress updates (for MCP Tasks)
   */
  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    onProgress?: (status: string, message?: string) => void,
    signal?: AbortSignal
  ): Promise<unknown> {
    const server = this.connectionCache.get(serverId)
    if (!server?.config) {
      throw new Error(`Server not found: ${serverId}`)
    }

    if (server.state !== 'connected') {
      throw new MCPConnectionError(serverId, `Server not connected: ${serverId}`)
    }

    console.log(`[MCPManager] Executing ${serverId}:${toolName}`)

    try {
      const result = await this.client.executeTool(
        serverId,
        {
          name: toolName,
          arguments: args,
        },
        onProgress,
        signal
      )

      return result
    } catch (error) {
      throw new MCPToolExecutionError(
        serverId,
        toolName,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  async invokeTool(serverId: string, toolName: string, args: Record<string, unknown>, options: {
    context?: MCPInvocationContext; signal?: AbortSignal; executionMode?: 'background' | 'wait'
  } = {}): Promise<MCPInvocation> {
    if (!options.context || options.executionMode === 'wait') {
      return { kind: 'result', result: await this.client.executeTool(serverId, { name: toolName, arguments: args }, undefined, options.signal, options.context) }
    }
    const { getMCPTaskManager } = await import('./task-manager')
    return getMCPTaskManager().invoke(serverId, toolName, args, options.context, options.signal)
  }

  /**
   * Execute a tool by full name (format: serverId:toolName)
   */
  async executeToolByFullName(
    fullToolName: string,
    args: Record<string, unknown> = {},
    onProgress?: (status: string, message?: string) => void
  ): Promise<unknown> {
    const [serverId, ...toolNameParts] = fullToolName.split(':')
    const toolName = toolNameParts.join(':')

    if (!serverId || !toolName) {
      throw new Error(`Invalid tool name format: ${fullToolName}. Expected: serverId:toolName`)
    }

    return this.executeTool(serverId, toolName, args, onProgress)
  }

  //===========================================================================
  // Health Checking
  //===========================================================================

  /**
   * Check health of a specific server
   */
  async healthCheck(serverId: string): Promise<boolean> {
    const server = this.connectionCache.get(serverId)
    if (!server?.config) {
      return false
    }

    // If not connected, can't be healthy
    if (server.state !== 'connected') {
      return false
    }

    try {
      // Try to discover tools as health check
      await this.discoverTools(serverId)
      server.lastHealthCheck = Date.now()
      return true
    } catch (error) {
      server.state = 'error'
      server.error = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /**
   * Check health of all connected servers
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()

    for (const [serverId, status] of this.connectionCache) {
      if (status.state === 'connected') {
        results.set(serverId, await this.healthCheck(serverId))
      }
    }

    return results
  }

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return
    }

    this.healthCheckTimer = setInterval(() => {
      this.healthCheckAll().catch((error) => {
        console.error('[MCPManager] Health check failed:', error)
      })
    }, this.config.healthCheckInterval)

    console.log(`[MCPManager] Started health check timer (${this.config.healthCheckInterval}ms)`)
  }

  /**
   * Stop periodic health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = null
      console.log('[MCPManager] Stopped health check timer')
    }
  }

  //===========================================================================
  // Event Handling
  //===========================================================================

  /**
   * Add an event listener
   */
  on(eventType: string, listener: MCPEventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set())
    }
    this.listeners.get(eventType)!.add(listener)
  }

  /**
   * Remove an event listener
   */
  off(eventType: string, listener: MCPEventListener): void {
    this.listeners.get(eventType)?.delete(listener)
  }

  /**
   * Forward events from MCPClientService
   */
  private handleClientEvent(event: MCPClientEvent): void {
    // Update connection cache based on events
    if (event.type === 'connection:stateChange') {
      const status = event.data as MCPConnectionStatus
      const cached = this.connectionCache.get(event.serverId)
      if (cached) {
        Object.assign(cached, status)
      }
    } else if (event.type === 'tools:updated') {
      const data = event.data as { tools: MCPToolDefinition[] }
      const cached = this.connectionCache.get(event.serverId)
      if (cached) {
        cached.tools = data.tools
      }
    }

    this.emit(event)
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: MCPClientEvent): void {
    const listeners = this.listeners.get(event.type)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          console.error(`[MCPManager] Event listener error:`, error)
        }
      }
    }
  }

  //===========================================================================
  // Cleanup
  //===========================================================================

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stopHealthCheck()
    this.disconnectAll()
    this.connectionCache.clear()
    this.listeners.clear()
    this.initialized = false
    this.initialization = undefined
    console.log('[MCPManager] Disposed')
  }

  //===========================================================================
  // Utility Methods
  //===========================================================================

  /**
   * Convert StoredMCPServer to MCPServerConfig (for client use)
   */
  private toClientConfig(stored: StoredMCPServer): MCPServerConfig {
    return normalizeMCPConfig({
      id: stored.id,
      name: stored.name,
      description: stored.description,
      url: stored.url,
      transport: stored.transport,
      enabled: stored.enabled,
      token: stored.token,
      timeout: stored.timeout,
      retryCount: stored.retryCount,
      retryDelay: stored.retryDelay,
      type: stored.type,
      env: stored.env,
      protocolMode: stored.protocolMode,
    })
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let managerInstance: MCPManager | null = null

export function getMCPManager(config?: MCPManagerConfig): MCPManager {
  if (!managerInstance) {
    managerInstance = new MCPManager(config)
  }
  return managerInstance
}

/**
 * Reset the singleton instance (mainly for testing)
 */
export function resetMCPManager(): void {
  managerInstance?.dispose()
  managerInstance = null
}
