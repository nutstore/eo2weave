import { toast } from 'sonner'
import { createUserMessage, type Conversation, type Message } from '@/agent/message-types'
import type { LLMProviderType } from '@/agent/providers/types'
import { useConversationRuntimeStore } from './conversation-runtime.store'

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
  let changed = false
  for (const queued of batch.messages) {
    const userMsg = queued.persistedMessage
      ? { ...queued.persistedMessage, content: queued.text, assets: queued.assets ?? queued.persistedMessage.assets }
      : createUserMessage(queued.text, queued.assets, queued.pageContext, {
          contentParts: queued.contentParts,
          readImageHandoff: queued.readImageHandoff,
        })
    const index = messages.findIndex((message) => message.id === userMsg.id)
    if (index === -1) {
      messages.push(userMsg)
      changed = true
    } else {
      const existing = messages[index]
      const sameAssets = (existing.assets ?? []).map((a) => a.id).join() ===
        (userMsg.assets ?? []).map((a) => a.id).join()
      if (existing.content !== userMsg.content || !sameAssets) {
        messages[index] = { ...existing, content: userMsg.content, assets: userMsg.assets }
        changed = true
      }
    }
  }
  if (changed) updateMessages(messages)

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
