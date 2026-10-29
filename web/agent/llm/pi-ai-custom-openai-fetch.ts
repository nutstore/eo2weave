import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamOptions,
  type ThinkingLevel,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai'
import '@earendil-works/pi-ai/openai-responses'
import { normalizeBaseUrl } from './pi-ai-url-utils'
import { assertHeaderAscii } from './http-headers'
import { isPotentiallyDynamicProviderType } from '@/agent/providers/types'

export const CW_OPENAI_FETCH_API = 'cw-openai-fetch' as const

/**
 * Thinking level extended with `max` (OpenAI/OpenRouter's highest tier).
 * pi-ai 0.78.0's `ThinkingLevel` stops at `xhigh` and its clamp function
 * silently downgrades unknown levels to `off` — this union lets the app
 * carry `max` end-to-end and inject it via `applyMaxThinkingOverride`.
 */
export type ExtendedThinkingLevel = ThinkingLevel | 'max'

const CUSTOM_PROVIDER_SOURCE_ID = 'creatorweave/cw-openai-fetch'

let customProviderRegistered = false

// ── Chat Completions stream chunk ──

interface OpenAIStreamChunk {
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      reasoning_text?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

type MutableToolCall = ToolCall & {
  partialArgs?: string
  toolCallIndex?: number
}

type MutableContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string }
  | MutableToolCall

export function ensurePiAICustomProvidersRegistered(): void {
  if (customProviderRegistered) return

  // Register Chat Completions API handler
  registerApiProvider(
    {
      api: CW_OPENAI_FETCH_API,
      stream: streamCwOpenAIChatCompletions,
      streamSimple: streamCwOpenAIChatCompletions,
    },
    CUSTOM_PROVIDER_SOURCE_ID
  )

  // Note: OpenAI Responses API is handled by the official pi-ai provider
  // (imported above via '@earendil-works/pi-ai/openai-responses').
  // When apiMode === 'responses', models use api = 'openai-responses' directly.

  customProviderRegistered = true
}

// =============================================================================
// Chat Completions API Implementation
// =============================================================================

