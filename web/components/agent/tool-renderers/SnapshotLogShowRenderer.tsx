/**
 * Renderer for `snapshot_log` and `snapshot_show` tools.
 *
 * snapshot_log: commit list with date, summary, workspace badge, and "hasMore" indicator.
 * snapshot_show: single commit detail with files, status badge, and optional diff stats.
 *
 * Consumes structured data from ctx.result.data.log / ctx.result.data.show directly.
 */

import { GitBranch, GitCommitHorizontal, MoreHorizontal } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

// ── Shared Types (mirrors opfs/git/index.ts) ──

interface SnapshotCommit {
  id: string
  summary: string | null
  source: string
  status: string
  createdAt: number
  committedAt: number | null
  opCount: number
  isCurrent?: boolean
  workspaceName?: string
}

interface GitLogResult {
  projectId: string
  head: string | null
  commits: SnapshotCommit[]
  hasMore: boolean
}

interface SnapshotFileInfo {
  path: string
  opType: 'create' | 'modify' | 'delete'
  beforeSize: number | null
  afterSize: number | null
}

interface GitShowResult {
  id: string
  summary: string | null
  source: string
  status: string
  createdAt: number
  committedAt: number | null
  opCount: number
  workspaceName?: string
  files: SnapshotFileInfo[]
  diff?: {
    files: Array<{
      path: string
      kind: 'add' | 'delete' | 'modify'
      additions?: number
      deletions?: number
    }>
    summary: { filesChanged: number; insertions: number; deletions: number }
  }
}

// ── Helpers ──

function parseEnvelope(ctx: ToolRenderCtx): Record<string, unknown> | null {
  if (ctx.result && typeof ctx.result === 'object') return ctx.result
  if (ctx.rawResult) {
    try { return JSON.parse(ctx.rawResult) as Record<string, unknown> } catch { /* ignore */ }
  }
  return null
}

function extractLogData(ctx: ToolRenderCtx): GitLogResult | undefined {
  const envelope = parseEnvelope(ctx)
  const data = envelope?.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return undefined
  const log = data.log
  if (log && typeof log === 'object' && Array.isArray((log as GitLogResult).commits)) {
    return log as GitLogResult
  }
  return undefined
}

function extractShowData(ctx: ToolRenderCtx): GitShowResult | undefined {
  const envelope = parseEnvelope(ctx)
  const data = envelope?.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return undefined
  const show = data.show
  if (show && typeof show === 'object' && typeof (show as GitShowResult).id === 'string') {
    return show as GitShowResult
  }
  return undefined
}

function extractOutputText(ctx: ToolRenderCtx): string {
  const envelope = parseEnvelope(ctx)
  const data = envelope?.data as Record<string, unknown> | undefined
  if (!data || typeof data !== 'object') return ''
  return typeof data.output === 'string' ? data.output : ''
}

/** Format timestamp to concise locale string */
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Short commit id for display */
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + '…' : id
}

/** Op type to short status character */
function opTypeToCode(t: string): string {
  switch (t) {
    case 'create': return 'A'
    case 'modify': return 'M'
    case 'delete': return 'D'
    default: return '?'
  }
}

function opTypeColor(t: string): string {
  switch (t) {
    case 'create': return 'text-green-500'
    case 'delete': return 'text-red-500'
    case 'modify': return 'text-yellow-500'
    default: return 'text-neutral-400'
  }
}

/** Status badge color */
function statusColor(status: string): string {
  switch (status) {
    case 'approved': return 'text-green-500'
    case 'committed': return 'text-blue-500'
    case 'rolled_back': return 'text-neutral-400 line-through'
    default: return 'text-neutral-400'
  }
}

function sourceIcon(source: string): string {
  return source === 'tool' ? '🔧' : source === 'review' ? '📝' : '👤'
}

function getSnapshotDisplayTitle(summary: string | null, opCount: number): string {
  return summary || `Saved ${opCount} file${opCount === 1 ? '' : 's'}`
}

