import { getMessageRecordType, type Message } from '@/agent/message-types'

/** Real dialogue for topic titles and suggestions, not model-context replay. */
export function selectConversationTranscript(messages: readonly Message[]): Message[] {
  return messages.filter(message => {
    const type = getMessageRecordType(message)
    return type === 'user_input' || type === 'assistant_output'
  })
}

/** Readable exports retain execution details, but omit the runtime journal. */
export function selectConversationExportMessages(
  messages: readonly Message[],
  options: { includeSystemMessages?: boolean; includeToolCalls?: boolean } = {},
): Message[] {
  return messages.filter(message => {
    const type = getMessageRecordType(message)
    if (type === 'context_update') return false
    if (type === 'system' && !options.includeSystemMessages) return false
    if (type === 'tool_result' && options.includeToolCalls === false) return false
    return true
  })
}
