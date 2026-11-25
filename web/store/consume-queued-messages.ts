import { toast } from 'sonner'
import { createUserMessage, type Conversation, type Message } from '@/agent/message-types'
import type { LLMProviderType } from '@/agent/providers/types'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

/** Keep durable but not-yet-dequeued app-tool prompts out of agent input. */
export function messagesForAgentTurn(conversationId: string, messages: Message[]): Message[] {
  const queuedIds = new Set(
    (useConversationRuntimeStore.getState().pendingMessageQueues.get(conversationId) ?? [])
      .map((item) => item.persistedMessage?.id)
      .filter((id): id is string => id !== undefined),
  )
  return queuedIds.size ? messages.filter((message) => !queuedIds.has(message.id)) : messages
}

interface QueueConsumer {
  conversationId: string
  providerType: LLMProviderType
  modelName: string
  maxTokens: number
  getConversation: () => Conversation | undefined
  updateMessages: (messages: Message[]) => void
  runAgent: (
    conversationId: string,
    providerType: LLMProviderType,
    modelName: string,
    maxTokens: number,
    directoryHandle: FileSystemDirectoryHandle | null,
    agentOverrideId?: string | null,
    options?: { background?: boolean },
  ) => Promise<void>
}

/**
 * Start one follow-up turn for a compatible prefix of the queue. Each queued
 * user message retains its own transcript record, identity and attachments;
 * only the agent dispatch is shared. MCP continuations remain a barrier: the
 * MCP task delivery path owns them and must not be folded into an agent turn.
 */
export async function consumeQueuedMessages({
  conversationId, providerType, modelName, maxTokens, getConversation, updateMessages, runAgent,
}: QueueConsumer): Promise<void> {
  const runtime = useConversationRuntimeStore.getState()
  const head = runtime.getQueuedMessage(conversationId, 0)
  if (!head) return
  if (head.mcpTaskId) {
    try {
      const { continueQueuedMCPTask } = await import('@/mcp/continue-task')
      await continueQueuedMCPTask(head.mcpTaskId, head.text)
    } catch (error) {
      console.error('[MCP] Queued result delivery failed:', error)
      toast.error(error instanceof Error ? error.message : String(error))
    }
    return
  }

  const current = getConversation()
  if (!current) return
  const batch = runtime.dequeueBatch(conversationId)
  if (!batch) return

  const messages = current.messages.slice()
  const consumedMessages: Message[] = []
  const consumedIds = new Set<string>()
  let changed = false
  for (const queued of batch.messages) {
    const userMsg = queued.persistedMessage
      ? { ...queued.persistedMessage, content: queued.text, assets: queued.assets ?? queued.persistedMessage.assets }
      : createUserMessage(queued.text, queued.assets, queued.pageContext, {
          contentParts: queued.contentParts,
          readImageHandoff: queued.readImageHandoff,
        })
    const existing = messages.find((message) => message.id === userMsg.id)
    const sameAssets = (existing?.assets ?? []).map((a) => a.id).join() ===
      (userMsg.assets ?? []).map((a) => a.id).join()
    if (!existing || existing.content !== userMsg.content || !sameAssets) changed = true
    consumedMessages.push(existing
      ? { ...existing, content: userMsg.content, assets: userMsg.assets }
      : userMsg)
    consumedIds.add(userMsg.id)
  }
  // Anchor the batch before its first visible record, or the first still-
  // queued persisted record. Missing earlier messages must precede later ones.
  if (consumedMessages.length) {
    const pendingIds = new Set(
      (runtime.pendingMessageQueues.get(conversationId) ?? [])
        .map((item) => item.persistedMessage?.id)
        .filter((id): id is string => id !== undefined),
    )
    const firstIndex = messages.findIndex((message) =>
      consumedIds.has(message.id) || pendingIds.has(message.id))
    const remaining = messages.filter((message) => !consumedIds.has(message.id))
    const insertionIndex = firstIndex < 0 ? remaining.length :
      messages.slice(0, firstIndex).filter((message) => !consumedIds.has(message.id)).length
    const ordered = [
      ...remaining.slice(0, insertionIndex), ...consumedMessages, ...remaining.slice(insertionIndex),
    ]
    if (!changed && ordered.some((message, index) => message.id !== messages[index]?.id)) changed = true
    if (changed) updateMessages(ordered)
  }

  // An all-rerun batch still needs one turn. Use the head even when that
  // entry is a rerun trigger (batch.messages will then be empty).
  queueMicrotask(() => {
    void runAgent(
      conversationId, providerType, modelName, maxTokens, null,
      head.agentOverrideId ?? null,
      head.background ? { background: true } : undefined,
    )
  })
}
