import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'
import type { Api, Message as PiMessage, Model } from '@earendil-works/pi-ai'
import { createAssistantMessage, createToolMessage, type Message, type ToolCall } from '../message-types'
import type { DeferredContext } from '../deferred-context'
import { createUsageSnapshot } from '../usage-cost'
import { renderPageContextBlock } from '../workspace-assistant-context'
import { ensureToolCallResults } from './tool-call-results'
import { projectCompressionHistory } from './compression-history'

/** Format file size for display in asset metadata */
function formatAssetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function parseToolArgs(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { __invalid_arguments: true }
  } catch {
    return { __invalid_arguments: true }
  }
}

export function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const text = content
    .filter((item): item is { type: string; text?: string; thinking?: string } => !!item)
    .map((item) => {
      if (item.type === 'text') return item.text || ''
      if (item.type === 'thinking') return item.thinking || ''
      return ''
    })
    .join('')
  return text || null
}

function mapInternalToPiMessage(
  msg: Message,
  model: Model<Api>,
  compressedMemoryPrefix: string
): PiMessage[] {
  if (
    msg.kind === 'run_changes' ||
    (msg.role === 'assistant' && (msg.kind === 'empty' || msg.kind === 'error' || msg.kind === 'aborted'))
  ) {
    // UI-only cards and incomplete assistant turns do not belong in model history.
    return []
  }
  if (msg.kind === 'context_summary') {
    // Map context_summary as a user message (system-context block) so the
    // model treats it as memory/context rather than its own prior response.
    // Guard against legacy data where the content already includes the prefix.
    const raw = msg.content || ''
    const content = raw.startsWith(compressedMemoryPrefix)
      ? raw
      : `${compressedMemoryPrefix}\n${raw}`
    return [
      {
        role: 'user',
        content,
        timestamp: msg.timestamp || Date.now(),
      },
    ]
  }
  if (msg.role === 'user') {
    // If a prior agent-loop round already produced a multimodal contentParts
    // array (e.g. from image uploads), reuse it verbatim.  This preserves
    // images across subsequent LLM calls; building fresh from msg.assets
    // would require re-reading OPFS and re-running base64 conversion.
    // pi-ai's UserMessage accepts the multimodal array via `content` directly
    // (no separate contentParts field), so we hand the array through as-is.
    if (msg.contentParts && msg.contentParts.length > 0) {
      return [{
        role: 'user',
        content: msg.contentParts,
        timestamp: msg.timestamp || Date.now(),
      }]
    }

    // Inject asset metadata into user message so the LLM knows about uploaded files
    let userContent = msg.content || ''
    // Defensive: model.input is required by pi-ai's Model<Api> type, but
    // test mocks sometimes omit it.  Default to text-only when absent.
    const hasVision = model.input?.includes('image') ?? false
    if (msg.assets && msg.assets.length > 0) {
      const assetLines = msg.assets.map((a) => {
        const dir = a.direction === 'upload' ? 'Uploaded' : 'Generated'
        return `- ${dir}: ${a.name} (${a.mimeType}, ${formatAssetSize(a.size)})`
      })
      userContent += `\n\n[Attached files]\n${assetLines.join('\n')}`

      // Inject OCR text for image assets (so AI can read text from screenshots)
      // ONLY when the model can't see images directly.  Vision-capable models
      // can OCR the image themselves, so including Tesseract's noisy output
      // would waste tokens and degrade quality.
      const imageAssetsForOcr = msg.assets.filter((a) => a.ocrText && a.ocrText.trim().length > 0)
      if (!hasVision && imageAssetsForOcr.length > 0) {
        const ocrTexts = imageAssetsForOcr.map((a) => `[OCR text from ${a.name}]\n${a.ocrText}`)
        userContent += `\n\n${ocrTexts.join('\n\n')}`
      }

      // Non-image assets: tell AI to use read tool
      const nonImageAssets = msg.assets.filter((a) => !a.mimeType.startsWith('image/'))
      if (nonImageAssets.length > 0) {
        userContent += '\nUse read vfs://assets/<filename> to read file contents.'
      }
    }

    // Inject page context captured at send time (side-panel mode only).
    // Mirrors the OCR-text attachment pattern: stored per-message, rendered
    // into the user content only here (UI never shows it). Kept out of the
    // system prompt so prompt caching remains stable across turns.
    if (msg.pageContext && msg.pageContextDelivery !== 'journal') {
      const block = renderPageContextBlock(msg.pageContext)
      if (block) {
        userContent += block
      }
    }

    // Check if we have image assets with base64 data (for Vision API)
    const imageAssets = msg.assets?.filter((a) => a.ocrBase64 && a.mimeType.startsWith('image/')) || []
    if (imageAssets.length > 0 && model.input.includes('image')) {
      // Vision API mode: send as multimodal content (text + images)
      const contentParts: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = []

      // Add text content first
      if (userContent) {
        contentParts.push({ type: 'text', text: userContent })
      }

      // Add image parts
      for (const imgAsset of imageAssets) {
        contentParts.push({
          type: 'image',
          data: imgAsset.ocrBase64!,
          mimeType: imgAsset.mimeType,
        })
      }

      return [
        {
          role: 'user',
          content: contentParts,
          timestamp: msg.timestamp || Date.now(),
        },
      ]
    }

    return [
      {
        role: 'user',
        content: userContent,
        timestamp: msg.timestamp || Date.now(),
      },
    ]
  }

  if (msg.role === 'assistant') {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'image'; data: string; mimeType: string }
      | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
    > = []

    if (msg.content) {
      content.push({ type: 'text', text: msg.content })
    }
    if (msg.reasoning) {
      content.push({ type: 'thinking', thinking: msg.reasoning })
    }
    // Round-trip assistant-generated images back into provider history
    // (issue #165, item 4): without this, the turn after an image-only reply
    // sends an EMPTY assistant message — the model loses the context of what
    // it just produced. Text stays first; images follow it. Only
    // vision-capable models can accept image blocks on any turn (mirrors the
    // user-branch `model.input.includes('image')` guard above); a
    // text-only model gets an OCR-style text placeholder instead so the
    // message is never emitted with fully empty content.
    const hasVision = model.input?.includes('image') ?? false
    let imageCount = 0
    for (const image of msg.images ?? []) {
      if (image.data && image.mimeType) {
        if (!hasVision) {
          imageCount += 1
          continue
        }
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      }
    }
    if (imageCount > 0) {
      content.push({
        type: 'text',
        text: imageCount === 1 ? '[generated an image]' : `[generated ${imageCount} images]`,
      })
    }
    for (const toolCall of msg.toolCalls || []) {
      content.push({
        type: 'toolCall',
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseToolArgs(toolCall.function.arguments),
      })
    }

    return [
      {
        role: 'assistant',
        // AssistantMessage's static type does not express image blocks on
        // assistant turns (same limitation pi-core-runner documents for its
        // empty-turn check); the cast is the established pattern there.
        content: content as import('@earendil-works/pi-ai').AssistantMessage['content'],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: msg.usage?.promptTokens ?? 0,
          output: msg.usage?.completionTokens ?? 0,
          cacheRead: msg.usage?.cacheReadTokens ?? 0,
          cacheWrite: 0,
          totalTokens: msg.usage?.totalTokens ?? 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: msg.stopReason ?? 'stop',
        timestamp: msg.timestamp || Date.now(),
      },
    ]
  }

  if (msg.role === 'tool') {
    return [
      {
        role: 'toolResult',
        toolCallId: msg.toolCallId || '',
        toolName: msg.name || 'tool',
        content: msg.contentParts && msg.contentParts.length > 0
          ? msg.contentParts
          : [{ type: 'text', text: msg.content || '' }],
        isError: msg.content?.startsWith('Error:') ?? false,
        timestamp: msg.timestamp || Date.now(),
      },
    ]
  }

  return []
}