function streamCwOpenAIChatCompletions(
  model: Model<typeof CW_OPENAI_FETCH_API>,
  context: Context,
  options?: StreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createEmptyAssistantOutput(model)

    try {
      // API key is optional for custom providers (see buildHeaders below).
      // Non-custom providers still go through their own handlers — but if a
      // custom provider is configured with a key, it's passed through here.
      const apiKey = options?.apiKey?.trim() || null

      const payload = buildChatCompletionsPayload(model, context, options)
      options?.onPayload?.(payload, model)

      const requestUrl = `${normalizeBaseUrl(model.baseUrl)}/chat/completions`
      // API key is optional for custom providers: local runtimes (Ollama,
      // LM Studio, llama.cpp server) reject or choke on arbitrary Bearer
      // tokens, so omit the Authorization header entirely when no key is set.
      const buildHeaders = (token: string | null) => ({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...(model.headers || {}),
        ...(options?.headers || {}),
      })
      const doFetch = (token: string | null) => {
        const headers = buildHeaders(token)
        assertHeaderAscii(headers, 'LLM request headers')
        return fetch(requestUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: options?.signal,
        })
      }

      let response = await doFetch(apiKey)

      // Set only when a 401 triggered a force-refresh attempt that ended in
      // status === 'expired' — i.e. the gateway session is unrecoverable and
      // the user must re-login (drives the GATEWAY_CREDENTIALS_EXPIRED error
      // card below). A transient refresh failure (network / 5xx) keeps the
      // original gateway error and the generic retry UI.
      let gatewayCredentialsExpired = false

      // 401 + LLM Gateway provider → force-refresh token then retry once.
      // Gateway access tokens are short-lived; this transparently refreshes
      // on-demand so the user never sees a hard "token expired" failure.
      // We use refreshAccessTokenWithStatus (not getValidAccessToken) because
      // the server has already rejected the token — we must NOT trust the
      // local expiry timestamp and must unconditionally hit /v1/auth/refresh.
      if (
        response.status === 401 &&
        String(model.provider) === 'llm-gateway'
      ) {
        console.warn('[llm-gateway] 401 received, attempting force-refresh')
        try {
          const { refreshAccessTokenWithStatus } =
            await import('@/agent/providers/llm-gateway-auth')
          const { getLLMGatewayBaseURL, getLLMGatewayClientId } =
            await import('@/agent/providers/llm-gateway-provider')
          const refreshResult = await refreshAccessTokenWithStatus(
            getLLMGatewayBaseURL(),
            getLLMGatewayClientId()
          )
          if (refreshResult.status === 'success') {
            console.info('[llm-gateway] force-refresh succeeded, retrying request')
            response = await doFetch(refreshResult.accessToken)
          } else if (refreshResult.status === 'expired') {
            gatewayCredentialsExpired = true
            console.warn('[llm-gateway] refresh reported dead credentials')
          } else {
            // 'missing' (never logged in) and 'temporary_error' (network/5xx)
            // keep the original gateway error — only a definitively expired
            // credential gets the re-login card.
            console.warn('[llm-gateway] refresh failed temporarily or missing; preserving original gateway error')
          }
        } catch (e) {
          console.warn('[llm-gateway] force-refresh threw temporarily:', e)
          // Refresh failed — fall through to the normal error path below
        }
      }

      if (!response.ok) {
        const errorBody = await safeReadText(response)
        // LLM Gateway with an unrecoverable dead credential (401 + refresh
        // ended in 'expired') → throw with a structured [CODE] prefix so the
        // error card can offer a "Re-login" action instead of a generic
        // retry (mirrors the codex bridge's parseErrorCode pattern). The
        // localized message stays as the payload.
        if (
          response.status === 401 &&
          String(model.provider) === 'llm-gateway' &&
          gatewayCredentialsExpired
        ) {
          const { t: translateStatic } = await import('@creatorweave/i18n')
          const { useI18nStore } = await import('@/i18n/store')
          const locale = useI18nStore.getState().locale
          const msg = translateStatic(locale, 'settings.gateway.tokenInvalidLoginExpired')
          throw new Error(
            `[GATEWAY_CREDENTIALS_EXPIRED] ${
              msg !== 'settings.gateway.tokenInvalidLoginExpired'
                ? msg
                : 'Nutstore AI login has expired. Please log in again.'
            }`
          )
        }
        // LLM Gateway credit exhaustion (429 + code "insufficient_credit",
        // retriable: false — retrying cannot succeed until the user tops
        // up): stamp a structured [CODE] prefix so the error card offers a
        // "Recharge" action instead of a useless retry. Body shape:
        // {"code":"insufficient_credit","message":"credit balance is
        // exhausted","retriable":false}. Distinguished from the SAME
        // 429 status carrying code "rate_limited" ( unsettled-request
        // window) — that one keeps the generic presentation.
        if (
          response.status === 429 &&
          String(model.provider) === 'llm-gateway' &&
          /"code"\s*:\s*"insufficient_credit"/.test(errorBody)
        ) {
          const { t: translateStatic } = await import('@creatorweave/i18n')
          const { useI18nStore } = await import('@/i18n/store')
          const locale = useI18nStore.getState().locale
          const msg = translateStatic(locale, 'conversation.error.gatewayInsufficientCredit')
          throw new Error(
            `[GATEWAY_INSUFFICIENT_CREDIT] ${
              msg !== 'conversation.error.gatewayInsufficientCredit'
                ? msg
                : 'Nutstore AI credit balance is exhausted. Please top up to continue.'
            }`
          )
        }
        throw new Error(`HTTP ${response.status}: ${errorBody}`)
      }

      if (!response.body) {
        throw new Error('Empty response body')
      }

      stream.push({ type: 'start', partial: output })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let currentBlock: any = null
      const blocks = output.content
      const blockIndex = () => blocks.length - 1
      const toolCallIdByIndex = new Map<number, string>()

      const finishCurrentBlock = createBlockFinisher(stream, output)

      await readSSE(response.body, (rawData) => {
        if (rawData === '[DONE]') {
          return
        }

        const chunk = safeParseChunk(rawData)
        if (!chunk) return

        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0
          const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || 0
          // Follow pi-ai convention: input = prompt_tokens minus cache hits
          const input = Math.max(0, (chunk.usage.prompt_tokens || 0) - cachedTokens)
          const outputTokens = (chunk.usage.completion_tokens || 0) + reasoningTokens
          output.usage = {
            input,
            output: outputTokens,
            cacheRead: cachedTokens,
            cacheWrite: 0,
            totalTokens: input + outputTokens + cachedTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }
        }

        const choice = chunk.choices?.[0]
        if (!choice) return

        if (choice.finish_reason) {
          output.stopReason = mapStopReason(choice.finish_reason)
        }

        const delta = choice.delta
        if (!delta) return

        // Skip pure-whitespace content chunks, but ONLY at the start of a new
        // text block. Some models (e.g. MiniMax-M2.7) emit trailing newlines
        // between the reasoning phase and tool_calls, which would otherwise
        // render as empty bubbles in the UI.
        //
        // IMPORTANT: Whitespace-only deltas that arrive IN THE MIDDLE of an
        // existing text block must be preserved — they carry meaningful
        // markdown structure (e.g. `\n\n` separating a `### heading` from a
        // following GFM table). Dropping them caused tables to render as a
        // single mashed-together paragraph.
        const isWhitespaceOnly = !!delta.content && delta.content.length > 0 && delta.content.trim().length === 0
        const startsNewTextBlock = !currentBlock || currentBlock.type !== 'text'
        if (delta.content && !(isWhitespaceOnly && startsNewTextBlock)) {
          if (startsNewTextBlock) {
            finishCurrentBlock(currentBlock)
            currentBlock = { type: 'text', text: '' }
            blocks.push(currentBlock)
            stream.push({ type: 'text_start', contentIndex: blockIndex(), partial: output })
          }

          currentBlock.text += delta.content
          stream.push({
            type: 'text_delta',
            contentIndex: blockIndex(),
            delta: delta.content,
            partial: output,
          })
        }

        const reasoningDelta = delta.reasoning_content || delta.reasoning || delta.reasoning_text
        if (reasoningDelta) {
          if (!currentBlock || currentBlock.type !== 'thinking') {
            finishCurrentBlock(currentBlock)
            currentBlock = { type: 'thinking', thinking: '', thinkingSignature: 'reasoning_content' }
            blocks.push(currentBlock)
            stream.push({ type: 'thinking_start', contentIndex: blockIndex(), partial: output })
          }

          currentBlock.thinking += reasoningDelta
          stream.push({
            type: 'thinking_delta',
            contentIndex: blockIndex(),
            delta: reasoningDelta,
            partial: output,
          })
        }

        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const toolCallDelta of delta.tool_calls) {
            const toolIndex = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : undefined
            if (toolIndex !== undefined && toolCallDelta.id) {
              toolCallIdByIndex.set(toolIndex, toolCallDelta.id)
            }
            const stableToolId =
              toolCallDelta.id ||
              (toolIndex !== undefined
                ? (toolCallIdByIndex.get(toolIndex) || `pending_tool_${toolIndex}`)
                : `pending_tool_${blocks.length}`)

            const isCurrentToolBlock = !!currentBlock && currentBlock.type === 'toolCall'
            const sameIndexedCall =
              isCurrentToolBlock &&
              toolIndex !== undefined &&
              (currentBlock.toolCallIndex === undefined || currentBlock.toolCallIndex === toolIndex)
            const sameIdCall = isCurrentToolBlock && currentBlock.id === stableToolId
            const shouldStartNewToolBlock =
              !isCurrentToolBlock || (!sameIndexedCall && !sameIdCall)

            if (
              shouldStartNewToolBlock
            ) {
              finishCurrentBlock(currentBlock)
              currentBlock = {
                type: 'toolCall',
                id: stableToolId,
                name: toolCallDelta.function?.name || '',
                arguments: {},
                partialArgs: '',
                toolCallIndex: toolIndex,
              }
              blocks.push(currentBlock)
              stream.push({ type: 'toolcall_start', contentIndex: blockIndex(), partial: output })
            }

            if (toolCallDelta.id) currentBlock.id = toolCallDelta.id
            if (toolIndex !== undefined) currentBlock.toolCallIndex = toolIndex
            if (toolCallDelta.function?.name) currentBlock.name = toolCallDelta.function.name

            const argsDelta = toolCallDelta.function?.arguments || ''
            if (argsDelta.length > 0) {
              currentBlock.partialArgs = (currentBlock.partialArgs || '') + argsDelta
              currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs)
            }

            stream.push({
              type: 'toolcall_delta',
              contentIndex: blockIndex(),
              delta: argsDelta,
              partial: output,
            })
          }
        }
      }, options?.signal)

      finishCurrentBlock(currentBlock)

      if (options?.signal?.aborted) {
        throw new Error('Request was aborted')
      }

      if (output.stopReason === 'aborted' || output.stopReason === 'error') {
        throw new Error('An unknown error occurred')
      }

      stream.push({
        type: 'done',
        reason: output.stopReason,
        message: output,
      })
      stream.end()
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}

