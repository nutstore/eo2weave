import { isCodeRunResult } from '@creatorweave/shared/code-output'
import { Code2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useT } from '@/i18n'
import { selectSubagentTasks, useSubagentTaskStore } from '@/store/subagent-task.store'
import { ImageOutputView } from './ImageOutputView'
import { ScriptBlock, ValueView } from '../script-view'
import { SubagentHistoryRow, SubagentStatusBadge } from '../subagent-card-parts'
import { registerRenderer } from './registry'
import { createWorkflowStore } from '@/agent/workflow/sqlite-store'
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
  startedAt?: number
  finishedAt?: number
}

interface RunCodeMeta {
  calls?: CodeToolTrace[]
  replay?: string | null
  steps?: AgentStep[]
}

/** The slice of render context the step views need. */
interface StepsCtx {
  toolCallId?: string
  conversationId?: string
  args: Record<string, unknown>
  result: Record<string, unknown> | null
}

/**
 * Steps for one card, in order of authority:
 *   1. the run's own result meta (present while the turn is live),
 *   2. the replay rows on disk, keyed by `conversation:replay` — the only source
 *      that survives a reload, because meta is stripped from the stored result.
 *      The replay key survives in the tool-call args, so it is the stable handle.
 * Without (2) a reopened conversation silently loses its step list and graph.
 */
function useRunSteps(ctx: StepsCtx): AgentStep[] {
  const meta = ctx.result?.meta as RunCodeMeta | undefined
  const inline = meta?.steps ?? []
  const replay = meta?.replay ?? (typeof ctx.args.replay === 'string' ? ctx.args.replay : undefined)
  const runId = replay && ctx.conversationId ? `${ctx.conversationId}:${replay}` : undefined
  const [persisted, setPersisted] = useState<AgentStep[]>([])
  useEffect(() => {
    if (inline.length > 0 || !runId) return
    let cancelled = false
    void createWorkflowStore()
      .listSteps(runId)
      .then((records) => {
        if (cancelled) return
        setPersisted(records.map((record) => ({
          index: record.stepIndex,
          status: record.status,
          agentId: record.agentId ?? undefined,
          name: record.name ?? undefined,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        })))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [runId, inline.length])
  return inline.length > 0 ? inline : persisted
}

function AgentSteps({ ctx }: { ctx: StepsCtx }) {
  const t = useT()
  const steps = useRunSteps(ctx)
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
/**
 * Steps that overlap in time ran in parallel; a step starting after the previous
 * layer finished starts a new one. Timing is the only structure a script leaves
 * behind, so this is an inference — not the DAG the script actually had — and the
 * UI says so instead of pretending to know the edges.
 */
function stepLayers(steps: AgentStep[]): AgentStep[][] {
  const ordered = [...steps].sort((a, b) => (a.startedAt ?? a.index) - (b.startedAt ?? b.index))
  const layers: AgentStep[][] = []
  let layerEndsAt = Number.NEGATIVE_INFINITY
  for (const step of ordered) {
    const startedAt = step.startedAt
    const finishedAt = step.finishedAt ?? startedAt
    if (startedAt === undefined || layers.length === 0 || startedAt >= layerEndsAt) {
      layers.push([step])
      if (finishedAt !== undefined) layerEndsAt = finishedAt
    } else {
      layers[layers.length - 1].push(step)
      if (finishedAt !== undefined) layerEndsAt = Math.max(layerEndsAt, finishedAt)
    }
  }
  // Stable reading order inside a layer: start time first, then step order.
  for (const layer of layers) layer.sort((a, b) => a.index - b.index)
  return layers
}

function statusDotClass(status: string): string {
  if (status === 'failed' || status === 'killed' || status === 'rejected') return 'bg-red-500'
  if (status === 'cached') return 'bg-primary-300'
  if (status === 'completed') return 'bg-primary-500'
  return 'bg-neutral-400'
}

/** Read-only picture of one run: which agents ran side by side, in what order. */
function StepGraph({ ctx }: { ctx: StepsCtx }) {
  const t = useT()
  const steps = useRunSteps(ctx)
  const live = useSubagentTaskStore(useShallow(selectSubagentTasks(ctx.conversationId ?? '')))
    .filter((task) => !!ctx.toolCallId && task.parentToolCallId === ctx.toolCallId)
    .sort((a, b) => a.createdAt - b.createdAt)
  // Live projections carry creation time only, so an in-flight run reads as
  // "all started, none finished" until the tool result lands with real timing.
  const nodes: AgentStep[] = steps.length > 0
    ? steps
    : live.map((task, index) => ({
        index,
        status: task.status,
        name: task.name || task.description,
        startedAt: task.createdAt,
      }))
  const layers = stepLayers(nodes)
  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
        {layers.map((layer, layerIndex) => (
          <div key={layerIndex} className="flex items-stretch gap-1">
            {layerIndex > 0 && (
              <span aria-hidden className="flex items-center text-xs text-neutral-300 dark:text-neutral-600">→</span>
            )}
            <div className="flex flex-col justify-center gap-1 rounded border border-dashed border-neutral-200 px-1 py-1 dark:border-neutral-700">
              {layer.map((step) => {
                const label = step.name || t('toolCallDisplay.workflowStepFallback', { index: step.index + 1 })
                return (
                  <span
                    key={step.index}
                    title={`${label} · ${t(`conversation.backgroundTasks.${step.status}`)}`}
                    className="flex max-w-[9rem] items-center gap-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] leading-4 dark:bg-neutral-800"
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(step.status)}`} />
                    <span className="truncate">{label}</span>
                  </span>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-neutral-400">{t('toolCallDisplay.workflowGraphHint')}</div>
    </div>
  )
}

/** Step list with an optional read-only graph view of the same run. */
function StepsSection({ ctx }: { ctx: StepsCtx }) {
  const t = useT()
  const steps = useRunSteps(ctx)
  const live = useSubagentTaskStore(useShallow(selectSubagentTasks(ctx.conversationId ?? '')))
    .filter((task) => !!ctx.toolCallId && task.parentToolCallId === ctx.toolCallId)
  const [view, setView] = useState<'list' | 'graph'>('list')
  if (live.length === 0 && steps.length === 0) return null
  // Without timing every step would become its own layer, drawing a serial
  // pipeline the script never had. No timing, no graph.
  const canGraph = steps.length + live.length > 1 && (live.length > 0 || steps.some((step) => step.startedAt !== undefined))
  if (!canGraph) return <AgentSteps ctx={ctx} />
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        {(['list', 'graph'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => setView(option)}
            className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${view === option
              ? 'bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'}`}
          >
            {t(option === 'list' ? 'toolCallDisplay.workflowListTab' : 'toolCallDisplay.workflowGraphTab')}
          </button>
        ))}
      </div>
      {view === 'graph' ? <StepGraph ctx={ctx} /> : <AgentSteps ctx={ctx} />}
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
        <StepsSection ctx={ctx} />
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
