import { isCodeRunResult } from '@creatorweave/shared/code-output'
/**
 * ToolCallDisplay - renders tool call details with tool-specific views.
 *
 * Architecture:
 *   1. ask_user_question → QuestionCard (interactive)
 *   2. web_search/web_fetch bridge error → ExtensionErrorCard
 *   3. spawn_subagent/batch_spawn → SubagentRenderer (rich progress)
 *   4. Lookup registry → tool-specific Summary + Detail
 *   5. Fallback → Generic JSON card (original behavior)
 *
 * All tool renderers are imported via the side-effect import below
 * which calls registerRenderer() at module load time.
 */

import { useId, useState, memo, lazy, Suspense } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectSubagentTasks, selectSubagentTask, useSubagentTaskStore } from '@/store/subagent-task.store'
import { ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle, Loader2, Bot } from 'lucide-react'
import { parse as bestEffortParse } from 'best-effort-json-parser'
import type { ToolCall } from '@/agent/message-types'
import { CopyIconButton } from './CopyIconButton'
import { MarkdownContent } from './MarkdownContent'
import { QuestionCard } from './QuestionCard'
import type { RawOption } from './QuestionCard.utils'
import { ExtensionErrorCard } from '@/components/extension'
import { useExtensionStore } from '@/store/extension.store'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'
import { getPendingQuestion, removePendingQuestion } from '@/store/pending-question.store'
import { useT } from '@/i18n'
import { getRenderer } from './tool-renderers/registry'
import type { ToolRenderCtx } from './tool-renderers/types'

// Side-effect imports: each file calls registerRenderer() on load
import './tool-renderers/RunCodeRenderer'
import './tool-renderers/ReadImageRenderer'
import './tool-renderers/FileReadRenderer'
import './tool-renderers/FileEditRenderer'
import './tool-renderers/SearchRenderer'
import './tool-renderers/FileWriteRenderer'
import './tool-renderers/ListDirRenderer'
import './tool-renderers/SnapshotDiffRenderer'
import './tool-renderers/SnapshotStatusRenderer'
import './tool-renderers/SnapshotLogShowRenderer'
import './tool-renderers/PythonRenderer'
import './tool-renderers/WebRenderers'
import './tool-renderers/ExternalToolRenderers'
import './tool-renderers/SkillSearchRenderer'
import './tool-renderers/BashRenderer'
import './tool-renderers/ExecRenderer'
import './tool-renderers/ProcessesRenderer'
import './tool-renderers/ImageGenRenderer'
import './tool-renderers/PageScreenshotRenderer'
import './tool-renderers/ReadImageRenderer'
import './tool-renderers/SearchConversationsRenderer'

// ─── Subagent types (kept local) ──────────────────────────────

interface SubagentEvent {
  agentId: string
  status: string
  summary: string
  timestamp: number
}

// ─── Props ────────────────────────────────────────────────────

interface ToolCallDisplayProps {
  toolCall: ToolCall
  result?: string
  isExecuting?: boolean
  /** Streaming tool arguments (tool_stream mode) — overrides toolCall.function.arguments for display */
  streamingArgs?: string
  /** SubAgent progress events for spawn_subagent / batch_spawn */
  subagentEvents?: SubagentEvent[]
  /** Conversation ID — needed for ask_user_question to bridge UI answer back to executor */
  conversationId?: string
}

// ─── Subagent helpers (kept from original) ────────────────────

const SUBAGENT_TOOLS = new Set(['spawn_subagent', 'batch_spawn'])

function SubagentStatusBadge({ status }: { status: string }) {
  const t = useT()
  const color = status === 'failed' || status === 'killed' || status === 'rejected'
    ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
    : status === 'completed'
      ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-neutral-200'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs leading-4 ${color}`}>{t(`conversation.backgroundTasks.${status}`)}</span>
}

