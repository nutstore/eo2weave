/**
 * BatchExportDialog - Search conversations across projects and batch-export
 * them as a single zip.
 *
 * Interaction design (2026-09 redesign):
 * - No "Search" button: any filter change re-queries automatically
 *   (250ms debounce for the keyword input, immediate for chips/dates).
 * - Keyword search covers message content when the in-input "full text"
 *   pill is on (default).
 * - Projects live in a dropdown with per-project conversation counts,
 *   filtered by project ID (same-named projects never collide; the
 *   untitled NULL group is selectable).
 * - Selection survives filter changes; rows outside the current view stay
 *   selected and are surfaced via a hint + per-batch export.
 * - Re-queries keep the list visible (opacity only) — no full-list spinner.
 * - Brand teal is reserved for selection states and the primary action.
 *
 * Reuses the same SQLite-backed pipeline as the agent's `search_conversations`
 * tool (`listConversationsForExport` + `exportConversationsBatch`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, ChevronDown, Download, Loader2, Search } from 'lucide-react'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
} from '@creatorweave/ui'
import { useT } from '@/i18n'
import {
  exportConversationsBatch,
  listConversationsForExport,
  listProjectsWithCounts,
  type BatchExportResult,
  type ConversationListItem,
  type ConversationListFilter,
  type ProjectWithCount,
} from '@/services/export/conversation-batch-export'
import type { ConversationExportFormat } from '@/services/export/conversation-export'
import { formatSize } from '@/lib/utils'

// ============================================================================
// Types & constants
// ============================================================================

interface BatchExportDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback to toggle open state */
  onOpenChange: (open: boolean) => void
}

type TimeRange = 'all' | '3' | '7' | '30' | '90' | 'custom'

const TIME_RANGE_OPTIONS: TimeRange[] = ['all', '3', '7', '30', '90', 'custom']
const RESULT_LIMIT = 500
const QUERY_DEBOUNCE_MS = 250

/** Pure filter builder so the auto-search effect stays dependency-clean. */
function buildListFilter(
  query: string,
  fullText: boolean,
  timeRange: TimeRange,
  fromDate: string,
  toDate: string,
  projects: Array<string | null>,
): ConversationListFilter {
  const filter: ConversationListFilter = { limit: RESULT_LIMIT }
  if (projects.length > 0) filter.projectIds = projects
  if (timeRange !== 'all' && timeRange !== 'custom') {
    filter.updatedAfter = Date.now() - Number(timeRange) * 24 * 60 * 60 * 1000
  }
  if (timeRange === 'custom') {
    if (fromDate) filter.updatedAfter = new Date(`${fromDate}T00:00:00`).getTime()
    if (toDate) filter.updatedBefore = new Date(`${toDate}T23:59:59.999`).getTime()
  }
  if (query.trim()) {
    filter.query = query.trim()
    filter.keywordSearch = fullText
  }
  return filter
}

// ============================================================================
// Component
// ============================================================================

