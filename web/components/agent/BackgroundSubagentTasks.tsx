import { memo, useEffect, useId, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Square } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useT } from '@/i18n'
import { peekSubagentRuntime } from '@/agent/subagent/runtime'
import { getSubagentRepository } from '@/sqlite/repositories/subagent.repository'
import { retrySubagentContinuation } from '@/store/subagent-continuation'
import {
  isBackgroundSubagentVisible,
  isSubagentActive,
  selectSubagentTasks,
  useSubagentTaskStore,
  type SubagentTaskProjection,
} from '@/store/subagent-task.store'
import { SubagentDetailPanel } from './SubagentDetailPanel'

const buttonClass = 'shrink-0 rounded px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800'

function TaskRow({ task, now, onAction }: {
  task: SubagentTaskProjection
  now: number
  onAction: (action: () => Promise<unknown>) => Promise<void>
}) {
  const t = useT()
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const detailId = useId()
  const active = isSubagentActive(task)
  const failed = task.status === 'failed' || task.status === 'killed'
  const deliveryBlocked = task.deliveryPhase === 'blocked' || task.deliveryPhase === 'error'
  const name = task.name || task.description
  const lastTool = task.messages.flatMap(message => message.toolCalls ?? []).at(-1)?.function.name
  const activity = task.recentActivity === 'tool_call'
    ? t('conversation.backgroundTasks.activityTool', { tool: lastTool ?? '' })
    : task.recentActivity === 'reasoning' ? t('conversation.backgroundTasks.activityReasoning')
    : task.recentActivity === 'content' ? t('conversation.backgroundTasks.activityContent')
    : task.recentActivity === 'compression' ? t('conversation.backgroundTasks.activityCompression')
    : task.recentActivity
  const elapsed = Math.max(0, Math.floor(((active ? now : task.updatedAt) - task.createdAt) / 1000))
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    await onAction(action)
    setBusy(false)
  }
  const acknowledge = async () => {
    if (!task.executionId) return
    const runtime = peekSubagentRuntime(task.conversationId)
    if (runtime) await runtime.acknowledge({ agentId: task.agentId, executionId: task.executionId })
    else await getSubagentRepository().acknowledge(task.conversationId, task.agentId, task.executionId)
    useSubagentTaskStore.getState().acknowledge(task.agentId, task.executionId)
  }
  return (
    <li className="min-w-0 border-t border-neutral-100 py-2 dark:border-neutral-800">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>{name}</span>
        <span className={`shrink-0 text-[11px] ${failed ? 'text-red-600 dark:text-red-400' : 'text-neutral-500 dark:text-neutral-400'}`}>
          {t(`conversation.backgroundTasks.${task.status}`)}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">{t('conversation.backgroundTasks.elapsed', { seconds: elapsed })}</span>
        {active && (
          <button type="button" className={buttonClass} disabled={busy}
            aria-label={`${t('conversation.backgroundTasks.stop')}: ${name}`}
            onClick={() => void run(async () => {
              const runtime = peekSubagentRuntime(task.conversationId)
              if (!runtime) throw new Error(t('conversation.backgroundTasks.unavailable'))
              await runtime.stop({ agentId: task.agentId, force: true })
            })}>
            <Square className="inline h-2.5 w-2.5" aria-hidden="true" /> {t('conversation.backgroundTasks.stop')}
          </button>
        )}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
        {activity && <span className="min-w-0 flex-1 truncate" title={activity}>{activity}</span>}
        {!active && task.deliveryPhase && (
          <span>{t(`conversation.backgroundTasks.${task.deliveryPhase === 'pending' ? 'deliveryPending' : task.deliveryPhase}`)}</span>
        )}
        <button type="button" className={buttonClass} aria-expanded={details} aria-controls={detailId}
          aria-label={`${t('conversation.backgroundTasks.details')}: ${name}`} onClick={() => setDetails(!details)}>
          {t('conversation.backgroundTasks.details')}
        </button>
        {deliveryBlocked && <button type="button" className={buttonClass} disabled={busy}
          onClick={() => void run(() => retrySubagentContinuation(task.conversationId))}>{t('conversation.backgroundTasks.retry')}</button>}
        {!active && (failed || deliveryBlocked) && task.executionId && (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(acknowledge)}>{t('conversation.backgroundTasks.acknowledge')}</button>
        )}
      </div>
      {task.error && <p className="mt-1 break-words text-xs text-red-600 dark:text-red-400">{task.error.message}</p>}
      {deliveryBlocked && task.deliveryError && <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-400">{task.deliveryError}</p>}
      {details && <div id={detailId} className="mt-1 min-w-0 overflow-x-hidden"><SubagentDetailPanel agentId={task.agentId} conversationId={task.conversationId} /></div>}
    </li>
  )
}

/** Background work has its own lifecycle; it never controls the composer or main-agent stop button. */
export const BackgroundSubagentTasks = memo(function BackgroundSubagentTasks({ conversationId }: { conversationId?: string | null }) {
  const t = useT()
  const tasks = useSubagentTaskStore(useShallow(selectSubagentTasks(conversationId ?? '')))
    .filter(isBackgroundSubagentVisible)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const listId = useId()
  const running = tasks.filter(task => task.status === 'running').length
  const queued = tasks.filter(task => task.status === 'pending').length
  const hasActive = running + queued > 0
  useEffect(() => {
    if (!expanded || !hasActive) return
    let timer: ReturnType<typeof setInterval> | undefined
    const updateVisibility = () => {
      if (timer) clearInterval(timer)
      timer = undefined
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    updateVisibility()
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      if (timer) clearInterval(timer)
      document.removeEventListener('visibilitychange', updateVisibility)
    }
  }, [expanded, hasActive])
  const onAction = async (action: () => Promise<unknown>) => {
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  if (!tasks.length) return null
  return (
    <section className="mb-2 min-w-0 rounded-lg border border-neutral-200 px-2 text-neutral-700 dark:border-neutral-700 dark:text-neutral-200" aria-label={t('conversation.backgroundTasks.label')}>
      <div className="flex min-w-0 flex-wrap items-center gap-1 py-1">
        <button type="button" aria-expanded={expanded} aria-controls={listId}
          className={`${buttonClass} flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left`}
          aria-label={t('conversation.backgroundTasks.summary', { count: tasks.length })}
          onClick={() => setExpanded(!expanded)}>
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <span>{t('conversation.backgroundTasks.summary', { count: tasks.length })}</span>
          {running > 0 && <span className="text-neutral-500 dark:text-neutral-400">{t('conversation.backgroundTasks.runningCount', { count: running })}</span>}
          {queued > 0 && <span className="text-neutral-500 dark:text-neutral-400">{t('conversation.backgroundTasks.queuedCount', { count: queued })}</span>}
        </button>
        {hasActive && <button type="button" className={buttonClass} disabled={busy}
          onClick={() => {
            setBusy(true)
            void onAction(async () => {
              const runtime = conversationId ? peekSubagentRuntime(conversationId) : undefined
              if (!runtime) throw new Error(t('conversation.backgroundTasks.unavailable'))
              await runtime.stopAll({ force: true, backgroundOnly: true })
            }).finally(() => setBusy(false))
          }}>{t('conversation.backgroundTasks.stopAll')}</button>}
      </div>
      {error && <p role="alert" className="pb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {expanded && <ul id={listId} className="max-h-[min(40vh,20rem)] min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain">
        {tasks.map(task => <TaskRow key={`${task.agentId}:${task.executionId}`} task={task} now={now} onAction={onAction} />)}
      </ul>}
    </section>
  )
})