// =============================================================================
// Block finisher helper
// =============================================================================

function createBlockFinisher(
  stream: AssistantMessageEventStream,
  output: AssistantMessage
) {
  const blocks = output.content
  const blockIndex = () => blocks.length - 1

  return (block: MutableContentBlock | null) => {
    if (!block) return

    if (block.type === 'text') {
      stream.push({
        type: 'text_end',
        contentIndex: blockIndex(),
        content: block.text,
        partial: output,
      })
      return
    }

    if (block.type === 'thinking') {
      stream.push({
        type: 'thinking_end',
        contentIndex: blockIndex(),
        content: block.thinking,
        partial: output,
      })
      return
    }

    if (block.type === 'toolCall') {
      block.arguments = parseStreamingJson(block.partialArgs || '')
      delete block.partialArgs
      stream.push({
        type: 'toolcall_end',
        contentIndex: blockIndex(),
        toolCall: block,
        partial: output,
      })
    }
  }
}

// =============================================================================
// Payload Builders
// =============================================================================

export function buildChatCompletionsPayload(
  model: Model<typeof CW_OPENAI_FETCH_API>,
  context: Context,
  options?: StreamOptions
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: convertContextMessages(context, model),
    stream: true,
    stream_options: { include_usage: true },
  }

  const normalizedTemperature = normalizeTemperatureForProvider(model.provider, options?.temperature)
  if (normalizedTemperature !== undefined) {
    payload.temperature = normalizedTemperature
  }

  if (options?.maxTokens !== undefined) {
    payload.max_tokens = options.maxTokens
  }

  if (context.tools && context.tools.length > 0) {
    payload.tools = context.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters,
      },
    }))
  }

  // ── Thinking / reasoning controls ──
  // The agent loop passes `reasoning` (ThinkingLevel | undefined) via spread options.
  // When undefined (user disabled thinking), we must still send an explicit "off" signal
  // because providers like OpenRouter enable thinking by default for capable models.
  if (model.reasoning) {
    // options can be undefined when caller doesn't pass it (e.g. test fixtures
    // or non-streaming paths) — guard with optional chaining instead of casting
    // through undefined.
    const reasoning = (options as
      | (Record<string, unknown> & { reasoning?: ExtendedThinkingLevel })
      | undefined)?.reasoning
    applyThinkingParams(payload, model.baseUrl, reasoning, model.thinkingLevelMap)
  }

  return payload
}

