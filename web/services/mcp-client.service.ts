import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core'
/** Browser MCP connections. The SDK owns negotiation, framing and transport state. */
import type { Client, Transport } from '@modelcontextprotocol/client'
import type {
  TaskEnabledSession,
  ToolExecution,
  SerializedTaskReference,
  TaskRecoveryOptions,
} from '@modelcontextprotocol/ext-tasks/client'
import type {
  MCPServerConfig,
  MCPConnectionStatus,
  MCPConnectionState,
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPToolCallResult,
  MCPInitializeResult,
  MCPResourceDefinition,
  MCPClientEvent,
  MCPClientEventType,
  MCPEventListener,
} from '@/mcp/mcp-types'
import { normalizeMCPConfig, MCPConnectionError } from '@/mcp/mcp-types'
import { createExtensionFetch, hasMCPNetworkV2 } from '@/mcp/extension-fetch'
import { createRawDispatch } from '@/mcp/raw-request'
import type { MCPInvocationContext, ManagedMCPTask } from '@/mcp/task-types'

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export const MCP_CLIENT_INFO = { name: 'creatorweave', version: '1.0.0' }
export const MCP_CLIENT_CAPABILITIES = {
  roots: {},
  sampling: { tools: {} },
  elicitation: { form: {}, url: {} },
  extensions: { 'io.modelcontextprotocol/tasks': {} },
}
type MCPExecution = ToolExecution<MCPToolCallResult, MCPInvocationContext | undefined>

export interface MCPConnectionRuntime {
  connectionId: string
  client: Client
  transport: Transport
  tasks: TaskEnabledSession<MCPInvocationContext | undefined>
  endpointId: string
  initialization: MCPInitializeResult
  executions: Set<MCPExecution>
  pendingExecutions: Set<Promise<MCPExecution>>
}

export class MCPClientService {
  private servers = new Map<string, MCPServerConfig>()
  private connections = new Map<string, MCPConnectionStatus>()
  private listeners = new Map<MCPClientEventType, Set<MCPEventListener>>()
  private runtimes = new Map<string, MCPConnectionRuntime>()
  private connecting = new Map<string, Promise<MCPInitializeResult>>()
  private connectionAborts = new Map<string, AbortController>()
  private generations = new Map<string, number>()

  addServer(config: MCPServerConfig): void {
    const existing = this.servers.get(config.id)
    const server = normalizeMCPConfig(config)
    if (existing && JSON.stringify(existing) !== JSON.stringify(server)) this.disconnect(config.id)
    this.servers.set(config.id, server)
    this.emit({
      type: existing ? 'server:updated' : 'server:added',
      serverId: config.id,
      data: server,
      timestamp: Date.now(),
    })
  }
  removeServer(serverId: string): boolean {
    this.disconnect(serverId)
    const removed = this.servers.delete(serverId)
    this.connections.delete(serverId)
    if (removed) this.emit({ type: 'server:removed', serverId, timestamp: Date.now() })
    return removed
  }
  getServer(serverId: string) {
    return this.servers.get(serverId)
  }
  getAllServers() {
    return [...this.servers.values()]
  }
  getEnabledServers() {
    return this.getAllServers().filter((server) => server.enabled)
  }
  getConnectionStatus(serverId: string) {
    return this.connections.get(serverId)
  }
  getAllConnectionStatuses() {
    return [...this.connections.values()]
  }

