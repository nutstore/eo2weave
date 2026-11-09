import { createApplicationInputHandler } from '@modelcontextprotocol/ext-tasks/client'
import type {
  ApplicationInputHandler,
  ApplicationInputRequest,
  ApplicationElicitResult,
  ApplicationCreateMessageResult,
  ApplicationSamplingContentBlock,
  ResolvedInputExchangeContext,
} from '@modelcontextprotocol/ext-tasks/client'
import { MCPTaskRepository } from '@/sqlite/repositories/mcp-task.repository'
import type { MCPInvocationContext } from './task-types'
import { createSchemaValidator, assertSchemaValue } from '@creatorweave/shared/webmcp-schema'
import type { ChatMessage, ChatCompletionRequest } from '@/agent/llm/llm-provider'
import type { PiAIProvider } from '@/agent/llm/pi-ai-provider'
import type { ToolDefinition } from '@/agent/tools/tool-types'
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core'

type Context = ResolvedInputExchangeContext<MCPInvocationContext | undefined>
type Response = ApplicationElicitResult | ApplicationCreateMessageResult
export interface PendingMCPInput {
  id: string
  serverId: string
  context: MCPInvocationContext
  request: ApplicationInputRequest
  sampling?: { model: string; maxTokens: number }
  sensitive: boolean
  error?: string
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
async function fingerprint(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJSON(value)))
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function isSensitiveMCPForm(request: ApplicationInputRequest): boolean {
  if (request.kind !== 'elicitation') return false
  return /password|secret|credential|writeOnly|authorization|api.?key|token/i.test(
    JSON.stringify(request.params.requestedSchema ?? {})
  )
}
function sanitizeSensitiveRequest(request: ApplicationInputRequest): ApplicationInputRequest {
  const clean = JSON.parse(JSON.stringify(request)) as ApplicationInputRequest
  if (
    clean.kind === 'elicitation' &&
    object(clean.params.requestedSchema) &&
    object(clean.params.requestedSchema.properties)
  ) {
    const properties: Record<string, unknown> = clean.params.requestedSchema.properties
    for (const [key, value] of Object.entries(properties)) {
      if (
        object(value) &&
        (/password|secret|credential|api.?key|token/i.test(`${key} ${JSON.stringify(value)}`) ||
          value.writeOnly === true ||
          value.format === 'password')
      ) {
        delete value.default
        delete value.examples
      }
    }
  }
  return clean
}
/** Validate the original schema, including enums and bounds, before accepting. */
export function validateElicitation(
  request: ApplicationInputRequest,
  response: ApplicationElicitResult
) {
  if (request.kind !== 'elicitation' || response.action !== 'accept') return
  if (request.params.mode === 'url') return
  const schema = request.params.requestedSchema
  if (!object(schema)) throw new Error('MCP form has no valid schema')
  const validator = createSchemaValidator(schema, 'MCP elicitation schema')
  assertSchemaValue(validator, response.content ?? {}, 'Invalid MCP form response')
}