// =============================================================================
// Thinking / Reasoning Parameter Injection
// =============================================================================

/**
 * Thinking format for a given provider, auto-detected from baseUrl.
 * Mirrors the logic in pi-ai's openai-completions handler.
 */
type ThinkingFormat =
  | 'openai'        // reasoning_effort
  | 'openrouter'    // reasoning: { effort }
  | 'deepseek'      // thinking: { type } + optional reasoning_effort
  | 'together'      // reasoning: { enabled } + optional reasoning_effort
  | 'qwen'          // enable_thinking: boolean
  | 'tencent-tokenhub' // reasoning_effort with "off" to disable, requires reasoning_content
  | 'minimax'       // reasoning_split: boolean (always on; reasoning_details carries the content)
  | 'auto'          // fallback: send reasoning_effort (most widely supported)

/**
 * Known baseUrl patterns → thinking format.
 * Each entry is a substring matched (case-insensitive) against the full baseUrl.
 * Order does not matter — the map is iterated and the first match wins.
 */
const BASE_URL_THINKING_FORMAT_MAP: Array<{ pattern: string; format: ThinkingFormat }> = [
  // OpenRouter-compatible endpoints
  { pattern: 'openrouter.ai', format: 'openrouter' },
  { pattern: 'ai-assistant.jianguoyun.net.cn', format: 'openrouter' },  // 坚果云内部 OpenRouter 代理
  // Tencent TokenHub (坚果云 AI Gateway 等基于 TokenHub 的服务)
  { pattern: 'jianguoyun.com', format: 'tencent-tokenhub' },  // ai.jianguoyun.com 等
  // DeepSeek
  { pattern: 'deepseek.com', format: 'deepseek' },
  // Together AI
  { pattern: 'api.together.ai', format: 'together' },
  { pattern: 'api.together.xyz', format: 'together' },
  // Qwen (Alibaba DashScope)
  { pattern: 'dashscope.aliyuncs.com', format: 'qwen' },
  // MiniMax — both international (api.minimax.io) and domestic (api.minimaxi.com)
  // MiniMax does NOT support disabling thinking; reasoning_split isolates the
  // thinking content into reasoning_details so it can be hidden from the user.
  { pattern: 'api.minimax.io', format: 'minimax' },
  { pattern: 'api.minimaxi.com', format: 'minimax' },
]

