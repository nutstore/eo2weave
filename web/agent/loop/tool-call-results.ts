import type { Message } from '../message-types'
import { generateId } from '../message-types'

/**
 * Normalize persisted tool-call history into the strict provider format: each
 * assistant tool call is followed immediately by its matching result. A run
 * can be interrupted after the call is persisted but before its result is
 * saved, and older histories can contain results after a later user message.
 */
export function ensureToolCallResults(messages: Message[]): Message[] {
  // NOTE: this function runs on the CANONICAL transcript (e.g. cancelAgent's
  // commit). It must not drop failure turns: the assignment of its result back
  // to `c.messages` + persistence would delete earlier empty/error/aborted
  // records from the transcript AND from SQLite (issue #165, item 1). Failure
  // turns are excluded from the PROVIDER path instead — see
  // `toProviderHistory` in message-mappers.ts, which filters them (plus their
  // tool results) before calling this function.

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
