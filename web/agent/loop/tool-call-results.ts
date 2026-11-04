import type { Message } from '../message-types'
import { generateId } from '../message-types'

/**
 * Normalize persisted tool-call history into the strict provider format: each
 * assistant tool call is followed immediately by its matching result. A run
 * can be interrupted after the call is persisted but before its result is
 * saved, and older histories can contain results after a later user message.
 */
export function ensureToolCallResults(messages: Message[]): Message[] {
  // Assistant turns that never reach the provider (aborted/failed/empty) are
  // filtered FIRST, before placeholder results are synthesized. If placeholders
  // were added for their tool calls and the turn was filtered afterwards, the
  // provider history would contain orphaned tool results with no matching
  // assistant call — which strict providers reject.
  const droppedAssistantIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'assistant' &&
          (message.kind === 'empty' || message.kind === 'error' || message.kind === 'aborted')
      )
      .map((message) => message.id)
  )
  if (droppedAssistantIds.size > 0) {
    messages = messages.filter(
      (message) => !(message.role === 'assistant' && droppedAssistantIds.has(message.id))
    )
  }

  const declaredToolCallIds = new Set<string>()
  const toolResultsByCallId = new Map<string, Message>()
  let changed = false

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        declaredToolCallIds.add(toolCall.id)
      }
    }

    if (message.role === 'tool' && message.toolCallId) {
      if (toolResultsByCallId.has(message.toolCallId)) {
        // Keep the first persisted result and remove duplicate deliveries for
        // the same call; strict providers accept one result per tool call.
        changed = true
      } else {
        toolResultsByCallId.set(message.toolCallId, message)
      }
    }
  }

  const result: Message[] = []

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]

    // Reinsert known tool results beside their owning assistant message below.
    // Unmatched tool messages are preserved in place so this repair remains
    // narrowly scoped to tool calls represented in the conversation.
    if (message.role === 'tool' && message.toolCallId && declaredToolCallIds.has(message.toolCallId)) {
      continue
    }

    result.push(message)
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue

    for (let toolCallIndex = 0; toolCallIndex < message.toolCalls.length; toolCallIndex += 1) {
      const toolCall = message.toolCalls[toolCallIndex]
      const existingResult = toolResultsByCallId.get(toolCall.id)

      if (existingResult) {
        // Results must be directly adjacent and in tool-call order. A result
        // found later in history is still not valid for strict providers.
        if (messages[messageIndex + toolCallIndex + 1] !== existingResult) {
          changed = true
        }
        result.push(existingResult)
        continue
      }

      result.push({
        id: generateId(),
        role: 'tool',
        content: JSON.stringify({
          status: 'interrupted',
          message: 'Tool execution was interrupted before completing.',
        }),
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        timestamp: Date.now(),
      })
      changed = true
    }
  }

  return changed ? result : messages
}