/**
 * Auto-detect thinking format from the provider's baseUrl.
 */
export function detectThinkingFormat(baseUrl: string): ThinkingFormat {
  const url = baseUrl.toLowerCase()
  for (const { pattern, format } of BASE_URL_THINKING_FORMAT_MAP) {
    if (url.includes(pattern)) return format
  }
  return 'auto'
}

/**
 * Thinking format for MiniMax.
 * MiniMax does NOT support disabling thinking — the model always generates
 * reasoning content. We can only redirect it to a separate field so the
 * end user doesn't see it.
 */
function applyMinimaxThinkingParams(
  payload: Record<string, unknown>,
  enabled: boolean,
  level?: ExtendedThinkingLevel,
  levelMap?: Partial<Record<string, string | null>>
): void {
  if (enabled) {
    // Enabled: tell MiniMax to include reasoning in reasoning_details (split mode).
    // reasoning_effort is optional and controls how much thinking the model does.
    payload.reasoning_split = true
    if (level) {
      payload.reasoning_effort = toEffortValue(level, levelMap)
    }
  } else {
    // Disabled: still send reasoning_split=true so the thinking goes into
    // reasoning_details instead of contaminating content.
    // The UI will filter out reasoning_details when the user has disabled thinking.
    payload.reasoning_split = true
  }
}

/**
 * ThinkingLevel → OpenRouter effort value.
 * OpenRouter also supports "none" (off), "xhigh", and "max".
 */
function toEffortValue(
  level: ExtendedThinkingLevel,
  levelMap?: Partial<Record<string, string | null>>
): string {
  return levelMap?.[level] ?? level
}

/**
 * Inject thinking/reasoning parameters into the Chat Completions payload
 * based on the detected provider format.
 *
 * @param level - ThinkingLevel when enabled, undefined when user disabled thinking.
 */