/** Keep internal provenance through pi-agent's conversion without putting it in provider payloads. */
const internalMessages = new WeakMap<object, Message>()

/** Materialize the same text and media as normal requests, retaining canonical source metadata. */
export function materializeProviderHistory(messages: Message[], model: Model<Api>, prefix: string): Message[] {
  return messages.flatMap(source => mapInternalToPiMessage(source, model, prefix).map(mapped => {
    const contentParts = Array.isArray(mapped.content)
      ? mapped.content.filter((part): part is NonNullable<Message['contentParts']>[number] => part.type === 'text' || part.type === 'image')
      : undefined
    return {
      ...source,
      content: typeof mapped.content === 'string' ? mapped.content : contentParts?.filter(part => part.type === 'text').map(part => part.text).join('') ?? null,
      contentParts: contentParts?.some(part => part.type === 'image') ? contentParts : undefined,
    }
  }))
}

/**
 * The provider-history view of the canonical transcript: incomplete assistant
 * turns (empty/error/aborted — issue #158) are excluded, ALONG WITH the tool
 * results that only those turns' calls requested. Without removing the orphan
 * results, strict providers reject the whole request (issue #165, item 3).
 * The filtering happens HERE, never on the canonical transcript — see
 * `ensureToolCallResults`.
 */
function toProviderHistory(messages: Message[]): Message[] {
  const droppedAssistantIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          (message.kind === 'empty' || message.kind === 'error' || message.kind === 'aborted')
      )
      .map((message) => message.id)
  )
  // No early return when there are no incomplete turns: a history repaired by
  // an earlier version of this filter (which removed the failed assistant turn
  // but left its tool result) still carries a truly orphaned tool result, and
  // strict providers reject the whole request even with zero incomplete turns
  // remaining.
  const keptCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && !droppedAssistantIds.has(message.id)) {
      for (const toolCall of message.toolCalls ?? []) keptCallIds.add(toolCall.id)
    }
  }
  return messages.filter(
    (message) =>
      !(message.role === 'assistant' && droppedAssistantIds.has(message.id)) &&
      !(message.role === 'tool' && message.toolCallId && !keptCallIds.has(message.toolCallId))
  )
}