function parseSpawnResult(result: string | undefined): { content?: string; agentId?: string; status?: string; usage?: { total_tokens?: number; duration_ms?: number } } | null {
  if (!result) return null
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    const data = (parsed.data ?? parsed) as Record<string, unknown>
    return {
      content: typeof data.content === 'string' ? data.content : undefined,
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      usage: data.usage as { total_tokens?: number; duration_ms?: number } | undefined,
    }
  } catch {
    return null
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ─── Build render context from props ─────────────────────────

function buildCtx(props: ToolCallDisplayProps): ToolRenderCtx {
  const { toolCall, result, isExecuting, streamingArgs } = props
  const rawArgs = streamingArgs ?? toolCall.function.arguments
  // Use best-effort parser so streaming (partial) JSON still yields usable args
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(rawArgs) } catch {
    try { args = bestEffortParse(rawArgs) ?? {} } catch { /* give up */ }
  }

  let parsedResult: Record<string, unknown> | null = null
  if (result) {
    try { parsedResult = JSON.parse(result) as Record<string, unknown> } catch {
      // Non-JSON tool results are valid (e.g. LLM provider validation errors, plain text)
      parsedResult = null
    }
  }

  // Failure detection relies on structured envelope fields only.
  // ① v2 envelope: ok:false means failure. ② Legacy/loose payloads: a TOP-LEVEL
  // `error` key with a non-null value, or `success === false`.
  // Deliberately NOT scanning the raw string for `"error"` — that flagged
  // successful calls whose payload merely embeds arbitrary content (fetched
  // page bodies, Python stdout, run_code inner traces, subagent summaries)
  // containing the literal token, rendering red badges on success.
  const envelopeSaysError =
    parsedResult != null &&
    Object.prototype.hasOwnProperty.call(parsedResult, 'ok') &&
    parsedResult.ok === false
  const hasToolError =
    envelopeSaysError ||
    (parsedResult != null &&
      Object.prototype.hasOwnProperty.call(parsedResult, 'error') &&
      parsedResult.error != null)
  const hasExplicitFailure = parsedResult?.success === false
  const isError = toolCall.function.name === 'run_code' && isCodeRunResult(parsedResult?.data)
    ? !parsedResult.data.ok : hasToolError || hasExplicitFailure
  const isStreaming = streamingArgs !== undefined && !result

  return {
    toolName: toolCall.function.name,
    args,
    rawArgs,
    result: parsedResult,
    rawResult: result,
    isExecuting: !!isExecuting,
    isStreaming,
    isError,
  }
}

// ─── Status icon (shared) ────────────────────────────────────

function StatusIcon({ ctx, executingText }: { ctx: ToolRenderCtx; executingText?: string }) {
  if (ctx.isStreaming) return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
  if (ctx.isExecuting) return <span className="text-blue-500 text-xs">{executingText ?? 'executing...'}</span>
  if (ctx.isError) return <XCircle className="h-4 w-4 text-red-500" />
  if (ctx.rawResult) return <CheckCircle2 className="h-4 w-4 text-green-500" />
  return null
}

// ─── Main Component ──────────────────────────────────────────

