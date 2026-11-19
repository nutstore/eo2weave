/**
 * Renderer for `search_conversations` tool — cross-workspace conversation search
 * with time-window / project filters and project activity breakdown.
 *
 * Layout:
 *   Summary: icon + mode badge + filter chips + count + mini breakdown
 *   Detail:  export toolbar (select-all + format + export button)
 *            + conversation list (checkbox + title + project + relative time)
 *            + breakdown table
 *
 * Export: checked conversations are packed into a single zip via
 * `exportConversationsBatch` (one directory per conversation + index.md +
 * manifest.json) and downloaded directly from the chat card.
 */

import { useState } from 'react'
import { MessageSquare, Search, Clock, Download, Loader2, CheckCircle2 } from 'lucide-react'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'
import {
  exportConversationsBatch,
  listConversationsForExport,
  type BatchExportResult,
} from '@/services/export/conversation-batch-export'
import type { ConversationExportFormat } from '@/services/export/conversation-export'

/** Shorthand for the translator function (matches the i18n package's createUseT shape). */
type Translator = (
  key: string,
  params?: Record<string, string | number>
) => string

interface SearchResultItem {
  conversationId: string
  title: string
  workspaceName?: string
  projectName?: string
  updatedAt: number
  snippet?: string | null
  // Last assistant message in the conversation — gives the LLM (and humans)
  // a one-liner hint about the conversation's status / where it left off.
  lastAssistantMessage?: string | null
}

interface ProjectBreakdownItem {
  projectName: string
  conversationCount: number
  lastActivityAt: number
}

interface SearchConversationsData {
  query?: string
  totalMatches?: number
  hasMore?: boolean
  mode?: 'keyword' | 'list'
  results?: SearchResultItem[]
  projects_breakdown?: ProjectBreakdownItem[]
  filters?: {
    updated_after?: number | null
    updated_before?: number | null
    project?: string | null
    projects?: string[] | null
    query?: string
    sort_by?: string
  }
}

/** Extract the data payload from the tool result envelope. */
function extractData(ctx: ToolRenderCtx): SearchConversationsData | null {
  if (!ctx.result?.data) return null
  return ctx.result.data as SearchConversationsData
}

/** Format a Unix-ms timestamp as a short relative time (e.g. "3h ago", "2d ago"). */
function relativeTime(ms: number): string {
  const now = Date.now()
  const diff = now - ms
  const sec = Math.floor(diff / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)

  if (sec < 60) return 'just now'
  if (min < 60) return `${min}m ago`
  if (hr < 24) return `${hr}h ago`
  if (day < 7) return `${day}d ago`
  // Fall back to date for older items
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** Format a Unix-ms timestamp as "MM-DD HH:MM" (local time). */
function formatTimePoint(ms: number): string {
  const d = new Date(ms)
  const M = String(d.getMonth() + 1).padStart(2, '0')
  const D = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${M}-${D} ${h}:${m}`
}

/**
 * Combine `updated_after` / `updated_before` into a single human-readable chip.
 *
 * SQL-style: directly shows absolute time points and the `→` / `~` range
 * operators. Symbols are language-neutral; only the "full day" label is
 * translated.
 *
 * Examples:
 *   (08-05 00:00, 08-06 00:00)  → "08-05 all day"           (full day)
 *   (08-05 09:00, 08-05 18:00)  → "08-05 09:00 → 08-05 18:00"
 *   (08-05 09:00, 08-06 12:00)  → "08-05 09:00 → 08-06 12:00"
 *   (08-05 00:00, null)         → "08-05 00:00 ~"       (open upper)
 *   (null, 08-06 00:00)         → "~ 08-06 00:00"       (open lower)
 *
 * Avoids the confusing "≥ 1d ago, ≤ 13h ago" form, which reads like two
 * opposing ranges rather than a single time window.
 */
function formatTimeRange(
  after: number | null | undefined,
  before: number | null | undefined,
  t: Translator
): string | null {
  if (after && before) {
    const sd = new Date(after)
    const ed = new Date(before)
    const isFullDay =
      sd.getHours() === 0 &&
      sd.getMinutes() === 0 &&
      ed.getHours() === 0 &&
      ed.getMinutes() === 0 &&
      before - after === 86400000
    if (isFullDay) {
      const date = `${sd.getMonth() + 1}-${sd.getDate()}`
      return `${date} ${t('agent.searchConversations.fullDay')}`
    }
    return `${formatTimePoint(after)} → ${formatTimePoint(before)}`
  }
  if (after) {
    return `${formatTimePoint(after)} ~`
  }
  if (before) {
    return `~ ${formatTimePoint(before)}`
  }
  return null
}

/** Truncate a string to n chars with ellipsis. */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Project badge color — deterministic per project name for visual distinction. */
const PROJECT_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
]

function projectColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length]
}

function ProjectBadge({ name }: { name: string }) {
  const short = name.length > 22 ? name.slice(0, 20) + '…' : name
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium shrink-0 ${projectColor(name)}`}
      title={name}
    >
      {short}
    </span>
  )
}

