/**
 * LLM Provider abstraction.
 * All providers must implement this interface.
 */

import type { ToolDefinition } from '../tools/tool-types'
import type { Message, ToolCall } from '../message-types'

/** Chat completion request */
export interface ChatCompletionRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  temperature?: number
  maxTokens?: number
  stream?: boolean
  /** If true, instruct the provider to disable thinking/reasoning (saves latency and tokens) */
  disableThinking?: boolean
  /**
   * Conversation id forwarded as the provider's session header. OpenCode Go
   * rejects requests without one; providers that need it fall back to a stable
   * per-provider-instance id when this is absent.
   */
  sessionId?: string
}

/** Message format sent to LLM API */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * For text-only messages this is the text payload. For multimodal user
   * messages this is an array of text + image content parts (mirrors
   * pi-ai's UserMessage.content format).  pi-ai's openai-responses-shared
   * handler produces `input_image` content parts from this array.
   */
  content: string | null | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  /** Chain-of-thought reasoning from assistant thinking blocks */
  reasoning?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

/** Non-streaming response */
export interface ChatCompletionResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | 'length'
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/** Token usage stats returned by the API */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** Streaming chunk */
export interface ChatCompletionChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      /** Chain-of-thought reasoning content (GLM-4.7+ specific) */
      reasoning_content?: string | null
      /** Optional generic reasoning field for non-GLM providers */
      reasoning?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | 'length' | null
  }>
  /** Token usage - present in the final chunk when stream_options.include_usage is true */
  usage?: TokenUsage
}

/** LLM Provider interface */
export interface LLMProvider {
  readonly name: string
  readonly maxContextTokens: number

  /** Non-streaming chat completion */
  chat(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse>

  /** Streaming chat completion */
  chatStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatCompletionChunk>

  /** Estimate token count for messages */
  estimateTokens(messages: ChatMessage[]): number
}

/** Convert internal Message[] to ChatMessage[] for API calls */
export function messagesToChatMessages(messages: Message[]): ChatMessage[] {
  const raw = messages.map((msg) => {
    // For multimodal messages (user uploads with images), pass the content
    // array as `content` so pi-ai's openai-responses-shared handler will
    // emit `input_image` parts.  Otherwise fall back to the text content.
    const content = msg.contentParts && msg.contentParts.length > 0
      ? msg.contentParts
      : msg.content

    const chatMsg: ChatMessage = {
      role: msg.role,
      content,
    }

    if (msg.reasoning) {
      chatMsg.reasoning = msg.reasoning
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      chatMsg.tool_calls = msg.toolCalls.map((tc: ToolCall) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }))
    }

    if (msg.toolCallId) {
      chatMsg.tool_call_id = msg.toolCallId
    }

    if (msg.name) {
      chatMsg.name = msg.name
    }

    return chatMsg
  })

  // ── Sanitize: ensure every assistant tool_call has a matching tool result ──
  // Some providers (e.g. MiniMax) reject requests with HTTP 400 "tool call
  // result does not follow tool call" if an assistant message contains
  // tool_calls but the following messages don't contain a tool result for
  // every tool_call id. This happens when:
  //   - The agent loop was interrupted (user sent a new message, abort, etc.)
  //   - ask_user_question was used (its result is a user message, not a tool result)
  //   - Network error during tool execution
  // We insert synthetic tool results for any orphaned tool_call ids so the
  // message sequence is always valid for strict providers.
  return sanitizeOrphanedToolCalls(raw)
}

/**
 * Ensure every assistant tool_call has a corresponding tool result message.
 *
 * Scans the message array for assistant messages containing tool_calls. For
 * each tool_call id, checks if a subsequent `role: 'tool'` message with a
 * matching `tool_call_id` exists. If not, inserts a synthetic tool result.
 *
 * This fixes HTTP 400 errors from strict providers (e.g. MiniMax error 2013:
 * "tool call result does not follow tool call") that occur when the agent
 * loop is interrupted mid-tool-execution (user abort, new message, timeout).
 */
function sanitizeOrphanedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages

  // Collect all tool_call ids that have a matching tool result
  const resolvedToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      resolvedToolCallIds.add(msg.tool_call_id)
    }
  }

  // Build the output, inserting synthetic results after orphaned assistant tool_calls
  const result: ChatMessage[] = []
  let insertedCount = 0

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    result.push(msg)

    // If this is an assistant message with tool_calls, check for orphans
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const orphans = msg.tool_calls.filter(
        (tc) => !resolvedToolCallIds.has(tc.id),
      )

      if (orphans.length > 0) {
        // Insert synthetic tool results right after this assistant message
        for (const orphan of orphans) {
          result.push({
            role: 'tool',
            tool_call_id: orphan.id,
            content: JSON.stringify({
              status: 'interrupted',
              message: 'Tool execution was interrupted before completing. The user may have sent a new message or aborted the run.',
            }),
          })
          insertedCount++
        }
      }
    }
  }

  if (insertedCount > 0) {
    console.warn(
      `[messagesToChatMessages] Inserted ${insertedCount} synthetic tool result(s) for orphaned tool_call(s). ` +
      'This happens when the agent loop is interrupted mid-execution.',
    )
  }

  return result
}