export const ToolCallDisplay = memo(function ToolCallDisplay(props: ToolCallDisplayProps) {
  const t = useT()
  const { toolCall, result, subagentEvents, conversationId } = props
  const ctx = buildCtx(props)
  const toolName = toolCall.function.name
  const [expanded, setExpanded] = useState(
    toolName === 'page_screenshot' ||
    toolName === 'read_image'
  )

  // ── 1. ask_user_question → interactive QuestionCard ──
  if (toolName === 'ask_user_question') {
    let resultAnswer: string | undefined
    let resultWarning: string | undefined
    let resultConfirmed: boolean | undefined
    let resultTimedOut = false
    if (result) {
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>
        const data = parsed.data as Record<string, unknown> | undefined
        if (data && typeof data.answer === 'string') resultAnswer = data.answer
        if (data && typeof data.confirmed === 'boolean') resultConfirmed = data.confirmed
        if (data && data.timed_out === true) resultTimedOut = true
        if (typeof parsed.warning === 'string') resultWarning = parsed.warning
      } catch { /* ignore */ }
    }
    const toolCallId = toolCall.id
    const handleAnswer = conversationId
      ? (answer: string) => {
          const q = getPendingQuestion(conversationId, toolCallId)
          if (q) {
            q.resolve({ answer, confirmed: true, timed_out: false })
            removePendingQuestion(conversationId, toolCallId)
          }
        }
      : undefined
    const handleSkip = conversationId
      ? () => {
          const q = getPendingQuestion(conversationId, toolCallId)
          if (q) {
            const fallback = typeof ctx.args.default_answer === 'string' ? ctx.args.default_answer : 'skipped'
            q.resolve({ answer: fallback, confirmed: false, timed_out: false })
            removePendingQuestion(conversationId, toolCallId)
          }
        }
      : undefined

    return (
      <QuestionCard
        question={typeof ctx.args.question === 'string' ? ctx.args.question : ''}
        type={(ctx.args.type as 'yes_no' | 'single_choice' | 'multi_choice' | 'free_text') ?? 'yes_no'}
        options={Array.isArray(ctx.args.options) ? ctx.args.options as RawOption[] : undefined}
        defaultAnswer={typeof ctx.args.default_answer === 'string' ? ctx.args.default_answer : undefined}
        context={ctx.args.context as { affected_files?: string[]; preview?: string } | undefined}
        answered={!!result}
        resultAnswer={resultAnswer}
        resultWarning={resultWarning}
        resultConfirmed={resultConfirmed}
        resultTimedOut={resultTimedOut}
        onAnswer={handleAnswer}
        onSkip={handleSkip}
      />
    )
  }

  // ── 2. web bridge error → ExtensionErrorCard ──
  const isWebBridgeTool = toolName === 'web_search' || toolName === 'web_fetch'
  if (isWebBridgeTool && ctx.result && !ctx.result.ok && (ctx.result.error as { code?: string })?.code === 'BRIDGE_UNAVAILABLE') {
    // Mobile devices can't install the extension — no install prompt there.
    if (!isMobileDeviceForExtension()) {
      const openInstallGuide = useExtensionStore.getState().openInstallGuide
      return <ExtensionErrorCard onInstallClick={() => openInstallGuide()} />
    }
  }

  // ── 3. spawn_subagent / batch_spawn → rich subagent view ──
  if (SUBAGENT_TOOLS.has(toolName)) {
    return (
      <SubagentCard
        ctx={ctx}
        toolCallId={toolCall.id}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
        subagentEvents={subagentEvents}
        conversationId={conversationId}
        t={t}
      />
    )
  }

  // ── 4. Registry lookup → tool-specific renderer ──
  const renderer = getRenderer(toolName)
  if (renderer) {
    return (
      <div className="my-1.5 rounded-lg border border-neutral-200 bg-neutral-50 text-sm
        dark:border-neutral-800 dark:bg-neutral-900/50 overflow-hidden
        hover:border-neutral-300 dark:hover:border-neutral-700 transition-colors">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 px-3 py-2 text-left
            hover:bg-neutral-100/60 dark:hover:bg-neutral-800/40 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-neutral-400 shrink-0" />
          )}
          {renderer.icon ?? <Wrench className="h-3.5 w-3.5 text-neutral-500 shrink-0" />}
          <span className="flex-1 flex items-center gap-1.5 min-w-0">
            <renderer.Summary {...ctx} />
          </span>
          <span className="shrink-0">
            <StatusIcon ctx={ctx} executingText={t('toolCallDisplay.executing')} />
          </span>
        </button>
        {expanded && (
          <div className="border-t border-neutral-200 dark:border-neutral-800">
            <renderer.Detail {...ctx} />
          </div>
        )}
      </div>
    )
  }

  // ── 5. Fallback: generic JSON card (original behavior) ──
  return (
    <div className="my-1 min-w-0 overflow-hidden rounded border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:hover:bg-neutral-700"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />
        )}
        <Wrench className="h-3.5 w-3.5 text-neutral-500" />
        <code className="font-medium text-neutral-700 dark:text-foreground">{toolName}</code>
        {typeof ctx.args.path === 'string' && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{ctx.args.path as string}</span>
        )}
        <span className="ml-auto">
          <StatusIcon ctx={ctx} executingText={t('toolCallDisplay.executing')} />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{t('toolCallDisplay.arguments')}</span>
              <CopyIconButton
                content={Object.keys(ctx.args).length > 0 ? JSON.stringify(ctx.args, null, 2) : ctx.rawArgs}
              />
            </div>
            <pre className="max-h-40 overflow-auto rounded bg-white p-2 text-xs text-neutral-600 dark:bg-neutral-900 text-neutral-300 text-neutral-300 dark:text-neutral-300">
              {Object.keys(ctx.args).length > 0 ? JSON.stringify(ctx.args, null, 2) : ctx.rawArgs}
              {ctx.isStreaming && (
                <span className="inline-block h-3 w-[2px] animate-pulse bg-neutral-400 align-text-bottom" />
              )}
            </pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{t('toolCallDisplay.result')}</span>
                <CopyIconButton content={result} />
              </div>
              <pre className="max-h-60 overflow-auto rounded bg-white p-2 text-xs text-neutral-600 dark:bg-neutral-900 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                {result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Subagent card with individual execution disclosure ──────