/** Minimal checkbox styled to match the card's neutral palette. */
function RowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={`grid h-3.5 w-3.5 shrink-0 place-content-center rounded border transition-colors ${
        checked
          ? 'border-primary-600 bg-primary-600 text-white'
          : 'border-neutral-300 bg-transparent hover:border-neutral-400 dark:border-neutral-600'
      }`}
    >
      {checked && (
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M2.5 6.2l2.4 2.4L9.5 3.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}

/**
 * Results body: export toolbar + checkable conversation list.
 *
 * One component owns both the selection state and the rows so checkboxes,
 * select-all and the export button share state naturally (no external hacks).
 */
function ResultsBody({
  results,
  hasMore,
  filters,
}: {
  results: SearchResultItem[]
  hasMore: boolean
  filters: SearchConversationsData['filters']
}) {
  const t = useT()
  // "Load all" re-queries the DB directly (limit 500) so conversations the
  // tool truncated become selectable and exportable too.
  const [allResults, setAllResults] = useState<SearchResultItem[]>(results)
  const [loadingAll, setLoadingAll] = useState(false)
  const [loadAllError, setLoadAllError] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [activeProject, setActiveProject] = useState<string | null>(null)
  const [format, setFormat] = useState<ConversationExportFormat>('markdown')
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, step: '', title: '' })
  const [result, setResult] = useState<BatchExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The tool result already contains the full returned result set. Keep every
  // row selectable: truncating here made conversations beyond the first 15
  // impossible to export even though they were included in the tool payload.
  const projects = [...new Set(allResults.flatMap((r) => (r.projectName ? [r.projectName] : [])))].sort()
  const visible = activeProject
    ? allResults.filter((r) => r.projectName === activeProject)
    : allResults

  const allChecked = visible.length > 0 && visible.every((r) => checked.has(r.conversationId))
  const someChecked = visible.some((r) => checked.has(r.conversationId)) && !allChecked

  const toggleRow = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (visible.every((r) => next.has(r.conversationId))) {
        for (const r of visible) next.delete(r.conversationId)
      } else {
        for (const r of visible) next.add(r.conversationId)
      }
      return next
    })

  const handleLoadAll = async () => {
    if (loadingAll) return
    setLoadingAll(true)
    setLoadAllError(null)
    try {
      const rows = await listConversationsForExport({
        projects: filters?.projects ?? (filters?.project ? [filters.project] : undefined),
        updatedAfter: filters?.updated_after ?? undefined,
        updatedBefore: filters?.updated_before ?? undefined,
        query: filters?.query && filters.query !== '*' ? filters.query : undefined,
        keywordSearch: true,
        limit: 500,
      })
      setAllResults((prev) => {
        const seen = new Set(prev.map((r) => r.conversationId))
        const extra = rows
          .filter((r) => !seen.has(r.conversationId))
          .map((r) => ({
            conversationId: r.conversationId,
            title: r.title,
            workspaceName: r.workspaceName,
            projectName: r.projectName ?? undefined,
            updatedAt: r.updatedAt,
            snippet: null,
            lastAssistantMessage: null,
          }))
        return [...prev, ...extra]
      })
    } catch (err) {
      setLoadAllError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingAll(false)
    }
  }

  const handleExport = async (ids?: string[]) => {
    const exportingAll = ids != null // "export all" path (whole filtered view)
    if (!exportingAll && checked.size === 0) return
    if (isExporting) return
    setIsExporting(true)
    setError(null)
    setResult(null)
    setProgress({ percent: 0, step: '', title: '' })
    try {
      // "Export all" must cover the *entire* filtered set, including rows the
      // tool response truncated. Re-query the DB for the full list (limit 500)
      // instead of only the rows currently loaded in the list.
      //
      // Project scope: the in-card `activeProject` filter wins over the tool's
      // `filters.project(s)` — the user narrowed the view after the tool ran,
      // so "export all of this project" must match what's on screen, not the
      // broader original query scope.
      let exportRows = allResults
      if (exportingAll) {
        const projectScope = activeProject
          ? [activeProject]
          : filters?.projects ?? (filters?.project ? [filters.project] : undefined)
        const full = await listConversationsForExport({
          projects: projectScope,
          updatedAfter: filters?.updated_after ?? undefined,
          updatedBefore: filters?.updated_before ?? undefined,
          query: filters?.query && filters.query !== '*' ? filters.query : undefined,
          keywordSearch: true,
          limit: 500,
        })
        if (full.length > 0) {
          exportRows = full.map((r) => ({
            conversationId: r.conversationId,
            title: r.title,
            workspaceName: r.workspaceName,
            projectName: r.projectName ?? undefined,
            updatedAt: r.updatedAt,
            snippet: null,
            lastAssistantMessage: null,
          }))
        }
      }
      const targetIds = ids ?? [...checked]
      const byId = new Map(exportRows.map((r) => [r.conversationId, r]))
      const res = await exportConversationsBatch(
        targetIds.map((id) => {
          const r = byId.get(id)
          return {
            conversationId: id,
            title: r?.title ?? id,
            projectName: r?.projectName,
            updatedAt: r?.updatedAt,
          }
        }),
        { format, onProgress: setProgress },
      )
      setResult(res)
      if (!res.success) setError(res.error ?? 'export failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <>
      {/* Export toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50/60 px-2 py-1.5 dark:border-neutral-700/60 dark:bg-neutral-800/40">
        <button
          type="button"
          role="checkbox"
          aria-checked={allChecked ? 'true' : someChecked ? 'mixed' : 'false'}
          onClick={toggleAll}
          className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <span
            className={`grid h-3 w-3 place-content-center rounded-[3px] border transition-colors ${
              allChecked
                ? 'border-primary-600 bg-primary-600'
                : someChecked
                  ? 'border-primary-600 bg-primary-600/60'
                  : 'border-neutral-300 dark:border-neutral-600'
            }`}
          >
            {(allChecked || someChecked) && (
              <svg viewBox="0 0 12 12" className="h-2 w-2 text-white" fill="none" stroke="currentColor" strokeWidth="2.4">
                <path d="M2.5 6.2l2.4 2.4L9.5 3.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          {t('agent.searchConversations.exportSelectAll')}
        </button>

        {/* Format pills */}
        <div className="flex rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          {(['markdown', 'json', 'html'] as ConversationExportFormat[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={`px-1.5 py-0.5 text-[10px] uppercase transition-colors ${
                format === f
                  ? 'bg-primary-600 text-white'
                  : 'text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
              }`}
            >
              {f === 'markdown' ? 'MD' : f.toUpperCase()}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[10px] text-neutral-400">
          {t('agent.searchConversations.exportSelected', { count: checked.size })}
        </span>

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={isExporting || checked.size === 0}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40 bg-primary-600 text-white hover:bg-primary-700"
        >
          {isExporting ? (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {progress.step}
            </>
          ) : (
            <>
              <Download className="h-2.5 w-2.5" />
              {t('agent.searchConversations.exportButton')}
            </>
          )}
        </button>

        {/* One-click export of the whole filtered view (project/time window),
            so users don't have to tick rows one by one. */}
        {visible.length > 0 && (
          <button
            type="button"
            onClick={() => void handleExport(visible.map((r) => r.conversationId))}
            disabled={isExporting}
            title={activeProject ? t('agent.searchConversations.exportAllProjectTitle') : t('agent.searchConversations.exportAllTitle')}
            className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40 hover:border-primary-500 hover:text-primary-600 dark:border-neutral-600"
          >
            <Download className="h-2.5 w-2.5" />
            {activeProject
              ? t('agent.searchConversations.exportAllProject', { count: visible.length })
              : t('agent.searchConversations.exportAll', { count: visible.length })}
          </button>
        )}
      </div>

      {/* Progress bar */}
      {isExporting && (
        <div className="space-y-1">
          <div className="h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <div
              className="h-full rounded-full bg-primary-600 transition-all duration-300"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          {progress.title && (
            <div className="truncate text-[10px] text-neutral-400">{progress.title}</div>
          )}
        </div>
      )}

      {/* Result / error */}
      {result?.success && !isExporting && (
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          {t('agent.searchConversations.exportDone', { count: result.exportedCount })}
          {result.skippedCount > 0
            ? ` · ${t('agent.searchConversations.exportSkipped', { count: result.skippedCount })}`
            : ''}
          <span className="text-neutral-400">
            {' '}{result.filename} ({(result.size / 1024).toFixed(0)} KB)
          </span>
        </div>
      )}
      {error && !isExporting && <div className="text-[10px] text-red-500">{error}</div>}

      {/* Quick project filter — selection is preserved when switching projects. */}
      {projects.length > 1 && (
        <div
          className="flex items-center gap-1 overflow-x-auto pb-0.5"
          role="group"
          aria-label={t('agent.searchConversations.filterProjects')}
        >
          <button
            type="button"
            aria-pressed={activeProject === null}
            onClick={() => setActiveProject(null)}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
              activeProject === null
                ? 'bg-neutral-700 text-white dark:bg-neutral-200 dark:text-neutral-900'
                : 'bg-neutral-100 text-neutral-500 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            {t('agent.searchConversations.filterAllProjects')}
          </button>
          {projects.map((project) => (
            <button
              key={project}
              type="button"
              aria-pressed={activeProject === project}
              onClick={() => setActiveProject(project)}
              className={`shrink-0 rounded transition-opacity ${
                activeProject === project
                  ? 'border border-primary-500 opacity-100'
                  : 'border border-transparent opacity-65 hover:opacity-100'
              }`}
            >
              <ProjectBadge name={project} />
            </button>
          ))}
        </div>
      )}

      {/* Conversation list with checkboxes */}
      <div className="space-y-1">
        {visible.map((r, i) => (
          <div
            key={r.conversationId}
            className="flex flex-col gap-0.5 text-xs"
            style={{ animation: `tool-row-in .2s ease-out ${i * 18}ms backwards` }}
          >
            <div className="flex items-center gap-2">
              <RowCheckbox
                checked={checked.has(r.conversationId)}
                onChange={() => toggleRow(r.conversationId)}
                label={r.title || 'conversation'}
              />
              <span
                className="text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300 truncate flex-1"
                title={r.title}
              >
                {r.title || t('agent.searchConversations.untitled')}
              </span>
              {r.projectName && <ProjectBadge name={r.projectName} />}
              <span className="text-[10px] text-neutral-400 shrink-0">{relativeTime(r.updatedAt)}</span>
            </div>
            {/* Last assistant message — gives the LLM status context for free */}
            {r.lastAssistantMessage && (
              <div
                className="ml-5 text-[11px] text-neutral-500 dark:text-neutral-400 truncate"
                title={r.lastAssistantMessage}
              >
                ↳ {truncate(r.lastAssistantMessage, 140)}
              </div>
            )}
          </div>
        ))}
      </div>

      <LoadAllFooter
        hasMore={hasMore}
        loading={loadingAll}
        error={loadAllError}
        onLoadAll={() => void handleLoadAll()}
      />
    </>
  )
}

registerRenderer({
  name: 'search_conversations',
  icon: <MessageSquare className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const data = extractData(ctx)
    const t = useT()

    if (ctx.isError) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">search_conversations</code>
          <span className="ml-auto shrink-0 text-xs text-red-500">{t('agent.searchConversations.failed')}</span>
        </>
      )
    }

    // Streaming / executing state
    if (ctx.isExecuting || ctx.isStreaming || !data) {
      const query = typeof ctx.args.query === 'string' ? ctx.args.query.trim() : ''
      const modeKey = query ? 'agent.searchConversations.modeKeyword' : 'agent.searchConversations.modeList'
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">search_conversations</code>
          <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 text-neutral-400 text-neutral-400 dark:text-neutral-400">
            {t(modeKey)}
          </span>
          {query && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">"{truncate(query, 30)}"</span>
          )}
          {typeof ctx.args.updated_after === 'number' && (
            <span className="text-xs text-neutral-400">· last {relativeTime(ctx.args.updated_after as number)} →</span>
          )}
        </>
      )
    }

    const total = data.totalMatches ?? 0
    const mode = data.mode ?? 'list'
    const filters = data.filters ?? {}
    const breakdown = data.projects_breakdown ?? []

    // Build filter chips — collapse the time window into one chip.
    const chips: string[] = []
    const timeRange = formatTimeRange(filters.updated_after, filters.updated_before, t)
    if (timeRange) chips.push(timeRange)
    if (filters.project) chips.push(filters.project)

    const modeLabel =
      mode === 'keyword'
        ? t('agent.searchConversations.modeKeyword')
        : t('agent.searchConversations.modeList')
    const matchLabel = t(
      total === 1 ? 'agent.searchConversations.match_one' : 'agent.searchConversations.match_other',
      { count: total }
    )

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">search_conversations</code>
        <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 text-neutral-400 text-neutral-400 dark:text-neutral-400">
          {modeLabel}
        </span>
        {mode === 'keyword' && data.query && data.query !== '*' && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">"{truncate(data.query, 30)}"</span>
        )}
        {chips.length > 0 && (
          <span className="truncate text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {chips.join(' · ')}
          </span>
        )}
        <span className="ml-auto shrink-0 text-xs text-neutral-400">{matchLabel}</span>
        {/* Mini breakdown badges — only when multiple projects */}
        {breakdown.length > 1 && (
          <span className="hidden sm:inline-flex items-center gap-1 shrink-0">
            {breakdown.slice(0, 3).map((p) => (
              <span
                key={p.projectName}
                className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] ${projectColor(p.projectName)}`}
                title={p.projectName}
              >
                {p.conversationCount}
              </span>
            ))}
          </span>
        )}
      </>
    )
  },

  Detail(ctx) {
    const data = extractData(ctx)
    const t = useT()

    // Error envelopes do not carry a `data` payload, so this must precede
    // the no-data loading state below.
    if (ctx.isError) {
      const errMsg =
        (ctx.result?.error as Record<string, unknown> | undefined)?.message ?? 'Search failed'
      return (
        <div className="px-3 py-2 text-xs text-red-400 dark:text-red-400/80">{String(errMsg)}</div>
      )
    }

    if (ctx.isExecuting || ctx.isStreaming || !data) {
      return <StreamingPlaceholder />
    }

    const results = data.results ?? []
    const breakdown = data.projects_breakdown ?? []
    const filters = data.filters ?? {}
    const mode = data.mode ?? 'list'
    const timeRange = formatTimeRange(filters.updated_after, filters.updated_before, t)

    if (results.length === 0) {
      return (
        <div className="px-3 py-3 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          {t('agent.searchConversations.noResults')}
        </div>
      )
    }

    return (
      <div className="px-3 py-2 space-y-2">
        {/* Filter summary line */}
        {(filters.updated_after || filters.updated_before || filters.project || mode === 'keyword') && (
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {mode === 'keyword' && data.query && data.query !== '*' && (
              <span className="inline-flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5">
                <Search className="h-2.5 w-2.5" />
                "{truncate(data.query, 24)}"
              </span>
            )}
            {timeRange && (
              <span className="inline-flex items-center gap-1 bg-neutral-100 dark:bg-neutral-800 rounded px-1.5 py-0.5">
                <Clock className="h-2.5 w-2.5" />
                {timeRange}
              </span>
            )}
            {filters.project && <ProjectBadge name={filters.project} />}
          </div>
        )}

        {/* Project breakdown table — only when meaningful (multi-project list mode) */}
        {breakdown.length > 1 && (
          <div className="rounded border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="bg-neutral-50 dark:bg-neutral-800/50 px-2 py-1 text-[10px] font-medium text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
              {t('agent.searchConversations.projectsHeader', { count: breakdown.length })}
            </div>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {breakdown.map((p) => (
                <div key={p.projectName} className="flex items-center gap-2 px-2 py-1 text-xs">
                  <ProjectBadge name={p.projectName} />
                  <span className="text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{p.conversationCount}</span>
                  <span className="ml-auto text-[10px] text-neutral-400">{relativeTime(p.lastActivityAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Conversation list + export toolbar (selection & export state live inside) */}
        <ResultsBody results={results} hasMore={!!data.hasMore} filters={filters} />
      </div>
    )
  },
})

/**
 * Footer of the results list: when the tool response was truncated
 * (hasMore), offers a one-click "load all" that re-queries the DB so every
 * matching conversation becomes checkable / exportable.
 */
function LoadAllFooter({
  hasMore,
  loading,
  error,
  onLoadAll,
}: {
  hasMore: boolean
  loading: boolean
  error: string | null
  onLoadAll: () => void
}) {
  const t = useT()
  if (error) {
    return <div className="text-[10px] text-red-500">{error}</div>
  }
  if (!hasMore && !loading) return null
  return (
    <div className="text-[10px] text-neutral-400 dark:text-neutral-500">
      {hasMore && (
        <button
          type="button"
          onClick={onLoadAll}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors text-neutral-500 hover:text-neutral-700 disabled:opacity-50 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          {loading && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {loading
            ? t('agent.searchConversations.loadingAll')
            : t('agent.searchConversations.loadAll')}
        </button>
      )}
      {!loading && (
        <span className="ml-1">{t('agent.searchConversations.moreAvailable')}</span>
      )}
    </div>
  )
}

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2 space-y-1.5">
      {[80, 60, 70, 50, 65].map((w, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="h-3 w-3 rounded bg-neutral-200 dark:bg-neutral-700 animate-pulse" />
          <div
            className="h-3 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse"
            style={{ width: w + '%' }}
          />
        </div>
      ))}
    </div>
  )
}
