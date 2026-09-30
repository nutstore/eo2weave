import { produce } from 'immer'
import { agentLoopContinue, type StreamFn } from '@earendil-works/pi-agent-core'
import { streamSimple as piAiStreamSimple } from '@earendil-works/pi-ai'
import { useSettingsStore } from '@/store/settings.store'
import type { AgentMode } from '../agent-mode'
import type { ContextManager } from '../context-manager'
import type { PiAIProvider } from '../llm/pi-ai-provider'
import { applyMaxThinkingOverride, stripDeveloperRoleForDynamicProviders, type ExtendedThinkingLevel } from '../llm/pi-ai-custom-openai-fetch'
import { generateId, type Message } from '../message-types'
import type { ToolRegistry } from '../tool-registry'
import type { ToolContext } from '../tools/tool-types'
import type { CompressionBaselineState } from './context-compression'
import { buildAgentTools } from './build-agent-tools'
import { convertAgentMessagesToLlm } from './convert-bridge'
import { extractTextContent, piToInternalMessage, internalToPiMessages } from './message-mappers'
import { applyPiAssistantUpdate } from './pi-events'
import { processPiLoopEvents } from './process-loop-events'
import type { AgentCallbacks, AgentLoopConfig, CompressionSummaryMode } from './types'

function normalizeResponsesInputPayload(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.input)) return

  const normalizeContentItem = (item: unknown): unknown => {
    if (!item || typeof item !== 'object') return item
    const src = item as Record<string, unknown>

    if (src.type === 'input_text') {
      return { type: 'input_text', text: typeof src.text === 'string' ? src.text : '' }
    }
    if (src.type === 'output_text') {
      return { type: 'output_text', text: typeof src.text === 'string' ? src.text : '' }
    }
    if (src.type === 'function_call') {
      return {
        type: 'function_call',
        call_id: src.call_id,
        name: src.name,
        arguments: src.arguments,
      }
    }
    return item
  }

  payload.input = payload.input.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry
    const msg = entry as Record<string, unknown>

    if (msg.type === 'message' && (msg.role === 'user' || msg.role === 'assistant')) {
      const normalizedContent = Array.isArray(msg.content)
        ? msg.content.map(normalizeContentItem)
        : msg.role === 'user'
          ? [{ type: 'input_text', text: '' }]
          : [{ type: 'output_text', text: '' }]
      return {
        role: msg.role,
        content: normalizedContent,
      }
    }

    if (msg.role === 'user' || msg.role === 'assistant') {
      const normalizedContent = Array.isArray(msg.content)
        ? msg.content.map(normalizeContentItem)
        : msg.content
      return {
        ...msg,
        content: normalizedContent,
      }
    }

    return entry
  })
}

export interface ExecutePiCoreLoopInput {
  signal?: AbortSignal
  initialMessages: Message[]
  callbacks?: AgentCallbacks
  baseSystemPrompt: string
  mode: AgentMode
  toolRegistry: ToolRegistry
  beforeToolCall?: AgentLoopConfig['beforeToolCall']
  afterToolCall?: AgentLoopConfig['afterToolCall']
  getToolContext: () => ToolContext
  provider: PiAIProvider
  contextManager: ContextManager
  toolExecutionTimeout: number
  toolTimeoutExemptions: Set<string>
  maxIterations: number
  convertCallCount: number
  lastSummaryConvertCall: number
  compressedMemoryPrefix: string
  generateContextSummaryWithLLM: (
    droppedContent: string,
    maxSummaryTokens: number
  ) => Promise<{ summary: string | null; mode: CompressionSummaryMode }>
  onAbortRequested?: () => void
  /** Restored compression baseline from a previous run's persisted state. */
  initialCompressionBaseline?: CompressionBaselineState | null
  /** When true, force-disable thinking/reasoning regardless of global settings. */
  disableThinking?: boolean
  /**
   * Forwarded to `processPiLoopEvents`. When this returns `true` after a
   * tool execution completes, the loop yields so the caller can consume
   * queued user messages (see `shouldYield` on `ProcessPiLoopEventsInput`).
   */
  shouldYieldForQueue?: () => boolean
  /**
   * Stable conversation identifier (workspaceId), used as prompt_cache_key
   * for providers that support it (e.g. ChatGPT Responses API via Codex).
   */
  sessionId?: string
}

export interface ExecutePiCoreLoopResult {
  allMessages: Message[]
  shouldStopForElicitation: boolean
  reachedMaxIterations: boolean
  convertCallCount: number
  lastSummaryConvertCall: number
}