export function internalToPiMessages(messages: Message[], model: Model<Api>, prefix: string): PiMessage[] {
  const visible = projectCompressionHistory(messages)
  return ensureToolCallResults(toProviderHistory(visible)).flatMap(message => {
    const mapped = mapInternalToPiMessage(message, model, prefix)
    for (const item of mapped) {
      internalMessages.set(item, message)
    }
    return mapped
  })
}

export function piToInternalMessage(message: PiAgentMessage): Message | null {
  const retained = internalMessages.get(message)
  if (retained) return retained
  const converted = mapPiToInternalMessage(message)
  if (converted) internalMessages.set(message, converted)
  return converted
}

function mapPiToInternalMessage(message: PiAgentMessage): Message | null {
  const now = Date.now()
  if (typeof message !== 'object' || !message || !('role' in message)) return null

  if (message.role === 'user') {
    const rawContent = message.content
    const isMultimodal = Array.isArray(rawContent)
    const textContent = isMultimodal
      ? extractTextContent(rawContent)
      : (typeof rawContent === 'string' ? rawContent : null)
    return {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      role: 'user',
      content: textContent,
      ...(isMultimodal ? { contentParts: rawContent as Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> } : {}),
      timestamp: message.timestamp || now,
    }
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((item) => !!item)
      .filter((item) => item.type === 'text')
      .map((item) => ('text' in item ? item.text || '' : ''))
      .join('')
    // Image-capable providers can return image blocks without any text or
    // tool calls. Preserve them on the internal message (the same shape the
    // /image command uses) so an image-only assistant turn is neither
    // classified as empty nor dropped from the conversation.
    const imageBlocks = (message.content as unknown[]).filter(
      (item): item is { type: 'image'; data: string; mimeType: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'image' &&
        typeof (item as { data?: unknown }).data === 'string' &&
        typeof (item as { mimeType?: unknown }).mimeType === 'string'
    )
    const reasoning = message.content
      .filter((item) => !!item)
      .filter((item) => item.type === 'thinking')
      .map((item) => ('thinking' in item ? item.thinking || '' : ''))
      .join('')
    const toolCalls: ToolCall[] = message.content
      .filter(
        (item): item is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } =>
          item.type === 'toolCall'
      )
      .map((item) => ({
        id: item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: JSON.stringify(item.arguments || {}),
        },
      }))

    // Only attach usage when the API actually reported non-zero tokens.
    // When the agent is cancelled mid-stream, the API never sends the final
    // usage chunk, so all values are 0 — in that case we leave usage undefined
    // so the UI falls back to the last valid usage from a previous message.
    const rawUsage = message.usage
    const hasRealUsage =
      (rawUsage?.input || 0) > 0 ||
      (rawUsage?.output || 0) > 0 ||
      (rawUsage?.totalTokens || 0) > 0

    const assistant = createAssistantMessage(
      text || null,
      toolCalls.length > 0 ? toolCalls : undefined,
      hasRealUsage
        ? createUsageSnapshot(
            {
              promptTokens: rawUsage!.input || 0,
              completionTokens: rawUsage!.output || 0,
              totalTokens: rawUsage!.totalTokens || 0,
              cacheReadTokens: rawUsage!.cacheRead || 0,
            },
            message.provider,
            message.model,
          )
        : undefined,
      reasoning || null
    )
    assistant.timestamp = message.timestamp || assistant.timestamp || now
    assistant.stopReason = message.stopReason
    if (imageBlocks.length > 0) {
      // GeneratedImage shape — the same inline representation the /image
      // command uses, rendered by AssistantTurnBubble/MessageBubble.
      assistant.images = imageBlocks.map((block) => ({ data: block.data, mimeType: block.mimeType }))
    }
    if (message.stopReason === 'error' && typeof message.errorMessage === 'string' && message.errorMessage.trim()) {
      assistant.errorMessage = message.errorMessage
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      assistant.kind = message.stopReason
    } else if (!text.trim() && toolCalls.length === 0 && imageBlocks.length === 0) {
      assistant.kind = 'empty'
    }
    return assistant
  }

  if (message.role === 'toolResult') {
    const text = extractTextContent(message.content) || ''
    // Preserve multimodal content (e.g. screenshot images from page_screenshot)
    // so the UI renderer can display them. Without this, image data is lost
    // when the tool result is converted to an internal Message.
    const imageParts = Array.isArray(message.content)
      ? message.content.filter(
          (part): part is { type: 'image'; data: string; mimeType: string } =>
            !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'image',
        )
      : []
    const tool = createToolMessage({
      toolCallId: message.toolCallId,
      name: message.toolName,
      content: text,
      ...(imageParts.length > 0
        ? {
            contentParts: structuredClone(message.content),
          }
        : {}),
    })
    const details = message.details as { displayContent?: string; deferred?: DeferredContext[] } | undefined
    tool.displayContent = details?.displayContent
    tool.deferredContext = details?.deferred
    tool.timestamp = message.timestamp || tool.timestamp || now
    return tool
  }

  return null
}