export function BatchExportDialog({ open, onOpenChange }: BatchExportDialogProps) {
  const t = useT()

  // Filter state
  const [query, setQuery] = useState('')
  const [fullText, setFullText] = useState(true)
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [projects, setProjects] = useState<Array<string | null>>([])
  const [availableProjects, setAvailableProjects] = useState<ProjectWithCount[]>([])
  const [projectOpen, setProjectOpen] = useState(false)

  // Result state
  const [rows, setRows] = useState<ConversationListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  // Selection deliberately survives filter changes; items filtered out of the
  // current view stay selected (surfaced in the toolbar hint).
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Metadata (title/project/updatedAt) for everything ever listed, so exports
  // can include rows that are currently filtered out of the view.
  const convInfoRef = useRef(new Map<string, ConversationListItem>())
  // Monotonic sequence: only the latest response may touch state.
  const requestSeqRef = useRef(0)

  // Export state
  const [format, setFormat] = useState<ConversationExportFormat>('markdown')
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState({ percent: 0, step: '', title: '' })
  const [result, setResult] = useState<BatchExportResult | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const selectAllRef = useRef<HTMLInputElement>(null)
  const projectBoxRef = useRef<HTMLDivElement>(null)

  // ------------------------------------------------------------- Searching

  const runSearch = useCallback(async (filter: ConversationListFilter) => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const found = await listConversationsForExport(filter)
      if (seq !== requestSeqRef.current) return
      for (const row of found) convInfoRef.current.set(row.conversationId, row)
      setRows(found)
      setSearched(true)
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setLoadError(err instanceof Error ? err.message : String(err))
      setRows([])
      setSearched(true)
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  // Auto-search: any filter change re-queries (no explicit search button).
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      void runSearch(buildListFilter(query, fullText, timeRange, fromDate, toDate, projects))
    }, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, query, fullText, timeRange, fromDate, toDate, projects, runSearch])

  // ------------------------------------------------------------ Open / close

  useEffect(() => {
    if (!open) {
      // Reset state after the close animation finishes.
      const timer = setTimeout(() => {
        setQuery('')
        setFullText(true)
        setTimeRange('all')
        setFromDate('')
        setToDate('')
        setProjects([])
        setAvailableProjects([])
        setProjectOpen(false)
        setRows([])
        setLoading(false)
        setLoadError(null)
        setSearched(false)
        setChecked(new Set())
        convInfoRef.current = new Map()
        setFormat('markdown')
        setExporting(false)
        setProgress({ percent: 0, step: '', title: '' })
        setResult(null)
        setExportError(null)
      }, 200)
      return () => clearTimeout(timer)
    }
    // Opening: load projects for the dropdown. The debounced auto-search
    // effect handles the initial query.
    let cancelled = false
    listProjectsWithCounts()
      .then((projects) => {
        if (!cancelled) setAvailableProjects(projects)
      })
      .catch(() => {
        /* dropdown stays empty; search still works */
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Close the project dropdown when interaction leaves the panel. Unlike the
  // other dropdowns in this app, this one lives inside a Radix modal Dialog,
  // which manipulates body pointer-events and has its own DismissableLayer;
  // we therefore listen in the CAPTURE phase (immune to stopPropagation in
  // any bubble handler along the chain) plus a focusout fallback (Tab/programmatic
  // focus moving out of the panel).
  useEffect(() => {
    if (!projectOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (projectBoxRef.current && !projectBoxRef.current.contains(e.target as Node)) {
        setProjectOpen(false)
      }
    }
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (projectBoxRef.current && !projectBoxRef.current.contains(next)) {
        setProjectOpen(false)
      }
    }
    const opts = { capture: true } as const
    document.addEventListener('mousedown', onPointerDown, opts)
    document.addEventListener('touchstart', onPointerDown, opts)
    document.addEventListener('focusout', onFocusOut, opts)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, opts)
      document.removeEventListener('touchstart', onPointerDown, opts)
      document.removeEventListener('focusout', onFocusOut, opts)
    }
  }, [projectOpen])

  const handleClose = useCallback(() => {
    if (exporting) return
    onOpenChange(false)
  }, [exporting, onOpenChange])

  // ------------------------------------------------------------- Selection

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.conversationId)), [rows])
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.conversationId))
  const someChecked = rows.some((r) => checked.has(r.conversationId)) && !allChecked
  const hiddenSelected = useMemo(
    () => [...checked].filter((id) => !visibleIds.has(id)).length,
    [checked, visibleIds],
  )

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someChecked
  }, [someChecked, allChecked])

  const toggleRow = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllVisible = useCallback(() => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (rows.length > 0 && rows.every((r) => next.has(r.conversationId))) {
        for (const r of rows) next.delete(r.conversationId)
      } else {
        for (const r of rows) next.add(r.conversationId)
      }
      return next
    })
  }, [rows])

  // ---------------------------------------------------------------- Export

  const handleExport = useCallback(async () => {
    if (checked.size === 0 || exporting) return
    setExporting(true)
    setExportError(null)
    setResult(null)
    setProgress({ percent: 0, step: '', title: '' })
    try {
      const res = await exportConversationsBatch(
        [...checked].map((id) => {
          const r = convInfoRef.current.get(id)
          return {
            conversationId: id,
            title: r?.title ?? id,
            projectName: r?.projectName ?? undefined,
            updatedAt: r?.updatedAt,
          }
        }),
        { format, onProgress: setProgress },
      )
      setResult(res)
      if (!res.success) setExportError(res.error ?? t('conversation.export.failed'))
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [checked, exporting, format, t])

  // ---------------------------------------------------------------- Render

  const hasActiveFilter =
    query.trim() !== '' || projects.length > 0 || timeRange !== 'all'
  const listEmpty = searched && !loading && rows.length === 0

  const selectedChip =
    'border-primary-600 bg-primary-50 font-semibold text-primary-700 dark:bg-primary-100/25 dark:text-primary-700'
  const idleChip = 'border-subtle text-tertiary hover:bg-muted hover:text-secondary'

  return (
    <BrandDialog open={open} onOpenChange={(next) => (exporting ? undefined : onOpenChange(next))}>
      <BrandDialogContent className="max-w-lg">
        <BrandDialogHeader>
          <BrandDialogTitle>{t('conversation.batchExport.title')}</BrandDialogTitle>
        </BrandDialogHeader>

        <BrandDialogBody className="space-y-3">
          {/* Keyword search with in-input full-text pill */}
          <div className="flex h-8 items-center gap-1.5 rounded-md border border-subtle bg-muted/40 pl-2.5 pr-1 transition-colors focus-within:border-primary">
            <Search className="h-3.5 w-3.5 shrink-0 text-tertiary" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('conversation.batchExport.searchPlaceholder')}
              disabled={exporting}
              className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-tertiary"
            />
            <button
              type="button"
              onClick={() => setFullText((v) => !v)}
              disabled={exporting}
              title={t('conversation.batchExport.searchContent')}
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50 ${
                fullText
                  ? 'border-primary-600/40 bg-primary-50 font-semibold text-primary-700 dark:bg-primary-100/25 dark:text-primary-700'
                  : 'border-subtle text-tertiary hover:bg-muted hover:text-secondary'
              }`}
            >
              {t('conversation.batchExport.fullText')}
            </button>
          </div>

          {/* Time range chips (instant) */}
          <div className="flex flex-wrap gap-1">
            {TIME_RANGE_OPTIONS.map((range) => (
              <button
                key={range}
                type="button"
                onClick={() => setTimeRange(range)}
                disabled={exporting}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                  timeRange === range ? selectedChip : idleChip
                }`}
              >
                {t(`conversation.batchExport.time${range === 'all' ? 'All' : range}`)}
              </button>
            ))}
          </div>
          {timeRange === 'custom' && (
            <div className="flex items-center gap-2 text-xs text-secondary">
              <span className="text-tertiary">{t('conversation.batchExport.from')}</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                disabled={exporting}
                className="h-7 rounded-md border border-subtle bg-muted/40 px-1.5 text-xs outline-none focus:border-primary"
              />
              <span className="text-tertiary">{t('conversation.batchExport.to')}</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={exporting}
                className="h-7 rounded-md border border-subtle bg-muted/40 px-1.5 text-xs outline-none focus:border-primary"
              />
            </div>
          )}

          {/* Projects dropdown */}
          <div className="relative" ref={projectBoxRef}>
            <button
              type="button"
              onClick={() => setProjectOpen((v) => !v)}
              disabled={exporting || availableProjects.length === 0}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors disabled:opacity-50 ${
                projects.length > 0 ? selectedChip : idleChip
              }`}
            >
              {projects.length > 0
                ? t('conversation.batchExport.projectFilterSelected', { count: projects.length })
                : t('conversation.batchExport.projectFilterAll')}
              <ChevronDown className="h-3 w-3" />
            </button>
            {projectOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-60 overflow-y-auto rounded-lg border border-subtle bg-background p-1 shadow-lg">
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium hover:bg-muted/60">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary-600"
                    checked={projects.length === 0}
                    onChange={() => setProjects([])}
                  />
                  {t('conversation.batchExport.projectAll')}
                </label>
                {availableProjects.map((p) => (
                  <label
                    key={p.projectId ?? '__untitled__'}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary-600"
                      checked={projects.includes(p.projectId)}
                      onChange={() =>
                        setProjects((prev) =>
                          prev.includes(p.projectId)
                            ? prev.filter((x) => x !== p.projectId)
                            : [...prev, p.projectId],
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {p.projectId === null ? t('conversation.batchExport.untitledProject') : p.name}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-tertiary">
                      {p.conversationCount}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Load error */}
          {loadError && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{loadError}</span>
            </div>
          )}

          {/* Selection + result toolbar */}
          {!listEmpty && rows.length > 0 && (
            <div className="flex items-center gap-2 px-1 text-xs text-secondary">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-primary-600"
                  checked={allChecked}
                  onChange={toggleAllVisible}
                  disabled={exporting}
                />
                {t('conversation.batchExport.selectAll')}
              </label>
              {checked.size > 0 && (
                <button
                  type="button"
                  onClick={() => setChecked(new Set())}
                  disabled={exporting}
                  className="text-[11px] text-tertiary underline-offset-2 transition-colors hover:text-secondary hover:underline disabled:opacity-50"
                >
                  {t('conversation.batchExport.clearSelection')}
                </button>
              )}
              <span className="ml-auto text-[10px] text-tertiary">
                {t('conversation.batchExport.resultCount', { count: rows.length })}
                {rows.length >= RESULT_LIMIT && (
                  <span className="ml-1">{t('conversation.batchExport.limitHint', { count: RESULT_LIMIT })}</span>
                )}
                {checked.size > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-primary-700">
                      {hiddenSelected === checked.size
                        ? t('conversation.batchExport.selectedAllHidden', { count: checked.size })
                        : hiddenSelected > 0
                          ? t('conversation.batchExport.selectedSomeHidden', {
                              count: checked.size,
                              hidden: hiddenSelected,
                            })
                          : t('conversation.batchExport.selectedCount', { count: checked.size })}
                    </span>
                  </>
                )}
              </span>
            </div>
          )}

          {/* Result list: rows stay visible during re-query (opacity only),
              so filter changes never flash a spinner over the whole list. */}
          <div
            className={`max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-subtle p-1 transition-opacity duration-150 ${
              loading ? 'pointer-events-none opacity-40' : 'opacity-100'
            }`}
          >
            {!loading && rows.length === 0 && (
              <div className="py-8 text-center text-xs text-tertiary">
                {hasActiveFilter
                  ? t('conversation.batchExport.noResults')
                  : t('conversation.batchExport.emptyHint')}
                {hasActiveFilter && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('')
                        setTimeRange('all')
                        setFromDate('')
                        setToDate('')
                        setProjects([])
                      }}
                      className="rounded-md border border-subtle px-2.5 py-1 text-[11px] text-secondary transition-colors hover:border-primary-600/40 hover:bg-primary-50 hover:text-primary-700"
                    >
                      {t('conversation.batchExport.clearFilters')}
                    </button>
                  </div>
                )}
              </div>
            )}
            {rows.map((row) => {
              const isChecked = checked.has(row.conversationId)
              return (
                <label
                  key={row.conversationId}
                  title={row.title}
                  className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors ${
                    isChecked
                      ? 'bg-primary-50 dark:bg-primary-100/20'
                      : 'hover:bg-muted/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 accent-primary-600"
                    checked={isChecked}
                    onChange={() => toggleRow(row.conversationId)}
                    disabled={exporting}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {row.title || t('agent.searchConversations.untitled')}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-tertiary">
                      {row.projectName ?? t('conversation.batchExport.untitledProject')} ·{' '}
                      {formatListTime(row.updatedAt)} ·{' '}
                      {t('conversation.batchExport.messageCount', { count: row.messageCount })}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>

          {/* Export progress */}
          {exporting && (
            <div className="space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="flex items-center gap-2 text-[10px] text-tertiary">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="truncate">
                  {progress.step} {progress.title}
                </span>
              </div>
            </div>
          )}

          {/* Export error */}
          {exportError && !exporting && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{exportError}</span>
            </div>
          )}

          {/* Export result */}
          {result?.success && !exporting && (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 p-2.5 text-xs text-green-700 dark:bg-green-950/30 dark:text-green-300">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t('conversation.batchExport.done', { count: result.exportedCount })}
                {result.skippedCount > 0 &&
                  ` · ${t('conversation.batchExport.skipped', { count: result.skippedCount })}`}
                {' · '}
                {result.filename} ({formatSize(result.size)})
              </span>
            </div>
          )}
        </BrandDialogBody>

        <BrandDialogFooter>
          <div className="mr-auto flex items-center gap-2">
            <span className="text-[11px] text-tertiary">{t('conversation.export.format')}</span>
            <div className="flex overflow-hidden rounded-md border border-subtle">
              {(['markdown', 'json', 'html'] as ConversationExportFormat[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  disabled={exporting}
                  className={`px-2 py-0.5 text-[10px] uppercase transition-colors disabled:opacity-50 ${
                    format === f
                      ? 'bg-muted font-semibold text-secondary'
                      : 'text-tertiary hover:bg-muted hover:text-secondary'
                  }`}
                >
                  {f === 'markdown' ? 'MD' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <BrandButton variant="ghost" onClick={handleClose} disabled={exporting}>
            {t('common.close')}
          </BrandButton>
          <BrandButton
            variant="primary"
            onClick={() => void handleExport()}
            disabled={exporting || loading || checked.size === 0}
          >
            {exporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {progress.step || t('conversation.batchExport.exporting')}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {checked.size > 0
                  ? t('conversation.batchExport.exportCount', { count: checked.size })
                  : t('conversation.export.button')}
              </>
            )}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialogContent>
    </BrandDialog>
  )
}

// ============================================================================
// Utility
// ============================================================================

/** Compact timestamp for list rows: HH:mm today, MM-DD this year, else YYYY-MM-DD. */
function formatListTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  const p = (n: number) => String(n).padStart(2, '0')
  if (sameYear) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
