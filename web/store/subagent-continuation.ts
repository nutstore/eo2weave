import { CompletionDeliveryCoordinator } from '@/agent/subagent/completion-delivery'
import type { SubagentCompletion } from '@/agent/subagent/async-types'
import { getSubagentCompletionRepository } from '@/sqlite/repositories/subagent-completion.repository'
import { getSubagentRepository } from '@/sqlite/repositories/subagent.repository'
import { useConversationRuntimeStore } from './conversation-runtime.store'
import { useSubagentTaskStore } from './subagent-task.store'
import { isConversationDispatchBusy } from './conversation-agent-run'

const localLocks = new Map<string, Promise<unknown>>()
async function withDeliveryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(key, operation)
  const previous = localLocks.get(key) ?? Promise.resolve()
  const work = previous.catch(() => {}).then(operation)
  localLocks.set(key, work)
  try {
    return await work
  } finally {
    if (localLocks.get(key) === work) localLocks.delete(key)
  }
}

const knownConversations = new Set<string>()
export function drainSubagentContinuations(id: string): void {
  if (knownConversations.has(id)) coordinator?.schedule(id)
}

let coordinator: CompletionDeliveryCoordinator | undefined
export function getSubagentContinuation(): CompletionDeliveryCoordinator {
  return (coordinator ??= new CompletionDeliveryCoordinator({
    repository: getSubagentCompletionRepository(),
    withLock: withDeliveryLock,
    isBusy: (id) =>
      isConversationDispatchBusy(id) ||
      useConversationRuntimeStore.getState().isConversationRunning(id) ||
      useConversationRuntimeStore.getState().getQueueDepth(id) > 0,
    validateOrigin: async (completion) => {
      const [{ getConversationRepository }, { getWorkspaceRepository }, { getProjectRepository }] =
        await Promise.all([
          import('@/sqlite/repositories/conversation.repository'),
          import('@/sqlite/repositories/workspace.repository'),
          import('@/sqlite/repositories/project.repository'),
        ])
      const [conversation, workspace] = await Promise.all([
        getConversationRepository().findById(completion.conversationId),
        getWorkspaceRepository().findWorkspaceById(completion.conversationId),
      ])
      if (!conversation || !workspace) return false
      if (
        completion.projectId &&
        (workspace.projectId !== completion.projectId ||
          !(await getProjectRepository().findById(completion.projectId)))
      )
        return false
      return true
    },
    appendNotification: async (id, message, eligible) => {
      const { appendSubagentNotification } = await import('./conversation.store.sqlite')
      return appendSubagentNotification(id, message, eligible)
    },
    dispatch: async (id, origin) => {
      const { useConversationStoreSQLite } = await import('./conversation.store.sqlite')
      await useConversationStoreSQLite
        .getState()
        .runAgent(
          id,
          origin.providerType as Parameters<
            ReturnType<typeof useConversationStoreSQLite.getState>['runAgent']
          >[1],
          origin.modelName,
          origin.maxTokens,
          null,
          origin.agentOverrideId,
          { background: true, transient: true, subagentContinuation: true }
        )
      const conv = useConversationStoreSQLite.getState().conversations.find((c) => c.id === id)
      if (conv?.status === 'error')
        await getSubagentContinuation().blockUnstarted(id, conv.error ?? 'Model dispatch failed')
    },
    onPhase: (row, phase) => {
      const store = useSubagentTaskStore.getState()
      store.setDeliveryPhase(row.agentId, row.executionId, phase)
      const task = store.tasks[row.agentId]
      if (task?.executionId === row.executionId)
        useSubagentTaskStore.getState().publish({ ...useSubagentTaskStore.getState().tasks[row.agentId], deliveryError: row.deliveryError })
    },
    onError: (error) => console.error('[subagent] Completion delivery failed:', error),
  }))
}

export function onSubagentCompletionReady(completion: SubagentCompletion): void {
  knownConversations.add(completion.conversationId)
  getSubagentContinuation().schedule(completion.conversationId)
}

