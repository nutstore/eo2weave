'use client'

import { Suspense, useId, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useT } from '@/i18n'
import { selectSubagentTask, useSubagentTaskStore } from '@/store/subagent-task.store'
import { SubagentDetailPanel } from './SubagentDetailPanel'
import { MAX_SUBAGENT_DEPTH } from './subagent-depth'

/**
 * Shared subagent presentation pieces.
 *
 * Kept out of ToolCallDisplay so any orchestration card (spawn_subagent,
 * run_workflow, ...) renders children with the exact same row, badge and
 * drill-down behaviour instead of inventing its own.
 */

export function SubagentStatusBadge({ status }: { status: string }) {
  const t = useT()
  const color = status === 'failed' || status === 'killed' || status === 'rejected'
    ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
    : status === 'completed' || status === 'cached'
      ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-neutral-200'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs leading-4 ${color}`}>{t(`conversation.backgroundTasks.${status}`)}</span>
}

/** One child agent: name + live status badge, expanding into its transcript. */
export function SubagentHistoryRow({ agentId, conversationId, name, status, depth = 0 }: { agentId: string; conversationId?: string; name?: string; status?: string; depth?: number }) {
  const t = useT()
  const task = useSubagentTaskStore(selectSubagentTask(agentId))
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const label = task?.name || task?.description || name || agentId
  // Caller-supplied status wins: a replay step says `cached` even though the
  // agent it points at finished long ago as `completed`.
  const badgeStatus = status || task?.status
  return <div className="min-w-0">
    <button type="button" aria-expanded={expanded} aria-controls={detailId}
      aria-label={`${t('conversation.backgroundTasks.details')}: ${label}`}
      className="flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {badgeStatus && <SubagentStatusBadge status={badgeStatus} />}
    </button>
    {expanded && <div id={detailId} className="min-w-0 overflow-x-hidden">
      {depth + 1 > MAX_SUBAGENT_DEPTH
        // Refuse before mounting the panel: mounting it would fetch another
        // transcript for a level we are not going to show anyway.
        ? <p className="px-3 py-2 text-xs text-neutral-400">{t('conversation.backgroundTasks.nestedLimit')}</p>
        : <Suspense fallback={<div className="py-2 text-xs text-neutral-400">{t('common.loading')}</div>}>
            <SubagentDetailPanel agentId={agentId} conversationId={conversationId} depth={depth + 1} />
            {task?.error && <p className="break-words py-1 text-xs text-red-600 dark:text-red-400">{task.error.message}</p>}
          </Suspense>}
    </div>}
  </div>
}