/** Only server-supplied messages enter the model request. No conversation context. */
export function mapSamplingMessages(
  params: Readonly<Record<string, JsonValue>>,
  supportsImages: boolean
): ChatCompletionRequest {
  if (!Array.isArray(params.messages) || !params.messages.length)
    throw new Error('Sampling requires explicit messages')
  if (Array.isArray(params.stopSequences) && params.stopSequences.length)
    throw new Error('Selected provider cannot enforce sampling stop sequences')
  const toolNames = new Map<string, string>()
  const messages: ChatMessage[] = []
  if (params.systemPrompt !== undefined) {
    if (typeof params.systemPrompt !== 'string') throw new Error('Invalid sampling system prompt')
    messages.push({ role: 'system', content: params.systemPrompt })
  }
  for (const raw of params.messages) {
    if (!object(raw) || (raw.role !== 'user' && raw.role !== 'assistant'))
      throw new Error('Unsupported sampling role')
    const blocks = Array.isArray(raw.content) ? raw.content : [raw.content]
    const content: Exclude<ChatMessage['content'], string | null> = []
    const calls: NonNullable<ChatMessage['tool_calls']> = []
    for (const block of blocks) {
      if (!object(block)) throw new Error('Invalid sampling content')
      if (block.type === 'text' && typeof block.text === 'string')
        content.push({ type: 'text', text: block.text })
      else if (
        block.type === 'image' &&
        typeof block.data === 'string' &&
        typeof block.mimeType === 'string' &&
        raw.role === 'user' &&
        supportsImages
      ) {
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      } else if (
        block.type === 'tool_use' &&
        raw.role === 'assistant' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        object(block.input)
      ) {
        toolNames.set(block.id, block.name)
        calls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        })
      } else if (
        block.type === 'tool_result' &&
        raw.role === 'user' &&
        typeof block.toolUseId === 'string' &&
        Array.isArray(block.content)
      ) {
        const parts = block.content.map((part) => {
          if (object(part) && part.type === 'text' && typeof part.text === 'string')
            return { type: 'text' as const, text: part.text }
          if (
            object(part) &&
            part.type === 'image' &&
            typeof part.data === 'string' &&
            typeof part.mimeType === 'string' &&
            supportsImages
          )
            return { type: 'image' as const, data: part.data, mimeType: part.mimeType }
          throw new Error('Sampling tool result contains unsupported content')
        })
        if (!toolNames.has(block.toolUseId))
          throw new Error('Sampling tool result has no matching tool use')
        if (block.structuredContent !== undefined)
          parts.push({ type: 'text', text: JSON.stringify(block.structuredContent) })
        if (block.isError === true) parts.unshift({ type: 'text', text: 'Error: ' })
        messages.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          name: toolNames.get(block.toolUseId),
          content: parts,
        })
      } else
        throw new Error(
          `Sampling content cannot be represented by the selected provider: ${String(block.type)}`
        )
    }
    if (content.length || calls.length)
      messages.push({ role: raw.role, content, ...(calls.length ? { tool_calls: calls } : {}) })
  }
  let tools: ToolDefinition[] | undefined
  if (params.tools !== undefined) {
    if (!Array.isArray(params.tools)) throw new Error('Invalid sampling tools')
    tools = params.tools.map((tool) => {
      if (
        !object(tool) ||
        typeof tool.name !== 'string' ||
        !object(tool.inputSchema) ||
        tool.inputSchema.type !== 'object'
      )
        throw new Error('Invalid sampling tool schema')
      createSchemaValidator(tool.inputSchema, 'Sampling tool')
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.inputSchema as unknown as ToolDefinition['function']['parameters'],
        },
      }
    })
  }
  const choice = params.toolChoice
  if (
    object(choice) &&
    choice.mode !== undefined &&
    choice.mode !== 'auto' &&
    choice.mode !== 'none'
  )
    throw new Error('Selected provider cannot enforce this sampling tool choice')
  if (object(choice) && choice.mode === 'none') tools = undefined
  return {
    messages,
    tools,
    temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
  }
}
async function prepareSampling(params: Readonly<Record<string, JsonValue>>) {
  const [{ useSettingsStore }, { loadApiKey }, { createLLMProvider }, { supportsImageInput }] =
    await Promise.all([
      import('@/store/settings.store'),
      import('@/security/api-key-store'),
      import('@/agent/llm/provider-factory'),
      import('@/agent/llm/pi-ai-model-resolver'),
    ])
  const settings = useSettingsStore.getState()
  const config = settings.getEffectiveProviderConfig()
  if (!config || !settings.providerType || !config.modelName)
    throw new Error('Sampling requires a configured model')
  const apiKey = await loadApiKey(config.apiKeyProviderKey)
  if (!apiKey) throw new Error('Sampling model credentials are missing')
  const provider = createLLMProvider({
    apiKey,
    providerType: settings.providerType,
    baseUrl: config.baseUrl,
    model: config.modelName,
    apiMode: settings.customProviders.find((item) => item.id === settings.providerType)?.apiMode,
  })
  if (provider.getModel().provider === 'codex-oauth')
    throw new Error('This provider cannot enforce the requested sampling output limit')
  if (!Number.isSafeInteger(params.maxTokens) || Number(params.maxTokens) <= 0)
    throw new Error('Sampling requires a positive maxTokens')
  const request = mapSamplingMessages(
    params,
    supportsImageInput(config.modelName, settings.providerType)
  )
  const maxTokens = Math.min(Number(params.maxTokens), provider.getModel().maxTokens || 4096, 16384)
  if (provider.estimateTokens(request.messages) + maxTokens > provider.maxContextTokens)
    throw new Error('Sampling request exceeds model context capacity')
  return { provider, request: { ...request, maxTokens }, model: config.modelName, maxTokens }
}