/** Hydration does not construct a provider, runtime, or mounted conversation view. */
export async function recoverSubagentContinuations(conversationIds: string[]): Promise<void> {
  const repository = getSubagentCompletionRepository()
  for (const id of conversationIds) {
    const tasks = await getSubagentRepository().findByWorkspaceId(id)
    for (const task of tasks) {
      const interrupted = task.status === 'pending' || task.status === 'running'
      const completion = task.execution
        ? await repository.find(`${task.agentId}:${task.execution.executionId}`)
        : null
      useSubagentTaskStore.getState().publish({
        agentId: task.agentId,
        conversationId: id,
        parentToolCallId: task.parentToolCallId,
        name: task.name,
        description: task.description,
        role: task.subagent_type,
        status: interrupted ? 'failed' : task.status,
        error: interrupted
          ? { code: 'SESSION_INTERRUPTED', message: 'Subagent interrupted by session restart.' }
          : task.error,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        lastActivity: task.last_activity_at,
        usage: task.usage,
        isAsync: task.execution?.isAsync ?? false,
        executionId: task.execution?.executionId,
        acknowledged: task.execution?.acknowledged,
        deliveryError: completion?.deliveryError,
        deliveryPhase: completion?.status,
        messages: task.messages,
      })
    }
    if (tasks.length) knownConversations.add(id)
    if (tasks.length && !isConversationDispatchBusy(id)) await getSubagentContinuation().recover(id)
  }
}

/** Explicit user retry; accepted messages retain their durable identity. */
export async function retrySubagentContinuation(conversationId: string): Promise<void> {
  await getSubagentContinuation().retry(conversationId)
}

// Async child writes remain pending for review, including paths also touched by
// the parent. A later run's pending-at-start exclusion preserves that ownership.
const childChangedPaths = new Map<string, Set<string>>()
export function recordAsyncSubagentPaths(conversationId: string, paths: readonly string[]): void {
  const owned = childChangedPaths.get(conversationId) ?? new Set<string>()
  paths.forEach((path) => owned.add(path))
  childChangedPaths.set(conversationId, owned)
  void refreshAsyncSubagentWorkspace(conversationId).catch(console.error)
}
export async function refreshAsyncSubagentWorkspace(conversationId: string): Promise<void> {
  const [{ getWorkspaceManager }, { useConversationContextStore }] = await Promise.all([
    import('@/opfs'),
    import('./conversation-context.store'),
  ])
  const workspace = await (await getWorkspaceManager()).getWorkspace(conversationId)
  if (!workspace) return
  const changes = await workspace.refreshPendingChanges()
  useConversationContextStore.setState((state) => ({
    workspaces: state.workspaces.map((item) =>
      item.id === conversationId ? { ...item, pendingCount: changes.changes.length } : item
    ),
  }))
  if (useConversationContextStore.getState().activeWorkspaceId === conversationId) {
    await useConversationContextStore.getState().refreshPendingChanges(true)
  }
}
export function hasRunningAsyncSubagents(conversationId: string): boolean {
  return Object.values(useSubagentTaskStore.getState().tasks).some(
    (task) =>
      task.conversationId === conversationId &&
      task.isAsync &&
      (task.status === 'pending' || task.status === 'running')
  )
}
export function retainPendingSubagentPaths(
  conversationId: string,
  pending: ReadonlySet<string>
): void {
  const owned = childChangedPaths.get(conversationId)
  if (owned) for (const path of owned) if (!pending.has(path)) owned.delete(path)
}
export function isAsyncSubagentPath(conversationId: string, path: string): boolean {
  return childChangedPaths.get(conversationId)?.has(path) ?? false
}
export function forgetSubagentContinuation(conversationId: string): void {
  getSubagentContinuation().stop(conversationId)
  knownConversations.delete(conversationId)
  childChangedPaths.delete(conversationId)
  useSubagentTaskStore.getState().removeConversation(conversationId)
}