  connect(serverId: string): Promise<MCPInitializeResult> {
    const pending = this.connecting.get(serverId)
    if (pending) return pending
    const existing = this.runtimes.get(serverId)
    if (existing) return Promise.resolve(existing.initialization)
    const generation = (this.generations.get(serverId) ?? 0) + 1
    this.generations.set(serverId, generation)
    const controller = new AbortController()
    this.connectionAborts.set(serverId, controller)
    const promise = this.open(serverId, generation, controller.signal).finally(() => {
      if (this.connecting.get(serverId) === promise) {
        this.connecting.delete(serverId)
        this.connectionAborts.delete(serverId)
      }
    })
    this.connecting.set(serverId, promise)
    return promise
  }
  private async open(
    serverId: string,
    generation: number,
    signal: AbortSignal
  ): Promise<MCPInitializeResult> {
    const server = this.servers.get(serverId)
    if (!server?.enabled)
      throw new MCPConnectionError(serverId, 'MCP server is missing or disabled')
    this.updateConnectionState(serverId, 'connecting')
    const [sdk, tasks, input] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/ext-tasks/client'),
      import('@/mcp/input-manager'),
    ])
    const client = new sdk.Client(MCP_CLIENT_INFO, {
      capabilities: MCP_CLIENT_CAPABILITIES,
      versionNegotiation: { mode: server.protocolMode ?? 'auto' },
    })
    const fetcher = createExtensionFetch(server.timeout)
    const options = { fetch: fetcher, requestInit: { headers: this.headers(server) } }
    const transport =
      server.transport === 'legacy_sse'
        ? new sdk.SSEClientTransport(new URL(server.url), options)
        : new sdk.StreamableHTTPClientTransport(new URL(server.url), options)
    let runtime: MCPConnectionRuntime | undefined
    try {
      if (server.transport === 'legacy_sse' && !hasMCPNetworkV2())
        throw new Error('Upgrade the browser extension for legacy SSE')
      await client.connect(transport, { timeout: server.timeout ?? 30000, signal })
      if (this.generations.get(serverId) !== generation) throw new Error('MCP connection replaced')
      const initialization: MCPInitializeResult = {
        protocolVersion: client.getNegotiatedProtocolVersion()!,
        capabilities: client.getServerCapabilities() ?? {},
        serverInfo: client.getServerVersion()!,
      }
      const endpointId = await this.endpointId(serverId)
      client.onclose = () => {
        if (this.runtimes.get(serverId) !== runtime) return
        this.runtimes.delete(serverId)
        this.updateConnectionState(serverId, 'disconnected')
      }
      const session = tasks.createTaskSessionFromClient<MCPInvocationContext | undefined>(client, {
        endpointId,
        rawDispatch: createRawDispatch(server.url, fetcher, () => ({
          ...this.headers(server),
          'mcp-protocol-version': initialization.protocolVersion,
          ...('sessionId' in transport && transport.sessionId
            ? { 'mcp-session-id': String(transport.sessionId) }
            : {}),
        })),
        v2RequestFraming: {
          protocolVersion: initialization.protocolVersion,
          clientInfo: MCP_CLIENT_INFO,
          clientCapabilities: MCP_CLIENT_CAPABILITIES,
        },
        tools: {
          currentTool: (name) => {
            const tool = this.connections.get(serverId)?.tools?.find((tool) => tool.name === name)
            return tool ? tasks.toolDeclarationFromMcpTool(tool) : undefined
          },
        },
        onInputRequest: input.getMCPInputManager().handler(serverId),
      })
      runtime = {
        connectionId: crypto.randomUUID(),
        client,
        transport,
        tasks: session,
        endpointId,
        initialization,
        executions: new Set(),
        pendingExecutions: new Set(),
      }
      if (this.generations.get(serverId) !== generation) throw new Error('MCP connection replaced')
      this.runtimes.set(serverId, runtime)
      this.connections.set(serverId, {
        serverId,
        state: 'connected',
        lastConnected: Date.now(),
        protocolVersion: initialization.protocolVersion,
        capabilities: initialization.capabilities,
      })
      await this.discoverTools(serverId)
      this.updateConnectionState(serverId, 'connected')
      return initialization
    } catch (error) {
      if (runtime)
        for (const execution of runtime.executions) await execution.detach().catch(() => {})
      await runtime?.tasks.close().catch(() => {})
      await client.close().catch(() => {})
      if (this.generations.get(serverId) === generation) {
        this.runtimes.delete(serverId)
        this.updateConnectionState(
          serverId,
          'error',
          error instanceof Error ? error.message : String(error)
        )
      }
      throw error
    }
  }
  disconnect(serverId: string): void {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1)
    this.connectionAborts.get(serverId)?.abort()
    this.connectionAborts.delete(serverId)
    this.connecting.delete(serverId)
    const runtime = this.runtimes.get(serverId)
    this.runtimes.delete(serverId)
    if (runtime)
      void (async () => {
        // Closing the SDK transport invalidates local driving without cancelling Tasks.
        // Await in-flight resumes as well as owned executions before Session.close(),
        // whose default disposal semantics would otherwise cancel detached work.
        await runtime.client.close().catch(() => {})
        await Promise.allSettled([...runtime.pendingExecutions])
        await Promise.all(
          [...runtime.executions].map(async (execution) => {
            await execution.detach().catch(() => {})
            await execution.result().catch(() => {})
          })
        )
        await runtime.tasks.close().catch(() => {})
      })()
    this.updateConnectionState(serverId, 'disconnected')
  }
  private runtime(serverId: string): MCPConnectionRuntime {
    const runtime = this.runtimes.get(serverId)
    if (!runtime) throw new MCPConnectionError(serverId, 'MCP server is not connected')
    return runtime
  }
  getRuntime(serverId: string) {
    return this.runtime(serverId)
  }
  private headers(server: MCPServerConfig): Record<string, string> {
    return server.token ? { Authorization: `Bearer ${server.token}` } : {}
  }
  async endpointId(serverId: string): Promise<string> {
    const server = this.servers.get(serverId)
    if (!server) throw new Error('MCP server not found')
    const { createTaskSessionEndpointId } = await import('@modelcontextprotocol/ext-tasks/client')
    // Auth is hashed into identity; secrets are never stored with task records.
    return createTaskSessionEndpointId('creatorweave', {
      url: server.url,
      transport: server.transport,
      protocolMode: server.protocolMode,
      auth: server.token ?? '',
    })
  }
  async discoverTools(serverId: string): Promise<MCPToolDefinition[]> {
    const runtime = this.runtime(serverId)
    const tools: MCPToolDefinition[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await runtime.client.listTools(cursor ? { cursor } : undefined)
      tools.push(...page.tools.map((tool) => ({ ...tool, _serverId: serverId })))
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('MCP tools pagination repeated a cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    if (this.runtimes.get(serverId) !== runtime)
      throw new Error('MCP connection replaced during discovery')
    this.connections.get(serverId)!.tools = tools
    this.emit({ type: 'tools:updated', serverId, data: { tools }, timestamp: Date.now() })
    return tools
  }
  getAllTools() {
    return this.getAllConnectionStatuses()
      .filter((status) => status.state === 'connected')
      .flatMap((status) => status.tools ?? [])
  }
  async startTool(
    serverId: string,
    request: MCPToolCallRequest,
    context?: MCPInvocationContext,
    signal?: AbortSignal
  ) {
    const runtime = this.runtime(serverId)
    const { toJsonValue } = await import('@modelcontextprotocol/ext-tasks/core')
    const args = request.arguments === undefined ? undefined : toJsonValue(request.arguments)
    if (args !== undefined && !isRecord(args)) throw new Error('Invalid MCP tool arguments')
    return this.trackExecution(
      runtime,
      runtime.tasks.callTool<MCPToolCallResult>(request.name, args, {
        applicationContext: context,
        signal,
        requestTimeoutMs: this.servers.get(serverId)?.timeout ?? 30000,
        task: { preference: hasMCPNetworkV2() ? 'prefer' : 'forbid' },
      })
    )
  }
  private trackExecution(
    runtime: MCPConnectionRuntime,
    promise: Promise<MCPExecution>
  ): Promise<MCPExecution> {
    const tracked = promise.then((execution) => {
      runtime.executions.add(execution)
      return execution
    })
    runtime.pendingExecutions.add(tracked)
    void tracked.finally(() => runtime.pendingExecutions.delete(tracked)).catch(() => {})
    return tracked
  }
  private borrowRuntime(runtime: MCPConnectionRuntime) {
    return {
      session: runtime.tasks,
      resume: (
        reference: SerializedTaskReference,
        options: TaskRecoveryOptions<MCPToolCallResult, MCPInvocationContext | undefined>
      ) =>
        this.trackExecution(
          runtime,
          runtime.tasks.resumeTask<MCPToolCallResult>(reference, options)
        ),
      untrack: (execution: MCPExecution) => {
        runtime.executions.delete(execution)
      },
      release: async () => {},
    }
  }

  async executeTool(
    serverId: string,
    request: MCPToolCallRequest,
    onProgress?: (status: string, message?: string) => void,
    signal?: AbortSignal,
    context?: MCPInvocationContext
  ): Promise<MCPToolCallResult> {
    const runtime = this.runtime(serverId)
    const execution = await this.startTool(serverId, request, context, signal)
    try {
      const { outcome } = await execution.settle({
        signal,
        onEvent: (event) => {
          if (event.type === 'task') onProgress?.(event.task.status, event.task.statusMessage)
        },
      })
      const { resultFromTaskOutcome } = await import('@modelcontextprotocol/ext-tasks/client')
      return resultFromTaskOutcome(outcome)
    } finally {
      if (signal?.aborted && execution.kind === 'task') await execution.cancel().catch(() => {})
      runtime.executions.delete(execution)
      await execution.detach()
    }
  }
  async executeToolByFullName(fullName: string, args: Record<string, unknown> = {}) {
    const [serverId, ...parts] = fullName.split(':')
    if (!serverId || !parts.length) throw new Error('Expected serverId:toolName')
    return this.executeTool(serverId, { name: parts.join(':'), arguments: args })
  }
  async listResources(serverId: string): Promise<MCPResourceDefinition[]> {
    const resources: MCPResourceDefinition[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const page = await this.runtime(serverId).client.listResources(
        cursor ? { cursor } : undefined
      )
      resources.push(...page.resources)
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('MCP resource pagination repeated a cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return resources
  }
  async readResource(serverId: string, uri: string) {
    return this.runtime(serverId).client.readResource({ uri })
  }

  async recoverySession(task: ManagedMCPTask) {
    const server = this.servers.get(task.serverId)
    if (!server?.enabled) throw new Error('MCP service is disabled or missing')
    if ((await this.endpointId(server.id)) !== task.endpointId)
      throw new Error('MCP endpoint or authentication changed')
    if (!hasMCPNetworkV2()) throw new Error('Upgrade the browser extension to restore MCP Tasks')
    if (task.reference?.generation !== 'v1') {
      await this.connect(server.id)
      return this.borrowRuntime(this.runtime(server.id))
    }
    const current = this.runtimes.get(server.id)
    if (current && current.connectionId === task.legacySession?.connectionId)
      return this.borrowRuntime(current)
    if (
      current &&
      'sessionId' in current.transport &&
      task.legacySession?.sessionId === current.transport.sessionId
    ) {
      return this.borrowRuntime(current)
    }
    if (!task.legacySession || server.transport !== 'streamable_http')
      throw new Error('Legacy MCP task has no resumable HTTP session')
    const [{ StreamableHTTPClientTransport }, { withTasks }, { restoreLegacyTaskPort }, input] =
      await Promise.all([
        import('@modelcontextprotocol/client'),
        import('@modelcontextprotocol/ext-tasks/client'),
        import('@/mcp/legacy-task-port'),
        import('@/mcp/input-manager'),
      ])
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      fetch: createExtensionFetch(server.timeout),
      requestInit: { headers: this.headers(server) },
      sessionId: task.legacySession.sessionId,
      protocolVersion: task.legacySession.protocolVersion,
    })
    const port = await restoreLegacyTaskPort(transport, task.endpointId, {
      generation: 'v1',
      capabilities: task.legacySession.capabilities.tasks ?? {},
    })
    const session = withTasks<MCPInvocationContext | undefined>(port, {
      tools: { currentTool: () => undefined },
      onInputRequest: input.getMCPInputManager().handler(server.id),
    })
    try {
      await transport.resumeStream('')
    } catch (error) {
      await session.close()
      await transport.close()
      throw error
    }
    return {
      session,
      resume: (
        reference: SerializedTaskReference,
        options: TaskRecoveryOptions<MCPToolCallResult, MCPInvocationContext | undefined>
      ) => session.resumeTask<MCPToolCallResult>(reference, options),
      untrack: () => {},
      release: async () => {
        await session.close()
        await transport.close()
      },
    }
  }
  on(type: MCPClientEventType, listener: MCPEventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  off(type: MCPClientEventType, listener: MCPEventListener) {
    this.listeners.get(type)?.delete(listener)
  }
  private emit(event: MCPClientEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      try {
        listener(event)
      } catch (error) {
        console.error(error)
      }
    }
  }
  private updateConnectionState(serverId: string, state: MCPConnectionState, error?: string) {
    const status: MCPConnectionStatus = {
      ...this.connections.get(serverId),
      serverId,
      state,
      error,
      ...(state === 'connected' ? { lastConnected: Date.now() } : {}),
    }
    this.connections.set(serverId, status)
    this.emit({ type: 'connection:stateChange', serverId, data: status, timestamp: Date.now() })
  }
  async connectAll() {
    const results = new Map<string, MCPInitializeResult>()
    for (const server of this.getEnabledServers()) {
      try {
        results.set(server.id, await this.connect(server.id))
      } catch (error) {
        console.error(error)
      }
    }
    return results
  }
  disconnectAll() {
    for (const id of this.servers.keys()) this.disconnect(id)
  }
  clear() {
    this.disconnectAll()
    this.servers.clear()
    this.connections.clear()
  }
}
let instance: MCPClientService | null = null
export function getMCPClient() {
  return (instance ??= new MCPClientService())
}
export function resetMCPClient() {
  instance?.clear()
  instance = null
}
