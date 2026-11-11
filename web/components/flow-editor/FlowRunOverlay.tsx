/**
 * FlowRunOverlay — shows real-time execution progress on the canvas.
 *
 * Highlights nodes as they run, shows output/error status.
 * Sits as an overlay on top of the FlowEditor.
 */

import { useState, useCallback, useEffect } from 'react'
import { Loader2, CheckCircle2, XCircle, X, Brain, Wrench, ArrowRight, ChevronDown } from 'lucide-react'
import { cn } from '@creatorweave/ui'
import { runFlow } from '@/agent/flow/engine'
import { useSettingsStore } from '@/store/settings.store'
import type { FlowInstance, FlowNodeRunResult, FlowRunResult, FlowNodeTraceStep } from '@/agent/flow/types'
import type { ToolContext } from '@/agent/tools/tool-types'
import {
  useFlowStore,
  getActiveRunAbortController,
  setActiveRunAbortController,
} from '@/store/flow.store'

export interface FlowRunHandle {
  result: FlowRunResult | null
  isRunning: boolean
  run: () => Promise<void>
  runWithConfig: (config: {
    flow: FlowInstance
    context: ToolContext
    llm: { apiKey: string; providerType: string; baseUrl: string; model: string; apiMode?: 'chat-completions' | 'responses' }
    userInput?: string
  }) => Promise<void>
  cancel: () => void
  reset: () => void
}

interface UseFlowRunOptions {
  flow: FlowInstance | null
  context: ToolContext | null
  llm: {
    apiKey: string
    providerType: string
    baseUrl: string
    model: string
    apiMode?: 'chat-completions' | 'responses'
  } | null
  /** Callback when node status changes (for highlighting canvas nodes) */
  onNodeStatusChange?: (statuses: Record<string, 'pending' | 'running' | 'completed' | 'failed'>) => void
}

/** Hook to run a flow and track progress.
 *
 * Run state (isRunning, result, nodeStatuses) is stored in the Zustand
 * flow store so it survives component unmount — closing and reopening the
 * canvas panel keeps the run alive and shows its progress. */
export function useFlowRun(options: UseFlowRunOptions): FlowRunHandle {
  // Read run state from the store (survives unmount)
  const result = useFlowStore((s) => s.runResult)
  const isRunning = useFlowStore((s) => s.isRunning)
  const nodeStatuses = useFlowStore((s) => s.nodeStatuses)
  const setRunState = useFlowStore((s) => s.setRunState)
  const resetRun = useFlowStore((s) => s.resetRun)

  // Propagate status changes to parent (for canvas highlighting)
  useEffect(() => {
    options.onNodeStatusChange?.(nodeStatuses)
  }, [nodeStatuses])

  // Core execution — shared by run() and runWithConfig()
  const execute = useCallback(
    async (
      flow: FlowInstance,
      context: ToolContext,
      llm: NonNullable<UseFlowRunOptions['llm']>,
      userInput?: string
    ) => {
      const abortController = new AbortController()
      setActiveRunAbortController(abortController)
      setRunState({ isRunning: true, runResult: null, nodeStatuses: {}, nodeResults: [] })

      const runResult = await runFlow({
        flow,
        context,
        llm,
        userInput,
        abortSignal: abortController.signal,
        compressionAbsoluteCapEnabled: useSettingsStore.getState().compressionAbsoluteCapEnabled,
        compressionAbsoluteCap: useSettingsStore.getState().compressionAbsoluteCap,
        onNodeStart: (nodeId) => {
          useFlowStore.getState().setRunState({
            nodeStatuses: { ...useFlowStore.getState().nodeStatuses, [nodeId]: 'running' },
          })
        },
        onNodeComplete: (nodeId) => {
          useFlowStore.getState().setRunState({
            nodeStatuses: { ...useFlowStore.getState().nodeStatuses, [nodeId]: 'completed' },
          })
        },
        onNodeError: (nodeId) => {
          useFlowStore.getState().setRunState({
            nodeStatuses: { ...useFlowStore.getState().nodeStatuses, [nodeId]: 'failed' },
          })
        },
        onNodeResult: (result) => {
          // Push each node's result (with trace) to the store immediately —
          // so the UI shows trace as soon as a node finishes, not after the whole flow.
          useFlowStore.getState().upsertNodeResult(result)
        },
      })

      setRunState({ isRunning: false, runResult })
      setActiveRunAbortController(null)
    },
    [setRunState]
  )

  const run = useCallback(async () => {
    if (!options.flow || !options.context || !options.llm || isRunning) return
    await execute(options.flow, options.context, options.llm)
  }, [options.flow, options.context, options.llm, isRunning, execute])

  const runWithConfig = useCallback(
    async (config: {
      flow: FlowInstance
      context: ToolContext
      llm: NonNullable<UseFlowRunOptions['llm']>
      userInput?: string
    }) => {
      if (isRunning) return
      await execute(config.flow, config.context, config.llm, config.userInput)
    },
    [isRunning, execute]
  )

  const cancel = useCallback(() => {
    getActiveRunAbortController()?.abort()
    setActiveRunAbortController(null)
    setRunState({ isRunning: false, nodeStatuses: {} })
  }, [setRunState])

  return { result, isRunning, run, runWithConfig, cancel, reset: resetRun }
}