// Lazy load SubagentDetailPanel to avoid circular dependency
// (SubagentDetailPanel imports ToolCallDisplay, which imports SubagentDetailPanel)
const SubagentDetailPanel = lazy(() =>
  import('./SubagentDetailPanel').then((m) => ({ default: m.SubagentDetailPanel }))
)

function SubagentHistoryRow({ agentId, conversationId, name, status }: { agentId: string; conversationId?: string; name?: string; status?: string }) {
  const t = useT()
  const task = useSubagentTaskStore(selectSubagentTask(agentId))
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const label = task?.name || task?.description || name || agentId
  return <div className="min-w-0">
    <button type="button" aria-expanded={expanded} aria-controls={detailId}
      aria-label={`${t('conversation.backgroundTasks.details')}: ${label}`}
      className="flex w-full min-w-0 items-center gap-2 rounded py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      onClick={() => setExpanded(!expanded)}>
      {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
      {(task?.status || status) && <SubagentStatusBadge status={task?.status || status!} />}
    </button>
    {expanded && <div id={detailId} className="min-w-0 overflow-x-hidden">
      <Suspense fallback={<div className="py-2 text-xs text-neutral-400">{t('common.loading')}</div>}>
        <SubagentDetailPanel agentId={agentId} conversationId={conversationId} />
        {task?.error && <p className="break-words py-1 text-xs text-red-600 dark:text-red-400">{task.error.message}</p>}
      </Suspense>
    </div>}
  </div>
}

function SubagentCard({
  ctx,
  toolCallId,
  expanded,
  onToggle,
  subagentEvents,
  conversationId,
  t,
}: {
  ctx: ToolRenderCtx
  toolCallId: string
  expanded: boolean
  onToggle: () => void
  subagentEvents?: SubagentEvent[]
  conversationId?: string
  t: (key: string) => string
}) {
  const spawnResult = parseSpawnResult(ctx.rawResult)
  const projected = useSubagentTaskStore(useShallow(selectSubagentTasks(conversationId ?? '')))
  const resultTasks: Array<{ agentId: string; name?: string; status?: string }> = []
  const rejected: Array<{ task_index?: number; reason: string }> = []
  let submitted = spawnResult?.status === 'pending' || spawnResult?.status === 'running'
  if (spawnResult?.agentId) resultTasks.push({ agentId: spawnResult.agentId, status: submitted ? 'submitted' : undefined })
  if (ctx.rawResult) {
    try {
      const parsed = JSON.parse(ctx.rawResult) as Record<string, unknown>
      const data = (parsed.data ?? parsed) as Record<string, unknown>
      if (Array.isArray(data.accepted)) submitted = data.accepted.length > 0
      for (const [group, status] of [[data.accepted, 'submitted'], [data.completed, 'completed'], [data.failed, 'failed']] as const) {
        if (!Array.isArray(group)) continue
        for (const item of group as Array<{ agentId?: string; name?: string; description?: string }>) {
          if (item.agentId) resultTasks.push({ agentId: item.agentId, name: item.name || item.description, status })
        }
      }
      if (Array.isArray(data.rejected)) rejected.push(...data.rejected as typeof rejected)
    } catch { /* Legacy text results have no task receipts. */ }
  }
  const agentIds = Array.from(new Set([
    ...(subagentEvents ?? []).map(event => event.agentId),
    ...resultTasks.map(task => task.agentId),
    ...projected.filter(task => task.parentToolCallId === toolCallId).map(task => task.agentId),
  ]))
  const tasks = projected.filter(task => agentIds.includes(task.agentId))
  const subagentTitle = typeof ctx.args.description === 'string' && ctx.args.description.trim()
    ? ctx.args.description
    : tasks.length === 1 ? tasks[0].description : t('conversation.backgroundTasks.label')
  const status = tasks.some(task => task.status === 'running') ? 'running'
    : tasks.some(task => task.status === 'pending') ? 'pending'
    : tasks.some(task => task.status === 'failed' || task.status === 'killed') ? 'failed'
    : tasks.length > 0 && tasks.length === agentIds.length ? 'completed'
    : submitted ? 'submitted'
    : rejected.length > 0 ? 'rejected'
    : resultTasks.some(task => task.status === 'failed') ? 'failed' : undefined
  const detailsId = useId()

  return (
    <div className="my-1 min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:hover:bg-neutral-700"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />
        )}
        <Bot className="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-neutral-700 dark:text-foreground" title={subagentTitle}>{subagentTitle}</span>
        <span className="ml-auto shrink-0">
          {status ? <SubagentStatusBadge status={status} /> : <StatusIcon ctx={ctx} executingText={t('toolCallDisplay.executing')} />}
        </span>
      </button>

      {expanded && (
        <div id={detailsId} className="min-w-0 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
          {agentIds.map(agentId => <SubagentHistoryRow key={agentId} agentId={agentId} conversationId={conversationId}
            name={resultTasks.find(task => task.agentId === agentId)?.name} status={resultTasks.find(task => task.agentId === agentId)?.status} />)}
          {rejected.map((item, index) => <p key={item.task_index ?? index} className="break-words py-1 text-xs text-red-600 dark:text-red-400">
            {t('conversation.backgroundTasks.rejected')}: {item.reason}
          </p>)}
        </div>
      )}

      {expanded && spawnResult?.content && !ctx.isExecuting && (
        <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <div className="rounded bg-white p-2 text-xs text-neutral-700 dark:bg-neutral-900 text-neutral-300 text-neutral-300 dark:text-neutral-300">
            <div className="prose-sm max-w-none break-words">
              <MarkdownContent content={spawnResult.content} />
            </div>
          </div>
          {spawnResult.usage && (
            <div className="mt-1 flex gap-3 text-[10px] text-neutral-400">
              {spawnResult.usage.total_tokens != null && (
                <span>{spawnResult.usage.total_tokens} tokens</span>
              )}
              {spawnResult.usage.duration_ms != null && (
                <span>{formatDuration(spawnResult.usage.duration_ms)}</span>
              )}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{t('toolCallDisplay.arguments')}</span>
              <CopyIconButton
                content={Object.keys(ctx.args).length > 0 ? JSON.stringify(ctx.args, null, 2) : ctx.rawArgs}
              />
            </div>
            <pre className="max-h-40 overflow-auto rounded bg-white p-2 text-xs text-neutral-600 dark:bg-neutral-900 text-neutral-300 text-neutral-300 dark:text-neutral-300">
              {Object.keys(ctx.args).length > 0 ? JSON.stringify(ctx.args, null, 2) : ctx.rawArgs}
              {ctx.isStreaming && (
                <span className="inline-block h-3 w-[2px] animate-pulse bg-neutral-400 align-text-bottom" />
              )}
            </pre>
          </div>
          {ctx.rawResult && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{t('toolCallDisplay.result')}</span>
                <CopyIconButton content={ctx.rawResult} />
              </div>
              <pre className="max-h-60 overflow-auto rounded bg-white p-2 text-xs text-neutral-600 dark:bg-neutral-900 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                {ctx.rawResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
