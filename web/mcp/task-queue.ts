import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { getMCPTaskManager } from './task-manager'

/** Hold a task's queued intent across tabs until it is consumed or withdrawn. */
export async function ownMCPTaskQueue(taskId: string, conversationId: string): Promise<() => void> {
  let release!: () => void
  let ready!: () => void
  let rejectReady!: (reason: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => {
    ready = resolve
    rejectReady = reject
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ownership = navigator.locks.request(`mcp-queue:${taskId}`, async () => {
    ready()
    await held
  })
  void ownership.catch(rejectReady)
  await acquired
  let stopped = false
  let seen = false
  let clearing = false
  const stop = () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    window.removeEventListener('pagehide', onPageHide)
    release()
  }
  const unsubscribe = useConversationRuntimeStore.subscribe((state) => {
    const queued = state.pendingMessageQueues
      .get(conversationId)
      ?.some((item) => item.mcpTaskId === taskId)
    if (queued) seen = true
    if (!queued && seen && !clearing) {
      clearing = true
      void (async () => {
        const manager = getMCPTaskManager()
        const task = manager.getSnapshot().find((item) => item.id === taskId)
        if (task) await manager.updateComposer(task.context.projectId, taskId, { queued: false })
      })()
        .catch(console.error)
        .finally(stop)
    }
  })
  const onPageHide = () => {
    removeMCPTaskFromQueue(taskId, conversationId)
    stop()
  }
  window.addEventListener('pagehide', onPageHide, { once: true })
  return stop
}

export function removeMCPTaskFromQueue(taskId: string, conversationId: string) {
  const runtime = useConversationRuntimeStore.getState()
  const index =
    runtime.pendingMessageQueues
      .get(conversationId)
      ?.findIndex((item) => item.mcpTaskId === taskId) ?? -1
  if (index >= 0) runtime.removeQueuedMessage(conversationId, index)
}