/** One shared interaction queue for both ordinary SDK requests and Tasks inputs. */
export class MCPInputManager {
  private pending = new Map<string, PendingMCPInput>()
  private snapshots: readonly PendingMCPInput[] = []
  private listeners = new Set<() => void>()
  private resolvers = new Map<
    string,
    { resolve(value: Response): void; reject(error: unknown): void }
  >()
  private inflight = new Map<string, Promise<Response>>()
  private responses = new Map<string, Response>()
  private fingerprints = new Map<string, string>()
  private channel?: BroadcastChannel
  private ownerId = crypto.randomUUID()
  private foreign = new Map<string, PendingMCPInput>()
  private confirming = new Set<string>()
  private failureCleanups = new Map<string, () => void>()
  private inputSignals = new Map<string, AbortSignal | undefined>()
  private sampling = new Map<string, { provider: PiAIProvider; request: ChatCompletionRequest }>()
  constructor(private repository = new MCPTaskRepository()) {
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('creatorweave:mcp-inputs:v1')
      this.channel.onmessage = (event) => {
        const message = event.data
        if (!message || message.owner === this.ownerId) return
        if (message.type === 'request' && message.input)
          this.foreign.set(message.input.id, message.input)
        if (message.type === 'remove') this.foreign.delete(message.id)
        if (message.type === 'discover')
          for (const input of this.pending.values())
            this.channel?.postMessage({ type: 'request', owner: this.ownerId, input })
        if (message.type === 'respond' && this.pending.has(message.id))
          void this.respond(message.id, message.response).catch(() => {})
        if (message.type === 'sampling' && this.pending.has(message.id))
          void this.confirmSampling(message.id, message.accepted).catch(() => {})
        this.changed()
      }
      this.channel.postMessage({ type: 'discover', owner: this.ownerId })
      window.addEventListener('pagehide', () => {
        for (const id of this.pending.keys())
          this.channel?.postMessage({ type: 'remove', owner: this.ownerId, id })
      })
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshots
  private changed() {
    this.snapshots = [...this.pending.values(), ...this.foreign.values()]
    for (const listener of this.listeners) listener()
  }
  handler(serverId: string): ApplicationInputHandler<MCPInvocationContext | undefined>['handle'] {
    const requireSource = (context: Context) => {
      if (!context.applicationContext?.projectId || !context.applicationContext.conversationId)
        throw new Error('MCP input has no unambiguous project and conversation')
    }
    return createApplicationInputHandler<MCPInvocationContext | undefined>({
      roots: () => ({ roots: [] }),
      elicitation: (request, context) => {
        requireSource(context)
        return this.handle(serverId, request, context) as Promise<ApplicationElicitResult>
      },
      sampling: (request, context) => {
        requireSource(context)
        return this.handle(serverId, request, context) as Promise<ApplicationCreateMessageResult>
      },
    })
  }

  private async handle(
    serverId: string,
    request: Exclude<ApplicationInputRequest, { kind: 'roots' }>,
    context: Context
  ): Promise<Response> {
    const source = context.applicationContext!
    const hash = await fingerprint(request)
    const inputId = context.inputId ?? hash
    const id = `${source.localTaskId ?? source.toolCallId ?? source.conversationId}:${inputId}`
    const known = this.fingerprints.get(id)
    if (known && known !== hash) throw new Error('MCP input ID reused with different content')
    this.fingerprints.set(id, hash)
    const cached = this.responses.get(id)
    if (cached) return cached
    const running = this.inflight.get(id)
    if (running) return running
    const promise = this.ask(id, inputId, hash, serverId, request, context)
    this.inflight.set(id, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(id)
    }
  }
  private async ask(
    id: string,
    inputId: string,
    hash: string,
    serverId: string,
    request: Exclude<ApplicationInputRequest, { kind: 'roots' }>,
    context: Context
  ): Promise<Response> {
    const source = context.applicationContext!
    this.failureCleanups.get(id)?.()
    context.signal?.throwIfAborted()
    const sensitive = isSensitiveMCPForm(request)
    let saved = source.localTaskId
      ? await this.repository.input(source.localTaskId, inputId)
      : undefined
    if (saved && saved.fingerprint !== hash)
      throw new Error('MCP input ID reused with different content')
    if (saved?.response !== undefined && !sensitive) return saved.response as Response
    // Sensitive form responses stay in memory. Persist only the request schema.
    if (source.localTaskId && !saved) {
      saved = {
        taskId: source.localTaskId,
        inputId,
        fingerprint: hash,
        kind: request.kind,
        request: sensitive ? sanitizeSensitiveRequest(request) : request,
        submission: 'pending',
      }
      await this.repository.saveInput(saved)
    }
    let sampling: Awaited<ReturnType<typeof prepareSampling>> | undefined
    try {
      sampling = request.kind === 'sampling' ? await prepareSampling(request.params) : undefined
    } catch (error) {
      const failed: PendingMCPInput = {
        id,
        serverId,
        context: source,
        request,
        sensitive,
        error: error instanceof Error ? error.message : String(error),
      }
      this.pending.set(id, failed)
      const cleanup = () => {
        context.signal?.removeEventListener('abort', cleanup)
        this.failureCleanups.delete(id)
        this.pending.delete(id)
        this.channel?.postMessage({ type: 'remove', owner: this.ownerId, id })
        this.changed()
      }
      this.failureCleanups.set(id, cleanup)
      context.signal?.addEventListener('abort', cleanup, { once: true })
      this.channel?.postMessage({ type: 'request', owner: this.ownerId, input: failed })
      this.changed()
      if (context.signal?.aborted) cleanup()
      throw error
    }
    if (sampling) this.sampling.set(id, sampling)
    const pending: PendingMCPInput = {
      id,
      serverId,
      context: source,
      request,
      sensitive,
      sampling: sampling ? { model: sampling.model, maxTokens: sampling.maxTokens } : undefined,
    }
    this.inputSignals.set(id, context.signal)
    const abort = () => this.resolvers.get(id)?.reject(context.signal?.reason)
    try {
      const response = await new Promise<Response>((resolve, reject) => {
        this.resolvers.set(id, { resolve, reject })
        this.pending.set(id, pending)
        this.channel?.postMessage({ type: 'request', owner: this.ownerId, input: pending })
        this.changed()
        context.signal?.addEventListener('abort', abort, { once: true })
        if (context.signal?.aborted) abort()
      })
      if (saved)
        await this.repository.saveInput({
          ...saved,
          response: sensitive ? undefined : response,
          submission: sensitive ? 'pending' : 'answered',
        })
      this.responses.set(id, response)
      return response
    } finally {
      context.signal?.removeEventListener('abort', abort)
      this.resolvers.delete(id)
      this.pending.delete(id)
      this.channel?.postMessage({ type: 'remove', owner: this.ownerId, id })
      this.inputSignals.delete(id)
      this.sampling.delete(id)
      this.changed()
    }
  }
  async respond(id: string, response: ApplicationElicitResult) {
    const remote = this.foreign.get(id)
    if (remote) {
      validateElicitation(remote.request, response)
      this.channel?.postMessage({ type: 'respond', owner: this.ownerId, id, response })
      return
    }
    const input = this.pending.get(id)
    if (!input || input.request.kind !== 'elicitation')
      throw new Error('MCP input is no longer active')
    validateElicitation(input.request, response)
    this.resolvers.get(id)?.resolve(response)
  }
  async confirmSampling(id: string, accepted: boolean) {
    if (this.foreign.has(id)) {
      this.channel?.postMessage({ type: 'sampling', owner: this.ownerId, id, accepted })
      return
    }
    if (this.confirming.has(id)) return
    const sampling = this.sampling.get(id)
    const resolver = this.resolvers.get(id)
    if (!sampling || !resolver) throw new Error('Sampling request is no longer active')
    if (!accepted) {
      resolver.reject(new Error('User declined sampling'))
      return
    }
    this.confirming.add(id)
    try {
      const result = await sampling.provider.chat(sampling.request, this.inputSignals.get(id))
      const choice = result.choices[0]
      if (!choice) throw new Error('Sampling returned no message')
      const content: ApplicationSamplingContentBlock[] = [
        ...(choice.message.content
          ? [{ type: 'text' as const, text: choice.message.content }]
          : []),
        ...(choice.message.tool_calls ?? []).map((call) => ({
          type: 'tool_use' as const,
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        })),
      ]
      resolver.resolve({
        role: 'assistant',
        model: sampling.provider.getModel().id,
        content:
          content.length === 1 &&
          content[0].type !== 'tool_use' &&
          content[0].type !== 'tool_result'
            ? content[0]
            : content,
        stopReason:
          choice.finish_reason === 'length'
            ? 'maxTokens'
            : choice.finish_reason === 'tool_calls'
              ? 'toolUse'
              : 'endTurn',
      })
    } catch (error) {
      resolver.reject(error)
    } finally {
      this.confirming.delete(id)
    }
  }
}
let instance: MCPInputManager | undefined
export function getMCPInputManager() {
  return (instance ??= new MCPInputManager())
}
