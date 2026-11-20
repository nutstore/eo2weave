import { isCodeRunResult } from '@creatorweave/shared/code-output'
import { Code2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useT } from '@/i18n'
import { selectSubagentTasks, useSubagentTaskStore } from '@/store/subagent-task.store'
import { ImageOutputView } from './ImageOutputView'
import { ScriptBlock, ValueView } from '../script-view'
import { SubagentHistoryRow, SubagentStatusBadge } from '../subagent-card-parts'
import { registerRenderer } from './registry'
import type { CodeToolTrace } from '@/agent/tools/run-code.tool'

/**
 * Tool card for run_code.
 *
 * Summary is the purpose (what this execution is for). Detail keeps three
 * layers readable that used to collapse into one JSON blob:
 *   1. the script itself, highlighted;
 *   2. subagent steps — live when agent() is running, persisted trace after
 *      (cached steps never spawn, so only the trace carries them);
 *   3. the script's return value plus the tool-call trace.
 */

interface AgentStep {
  index: number
  status: string
  agentId?: string
  name?: string
  error?: string
}

interface RunCodeMeta {
  calls?: CodeToolTrace[]
  replay?: string | null
  steps?: AgentStep[]
}

function AgentSteps({ ctx }: { ctx: { toolCallId?: string; conversationId?: string; result: Record<string, unknown> | null } }) {
  const t = useT()
  const meta = ctx.result?.meta as RunCodeMeta | undefined
  const steps = meta?.steps ?? []
  const live = useSubagentTaskStore(useShallow(selectSubagentTasks(ctx.conversationId ?? '')))
    .filter((task) => !!ctx.toolCallId && task.parentToolCallId === ctx.toolCallId)
    .sort((a, b) => a.createdAt - b.createdAt)

  if (live.length === 0 && steps.length === 0) return null
  return (
    <div className="space-y-0.5">
      {live.length > 0
        ? live.map((task) => (
            <SubagentHistoryRow
              key={task.agentId}
              agentId={task.agentId}
              conversationId={ctx.conversationId}
              name={task.name || task.description}
              status={task.status}
            />
          ))
        : steps.map((step) => (
            step.agentId
              ? <SubagentHistoryRow
                  key={step.index}
                  agentId={step.agentId}
                  conversationId={ctx.conversationId}
                  name={step.name || t('toolCallDisplay.workflowStepFallback', { index: step.index + 1 })}
                  status={step.status}
                />
              : <div key={step.index} className="flex min-w-0 items-center gap-2 py-1 text-xs">
                  <span className="shrink-0 text-neutral-400">#{step.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate" title={step.name}>{step.name || t('toolCallDisplay.workflowStepFallback', { index: step.index + 1 })}</span>
                  {step.error && <span className="min-w-0 max-w-[45%] truncate text-red-600 dark:text-red-400">{step.error}</span>}
                  <SubagentStatusBadge status={step.status} />
                </div>
          ))}
    </div>
  )
}

registerRenderer({
  name: 'run_code',
  icon: <Code2 className="h-3.5 w-3.5" />,
  Summary(ctx) {
    const meta = ctx.result?.meta as RunCodeMeta | undefined
    const steps = meta?.steps ?? []
    const cached = steps.filter((step) => step.status === 'cached').length
    const failed = steps.filter((step) => step.status === 'failed').length
    const extra = steps.length > 0
      ? ` · ${steps.length} agent${cached > 0 ? ` (${cached} cached)` : ''}${failed > 0 ? ` · ${failed} failed` : ''}`
      : ''
    return (
      <span className="truncate">
        {String(ctx.args.purpose || 'run_code')}
        {extra && <span className="ml-1.5 text-muted-foreground">{extra}</span>}
      </span>
    )
  },
  // Collapsed cards keep the step agents visible AND expandable: digging into
  // one child's transcript must not require opening the whole run first.
  Aside(ctx) {
    return <AgentSteps ctx={ctx} />
  },
  Detail(ctx) {
    const t = useT()
    const meta = ctx.result?.meta as RunCodeMeta | undefined
    const execution = isCodeRunResult(ctx.result?.data) ? ctx.result.data : undefined
    const code = String(ctx.args.code || '')
    return (
      <div className="space-y-2 px-3 py-2">
        {code && <ScriptBlock code={code} />}
        <AgentSteps ctx={ctx} />
        {execution?.output.map((part, index) => part.type === 'image'
          ? <ImageOutputView key={index} image={part} alt={String(ctx.args.purpose || 'run_code')} />
          : <pre key={index} className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{part.text}</pre>)}
        {execution && !execution.ok && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-red-600 dark:text-red-400">
            {execution.error.code}: {execution.error.message}
          </pre>
        )}
        {execution?.ok && execution.value !== undefined && (
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              {t('toolCallDisplay.workflowResult')}
            </div>
            <div className="rounded bg-white p-2 text-xs dark:bg-neutral-900">
              <ValueView value={execution.value} />
            </div>
          </div>
        )}
        {meta?.calls?.map((call) => (
          <details key={call.id}>
            <summary className="cursor-pointer text-xs">{call.name} · {call.status}</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(call.args, null, 2)}{'\n'}{call.result}</pre>
          </details>
        ))}
        {meta?.replay && (
          <div className="text-[11px] text-neutral-400">{t('toolCallDisplay.workflowReplay')}: {meta.replay}</div>
        )}
      </div>
    )
  },
})
