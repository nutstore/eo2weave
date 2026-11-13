import type { Message } from '@/agent/message-types'
import { getMessageRepository } from '@/sqlite/repositories/message.repository'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { toolErrorJson, toolOkJson } from './tool-envelope'

export const readConversationHistoryDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_conversation_history',
    description: 'Recover original messages from this conversation, including history covered by a compression checkpoint. Returns JSON records as text with stable source message IDs. Follow nextCursor to read remaining text; concatenate fragments with the same ID before decoding JSON. Does not require file access or a browser extension.',
    parameters: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'Read one source message by exact ID.' },
        query: { type: 'string', description: 'Optional case-insensitive keyword in message text or tool metadata.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the previous page. Keep the same message_id/query filters.' },
        limit: { type: 'number', minimum: 1, maximum: 20, description: 'Maximum records per page; default 10.' },
        max_chars: { type: 'number', minimum: 1000, maximum: 24000, description: 'Total JSON text characters per page; default 12000. Long records continue on the next page.' },
      },
    },
  },
}

/** Exclude binary media and runtime catalogs, while retaining their readable provenance. */
function historyRecord(message: Message): string {
  return JSON.stringify({
    id: message.id,
    role: message.role,
    kind: message.kind,
    timestamp: message.timestamp,
    content: message.content,
    pageContext: message.pageContext,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    name: message.name,
    errorMessage: message.errorMessage,
    stopReason: message.stopReason,
    assets: message.assets?.map(asset => ({ name: asset.name, mimeType: asset.mimeType, size: asset.size, ocrText: asset.ocrText })),
    contentParts: message.contentParts?.map(part => part.type === 'image'
      ? { type: 'image', mimeType: part.mimeType, sourceMessageId: message.id } : part),
    images: message.images?.map(image => ({ mimeType: image.mimeType, sourceMessageId: message.id })),
  })
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
}

export const readConversationHistoryExecutor: ToolExecutor = async (args, context) => {
  const conversationId = context.conversationHistory?.id ?? (context.isSubagent ? null : context.workspaceId)
  if (!conversationId) return toolErrorJson('read_conversation_history', 'invalid_arguments', 'No current conversation is available.')
  try {
    const messageId = typeof args.message_id === 'string' ? args.message_id : ''
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const scope = JSON.stringify([conversationId, messageId, query])
    const all = context.conversationHistory
      ? await context.conversationHistory.read()
      : await getMessageRepository().findByConversation(conversationId)
    const source = all.filter(message => message.kind !== 'context_update' && message.kind !== 'run_changes')
      .map(message => ({ id: message.id, text: historyRecord(message) }))
      .filter(record => (!messageId || record.id === messageId) && (!query || record.text.toLowerCase().includes(query)))
    let index = 0
    let offset = 0
    if (typeof args.cursor === 'string' && args.cursor) {
      const cursor: { id?: string; offset?: number; scope?: string } = JSON.parse(args.cursor)
      index = source.findIndex(record => record.id === cursor.id)
      if (cursor.scope !== scope || index < 0 || !Number.isInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! > source[index].text.length) {
        return toolErrorJson('read_conversation_history', 'invalid_arguments', 'The history cursor no longer matches these messages or filters.')
      }
      offset = cursor.offset!
    }
    const limit = boundedInteger(args.limit, 10, 1, 20)
    let remaining = boundedInteger(args.max_chars, 12000, 1000, 24000)
    const records: Array<{ id: string; offset: number; text: string; complete: boolean }> = []
    while (index < source.length && records.length < limit && remaining > 0) {
      const record = source[index]
      const text = record.text.slice(offset, offset + remaining)
      const nextOffset = offset + text.length
      records.push({ id: record.id, offset, text, complete: nextOffset === record.text.length })
      remaining -= text.length
      if (nextOffset < record.text.length) { offset = nextOffset; break }
      index++
      offset = 0
    }
    const nextCursor = index < source.length ? JSON.stringify({ id: source[index].id, offset, scope }) : null
    return toolOkJson('read_conversation_history', { conversationId, records, hasMore: nextCursor !== null, nextCursor })
  } catch (error) {
    return toolErrorJson('read_conversation_history', 'internal_error', error instanceof Error ? error.message : String(error))
  }
}

export const readConversationHistoryPromptDoc: ToolPromptDoc = {
  category: 'search',
  section: '### Conversation history recall',
  lines: ['- `read_conversation_history(message_id?, query?, cursor?, max_chars?)` — recover exact original requirements, tool arguments or results from this conversation after compression. Follow nextCursor for complete long records; source IDs in checkpoints refer to these messages.'],
}
