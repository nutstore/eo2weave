/**
 * ActivityHeatmap - Refined contribution heatmap
 *
 * Theme-aware, uses project accent color.
 * Staggered cell reveal animation, summary stats, and a proper React tooltip.
 *
 * P0: Metrics redesigned — shows "N 个文档 · N 次对话 · N 个活跃天"
 *     instead of the opaque "N 次活动" aggregate. Removed streak.
 * P1: Clickable cells — click any cell to expand that day's work
 *     (documents edited, conversations had), with jump-to entries.
 */

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getSQLiteDB } from '@/sqlite/sqlite-database'
import { useT } from '@/i18n'
import { projectWorkspacePath } from '@/lib/route-paths'
import { useTheme } from '@/store/theme.store'
import { AlertCircle, FileText, MessageSquare, X } from 'lucide-react'

//-----------------------------------------------------------------------------
// Types
//-----------------------------------------------------------------------------

type ActivityRange = '1m' | '3m' | '6m' | '1y'

const RANGE_STORAGE_KEY = 'creatorweave:activity-heatmap:range'

const RANGE_CONFIG: Record<
  ActivityRange,
  { weeks: number; days: number; i18nKey: string }
> = {
  '1m': { weeks: 5, days: 30, i18nKey: '1m' },
  '3m': { weeks: 13, days: 90, i18nKey: '3m' },
  '6m': { weeks: 26, days: 180, i18nKey: '6m' },
  '1y': { weeks: 52, days: 365, i18nKey: '1y' },
}

const RANGE_ORDER: ActivityRange[] = ['1m', '3m', '6m', '1y']

const DEFAULT_RANGE: ActivityRange = '6m'

function loadPersistedRange(): ActivityRange {
  if (typeof window === 'undefined') return DEFAULT_RANGE
  try {
    const saved = window.localStorage.getItem(RANGE_STORAGE_KEY)
    if (saved && saved in RANGE_CONFIG) return saved as ActivityRange
  } catch {
    // ignore
  }
  return DEFAULT_RANGE
}

function persistRange(range: ActivityRange) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, range)
  } catch {
    // ignore quota / disabled storage
  }
}

interface DayCell {
  date: string // YYYY-MM-DD
  docs: number // distinct documents edited
  chats: number // user conversation turns
  level: 0 | 1 | 2 | 3 | 4
  dow: number // 0=Sun ... 6=Sat
  // detail items for the expansion panel (P1)
  docItems: DayDetailItem[]
  chatItems: DayDetailItem[]
}

interface DayDetailItem {
  name: string
  workspaceId: string
  projectId: string
  projectName: string
  badge?: string // e.g. "新建"
}

interface ActivityData {
  weeks: DayCell[][]
  maxCount: number
  totalDocs: number
  totalChats: number
  activeDays: number
}

//-----------------------------------------------------------------------------
// Data layer
//-----------------------------------------------------------------------------

interface RawDayRow {
  day: string
  // document aggregation — each record is path@@ws@@proj@@projName, SEP-joined
  docs: number
  docRecords: string
  // chat aggregation — each record is title@@ws@@proj@@projName, SEP-joined
  chats: number
  chatRecords: string
}

const FIELD_SEP = '@@'
const SEP = '\x1f'