/**
 * OpenAI reasoning models (o-series, gpt-5 series) reject `temperature` outright
 * (400 "Unsupported parameter"), so the user's temperature setting must never be
 * sent to them. Non-reasoning OpenAI models (gpt-4o, gpt-4.1, …) honor it.
 *
 * Gate by ENDPOINT rather than by pi-ai api handler: custom providers resolve to
 * 'cw-openai-fetch' (or 'openai-responses'), so an api-type guard would miss
 * custom providers pointed at api.openai.com — while an unconditional strip
 * would wrongly drop temperature for proxy endpoints (openrouter.ai,
 * llm-gateway, …) where it is a valid param.
 *
 * Exported for tests: this guard protects a wiring change against a 400
 * regression on a valid pre-change configuration.
 */
export function shouldStripTemperatureForModel(model: {
  id: string
  provider: string
  baseUrl?: string
}): boolean {
  const isOpenAiEndpoint =
    model.provider === 'openai' || /api\.openai\.com/i.test(model.baseUrl || '')
  return isOpenAiEndpoint && /^(o[134](-|$)|gpt-5)/.test(model.id)
}

export async function executePiCoreLoop(
  input: ExecutePiCoreLoopInput
): Promise<ExecutePiCoreLoopResult> {
  if (!input.signal) {
    return {
      allMessages: input.initialMessages,
      shouldStopForElicitation: false,
      reachedMaxIterations: false,
      convertCallCount: input.convertCallCount,
      lastSummaryConvertCall: input.lastSummaryConvertCall,
    }
  }

  let allMessages = input.initialMessages
  const messageState = { allMessages }
  let shouldStopForElicitation = false
  let reachedMaxIterations = false
  let compressionBaseline: CompressionBaselineState | null = input.initialCompressionBaseline ?? null
  let convertCallCount = input.convertCallCount
  let lastSummaryConvertCall = input.lastSummaryConvertCall

  const model = input.provider.getModel()
  const apiKey = input.provider.getApiKey()

  const agentTools = buildAgentTools({
    toolRegistry: input.toolRegistry,
    mode: input.mode,
    callbacks: input.callbacks,
    beforeToolCall: input.beforeToolCall,
    afterToolCall: input.afterToolCall,
    getAllMessages: () => allMessages,
    getAbortSignal: () => input.signal,
    getToolContext: input.getToolContext,
    provider: input.provider,
    contextManager: input.contextManager,
    toolExecutionTimeout: input.toolExecutionTimeout,
    toolTimeoutExemptions: input.toolTimeoutExemptions,
    onElicitationDetected: () => {
      shouldStopForElicitation = true
      input.onAbortRequested?.()
    },
  })

  const context = {
    systemPrompt: input.contextManager.getConfig().systemPrompt || input.baseSystemPrompt,
    messages: internalToPiMessages(input.initialMessages, model, input.compressedMemoryPrefix),
    tools: agentTools,
  }

  const streamFn = ((
    streamModel: unknown,
    streamContext: unknown,
    streamOptions?: Record<string, unknown>
  ) => {
    const prevOnPayload =
      streamOptions && typeof streamOptions.onPayload === 'function'
        ? (streamOptions.onPayload as (payload: Record<string, unknown>) => void)
        : undefined

    // pi-ai 0.78.0 does not know `max` (its ThinkingLevel stops at xhigh) and
    // its clamp silently downgrades unknown levels to `off`, which would turn
    // thinking off entirely when the user picks max. Detect the requested
    // level from the stream options and, for max, rewrite the payload after
    // the built-in handler built it (see applyMaxThinkingOverride).
    const requestedReasoning = (streamOptions as
      | (Record<string, unknown> & { reasoning?: ExtendedThinkingLevel })
      | undefined)?.reasoning

    const mergedOptions: Record<string, unknown> = {
      ...(streamOptions || {}),
      onPayload: (payload: Record<string, unknown>) => {
        normalizeResponsesInputPayload(payload)
        // Responses API may omit tool_choice on some paths; default to "auto" when tools exist.
        if (Array.isArray(payload.tools) && payload.tools.length > 0 && payload.tool_choice == null) {
          payload.tool_choice = 'auto'
        }
        // openai-responses API: 'instructions' is required
        // chat-completions API does NOT support 'instructions' — uses system message instead
        if (model.api === 'openai-responses' && !payload.instructions && context.systemPrompt) {
          payload.instructions = context.systemPrompt
        }
        // Codex API does not support max_output_tokens or temperature
        if (model.provider === 'codex-oauth') {
          delete payload.max_output_tokens
          delete payload.temperature
        }
        // OpenAI reasoning models (o-series, gpt-5 series) reject `temperature`
        // outright (400 "Unsupported parameter"). Before the user temperature
        // setting was wired through, these models simply omitted the field;
        // strip it again here so wiring the setting doesn't break them.
        // Non-reasoning OpenAI models (gpt-4o, gpt-4.1, …) still honor it.
        if (shouldStripTemperatureForModel(model)) {
          delete payload.temperature
        }
        // Codex (ChatGPT Responses API): set prompt_cache_key for server-side
        // prompt caching. The key is the conversation's sessionId (workspaceId),
        // which is stable across all turns in the same conversation. This tells
        // ChatGPT's cache layer to reuse the cached prefix across requests that
        // share the same key, even though store=false (OAuth path doesn't persist
        // responses, so previous_response_id is not usable).
        //
        // See codex-rs/core/src/client.rs: prompt_cache_key = thread_id.to_string()
        if (model.provider === 'codex-oauth' && input.sessionId) {
          payload.prompt_cache_key = input.sessionId
        }
        // Restore the max thinking tier after built-in handlers clamp it away.
        if (requestedReasoning === 'max' && model.reasoning) {
          applyMaxThinkingOverride(payload, model.baseUrl, model.thinkingLevelMap)
        }
        // Dynamically-registered providers (llm-gateway, custom-*) never emit
        // developer role — pi-ai's responses handler hardcodes it for
        // reasoning models and ignores compat.supportsDeveloperRole (see
        // stripDeveloperRoleForDynamicProviders). No-op for built-in providers.
        stripDeveloperRoleForDynamicProviders(payload, model.provider)
        prevOnPayload?.(payload)
      },
    }

    // ── Codex OAuth: fetch is permanently wrapped by installCodexBridgeFetch() ──
    // The openai-responses handler calls fetch() internally. For codex-oauth,
    // fetch() is already intercepted at the global level to route through
    // the extension bridge. No special handling needed here.

    return piAiStreamSimple(
      streamModel as Parameters<typeof piAiStreamSimple>[0],
      streamContext as Parameters<typeof piAiStreamSimple>[1],
      mergedOptions as Parameters<typeof piAiStreamSimple>[2],
    )
  }) as unknown as StreamFn

  const settingsState = useSettingsStore.getState()
  const rawThinkingLevel = input.disableThinking
    ? undefined
    : settingsState.enableThinking
      ? settingsState.thinkingLevel
      : undefined

  // pi-ai 0.78.0's ThinkingLevel stops at xhigh; a raw 'max' would be clamped
  // to 'off' by its handlers (disabling thinking entirely). We pass a supported
  // level ('high') to the loop so thinking stays enabled, and the streamFn
  // onPayload wrapper restores the true max tier via applyMaxThinkingOverride.
  const reasoning = rawThinkingLevel === 'max' ? 'high' : rawThinkingLevel

  const loop = agentLoopContinue(
    context,
    {
      model,
      getApiKey: () => apiKey,
      maxTokens: model.maxTokens,
      // Forward the user's Temperature setting (Settings → Advanced) into the
      // LLM request. pi-ai's handlers only set payload.temperature when this is
      // defined, so leaving it undefined means providers apply their own default.
      temperature: settingsState.temperature,
      reasoning,
      convertToLlm: async (agentMessages) => {
        const contextConfig = input.contextManager.getConfig()
        const converted = await convertAgentMessagesToLlm({
          agentMessages,
          model,
          provider: input.provider,
          callbacks: input.callbacks,
          compressedMemoryPrefix: input.compressedMemoryPrefix,
          convertCallCount,
          lastSummaryConvertCall,
          compressionBaseline,
          maxContextTokens: contextConfig.maxContextTokens,
          reserveTokens: contextConfig.reserveTokens ?? 0,
          generateContextSummaryWithLLM: input.generateContextSummaryWithLLM,
          onSummaryInjected: (summary, cutoffTimestamp) => {
            // Create context_summary as a user-role message so the LLM always
            // receives it as role='user'.  The kind flag lets the UI render it
            // with the amber summary styling and lets internalToPiMessages()
            // prepend the compressed-memory prefix for the LLM.
            const summaryMsg: Message = {
              id: generateId(),
              role: 'user',
              content: summary,
              kind: 'context_summary',
              timestamp: Math.max(0, cutoffTimestamp - 1),
            }
            const nextMessages = produce(messageState.allMessages, (draft) => {
              draft.push(summaryMsg)
            })
            messageState.allMessages = nextMessages
            allMessages = nextMessages
            input.callbacks?.onMessagesUpdated?.(nextMessages)
          },
        })

        convertCallCount = converted.convertCallCount
        lastSummaryConvertCall = converted.lastSummaryConvertCall
        compressionBaseline = converted.compressionBaseline
        return converted.piMessages
      },
    },
    input.signal,
    streamFn
  )

  const processed = await processPiLoopEvents({
    loop,
    initialMessages: messageState.allMessages,
    messageState,
    callbacks: input.callbacks,
    maxIterations: input.maxIterations,
    applyAssistantUpdate: applyPiAssistantUpdate,
    mapPiToInternal: (message) => piToInternalMessage(message),
    extractTextContent,
    shouldYield: input.shouldYieldForQueue,
  })
  allMessages = processed.allMessages
  reachedMaxIterations = processed.reachedMaxIterations

  return {
    allMessages,
    shouldStopForElicitation,
    reachedMaxIterations,
    convertCallCount,
    lastSummaryConvertCall,
  }
}