// ── Streaming placeholder ──

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2 space-y-1">
      {[60, 80, 50, 70, 55].map((w, i) => (
        <div key={i} className="h-3 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" style={{ width: w + '%' }} />
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// snapshot_log renderer
// ════════════════════════════════════════════════════════════════════════════

registerRenderer({
  name: 'snapshot_log',
  icon: <GitBranch className="h-3.5 w-3.5 text-neutral-400" />,

  Summary(ctx) {
    const t = useT()
    const path = typeof ctx.args.path === 'string' ? ctx.args.path : undefined
    const log = extractLogData(ctx)

    if (!log) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_log</code>
          {path && <span className="max-w-[200px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{path}</span>}
          {ctx.isExecuting && <span className="ml-auto text-xs text-blue-500 shrink-0">{t('common.loading')}</span>}
        </>
      )
    }

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_log</code>
        {path && <span className="max-w-[200px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{path}</span>}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="text-xs text-neutral-400">{log.commits.length}{log.hasMore ? '+' : ''} commits</span>
        </span>
      </>
    )
  },

  Detail(ctx) {
    const log = extractLogData(ctx)

    if (!log) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No commits found</div>
    }

    if (log.commits.length === 0) {
      return <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No commits yet</div>
    }

    const outputText = extractOutputText(ctx)

    return (
      <div className="px-3 py-2 space-y-0.5">
        {log.commits.map((commit, i) => (
          <div
            key={commit.id}
            className="flex items-start gap-2 text-xs py-1 border-b border-neutral-100 dark:border-neutral-800 last:border-0"
            style={{ animation: `tool-row-in .2s ease-out ${i * 30}ms backwards` }}
          >
            {/* Commit icon / current marker */}
            <span className="shrink-0 mt-0.5">
              {commit.isCurrent
                ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mt-1" />
                : <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600 mt-1" />
              }
            </span>

            {/* Main content */}
            <div className="min-w-0 flex-1">
              {/* First line: summary */}
              <div className="flex items-center gap-1.5">
                <span className="truncate text-neutral-700 dark:text-foreground">
                  {getSnapshotDisplayTitle(commit.summary, commit.opCount)}
                </span>
                <span className={statusColor(commit.status)}>{commit.status}</span>
              </div>
              {/* Second line: meta */}
              <div className="flex items-center gap-2 mt-0.5 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                <span className="font-mono">{shortId(commit.id)}</span>
                <span>{fmtDate(commit.createdAt)}</span>
                {commit.workspaceName && (
                  <span className="px-1 py-0 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400 truncate max-w-[150px]">
                    {commit.workspaceName}
                  </span>
                )}
                <span>{sourceIcon(commit.source)}</span>
                {commit.opCount > 0 && <span>{commit.opCount} ops</span>}
              </div>
            </div>
          </div>
        ))}

        {log.hasMore && (
          <div className="flex items-center gap-1 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 pt-1">
            <MoreHorizontal className="w-3 h-3" />
            <span>more commits available</span>
          </div>
        )}

        <div className="flex justify-end pt-1">
          <CopyIconButton content={outputText} />
        </div>
      </div>
    )
  },
})

// ════════════════════════════════════════════════════════════════════════════
// snapshot_show renderer
// ════════════════════════════════════════════════════════════════════════════

registerRenderer({
  name: 'snapshot_show',
  icon: <GitCommitHorizontal className="h-3.5 w-3.5 text-neutral-400" />,

  Summary(ctx) {
    const t = useT()
    const snapshotId = typeof ctx.args.snapshot_id === 'string' ? ctx.args.snapshot_id : undefined
    const show = extractShowData(ctx)

    if (!show) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_show</code>
          {snapshotId && (
            <span className="max-w-[120px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {shortId(snapshotId)}
            </span>
          )}
          {ctx.isExecuting && <span className="ml-auto text-xs text-blue-500 shrink-0">{t('common.loading')}</span>}
        </>
      )
    }

    const totalIns = show.diff?.summary.insertions
    const totalDel = show.diff?.summary.deletions

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_show</code>
        <span className="max-w-[120px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          {shortId(show.id)}
        </span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <span className="text-xs text-neutral-400">{show.files.length} file{show.files.length !== 1 ? 's' : ''}</span>
          {totalIns != null && totalIns > 0 && <span className="text-xs text-green-500 dark:text-green-400">+{totalIns}</span>}
          {totalDel != null && totalDel > 0 && <span className="text-xs text-red-400 dark:text-red-500">-{totalDel}</span>}
        </span>
      </>
    )
  },

  Detail(ctx) {
    const show = extractShowData(ctx)

    if (!show) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">Commit not found</div>
    }

    const outputText = extractOutputText(ctx)
    const hasDiff = show.diff && show.diff.files.length > 0

    return (
      <div className="px-3 py-2 space-y-2">
        {/* Commit header */}
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-neutral-500">{shortId(show.id)}</span>
            <span className={statusColor(show.status)}>{show.status}</span>
            <span className="text-[10px]">{sourceIcon(show.source)}</span>
          </div>
          <div className="text-xs text-neutral-700 dark:text-foreground whitespace-pre-wrap">
            {getSnapshotDisplayTitle(show.summary, show.opCount).split('\n')[0]}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            <span>{fmtDate(show.createdAt)}</span>
            {show.workspaceName && (
              <span className="px-1 py-0 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                {show.workspaceName}
              </span>
            )}
          </div>
        </div>

        {/* Changed files */}
        <div className="space-y-0.5">
          <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-0.5">
            Changed files ({show.files.length})
          </div>
          {show.files.map((f, i) => {
            const code = opTypeToCode(f.opType)
            const diffFile = hasDiff ? show.diff!.files.find(df => df.path === f.path) : undefined
            return (
              <div
                key={i}
                className="flex items-center gap-2 text-xs font-mono"
                style={{ animation: `tool-row-in .2s ease-out ${i * 30}ms backwards` }}
              >
                <span className={opTypeColor(f.opType)}>{code}</span>
                <span className="truncate text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">{f.path}</span>
                {/* Size change or diff stats */}
                {diffFile ? (
                  <>
                    {(diffFile.additions ?? 0) > 0 && <span className="text-green-500 text-[10px] ml-auto">+{diffFile.additions}</span>}
                    {(diffFile.deletions ?? 0) > 0 && <span className="text-red-400 text-[10px]">-{diffFile.deletions}</span>}
                  </>
                ) : (
                  f.beforeSize != null && f.afterSize != null && f.beforeSize !== f.afterSize && (
                    <span className="text-[10px] text-neutral-400 ml-auto">
                      {f.beforeSize} → {f.afterSize}
                    </span>
                  )
                )}
              </div>
            )
          })}
        </div>

        <div className="flex justify-end">
          <CopyIconButton content={outputText} />
        </div>
      </div>
    )
  },
})