function parseRecords(joined: string): DayDetailItem[] {
  if (!joined) return []
  const items: DayDetailItem[] = []
  const seen = new Set<string>()
  for (const rec of joined.split(SEP)) {
    if (!rec) continue
    const [name, workspaceId, projectId, projectName] = rec.split(FIELD_SEP)
    if (!name || !workspaceId || !projectId) continue
    const key = `${workspaceId}::${name}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ name, workspaceId, projectId, projectName: projectName || '' })
  }
  return items
}

async function fetchActivityData(range: ActivityRange): Promise<Map<string, RawDayRow>> {
  const db = getSQLiteDB()
  const since = Date.now() - RANGE_CONFIG[range].days * 24 * 60 * 60 * 1000
  const map = new Map<string, RawDayRow>()

  const emptyRow = (day: string): RawDayRow => ({
    day, docs: 0, docRecords: '', chats: 0, chatRecords: '',
  })

  try {
    // Documents: join each fs_op row with its workspace→project, then bind all
    // fields into ONE concat string (path@@ws@@proj@@projName) so alignment is
    // guaranteed. Dedup happens in parseRecords() on the JS side. All text
    // fields are REPLACE-sanitized against the field separator.
    const docRows = await db.queryAll<{ day: string; docs: number; docRecords: string }>(
      `SELECT
         strftime('%Y-%m-%d', o.created_at / 1000, 'unixepoch', 'localtime') AS day,
         COUNT(*) AS docs,
         GROUP_CONCAT(
           REPLACE(o.path, '${FIELD_SEP}', ' ') || '${FIELD_SEP}' || w.id || '${FIELD_SEP}' || w.project_id || '${FIELD_SEP}' || REPLACE(p.name, '${FIELD_SEP}', ' '),
           '${SEP}'
         ) AS docRecords
       FROM fs_ops o
       JOIN workspaces w ON w.id = o.workspace_id
       JOIN projects p ON p.id = w.project_id
       WHERE o.created_at >= ?
         AND o.op_type IN ('create', 'modify')
         AND o.status != 'discarded'
       GROUP BY day`,
      [since]
    )
    for (const r of docRows) {
      if (r.day) map.set(r.day, { ...emptyRow(r.day), docs: r.docs, docRecords: r.docRecords || '' })
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('[activity] docs query failed', e)
  }

  try {
    const chatRows = await db.queryAll<{ day: string; chats: number; chatRecords: string }>(
      `SELECT
         strftime('%Y-%m-%d', m.timestamp / 1000, 'unixepoch', 'localtime') AS day,
         COUNT(*) AS chats,
         GROUP_CONCAT(
           REPLACE(SUBSTR(c.title, 1, 60), '${FIELD_SEP}', ' ') || '${FIELD_SEP}' || w.id || '${FIELD_SEP}' || w.project_id || '${FIELD_SEP}' || REPLACE(p.name, '${FIELD_SEP}', ' '),
           '${SEP}'
         ) AS chatRecords
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       -- workspace.id == conversation.id by design (see sqlite-schema.sql)
       JOIN workspaces w ON w.id = c.id
       JOIN projects p ON p.id = w.project_id
       WHERE m.timestamp >= ?
         AND m.role = 'user'
       GROUP BY day`,
      [since]
    )
    for (const r of chatRows) {
      if (!r.day) continue
      const existing = map.get(r.day) || emptyRow(r.day)
      existing.chats = r.chats
      existing.chatRecords = r.chatRecords || ''
      map.set(r.day, existing)
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('[activity] chats query failed', e)
  }

  return map
}

//-----------------------------------------------------------------------------
// Helpers
//-----------------------------------------------------------------------------

// (parseRecords above handles field-splitting + dedup)

function getLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0 || max === 0) return 0
  const r = count / max
  if (r < 0.2) return 1
  if (r < 0.45) return 2
  if (r < 0.7) return 3
  return 4
}

function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildGrid(data: Map<string, RawDayRow>, totalWeeks: number): ActivityData {
  const now = new Date()
  now.setHours(0, 0, 0, 0)

  const start = new Date(now)
  start.setDate(start.getDate() - totalWeeks * 7)
  while (start.getDay() !== 0) {
    start.setDate(start.getDate() - 1)
  }

  // Compute max using combined metric (docs + chats) so chat-only days
  // still get a visible color level instead of looking empty.
  let maxCount = 0
  let totalDocs = 0
  let totalChats = 0
  let activeDays = 0
  data.forEach((r) => {
    // Only count days within the visible grid for totals
    const combined = (r.docs || 0) + (r.chats || 0)
    if (combined > maxCount) maxCount = combined
    totalDocs += r.docs || 0
    totalChats += r.chats || 0
    if (combined > 0) activeDays++
  })

  const weeks: DayCell[][] = []
  const cursor = new Date(start)

  while (cursor <= now) {
    const week: DayCell[] = []
    for (let dow = 0; dow < 7; dow++) {
      const key = toDateKey(cursor)
      const raw = data.get(key)
      const docs = raw?.docs || 0
      const chats = raw?.chats || 0
      const docItems = raw ? parseRecords(raw.docRecords) : []
      const chatItems = raw ? parseRecords(raw.chatRecords) : []
      week.push({
        date: key,
        docs,
        chats,
        // Color level reflects combined activity (docs + chats) so days with
        // only conversations still show up on the heatmap.
        level: cursor <= now ? getLevel(docs + chats, maxCount) : 0,
        dow,
        docItems,
        chatItems,
      })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }

  return { weeks, maxCount, totalDocs, totalChats, activeDays }
}

// =============================================
// Component
// =============================================

const CELL_SIZE = 11
const CELL_GAP = 3
const CELL_RADIUS = 2.5
const TOOLTIP_OFFSET_Y = 44

export function ActivityHeatmap() {
  const t = useT()
  const { isDark } = useTheme()
  const navigate = useRouter()
  const [range, setRange] = useState<ActivityRange>(() => loadPersistedRange())
  const [data, setData] = useState<Map<string, RawDayRow>>(new Map())
  const [loaded, setLoaded] = useState(false)
  const [hoveredCell, setHoveredCell] = useState<DayCell | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number; flipped: boolean } | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setLoaded(false)
    setLoadError(false)
    let cancelled = false
    fetchActivityData(range)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoadError(true)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [range, retryKey])

  const handleRetry = useCallback(() => {
    setRetryKey((k) => k + 1)
  }, [])

  const handleRangeChange = useCallback((next: ActivityRange) => {
    if (next === range) return
    setRange(next)
    setSelectedDate(null)
    persistRange(next)
  }, [range])

  const { weeks, totalDocs, totalChats, activeDays } = useMemo(
    () => buildGrid(data, RANGE_CONFIG[range].weeks),
    [data, range]
  )

  const selectedCell = useMemo(() => {
    if (!selectedDate) return null
    for (const week of weeks) {
      for (const cell of week) {
        if (cell.date === selectedDate) return cell
      }
    }
    return null
  }, [selectedDate, weeks])

  const dayLabelsRaw = t('activityHeatmap.days') as unknown
  const dayLabels = Array.isArray(dayLabelsRaw)
    ? dayLabelsRaw
    : ['', 'Mon', '', 'Wed', '', 'Fri', '']

  // Theme-aware cell colors using oklch derived from accent hue
  const getCellColor = useCallback(
    (level: number): string => {
      if (typeof document === 'undefined') {
        return level === 0 ? '#ebedf0' : '#9be9a8'
      }
      const root = document.documentElement
      const primary = root.style.getPropertyValue('--primary').trim()
      if (!primary) {
        const fallback = isDark
          ? ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']
          : ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']
        return fallback[level] || fallback[0]
      }
      const match = primary.match(/(\d+)\s+(\d+)%\s+(\d+)%/)
      if (!match) return '#ebedf0'
      const h = parseInt(match[1])
      const s = parseInt(match[2])
      const l = parseInt(match[3])
      if (level === 0) {
        return isDark
          ? `hsl(${h}, ${Math.max(5, s * 0.2)}%, 14%)`
          : `hsl(${h}, ${Math.max(5, s * 0.2)}%, 94%)`
      }
      const lightnessShift = isDark
        ? [0, 12, 8, 4, -2][level]
        : [0, -8, -14, -22, -32][level]
      return `hsl(${h}, ${Math.min(80, s * 1.2)}%, ${l + lightnessShift}%)`
    },
    [isDark]
  )

  const levelColors = useMemo(() => {
    return [0, 1, 2, 3, 4].map((l) => getCellColor(l))
  }, [getCellColor])

  const monthLabels = useMemo(() => {
    // Inline monthNames to keep it stable across renders (avoids recreating
    // a new array literal each render, which would thrash this memo).
    const monthNamesRaw = t('activityHeatmap.months') as unknown
    const monthNames = Array.isArray(monthNamesRaw)
      ? monthNamesRaw
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const labels: { name: string; span: number }[] = []
    let prevMonth = -1
    for (const week of weeks) {
      const mid = week[3]
      if (!mid) continue
      const m = parseInt(mid.date.split('-')[1], 10) - 1
      if (m !== prevMonth) {
        labels.push({ name: monthNames[m], span: 1 })
        prevMonth = m
      } else if (labels.length > 0) {
        labels[labels.length - 1].span++
      }
    }
    return labels
  }, [weeks, t])

  const handleCellHover = useCallback(
    (cell: DayCell, el: HTMLElement) => {
      setHoveredCell(cell)
      const rect = el.getBoundingClientRect()
      const vw = typeof window !== 'undefined' ? window.innerWidth : 9999
      // Center horizontally but clamp so the tooltip (est. ~140px wide) doesn't
      // overflow off-screen on the rightmost cells.
      const centerX = rect.left + rect.width / 2
      const clampedX = Math.max(80, Math.min(vw - 80, centerX))
      // Flip below the cell if there isn't room above
      const flipped = rect.top < TOOLTIP_OFFSET_Y + 40
      const y = flipped ? rect.bottom + 8 : rect.top - TOOLTIP_OFFSET_Y
      setTooltipPos({ x: clampedX, y, flipped })
    },
    []
  )

  const handleCellLeave = useCallback(() => {
    setHoveredCell(null)
    setTooltipPos(null)
  }, [])

  const handleCellClick = useCallback((cell: DayCell) => {
    setSelectedDate((prev) => (prev === cell.date ? null : cell.date))
  }, [])

  const handleJumpToWorkspace = useCallback(
    (item: DayDetailItem) => {
      navigate.push(projectWorkspacePath(item.projectId, item.workspaceId))
    },
    [navigate]
  )

  if (loadError) {
    return (
      <div className="home-reveal home-delay-3 rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="home-mono text-[11px] uppercase tracking-wider text-secondary dark:text-secondary-foreground">
            {t('projectHome.activity.title')}
          </span>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-10 h-10 rounded-full bg-danger/10 flex items-center justify-center mb-3">
            <AlertCircle className="w-4 h-4 text-danger/80" />
          </div>
          <p className="home-body text-sm text-tertiary dark:text-muted max-w-xs mb-4">
            {t('projectHome.activity.loadFailed')}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="home-body min-h-[32px] px-4 text-xs rounded-md bg-card border border-border text-secondary dark:text-foreground hover:bg-muted/50 transition-colors"
          >
            {t('projectHome.activity.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="home-reveal rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="h-[120px] flex items-center justify-center">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <span className="home-mono text-[11px] text-tertiary dark:text-muted">
              {t('common.loading')}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // P2-b: Empty state — no activity in the selected range
  const isEmpty = totalDocs === 0 && totalChats === 0
  if (isEmpty) {
    return (
      <div className="home-reveal home-delay-3 rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-center gap-2 mb-3">
          <span className="home-mono text-[11px] uppercase tracking-wider text-secondary dark:text-secondary-foreground">
            {t('projectHome.activity.title')}
          </span>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <FileText className="w-4 h-4 text-primary/60" />
          </div>
          <p className="home-body text-sm text-tertiary dark:text-muted max-w-xs">
            {t('projectHome.activity.emptyHint')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="home-reveal home-delay-3 rounded-xl border border-border/60 bg-card/60 p-5">
        {/* Header with range selector and stats */}
        <div className="mb-4">
          {/* Top row: title (left) + range selector (right) */}
          <div className="flex items-center justify-between gap-3">
            <span className="home-mono text-[11px] uppercase tracking-wider text-secondary dark:text-secondary-foreground">
              {t('projectHome.activity.title')}
            </span>

            {/* Range selector */}
            <div
              className="flex rounded-lg border border-border p-0.5 bg-muted/30 dark:bg-muted/30"
              role="radiogroup"
              aria-label={t('projectHome.activity.range.label')}
            >
              {RANGE_ORDER.map((r) => {
                const isActive = range === r
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => handleRangeChange(r)}
                    className={`home-body min-h-[32px] sm:min-h-[24px] px-2 sm:px-2.5 text-[11px] rounded-md transition-all ${
                      isActive
                        ? 'bg-card dark:bg-card text-secondary dark:text-foreground shadow-sm'
                        : 'text-tertiary dark:text-muted hover:text-secondary dark:hover:text-secondary-foreground'
                    }`}
                  >
                    {t(`projectHome.activity.range.${RANGE_CONFIG[r].i18nKey}`)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* P0: Summary stats — horizontal row below header, wraps on narrow screens */}
          {(totalDocs > 0 || totalChats > 0) && (
            <div className="hidden sm:flex items-center gap-x-3 gap-y-1.5 mt-2 flex-wrap text-xs">
              {totalDocs > 0 && (
                <div className="flex items-center gap-1">
                  <FileText className="w-3 h-3 text-primary/70 shrink-0" />
                  <span className="home-mono text-sm font-semibold tabular-nums text-secondary dark:text-foreground">
                    {totalDocs}
                  </span>
                  <span className="text-muted-foreground">
                    {t('projectHome.activity.docsLabel')}
                  </span>
                </div>
              )}
              {totalChats > 0 && (
                <div className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3 text-primary/70 shrink-0" />
                  <span className="home-mono text-sm font-semibold tabular-nums text-secondary dark:text-foreground">
                    {totalChats}
                  </span>
                  <span className="text-muted-foreground">
                    {t('projectHome.activity.chatsLabel')}
                  </span>
                </div>
              )}
              {activeDays > 0 && (
                <div className="flex items-center gap-1">
                  <span className="home-mono text-sm font-semibold tabular-nums text-secondary dark:text-foreground">
                    {activeDays}
                  </span>
                  <span className="text-muted-foreground">
                    {t('projectHome.activity.activeDaysLabel')}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Heatmap grid (desktop only) */}
        <div className="relative overflow-x-auto scrollbar-none hidden sm:block">
          <div className="inline-flex">
            {/* Day labels */}
            <div
              className="flex flex-col shrink-0 mr-1.5"
              style={{ gap: CELL_GAP, paddingTop: 18 }}
            >
              {dayLabels.map((label, i) => (
                <div
                  key={i}
                  className="text-[10px] leading-none text-muted-foreground select-none"
                  style={{ height: CELL_SIZE, width: 20, textAlign: 'right', lineHeight: `${CELL_SIZE}px` }}
                >
                  {label}
                </div>
              ))}
            </div>

            <div>
              {/* Month labels */}
              <div className="flex text-[10px] text-muted-foreground mb-1 select-none">
                {monthLabels.map((m, i) => (
                  <div key={i} style={{ width: m.span * (CELL_SIZE + CELL_GAP), textAlign: 'left' }}>
                    {m.name}
                  </div>
                ))}
              </div>

              {/* Grid cells */}
              <div className="flex" style={{ gap: CELL_GAP }}>
                {weeks.map((week, wi) => (
                  <div key={wi} className="flex flex-col" style={{ gap: CELL_GAP }}>
                    {week.map((cell) => {
                      const isSelected = cell.date === selectedDate
                      const hasActivity = cell.docs > 0 || cell.chats > 0
                      return (
                        <div
                          key={cell.date}
                          className={`heat-cell rounded-[2.5px] ${hasActivity ? 'cursor-pointer' : 'cursor-default'} ${isSelected ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''}`}
                          role={hasActivity ? 'button' : undefined}
                          tabIndex={hasActivity ? 0 : undefined}
                          aria-label={`${cell.date}, ${cell.docs} ${t('projectHome.activity.docsLabel')}, ${cell.chats} ${t('projectHome.activity.chatsLabel')}`}
                          style={{
                            width: CELL_SIZE,
                            height: CELL_SIZE,
                            backgroundColor: levelColors[cell.level],
                            borderRadius: CELL_RADIUS,
                            animationDelay: `${wi * 8}ms`,
                          }}
                          onMouseEnter={(e) => handleCellHover(cell, e.currentTarget)}
                          onMouseLeave={handleCellLeave}
                          onClick={() => hasActivity && handleCellClick(cell)}
                          onKeyDown={(e) => {
                            if (hasActivity && (e.key === 'Enter' || e.key === ' ')) {
                              e.preventDefault()
                              handleCellClick(cell)
                            }
                          }}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center justify-end gap-1.5 mt-3">
          <span className="home-mono text-[10px] text-muted-foreground">
            {t('projectHome.activity.less')}
          </span>
          {levelColors.map((c, i) => (
            <div
              key={i}
              className="rounded-[2px]"
              style={{ width: CELL_SIZE, height: CELL_SIZE, backgroundColor: c, borderRadius: CELL_RADIUS - 0.5 }}
            />
          ))}
          <span className="home-mono text-[10px] text-muted-foreground">
            {t('projectHome.activity.more')}
          </span>
        </div>

        {/* P2-a: Mobile bar chart (recent 14 days) */}
        <MobileBarChart weeks={weeks} colors={levelColors} selectedDate={selectedDate} onSelect={handleCellClick} dayLabels={dayLabels} t={t} />

        {/* P1: Day detail expansion panel */}
        {selectedCell && (
          <DayDetailPanel
            cell={selectedCell}
            onClose={() => setSelectedDate(null)}
            onJump={handleJumpToWorkspace}
          />
        )}

        </div>

      {/* Tooltip rendered outside the card to avoid overflow clipping */}
      {hoveredCell && tooltipPos && (
        <div
          className="fixed pointer-events-none"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y,
            transform: tooltipPos.flipped ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            zIndex: 9999,
          }}
        >
          <div
            className="rounded-lg px-3 py-2 text-xs whitespace-nowrap"
            style={{
              backgroundColor: isDark ? 'rgba(28, 28, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)',
              color: isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)',
              boxShadow: isDark
                ? '0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06)'
                : '0 4px 16px rgba(0,0,0,0.1), 0 0 0 1px rgba(0,0,0,0.04)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            <div className="font-medium" style={{ marginBottom: hoveredCell.docs > 0 || hoveredCell.chats > 0 ? 4 : 0 }}>
              {hoveredCell.date}
            </div>
            {hoveredCell.docs > 0 || hoveredCell.chats > 0 ? (
              <>
                {hoveredCell.docs > 0 && (
                  <div className="flex items-center gap-1.5 opacity-85">
                    <FileText className="w-2.5 h-2.5" />
                    {hoveredCell.docs} {t('projectHome.activity.docsLabel')}
                  </div>
                )}
                {hoveredCell.chats > 0 && (
                  <div className="flex items-center gap-1.5 opacity-85">
                    <MessageSquare className="w-2.5 h-2.5" />
                    {hoveredCell.chats} {t('projectHome.activity.chatsLabel')}
                  </div>
                )}
                <div className="opacity-50 mt-1 pt-1" style={{ borderTop: '1px solid currentColor', fontSize: 10 }}>
                  {t('projectHome.activity.clickToView')}
                </div>
              </>
            ) : (
              <div className="opacity-60 italic">{t('projectHome.activity.noActivity')}</div>
            )}
          </div>
          {/* Arrow — points up when tooltip is above cell, down when flipped below */}
          <div
            className="mx-auto"
            style={{
              width: 0,
              height: 0,
              borderLeft: '4px solid transparent',
              borderRight: '4px solid transparent',
              ...(tooltipPos.flipped
                ? {
                    borderBottom: isDark
                      ? '4px solid rgba(28, 28, 30, 0.95)'
                      : '4px solid rgba(255, 255, 255, 0.95)',
                    marginTop: -1,
                  }
                : {
                    borderTop: isDark
                      ? '4px solid rgba(28, 28, 30, 0.95)'
                      : '4px solid rgba(255, 255, 255, 0.95)',
                  }),
            }}
          />
        </div>
      )}
    </>
  )
}

//-----------------------------------------------------------------------------
// P1: Day detail expansion panel
//-----------------------------------------------------------------------------

interface DayDetailPanelProps {
  cell: DayCell
  onClose: () => void
  onJump: (item: DayDetailItem) => void
}

function DayDetailPanel({ cell, onClose, onJump }: DayDetailPanelProps) {
  const t = useT()
  const { docItems, chatItems } = cell

  if (docItems.length === 0 && chatItems.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-border/60 heat-panel-slide">
        <div className="flex items-center justify-between mb-4">
          <span className="home-body text-sm font-medium text-secondary dark:text-foreground">
            {cell.date}
          </span>
          <button
            onClick={onClose}
            className="text-tertiary hover:text-foreground p-1 rounded"
            aria-label={t('common.close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="py-4 text-center text-sm text-tertiary dark:text-muted">
          {t('projectHome.activity.noActivity')}
        </div>
      </div>
    )
  }

  const renderItems = (
    items: DayDetailItem[],
    icon: React.ReactNode,
    count: number,
    sectionLabel: string
  ) => {
    if (items.length === 0) return null
    return (
      <div className="mb-3 last:mb-0">
        <div className="home-mono text-[10px] uppercase tracking-wider text-tertiary dark:text-muted mb-2 flex items-center gap-1">
          {icon}
          {sectionLabel}（{count}）
        </div>
        {items.slice(0, 8).map((item, idx) => (
          <button
            key={`${item.workspaceId}-${item.name}-${idx}`}
            onClick={() => onJump(item)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-muted/50 dark:hover:bg-muted/30 transition-colors text-left group"
          >
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              {icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="home-body text-sm text-foreground truncate group-hover:text-primary transition-colors">
                {item.name}
              </div>
              <div className="text-[11px] text-tertiary dark:text-muted truncate">
                {item.projectName}
              </div>
            </div>
            {item.badge && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-secondary dark:text-foreground shrink-0">
                {item.badge}
              </span>
            )}
          </button>
        ))}
        {items.length > 8 && (
          <div className="text-[11px] text-tertiary dark:text-muted px-2.5 py-1">
            +{items.length - 8} {t('projectHome.activity.moreItems')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4 pt-4 border-t border-border/60 heat-panel-slide">
      <div className="flex items-center justify-between mb-4">
        <span className="home-body text-sm font-medium text-secondary dark:text-foreground">
          {t('projectHome.activity.dayWork', { date: cell.date })}
        </span>
        <button
          onClick={onClose}
          className="text-tertiary hover:text-foreground p-1 rounded"
          aria-label={t('common.close')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div>
        {renderItems(
          docItems,
          <FileText className="w-3.5 h-3.5 text-primary" />,
          cell.docs,
          t('projectHome.activity.docsLabel')
        )}
        {renderItems(
          chatItems,
          <MessageSquare className="w-3.5 h-3.5 text-primary" />,
          cell.chats,
          t('projectHome.activity.chatsLabel')
        )}
      </div>
      </div>
  )
}

//-----------------------------------------------------------------------------
// P2-a: Mobile bar chart — recent 14 days for small screens
//-----------------------------------------------------------------------------

interface MobileBarChartProps {
  weeks: DayCell[][]
  colors: string[]
  selectedDate: string | null
  onSelect: (cell: DayCell) => void
  dayLabels: string[]
  t: (key: string, params?: Record<string, string | number>) => string
}

function MobileBarChart({ weeks, colors, selectedDate, onSelect, dayLabels, t }: MobileBarChartProps) {
  // Flatten and take last 14 days
  const allDays = weeks.flat().filter((c) => c.date)
  const recent = allDays.slice(-14)
  if (recent.length === 0) return null

  const maxDocs = Math.max(...recent.map((c) => c.docs), 1)
  const maxChats = Math.max(...recent.map((c) => c.chats), 1)

  // Per-metric max for stacked bar normalization (each metric scales to its own
  // max so a docs-heavy day doesn't dwarf chat-heavy days).
  const docsScale = (n: number) => (n / maxDocs) * 100
  const chatsScale = (n: number) => (n / maxChats) * 100

  // Full day-of-week labels for the bar chart (7 entries, index = getDay())
  // Derive from the i18n dayLabels (which has gaps); fall back to short names.
  const fullDayLabels: string[] = (() => {
    const fallback = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    const src = dayLabels.length === 7 ? dayLabels : fallback
    return src.map((d, i) => d || fallback[i] || String(i))
  })()

  // Group into two rows of 7 for compact display
  const row1 = recent.slice(0, 7)
  const row2 = recent.slice(7, 14)

  const renderBar = (cell: DayCell) => {
    const hasActivity = cell.docs > 0 || cell.chats > 0
    const isSelected = cell.date === selectedDate
    const dow = new Date(cell.date + 'T00:00:00').getDay()
    const dayShort = fullDayLabels[dow] || String(dow)



    return (
      <button
        key={cell.date}
        type="button"
        disabled={!hasActivity}
        onClick={() => hasActivity && onSelect(cell)}
        className={`flex flex-col items-center gap-1 flex-1 min-w-0 ${hasActivity ? 'cursor-pointer' : 'cursor-default'} ${isSelected ? 'opacity-100' : 'opacity-80'}`}
        aria-label={`${cell.date}, ${cell.docs} ${t('projectHome.activity.docsLabel')}, ${cell.chats} ${t('projectHome.activity.chatsLabel')}`}
      >
        <div className="w-full flex items-end justify-center gap-0.5" style={{ height: 36 }}>
          {cell.docs > 0 && (
            <div
              className={`w-[5px] rounded-sm transition-all ${isSelected ? 'ring-1 ring-primary ring-offset-1 ring-offset-background' : ''}`}
              style={{
                height: `${Math.max(8, docsScale(cell.docs))}%`,
                backgroundColor: colors[cell.level],
              }}
            />
          )}
          {cell.chats > 0 && (
            <div
              className="w-[5px] rounded-sm transition-all"
              style={{
                height: `${Math.max(8, chatsScale(cell.chats))}%`,
                backgroundColor: colors[cell.level],
                opacity: 0.55,
              }}
            />
          )}
          {!hasActivity && (
            <div
              className="w-[5px] rounded-sm"
              style={{ height: '15%', backgroundColor: colors[0] }}
            />
          )}
        </div>
        <span className={`text-[9px] text-muted-foreground ${hasActivity ? '' : 'opacity-50'}`}>
          {dayShort}
        </span>
      </button>
    )
  }

  return (
    <div className="sm:hidden">
      <div className="flex items-center gap-1 mb-2">
        {[row1, row2].map((row, ri) => (
          <div key={ri} className="flex items-end gap-0.5 flex-1">
            {row.map(renderBar)}
            {/* Pad if row has fewer than 7 */}
            {Array.from({ length: Math.max(0, 7 - row.length) }).map((_, i) => (
              <div key={`pad-${ri}-${i}`} className="flex-1 min-w-0" style={{ height: 50 }} />
            ))}
          </div>
        ))}
      </div>
      {/* Mini legend */}
      <div className="flex items-center justify-center gap-1.5 mt-2 flex-wrap">
        <span className="home-mono text-[9px] text-muted-foreground">
          {t('projectHome.activity.less')}
        </span>
        {colors.map((c, i) => (
          <div key={i} className="rounded-[2px]" style={{ width: 8, height: 8, backgroundColor: c }} />
        ))}
        <span className="home-mono text-[9px] text-muted-foreground">
          {t('projectHome.activity.more')}
        </span>
        <div className="w-px h-3 bg-border mx-0.5" />
        <div className="flex items-center gap-1">
          <div className="w-[5px] h-2 rounded-sm" style={{ backgroundColor: colors[3] }} />
          <span className="home-mono text-[9px] text-muted-foreground">{t('projectHome.activity.docsLabel')}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-[5px] h-2 rounded-sm" style={{ backgroundColor: colors[3], opacity: 0.55 }} />
          <span className="home-mono text-[9px] text-muted-foreground">{t('projectHome.activity.chatsLabel')}</span>
        </div>
      </div>
    </div>
  )
}
