'use client'

import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import dynamic from 'next/dynamic'
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Loader2 } from 'lucide-react'
import { useT } from '@/i18n'
import { useProjectStore } from '@/store/project.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { getMCPTaskManager } from '@/mcp/task-manager'
import { getMCPManager } from '@/mcp/mcp-manager'
import { getMCPInputManager, type PendingMCPInput } from '@/mcp/input-manager'
import { getTaskCardState, isComposerTaskVisible } from '@/mcp/task-card-state'
import type { ManagedMCPTask } from '@/mcp/task-types'
import type { MCPToolCallResult } from '@/mcp/mcp-types'
import styles from './MCPTaskCards.module.css'

const InputForm = dynamic(() => import('./MCPInputForm').then((module) => module.MCPInputForm))
const EMPTY_INPUTS: readonly PendingMCPInput[] = []
const emptyInputs = () => EMPTY_INPUTS
const button =
  'rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800'
const primary =
  'shrink-0 rounded-md bg-emerald-700 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-emerald-600 dark:hover:bg-emerald-500'

function Elapsed({ task }: { task: ManagedMCPTask }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (task.settledAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [task.settledAt])
  const seconds = Math.max(0, Math.floor(((task.settledAt ?? now) - task.createdAt) / 1000))
  return (
    <span className="shrink-0 font-mono text-[11px] tabular-nums text-neutral-400">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function TaskCard({
  task,
  inputs,
  onSent,
}: {
  task: ManagedMCPTask
  inputs: readonly PendingMCPInput[]
  onSent: (id: string) => void
}) {
  const t = useT()
  const manager = getMCPTaskManager()
  const running = useConversationRuntimeStore((state) =>
    state.isConversationRunning(task.context.conversationId)
  )
  const [expandedPanel, setExpandedPanel] = useState<'details' | 'result' | null>(null)
  const [preview, setPreview] = useState<{
    result: MCPToolCallResult
    Component: typeof import('./MCPTaskResult').default
  }>()
  const [loadingResult, setLoadingResult] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const state = inputs.length ? 'input_required' : getTaskCardState(task)
  // Opening task details or an input form does not open the eventual result preview.
  const panel = state === 'ready' ? 'result' : 'details'
  const expanded = expandedPanel === panel
  const needsInput = state === 'input_required'
  const previousInputIds = useRef(new Set<string>())
  useEffect(() => {
    if (inputs.some((input) => !previousInputIds.current.has(input.id))) setExpandedPanel('details')
    else if (previousInputIds.current.size > 0 && inputs.length === 0)
      setExpandedPanel((current) => (current === 'details' ? null : current))
    previousInputIds.current = new Set(inputs.map((input) => input.id))
  }, [inputs])
  const failed = state === 'failed' || state === 'cancelled' || state === 'submission_unknown'
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const show = async () => {
    if (loadingResult) return
    if (expanded) {
      setExpandedPanel(null)
      return
    }
    if (preview || (!task.result && !task.resultAssetId)) {
      setExpandedPanel(panel)
      return
    }
    setLoadingResult(true)
    setError('')
    try {
      // Keep the card unchanged until both its content and renderer are ready.
      const [result, { default: Component }] = await Promise.all([
        manager.result(task.context.projectId, task.id),
        import('./MCPTaskResult'),
      ])
      if (result) {
        setPreview({ result, Component })
        setExpandedPanel(panel)
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingResult(false)
    }
  }
  return (
    <article
      className={`min-w-0 rounded-lg border border-t-0 bg-white dark:bg-neutral-900 ${needsInput ? 'border-amber-400 dark:border-amber-600' : 'border-neutral-200/80 dark:border-neutral-700'}`}
    >
      <div
        className={`sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg border-t bg-white px-2.5 py-2 dark:bg-neutral-900 ${needsInput ? 'border-amber-400 dark:border-amber-600' : 'border-neutral-200/80 dark:border-neutral-700'}`}
      >
        {needsInput ? (
          <span
            role="status"
            className="flex w-full items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"
          >
            <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
            {t('mcp.tasks.inputRequiredTitle')}
          </span>
        ) : null}
        {needsInput ? null : state === 'ready' ? (
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : failed || state === 'paused' ? (
          <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        ) : (
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400 motion-reduce:animate-none"
          />
        )}
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={`${task.serverId} · ${task.toolName}`}
        >
          {task.serverId} · {task.toolName}
        </span>
        <Elapsed task={task} />
        <span
          role="status"
          className={
            needsInput
              ? 'px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-200'
              : 'text-xs text-neutral-500 dark:text-neutral-400'
          }
        >
          {t(`mcp.tasks.${state}`)}
        </span>
        <button
          type="button"
          className={`${button} relative`}
          disabled={loadingResult}
          aria-busy={loadingResult || undefined}
          aria-expanded={expanded}
          onClick={() => void show()}
        >
          <span className={loadingResult ? 'opacity-0' : undefined}>
            {expanded
              ? t('mcp.tasks.collapse')
              : state === 'ready'
                ? t('mcp.tasks.viewResult')
                : state === 'input_required'
                  ? t('mcp.tasks.handleInput')
                  : t('mcp.tasks.details')}
          </span>
          {loadingResult ? (
            <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            </span>
          ) : null}
        </button>
        {state === 'ready' ? (
          <button
            type="button"
            disabled={busy}
            className={primary}
            onClick={() =>
              void run(async () => {
                const { continueMCPTask } = await import('@/mcp/continue-task')
                const delivery = await continueMCPTask(task, t('mcp.tasks.continueMessage'))
                if (delivery.kind === 'sent') onSent(task.id)
              })
            }
          >
            {busy
              ? t('mcp.tasks.sending')
              : running
                ? t('mcp.tasks.enqueueResult')
                : t('mcp.tasks.sendToAI')}
          </button>
        ) : null}
        {failed ? (
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={() =>
              void run(() =>
                manager.updateComposer(task.context.projectId, task.id, { dismissedAt: Date.now() })
              )
            }
          >
            {t('mcp.tasks.acknowledge')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="whitespace-pre-wrap px-2.5 pb-2 text-xs text-red-600">
          {error}
        </p>
      ) : null}
      {expanded ? (
        <div className="mx-2.5 space-y-2 border-t border-neutral-100 py-2 dark:border-neutral-800">
          {task.snapshot?.statusMessage ? (
            <p className="whitespace-pre-wrap break-words text-xs text-neutral-500">
              {task.snapshot.statusMessage}
            </p>
          ) : null}
          {task.error ? (
            <p className="whitespace-pre-wrap break-words text-xs text-amber-700 dark:text-amber-400">
              {task.error}
            </p>
          ) : null}
          {state === 'submission_unknown' ? (
            <p className="text-xs text-neutral-500">{t('mcp.tasks.unknownNotice')}</p>
          ) : null}
          {inputs.map((input) => (
            <InputForm key={input.id} input={input} />
          ))}
          {preview ? <preview.Component result={preview.result} /> : null}
          {!failed && state !== 'ready' && state !== 'preparing' && task.reference ? (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                disabled={busy}
                className={button}
                onClick={() =>
                  void run(() =>
                    state === 'paused'
                      ? manager.resume(task.context.projectId, task.id)
                      : manager.pause(task.context.projectId, task.id)
                  )
                }
              >
                {t(state === 'paused' ? 'mcp.tasks.resume' : 'mcp.tasks.pause')}
              </button>
              <button
                type="button"
                disabled={busy || !task.cancellationSupported || task.cancellationRequested}
                title={!task.cancellationSupported ? t('mcp.tasks.cancelUnsupported') : undefined}
                className={button}
                onClick={() => void run(() => manager.cancel(task.context.projectId, task.id))}
              >
                {t(task.cancellationRequested ? 'mcp.tasks.cancelling' : 'mcp.tasks.cancel')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function MCPTaskCards({
  conversationId,
  viewportRef,
}: {
  conversationId?: string
  viewportRef?: RefObject<HTMLDivElement>
}) {
  const t = useT()
  const detailsId = useId()
  const projectId = useProjectStore((state) => state.activeProjectId)
  const manager = getMCPTaskManager()
  const inputManager = getMCPInputManager()
  const records = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getServerSnapshot
  )
  const pending = useSyncExternalStore(
    inputManager.subscribe,
    inputManager.getSnapshot,
    emptyInputs
  )
  const storageKey = `mcp-cards:v1:${projectId}:${conversationId}`
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) !== 'expanded'
    } catch {
      return true
    }
  })
  const [all, setAll] = useState(false)
  const [sent, setSent] = useState<Set<string>>(() => new Set())
  const previousInputIds = useRef(new Set<string>())
  const scrollArea = useRef<HTMLDivElement>(null)
  const observedResultIds = useRef<Set<string> | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [availableHeight, setAvailableHeight] = useState<number>()
  useEffect(() => {
    void (async () => {
      await getMCPManager().initialize()
      await manager.initialize()
    })().catch(console.error)
  }, [manager])
  const inputs = pending.filter(
    (input) =>
      input.context.projectId === projectId && input.context.conversationId === conversationId
  )
  const inputTaskIds = new Set(inputs.map((input) => input.context.localTaskId))
  const needsInput = (task: ManagedMCPTask) =>
    inputTaskIds.has(task.id) || getTaskCardState(task) === 'input_required'
  const needsReview = (task: ManagedMCPTask) =>
    needsInput(task) || getTaskCardState(task) === 'ready'
  const priority = (task: ManagedMCPTask) =>
    needsInput(task) ? 2 : getTaskCardState(task) === 'ready' ? 1 : 0
  const sortTime = (task: ManagedMCPTask) =>
    getTaskCardState(task) === 'ready' ? (task.settledAt ?? task.createdAt) : task.createdAt
  const tasks = records
    .filter(
      (task) =>
        task.context.projectId === projectId &&
        task.context.conversationId === conversationId &&
        isComposerTaskVisible(task) &&
        !sent.has(task.id)
    )
    .sort(
      (a, b) =>
        priority(b) - priority(a) ||
        sortTime(b) - sortTime(a) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id)
    )
  useEffect(() => {
    const hasNewInput = inputs.some((input) => !previousInputIds.current.has(input.id))
    const finishedInputs = previousInputIds.current.size > 0 && inputs.length === 0
    previousInputIds.current = new Set(inputs.map((input) => input.id))
    const readyIds = tasks
      .filter(
        (task) =>
          !inputs.some((input) => input.context.localTaskId === task.id) &&
          getTaskCardState(task) === 'ready'
      )
      .map((task) => task.id)
    const previousResults = observedResultIds.current
    const hasNewResult = previousResults !== null && readyIds.some((id) => !previousResults.has(id))
    // Existing ready results on mount do not override a user's collapsed preference.
    observedResultIds.current ??= new Set()
    for (const id of readyIds) observedResultIds.current.add(id)
    if (!hasNewInput && !hasNewResult && !finishedInputs) return
    const nextCollapsed = !(hasNewInput || hasNewResult)
    setCollapsed(nextCollapsed)
    if (!nextCollapsed && scrollArea.current) scrollArea.current.scrollTop = 0
    try {
      sessionStorage.setItem(storageKey, nextCollapsed ? 'collapsed' : 'expanded')
    } catch {
      /* Storage is optional. */
    }
  }, [inputs, tasks, storageKey])
  const standalone = inputs.filter(
    (input) => !tasks.some((task) => task.id === input.context.localTaskId)
  )
  const count = tasks.length + standalone.length
  const hasEntries = !!projectId && !!conversationId && count > 0
  useLayoutEffect(() => {
    const panel = panelRef.current
    const viewport = viewportRef?.current
    if (!panel || !viewport) return
    const updateHeight = () => {
      const top = Math.max(
        viewport.getBoundingClientRect().top,
        window.visualViewport?.offsetTop ?? 0
      )
      setAvailableHeight(Math.max(0, Math.floor(panel.getBoundingClientRect().bottom - top - 8)))
    }
    updateHeight()
    // Composer growth changes the message viewport height without a window resize.
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHeight) : undefined
    observer?.observe(viewport)
    window.addEventListener('resize', updateHeight)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', updateHeight)
    visualViewport?.addEventListener('scroll', updateHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateHeight)
      visualViewport?.removeEventListener('resize', updateHeight)
      visualViewport?.removeEventListener('scroll', updateHeight)
    }
  }, [hasEntries, collapsed, viewportRef])
  const visibleCount = Math.max(2, standalone.length + tasks.filter(needsReview).length)
  if (!projectId || !conversationId || !count) return null
  const attention =
    inputs.length > 0 ||
    tasks.some((task) =>
      ['ready', 'failed', 'cancelled', 'paused', 'submission_unknown'].includes(
        getTaskCardState(task)
      )
    )
  const summaryInput = standalone[0]
  const summaryTask =
    tasks.find(needsInput) ??
    tasks.find((task) => {
      const state = getTaskCardState(task)
      return state === 'working' || state === 'preparing'
    }) ??
    tasks[0]
  const summaryState =
    summaryInput || (summaryTask && needsInput(summaryTask))
      ? 'input_required'
      : summaryTask
        ? getTaskCardState(summaryTask)
        : 'working'
  const summaryName = summaryInput
    ? summaryInput.serverId
    : summaryTask
      ? `${summaryTask.serverId} · ${summaryTask.toolName}`
      : ''
  const summaryMessage = summaryInput ? undefined : summaryTask?.snapshot?.statusMessage
  const collapse = (next: boolean) => {
    setCollapsed(next)
    try {
      sessionStorage.setItem(storageKey, next ? 'collapsed' : 'expanded')
    } catch {
      /* Storage is optional. */
    }
  }
  const entries = [
    ...standalone.map((input) => (
      <article
        key={input.id}
        className="rounded-lg border border-amber-400 p-2 dark:border-amber-600"
      >
        <p
          role="status"
          className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200"
        >
          <CircleAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('mcp.tasks.inputRequiredTitle')}
        </p>
        <p className="mb-2 text-xs font-medium">{input.serverId}</p>
        <InputForm input={input} />
      </article>
    )),
    ...tasks.map((task) => (
      <TaskCard
        key={task.id}
        task={task}
        inputs={inputs.filter((input) => input.context.localTaskId === task.id)}
        onSent={(id) => setSent((previous) => new Set(previous).add(id))}
      />
    )),
  ]
  return (
    <section
      aria-label={t('mcp.tasks.title')}
      className="relative mb-2 min-w-0 text-neutral-800 dark:text-neutral-100"
    >
      <div className="flex h-8 min-w-0 items-center gap-2 px-1">
        {summaryState === 'working' || summaryState === 'preparing' ? (
          <Loader2
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400 motion-reduce:animate-none"
          />
        ) : summaryState === 'ready' ? (
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : (
          <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        )}
        <span
          role="status"
          title={summaryMessage ? `${summaryName} · ${summaryMessage}` : summaryName}
          className={`min-w-0 flex-1 truncate text-xs font-medium ${summaryState === 'input_required' ? 'text-amber-700 dark:text-amber-300' : ''}`}
        >
          {t(`mcp.tasks.${summaryState}`)}
          <span className="ml-1.5 font-normal text-neutral-500 dark:text-neutral-400">
            {summaryMessage || summaryName}
          </span>
        </span>
        {!summaryInput && summaryTask ? <Elapsed task={summaryTask} /> : null}
        <span className="shrink-0 text-[11px] text-neutral-500">
          {t(attention ? 'mcp.tasks.attentionCount' : 'mcp.tasks.activeCount', { count })}
        </span>
        <button
          type="button"
          className={`${button} flex shrink-0 items-center gap-1`}
          aria-expanded={!collapsed}
          aria-controls={detailsId}
          onClick={() => collapse(!collapsed)}
        >
          {collapsed ? t('mcp.tasks.expand') : t('mcp.tasks.later')}
          {collapsed ? (
            <ChevronDown aria-hidden="true" className="h-3 w-3" />
          ) : (
            <ChevronUp aria-hidden="true" className="h-3 w-3" />
          )}
        </button>
      </div>
      {!collapsed ? (
        <div
          ref={panelRef}
          id={detailsId}
          role="group"
          aria-label={t('mcp.tasks.details')}
          style={{ maxHeight: availableHeight ?? '70dvh' }}
          className="absolute inset-x-0 bottom-full z-20 mb-2 flex min-w-0 flex-col rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div
            ref={scrollArea}
            className={`${styles.scrollArea} min-h-0 space-y-1.5 overflow-y-auto overscroll-contain pr-1`}
          >
            {all ? entries : entries.slice(0, visibleCount)}
            {entries.length > visibleCount ? (
              <button
                type="button"
                className={button}
                onClick={() => setAll(!all)}
                aria-expanded={all}
              >
                {all
                  ? t('mcp.tasks.collapse')
                  : t('mcp.tasks.showMore', { count: entries.length - visibleCount })}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default memo(MCPTaskCards)
