import { isCredentialPending } from '@/agent/providers/credential-state'
import type { ManagedMCPTask } from './task-types'
import { getMCPTaskManager } from './task-manager'

export type MCPTaskDelivery = { kind: 'sent'; messageId: string } | { kind: 'queued' }

/** Explicit user action. Resolves on durable message acceptance, not model completion. */
export async function continueMCPTask(
  task: ManagedMCPTask,
  text: string,
  fromQueue = false
): Promise<MCPTaskDelivery> {
  const manager = getMCPTaskManager()
  await manager.initialize()
  return navigator.locks.request(`mcp-delivery:${task.id}`, async () => {
    task = await manager.reload(task.context.projectId, task.id)
    if (
      task.remoteStatus !== 'completed' ||
      task.resultIsError ||
      task.result?.isError ||
      !task.settledAt ||
      (!task.result && !task.resultAssetId)
    )
      throw new Error('MCP task result is not ready')
    const id = task.context.conversationId
    const messageId = `mcp-result-${task.id}`
    const [
      { useConversationStore },
      { useConversationRuntimeStore },
      { useSettingsStore },
      { useProjectStore },
      { getConversationRepository },
      { getWorkspaceRepository },
      { getMessageRepository },
      { createUserMessage },
    ] = await Promise.all([
      import('@/store/conversation.store'),
      import('@/store/conversation-runtime.store'),
      import('@/store/settings.store'),
      import('@/store/project.store'),
      import('@/sqlite/repositories/conversation.repository'),
      import('@/sqlite/repositories/workspace.repository'),
      import('@/sqlite/repositories/message.repository'),
      import('@/agent/message-types'),
    ])
    const [conversation, workspace, accepted] = await Promise.all([
      getConversationRepository().findById(id),
      getWorkspaceRepository().findWorkspaceById(id),
      getMessageRepository().hasMessage(id, messageId),
    ])
    if (!conversation || !workspace || workspace.projectId !== task.context.projectId)
      throw new Error('Original conversation no longer exists')
    if (accepted || task.composer?.sentMessageId) {
      await manager.updateComposer(task.context.projectId, task.id, {
        sentMessageId: messageId,
        queued: false,
      })
      return { kind: 'sent', messageId }
    }
    if (!fromQueue && useProjectStore.getState().activeProjectId !== task.context.projectId)
      throw new Error('Open the original project before continuing')
    const settings = useSettingsStore.getState()
    if (!settings.providerType || !settings.modelName ||
        (!settings.hasApiKey && !isCredentialPending(settings.providerType)))
      throw new Error('Configure a model before continuing')
    const runtime = useConversationRuntimeStore.getState()
    const { ownMCPTaskQueue, removeMCPTaskFromQueue } = await import('./task-queue')
    if (!fromQueue && task.composer?.queued) {
      const owned = await navigator.locks.request(
        `mcp-queue:${task.id}`,
        { ifAvailable: true },
        (lock) => !lock
      )
      if (owned) return { kind: 'queued' }
      await manager.updateComposer(task.context.projectId, task.id, { queued: false })
    }
    const message = text.includes(`mcp_tasks.result local_task_id=${task.id}`)
      ? text
      : `${text}\n\nmcp_tasks.result local_task_id=${task.id}`
    if (runtime.isConversationRunning(id)) {
      if (fromQueue) throw new Error('Original conversation is still running')
      const release = await ownMCPTaskQueue(task.id, id)
      try {
        if (
          !runtime.enqueueMessage(id, {
            text: message,
            mcpTaskId: task.id,
            agentOverrideId: task.context.agentId ?? null,
            enqueuedAt: Date.now(),
            background: true,
          }).enqueued
        )
          throw new Error('Original conversation message queue is full')
        await manager.updateComposer(task.context.projectId, task.id, { queued: true })
        return { kind: 'queued' }
      } catch (error) {
        removeMCPTaskFromQueue(task.id, id)
        release()
        throw error
      }
    }
    const store = useConversationStore.getState()
    if (!store.conversations.some((item) => item.id === id))
      throw new Error('Original conversation is unavailable')
    if (
      !store.conversations
        .find((item) => item.id === id)
        ?.messages.some((item) => item.id === messageId)
    ) {
      const userMessage = createUserMessage(message)
      userMessage.id = messageId
      store.addMessage(id, userMessage)
    }
    const { waitForConversationWrites } = await import('@/store/conversation.store.sqlite')
    await waitForConversationWrites(id)
    const messages = useConversationStore
      .getState()
      .conversations.find((item) => item.id === id)?.messages
    if (!messages?.some((item) => item.id === messageId))
      throw new Error('Original conversation could not be loaded')
    const { persistMessageReplace } = await import('@/store/conversation-persist')
    await persistMessageReplace(id, messages, true)
    // A later model failure belongs to the conversation; it must not revive this card.
    try {
      await manager.updateComposer(task.context.projectId, task.id, {
        sentMessageId: messageId,
        queued: false,
      })
    } catch (error) {
      // The durable message identity still prevents a repeated delivery after refresh.
      console.error('[MCP] Could not save result delivery receipt:', error)
    } finally {
      if (fromQueue) removeMCPTaskFromQueue(task.id, id)
      queueMicrotask(() => {
        void store
          .runAgent(
            id,
            settings.providerType,
            settings.modelName,
            settings.maxTokens,
            null,
            task.context.agentId ?? null,
            { background: true }
          )
          .catch(console.error)
      })
    }
    return { kind: 'sent', messageId }
  })
}

/** A previously confirmed queue item is handed off after the current run ends. */
export async function continueQueuedMCPTask(taskId: string, text: string): Promise<void> {
  const manager = getMCPTaskManager()
  await manager.initialize()
  const task = manager.getSnapshot().find((item) => item.id === taskId)
  if (!task) throw new Error('MCP task no longer exists')
  try {
    await continueMCPTask(task, text, true)
  } finally {
    const { removeMCPTaskFromQueue } = await import('./task-queue')
    removeMCPTaskFromQueue(taskId, task.context.conversationId)
    await manager.updateComposer(task.context.projectId, taskId, { queued: false })
  }
}
