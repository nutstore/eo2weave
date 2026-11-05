import type { Message } from '@/agent/message-types'

const MESSAGE_META_FIELDS = [
  'displayContent',
  'deferredContext',
  'kind',
  'stopReason',
  'errorMessage',
  'contextCommit',
  'compressionBoundary',
  'pageContext',
  'pageContextDelivery',
  'reasoning',
  'reasoningDurationMs',
  'toolCalls',
  'toolCallId',
  'name',
  'usage',
  'assets',
  'images',
  'contentParts',
  'runChanges',
  'readImageHandoff',
  'delegationNote',
] as const satisfies readonly (keyof Message)[]

export type MessageMeta = Partial<Pick<Message, (typeof MESSAGE_META_FIELDS)[number]>>

export function serializeMessageMetadata(message: Partial<Message>): string | null {
  const meta: MessageMeta = {}
  for (const field of MESSAGE_META_FIELDS) {
    if (message[field] !== undefined) {
      Object.assign(meta, { [field]: message[field] })
    }
  }
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
}

export function deserializeMessageMetadata(metaJson: string | null): MessageMeta {
  return metaJson ? (JSON.parse(metaJson) as MessageMeta) : {}
}
