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

import { useState, memo, lazy, Suspense } from 'react'
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
  const base = 'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium'
  switch (status) {
    case 'running':
      return <span className={`${base} bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300`}>running</span>
    case 'completed':
      return <span className={`${base} bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300`}>completed</span>
    case 'failed':
      return <span className={`${base} bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300`}>failed</span>
    case 'killed':
      return <span className={`${base} bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300`}>killed</span>
    default:
      return <span className={`${base} bg-neutral-100 text-neutral-600 dark:bg-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300`}>{status}</span>
  }
}

function SubagentProgressSection({ events }: { events: SubagentEvent[] }) {
  if (events.length === 0) return null
  const latestByAgent = new Map<string, SubagentEvent>()
  for (const ev of events) {
    latestByAgent.set(ev.agentId, ev)
  }
  const uniqueEvents = Array.from(latestByAgent.values())
  return (
    <div className="mb-2 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-600 dark:bg-neutral-850">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
        <Bot className="h-3 w-3" />
        <span>SubAgent</span>
      </div>
      <div className="space-y-1">
        {uniqueEvents.map((ev) => (
          <div key={ev.agentId} className="flex items-center gap-2 text-xs">
            <SubagentStatusBadge status={ev.status} />
            {ev.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
            <span className="truncate text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">{ev.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function extractSubagentDescription(parsedArgs: Record<string, unknown>): string | undefined {
  return typeof parsedArgs.description === 'string' ? parsedArgs.description : undefined
}

function getSubagentTitle(toolName: string, parsedArgs: Record<string, unknown>): string {
  if (toolName === 'batch_spawn') return 'Subagents'

  switch (parsedArgs.subagent_type) {
    case 'explorer':
      return 'Explorer'
    case 'worker':
      return 'Worker'
    case 'awaiter':
      return 'Awaiter'
    default:
      return 'Subagent'
  }
}

function parseSpawnResult(result: string | undefined): { content?: string; agentId?: string; usage?: { total_tokens?: number; duration_ms?: number } } | null {
  if (!result) return null
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    const data = (parsed.data ?? parsed) as Record<string, unknown>
    return {
      content: typeof data.content === 'string' ? data.content : undefined,
      agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
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

  const hasToolError = parsedResult && Object.prototype.hasOwnProperty.call(parsedResult, 'error')
    ? true
    : result ? result.includes('"error"') : false
  const hasExplicitFailure = parsedResult?.success === false
  const isError = hasToolError || hasExplicitFailure
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
  // Auto-expand spawn_subagent / batch_spawn while executing so users can
  // see the live subagent step details without manual interaction.
  // Also keep expanded after a cancel-induced synthetic [Interrupted] result
  // because the subagent may still be running in the background.
  const isSubagentTool = toolCall.function.name === 'spawn_subagent' || toolCall.function.name === 'batch_spawn'
  const isInterruptedResult = (() => {
    if (!result) return false
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>
      const data = (parsed.data ?? parsed) as Record<string, unknown>
      return data?.interrupted === true
    } catch { return false }
  })()

  const ctx = buildCtx(props)
  const toolName = toolCall.function.name
  const [expanded, setExpanded] = useState(
    (isSubagentTool && (!result || isInterruptedResult)) ||
    toolName === 'page_screenshot'
  )

  // ── 1. ask_user_question → interactive QuestionCard ──
  if (toolName === 'ask_user_question') {
    let resultAnswer: string | undefined
    let resultWarning: string | undefined
    if (result) {
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>
        const data = parsed.data as Record<string, unknown> | undefined
        if (data && typeof data.answer === 'string') resultAnswer = data.answer
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
        onAnswer={handleAnswer}
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
    <div className="my-1 rounded border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
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

// ─── Subagent card (extracted from original, unchanged logic) ──

// Lazy load SubagentDetailPanel to avoid circular dependency
// (SubagentDetailPanel imports ToolCallDisplay, which imports SubagentDetailPanel)
const SubagentDetailPanel = lazy(() =>
  import('./SubagentDetailPanel').then((m) => ({ default: m.SubagentDetailPanel }))
)

function SubagentCard({
  ctx,
  expanded,
  onToggle,
  subagentEvents,
  conversationId,
  t,
}: {
  ctx: ToolRenderCtx
  expanded: boolean
  onToggle: () => void
  subagentEvents?: SubagentEvent[]
  conversationId?: string
  t: (key: string) => string
}) {
  const subagentDesc = extractSubagentDescription(ctx.args)
  const subagentTitle = getSubagentTitle(ctx.toolName, ctx.args)
  const spawnResult = parseSpawnResult(ctx.rawResult)

  return (
    <div className="my-1 rounded border border-neutral-200 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-800">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-700"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-neutral-400" />
        )}
        <Bot className="h-3.5 w-3.5 text-violet-500" />
        <span className="font-medium text-neutral-700 dark:text-foreground">{subagentTitle}</span>
        {subagentDesc && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">&quot;{subagentDesc}&quot;</span>
        )}
        <span className="ml-auto">
          <StatusIcon ctx={ctx} executingText={t('toolCallDisplay.executing')} />
        </span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
          {subagentEvents && subagentEvents.length > 0 ? (
            <SubagentProgressSection events={subagentEvents} />
          ) : (
            /* When subagentEvents is missing (committed message after cancel),
               show an interrupted status badge if the result indicates interruption. */
            ctx.isError && spawnResult?.agentId && (
              <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
                <SubagentStatusBadge status="killed" />
                <span className="text-neutral-400">已中断（用户取消运行）</span>
              </div>
            )
          )}
          {/* Render detailed step panels for each subagent.
              During the run, agentIds come from subagentEvents (live status updates).
              After the run completes, subagentEvents is gone (draftAssistant cleared),
              so we fall back to parsing agentIds from the committed tool result. */}
          {(() => {
            const liveAgentIds = subagentEvents
              ? Array.from(new Set(subagentEvents.map((e) => e.agentId)))
              : []
            // Fallback: extract agentId(s) from the spawn result JSON.
            // spawn_subagent → { agentId: "..." }
            // batch_spawn   → { completed: [{ agentId: "..." }, ...] }
            const resultAgentIds: string[] = []
            if (spawnResult?.agentId) {
              resultAgentIds.push(spawnResult.agentId)
            }
            // Also check for batch_spawn completed array
            if (ctx.rawResult) {
              try {
                const parsed = JSON.parse(ctx.rawResult) as Record<string, unknown>
                const data = (parsed.data ?? parsed) as Record<string, unknown>
                for (const batchResult of [data.completed, data.failed]) {
                  if (Array.isArray(batchResult)) {
                    for (const item of batchResult) {
                      const aid = (item as Record<string, unknown>)?.agentId
                      if (typeof aid === 'string') resultAgentIds.push(aid)
                    }
                  }
                }
              } catch { /* non-JSON result, skip */ }
            }
            const allAgentIds = Array.from(new Set([...liveAgentIds, ...resultAgentIds]))
            if (allAgentIds.length === 0) return null
            return allAgentIds.map((agentId) => (
              <Suspense key={agentId} fallback={<div className="py-2 text-xs text-neutral-400">Loading...</div>}>
                <SubagentDetailPanel agentId={agentId} conversationId={conversationId} />
              </Suspense>
            ))
          })()}
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