function applyThinkingParams(
  payload: Record<string, unknown>,
  baseUrl: string,
  level: ExtendedThinkingLevel | undefined,
  thinkingLevelMap?: Partial<Record<string, string | null>>
): void {
  const format = detectThinkingFormat(baseUrl)
  const enabled = !!level

  switch (format) {
    case 'openrouter': {
      // OpenRouter unified: reasoning: { effort: "none" | "low" | ... }
      // Must send effort:"none" explicitly — OpenRouter enables thinking by default.
      const orPayload = payload as Record<string, unknown>
      orPayload.reasoning = {
        effort: enabled ? toEffortValue(level!, thinkingLevelMap) : 'none',
      }
      break
    }
    case 'deepseek': {
      payload.thinking = { type: enabled ? 'enabled' : 'disabled' }
      if (enabled) {
        payload.reasoning_effort = toEffortValue(level!, thinkingLevelMap)
      }
      break
    }
    case 'together': {
      const togetherPayload = payload as Record<string, unknown>
      togetherPayload.reasoning = { enabled }
      if (enabled) {
        payload.reasoning_effort = toEffortValue(level!, thinkingLevelMap)
      }
      break
    }
    case 'qwen': {
      payload.enable_thinking = enabled
      break
    }
    case 'tencent-tokenhub': {
      // Tencent TokenHub: reasoning_effort with "off" to disable thinking
      payload.reasoning_effort = enabled
        ? toEffortValue(level!, thinkingLevelMap)
        : 'off'
      break
    }
    case 'minimax': {
      // MiniMax does not support disabling thinking. Use reasoning_split so
      // the thinking content lands in reasoning_details and can be hidden from
      // the user without being stripped from the conversation history.
      applyMinimaxThinkingParams(payload, enabled, level, thinkingLevelMap)
      break
    }
    case 'openai':
    case 'auto':
    default: {
      // Most OpenAI-compatible APIs: reasoning_effort controls thinking level.
      // When disabled, omit the field entirely (no standard "off" value).
      if (enabled) {
        payload.reasoning_effort = toEffortValue(level!, thinkingLevelMap)
      }
      break
    }
  }
}

/**
 * Override an already-built payload so that thinking runs at `max`.
 *
 * pi-ai 0.78.0's `clampThinkingLevel` does not know `max` and silently
 * downgrades it to `off` — meaning built-in handlers (openai-completions,
 * openai-responses) would disable thinking entirely when the user picks `max`.
 * This function inspects the payload that the handler already wrote (using its
 * detected format) and rewrites the effort fields to the `max` value, matching
 * the exact shape the built-in handlers produce. Call it from the streamFn
 * onPayload wrapper (pi-core-runner) right before the request goes out.
 */
export function applyMaxThinkingOverride(
  payload: Record<string, unknown>,
  baseUrl: string,
  thinkingLevelMap?: Partial<Record<string, string | null>>
): void {
  const effort = toEffortValue('max', thinkingLevelMap)
  const format = detectThinkingFormat(baseUrl)

  switch (format) {
    case 'openrouter': {
      // openai-completions handler writes reasoning: { effort }
      const reasoning = payload.reasoning as Record<string, unknown> | undefined
      if (reasoning && typeof reasoning === 'object') {
        reasoning.effort = effort
      } else {
        payload.reasoning = { effort }
      }
      break
    }
    case 'openai':
    case 'tencent-tokenhub':
    case 'auto':
    default: {
      // openai-completions handler writes reasoning_effort for these formats
      payload.reasoning_effort = effort
      // Responses API handler writes reasoning: { effort, summary }
      const reasoning = payload.reasoning as Record<string, unknown> | undefined
      if (reasoning && typeof reasoning === 'object' && 'effort' in reasoning) {
        reasoning.effort = effort
      }
      break
    }
    case 'deepseek': {
      payload.thinking = { type: 'enabled' }
      payload.reasoning_effort = effort
      break
    }
    case 'together': {
      payload.reasoning = { enabled: true }
      payload.reasoning_effort = effort
      break
    }
    case 'qwen': {
      // Qwen has no effort tiers — thinking is boolean. Keep enabled.
      payload.enable_thinking = true
      break
    }
    case 'minimax': {
      // MiniMax has no effort tiers — reasoning_split isolates thinking.
      payload.reasoning_split = true
      break
    }
  }
}

// =============================================================================
// Message Converters (Chat Completions format)
// =============================================================================

/**
 * Ensure every assistant tool_call in the API message array has a matching
 * tool result. Inserts synthetic results for orphaned tool_call ids.
 * See sanitizeOrphanedToolCalls in llm-provider.ts for the same logic at
 * the ChatMessage level — this is the API-level safety net.
 */
function sanitizeApiMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (messages.length === 0) return messages

  const resolvedIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      resolvedIds.add(msg.tool_call_id)
    }
  }

  const result: Record<string, unknown>[] = []
  let patched = 0

  for (const msg of messages) {
    result.push(msg)

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const orphans = (msg.tool_calls as Array<{ id: string }>).filter(
        (tc) => !resolvedIds.has(tc.id),
      )
      for (const orphan of orphans) {
        result.push({
          role: 'tool',
          tool_call_id: orphan.id,
          content: JSON.stringify({
            status: 'interrupted',
            message: 'Tool execution was interrupted before completing.',
          }),
        })
        patched++
      }
    }
  }

  if (patched > 0) {
    console.warn(`[convertContextMessages] Patched ${patched} orphaned tool_call(s) with synthetic results.`)
  }

  return result
}

function convertContextMessages(context: Context, model: Model<Api>): unknown[] {
  const messages: Record<string, unknown>[] = []

  if (context.systemPrompt) {
    messages.push({
      role: 'system',
      content: context.systemPrompt,
    })
  }

  for (const message of context.messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string' || message.content == null) {
        messages.push({
          role: 'user',
          content: message.content as string | null,
        })
      } else {
        const content = message.content
          .map((item) => {
            if (item.type === 'text') {
              return {
                type: 'text',
                text: item.text,
              }
            }
            if (!model.input.includes('image')) return null
            return {
              type: 'image_url',
              image_url: {
                url: `data:${item.mimeType};base64,${item.data}`,
              },
            }
          })
          .filter((item) => item !== null)

        if (content.length > 0) {
          messages.push({
            role: 'user',
            content,
          })
        }
      }
      continue
    }

    if (message.role === 'assistant') {
      const textContent = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')

      const thinkingContent = message.content
        .filter((part): part is { type: 'thinking'; thinking: string } => part.type === 'thinking')
        .map((part) => part.thinking)
        .join('')

      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: textContent.length > 0 ? textContent : null,
      }

      const toolCalls = message.content.filter((part): part is ToolCall => part.type === 'toolCall')
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments || {}),
          },
        }))
      }

      // Some upstream gateways (e.g. Tencent TokenHub) require reasoning_content
      // on all assistant messages when thinking is enabled (Interleaved Thinking mode).
      // pi-ai preserves thinking blocks in context.messages, so we can rely on
      // the content blocks directly.
      if (thinkingContent) {
        assistantMessage.reasoning_content = thinkingContent
      }

      if (assistantMessage.content !== null || toolCalls.length > 0) {
        messages.push(assistantMessage)
      }
      continue
    }

    if (message.role === 'toolResult') {
      const textParts = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const imageParts = message.content
        .filter((part): part is { type: 'image'; data: string; mimeType: string } => part.type === 'image')

      const toolMessage: Record<string, unknown> = {
        role: 'tool',
        // If the tool returned images (e.g. page_screenshot), emit a
        // multimodal content array (text + image_url parts) so vision-capable
        // models can see the image. For text-only models, the fetch layer
        // strips out image parts at request-build time (see model.input check
        // in the user-content branch above).
        content:
          imageParts.length > 0
            ? [
                ...imageParts.map((p) => ({
                  type: 'image_url' as const,
                  image_url: { url: `data:${p.mimeType};base64,${p.data}` },
                })),
                ...(textParts ? [{ type: 'text' as const, text: textParts }] : []),
              ]
            : textParts || '(empty tool result)',
        tool_call_id: message.toolCallId,
      }

      if (message.toolName) {
        toolMessage.name = message.toolName
      }

      messages.push(toolMessage)
    }
  }

  // ── Sanitize: ensure every tool_call has a matching tool result ──
  // Strict providers (e.g. MiniMax error 2013) reject if an assistant
  // tool_call lacks a following tool result. This happens when the agent
  // loop is interrupted (user abort, new message) mid-execution.
  return sanitizeApiMessages(messages)
}

// =============================================================================
// Developer-role sanitization for dynamically-registered providers
// =============================================================================