// ---------------------------------------------------------------------------
// Run result panel (shown after execution)
// ---------------------------------------------------------------------------

interface FlowRunResultPanelProps {
  result: FlowRunResult
  onClose: () => void
}

export function FlowRunResultPanel({ result, onClose }: FlowRunResultPanelProps) {
  const isSuccess = result.status === 'success'
  const duration = (result.durationMs / 1000).toFixed(1)

  return (
    <div className="absolute bottom-4 right-4 z-30 w-[360px] rounded-xl border border-neutral-200 bg-white/95 p-3 shadow-lg backdrop-blur-md dark:border-neutral-700 dark:bg-neutral-900/95">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2">
        {isSuccess ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <XCircle className="h-4 w-4 text-danger-500" />
        )}
        <span className={cn('text-[12px] font-semibold', isSuccess ? 'text-success' : 'text-danger-600 dark:text-danger-500')}>
          {isSuccess ? '运行完成' : '运行失败'}
        </span>
        <span className="text-[10px] text-neutral-400">耗时 {duration}s</span>
        <button onClick={onClose} className="ml-auto text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Error message */}
      {!isSuccess && result.error && (
        <div className="mb-2 rounded-md bg-danger-50 px-2 py-1.5 text-[10px] text-danger-600 dark:bg-danger-950/30 dark:text-danger-500">
          {result.error}
        </div>
      )}

      {/* Node results */}
      <div className="max-h-[400px] space-y-0.5 overflow-y-auto">
        {result.nodeResults.map((nr) => (
          <NodeResultRow key={nr.nodeId} result={nr} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Node result row (expandable, with trace timeline)
// ---------------------------------------------------------------------------

function NodeResultRow({ result }: { result: FlowNodeRunResult }) {
  const [expanded, setExpanded] = useState(false)
  const statusIcon = {
    completed: <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />,
    failed: <XCircle className="h-3 w-3 shrink-0 text-danger-500" />,
    running: <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary-500" />,
    pending: <div className="h-3 w-3 shrink-0 rounded-full border border-neutral-300 dark:border-neutral-600" />,
    skipped: <div className="h-3 w-3 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-600" />,
  }

  const hasTrace = (result.trace?.length ?? 0) > 0
  const hasOutput = result.output !== undefined && result.output !== null
  const canExpand = hasOutput || !!result.error || hasTrace
  const label = result.nodeLabel || result.nodeId.slice(0, 12)

  // Badge counts for trace steps
  const toolCallCount = result.trace?.filter((s) => s.type === 'tool_call').length ?? 0
  const thinkingCount = result.trace?.filter((s) => s.type === 'thinking').length ?? 0

  return (
    <div className="rounded-md">
      <button
        onClick={() => canExpand && setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 px-1 py-1 text-[10px]',
          canExpand && 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800',
        )}
      >
        {statusIcon[result.status]}
        <span className="font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
        {result.nodeKind && (
          <span className="text-[9px] text-neutral-400">{result.nodeKind}</span>
        )}
        {/* Trace badges */}
        {!expanded && toolCallCount > 0 && (
          <span className="flex items-center gap-0.5 text-neutral-500" title="工具调用次数">
            <Wrench className="h-2.5 w-2.5" />
            {toolCallCount}
          </span>
        )}
        {!expanded && thinkingCount > 0 && (
          <span className="flex items-center gap-0.5 text-primary-400" title="思考过程">
            <Brain className="h-2.5 w-2.5" />
            {thinkingCount}
          </span>
        )}
        {result.score !== undefined && (
          <span className="ml-auto text-warning">得分 {result.score}</span>
        )}
        {result.error && !expanded && (
          <span className="ml-auto truncate text-danger-500" title={result.error}>
            {result.error.slice(0, 25)}
          </span>
        )}
        {canExpand && !result.error && !result.score && (
          <span className="ml-auto text-neutral-400">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-0.5 max-h-[400px] space-y-1 overflow-y-auto pl-1">
          {/* Trace timeline (shown first if present) */}
          {hasTrace && <TraceTimeline trace={result.trace!} />}
          {/* Final output */}
          {hasOutput && (
            <div className="whitespace-pre-wrap break-words rounded bg-neutral-50 px-2 py-1.5 text-[10px] leading-relaxed text-neutral-600 dark:bg-neutral-800/50 dark:text-neutral-400">
              <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
                最终输出
              </div>
              {formatNodeOutput(result.output)}
            </div>
          )}
          {/* Error */}
          {result.error && (
            <div className="whitespace-pre-wrap break-words rounded bg-danger-50 px-2 py-1.5 text-[10px] text-danger-600 dark:bg-danger-950/30 dark:text-danger-500">
              {result.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Trace timeline — renders agent reasoning, tool calls, and results
// ---------------------------------------------------------------------------

export function TraceTimeline({ trace }: { trace: FlowNodeTraceStep[] }) {
  return (
    <div className="space-y-0.5 border-l border-neutral-200 pl-2 dark:border-neutral-700">
      {trace.map((step, i) => (
        <TraceStepRow key={i} step={step} />
      ))}
    </div>
  )
}

function TraceStepRow({ step }: { step: FlowNodeTraceStep }) {
  const [open, setOpen] = useState(false)

  switch (step.type) {
    case 'thinking':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          <Brain className="mt-0.5 h-2.5 w-2.5 shrink-0 text-primary-400" />
          <button
            onClick={() => setOpen(!open)}
            className="min-w-0 flex-1 text-left"
          >
            <span className="text-[10px] font-medium text-primary-500 dark:text-primary-400">思考</span>
            <ChevronDown className={cn('ml-0.5 inline h-2 w-2 transition-transform', open && 'rotate-180')} />
            {!open && (
              <span className="ml-1 line-clamp-1 text-[10px] text-neutral-400 dark:text-neutral-500">
                {step.thinking}
              </span>
            )}
            {open && step.thinking && (
              <div className="mt-1 whitespace-pre-wrap break-words rounded bg-primary-50/50 px-2 py-1.5 text-[10px] leading-relaxed text-neutral-600 dark:bg-primary-950/20 dark:text-neutral-400">
                {step.thinking}
              </div>
            )}
          </button>
        </div>
      )

    case 'tool_call':
      return (
        <div className="flex items-start gap-1.5 py-0.5">
          <Wrench className="mt-0.5 h-2.5 w-2.5 shrink-0 text-cyan-500" />
          <div className="min-w-0 flex-1">
            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1 text-left"
            >
              <span className="text-[10px] font-medium text-neutral-600 dark:text-neutral-400">
                {step.toolName}
              </span>
              <ChevronDown className={cn('h-2 w-2 transition-transform', open && 'rotate-180')} />
            </button>
            {open && step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
              <pre className="mt-0.5 overflow-x-auto rounded bg-neutral-50 dark:bg-neutral-800/50 px-2 py-1 text-[9px] leading-relaxed text-neutral-600 dark:bg-neutral-800/50 dark:text-neutral-400">
                {JSON.stringify(step.toolArgs, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )

    case 'tool_result':
      return (
        <div className="flex items-start gap-1.5 py-0.5 pl-4">
          <ArrowRight className="mt-0.5 h-2.5 w-2.5 shrink-0 text-neutral-400" />
          <div className="min-w-0 flex-1">
            <button
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1 text-left"
            >
              <span className={cn(
                'text-[10px] font-medium',
                step.isError ? 'text-danger-500' : 'text-neutral-400 dark:text-neutral-500'
              )}>
                结果{step.isError ? '（错误）' : ''}
              </span>
              <ChevronDown className={cn('h-2 w-2 transition-transform', open && 'rotate-180')} />
            </button>
            {!open && step.toolResult && (
              <span className="ml-1 line-clamp-1 text-[9px] text-neutral-400 dark:text-neutral-500">
                {step.toolResult}
              </span>
            )}
            {open && step.toolResult && (
              <pre className="mt-0.5 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words rounded bg-neutral-50 px-2 py-1 text-[9px] leading-relaxed text-neutral-500 dark:bg-neutral-800/50 dark:text-neutral-400">
                {step.toolResult}
              </pre>
            )}
          </div>
        </div>
      )

    case 'text':
      // Intermediate text is shown inline as part of the trace flow.
      // The final output is displayed separately below the trace.
      return null

    default:
      return null
  }
}

function formatNodeOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (typeof output === 'number' || typeof output === 'boolean') return String(output)
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}