/**
 * Rewrite role:"developer" → role:"system" in an already-built Responses API
 * payload, for dynamically-registered providers (llm-gateway, custom-*, and
 * any future async-registered id).
 *
 * pi-ai's openai-responses handler picks the system role via
 * `model.reasoning ? "developer" : "system"` and does NOT consult
 * `compat.supportsDeveloperRole` — so a custom provider whose apiMode is
 * 'responses' emits developer-role system prompts that some upstream backends
 * reject with 400 ("developer is not one of ['system', 'assistant', ...]").
 * Since the developer role only ever carries the system prompt here, rewriting
 * it to "system" is semantically lossless and matches what every provider in
 * this category expects.
 *
 * NO-OP for everything else: OpenAI / codex-oauth / Azure keep their native
 * developer-role behavior untouched. (codex-oauth is technically in the
 * dynamic-provider set, but the ChatGPT Responses endpoint natively uses and
 * accepts the developer role — it is explicitly exempted below.)
 *
 * Call from the onPayload wrapper (pi-core-runner / pi-ai-provider) right
 * before the request goes out — same insertion point as
 * applyMaxThinkingOverride.
 */
export function stripDeveloperRoleForDynamicProviders(
  payload: Record<string, unknown>,
  provider: string | undefined
): void {
  if (!provider || provider === 'codex-oauth') return
  if (!isPotentiallyDynamicProviderType(provider)) return

  // Chat Completions shape: top-level messages array. The custom handler
  // never emits developer, but sanitize defensively (e.g. if a future handler
  // path lands here).
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (
        msg &&
        typeof msg === 'object' &&
        (msg as { role?: unknown }).role === 'developer'
      ) {
        (msg as { role: string }).role = 'system'
      }
    }
  }

  // Responses API shape: input array of message entries.
  if (Array.isArray(payload.input)) {
    for (const entry of payload.input) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { role?: unknown }).role === 'developer'
      ) {
        (entry as { role: string }).role = 'system'
      }
    }
  }
}

// =============================================================================
// SSE Utilities
// =============================================================================

async function readSSE(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      if (signal?.aborted) break

      // Race reader.read() against signal abort so that a pending read
      // (e.g. slow/keep-alive connection) can be interrupted.
      const { done, value } = signal
        ? await Promise.race([
            reader.read(),
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              if (signal.aborted) {
                resolve({ done: true, value: undefined as any })
                return
              }
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort)
                resolve({ done: true, value: undefined as any })
              }
              signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        : await reader.read()

      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let separator = findSSESeparator(buffer)

      while (separator) {
        const rawEvent = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        const data = extractSSEData(rawEvent)
        if (data !== null) {
          onData(data)
        }
        separator = findSSESeparator(buffer)
      }
    }
  } finally {
    // Release the reader lock so the response body can be garbage-collected
    // when the caller is no longer interested in the stream.
    try { reader.releaseLock() } catch { /* already released */ }
  }

  if (signal?.aborted) return

  buffer += decoder.decode()
  const trailingData = extractSSEData(buffer)
  if (trailingData !== null) {
    onData(trailingData)
  }
}

function findSSESeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  if (lf === -1 && crlf === -1) return null
  if (lf === -1) return { index: crlf, length: 4 }
  if (crlf === -1) return { index: lf, length: 2 }
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
}

function extractSSEData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/)
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0) return null
  return dataLines.join('\n')
}

function safeParseChunk(data: string): OpenAIStreamChunk | null {
  try {
    return JSON.parse(data) as OpenAIStreamChunk
  } catch {
    return null
  }
}

function mapStopReason(
  finishReason: string
): 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' {
  if (finishReason === 'tool_calls') return 'toolUse'
  if (finishReason === 'length') return 'length'
  if (finishReason === 'stop') return 'stop'
  return 'stop'
}

function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  }
}

function createEmptyAssistantOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text || 'No response body'
  } catch {
    return 'Failed to read response body'
  }
}

function normalizeTemperatureForProvider(
  provider: string | undefined,
  temperature: number | undefined
): number | undefined {
  if (temperature === undefined || Number.isNaN(temperature)) return undefined
  if (provider !== 'minimax' && provider !== 'minimax-cn') return temperature

  // MiniMax OpenAI-compatible API requires temperature in (0.0, 1.0].
  return Math.min(1, Math.max(0.01, temperature))
}
