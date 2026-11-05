/**
 * Renderer for `snapshot_status` tool — file-centric working tree status.
 *
 * Data shape from backend (via toolOkJson envelope):
 *   ctx.result = { ok: true, tool: "snapshot_status", version: 2, data: { format, output?, status } }
 *   ctx.result.data.status = GitStatusResult {
 *     workspaceId, branch,
 *     pending: FileChangeEntry[],   // awaiting review
 *     approved: FileChangeEntry[],  // approved, syncing to disk
 *     conflicts: FileChangeEntry[], // sync errors
 *     counts: { pending, approved, conflicts, total }
 *   }
 */

import { GitBranch } from 'lucide-react'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

// ── Status code helpers ────────────────────────────────────────────────────

/** Map backend `FileChangeEntry.type` to git short-status character */
function typeToCode(t: string): string {
  switch (t) {
    case 'create': return 'A'
    case 'modify': return 'M'
    case 'delete': return 'D'
    default: return '?'
  }
}

/** Tailwind colour classes per stage */
const stageColors: Record<string, string> = {
  pending: 'text-yellow-500',
  approved: 'text-green-500',
  failed: 'text-red-500',
}

// ── Data extraction ────────────────────────────────────────────────────────

interface StatusEntry {
  code: string       // A / M / D
  path: string
  stage: 'pending' | 'approved' | 'failed'
  error?: string
}

interface ExtractResult {
  branch: string
  entries: StatusEntry[]
  counts: { pending: number; approved: number; conflicts: number; total: number }
}

/**
 * Extract structured status from the tool result envelope.
 *
 * Tries in order:
 *  1. ctx.result.data.status (structured GitStatusResult)
 *  2. ctx.result.data.output / ctx.rawResult (parse text fallback)
 */
function extractStatus(ctx: ToolRenderCtx): ExtractResult {
  // ── Structured path ──────────────────────────────────────────────────
  const data = ctx.result?.data as Record<string, unknown> | undefined
  const statusObj = data?.status as Record<string, unknown> | undefined

  if (statusObj && typeof statusObj === 'object') {
    const branch = typeof statusObj.branch === 'string' ? statusObj.branch : ''
    const pending = Array.isArray(statusObj.pending) ? statusObj.pending : []
    const approved = Array.isArray(statusObj.approved) ? statusObj.approved : []
    const conflicts = Array.isArray(statusObj.conflicts) ? statusObj.conflicts : []
    const countsObj = (statusObj.counts ?? {}) as Record<string, unknown>

    const entries: StatusEntry[] = []

    for (const f of pending as Record<string, unknown>[]) {
      const p = typeof f.path === 'string' ? f.path : ''
      if (!p) continue
      entries.push({
        code: typeToCode(typeof f.type === 'string' ? f.type : ''),
        path: p,
        stage: 'pending',
      })
    }
    for (const f of approved as Record<string, unknown>[]) {
      const p = typeof f.path === 'string' ? f.path : ''
      if (!p) continue
      entries.push({
        code: typeToCode(typeof f.type === 'string' ? f.type : ''),
        path: p,
        stage: 'approved',
      })
    }
    for (const f of conflicts as Record<string, unknown>[]) {
      const p = typeof f.path === 'string' ? f.path : ''
      if (!p) continue
      entries.push({
        code: typeToCode(typeof f.type === 'string' ? f.type : ''),
        path: p,
        stage: 'failed',
        error: typeof f.error === 'string' ? f.error : undefined,
      })
    }

    if (entries.length > 0 || branch) {
      return {
        branch,
        entries,
        counts: {
          pending: typeof countsObj.pending === 'number' ? countsObj.pending : pending.length,
          approved: typeof countsObj.approved === 'number' ? countsObj.approved : approved.length,
          conflicts: typeof countsObj.conflicts === 'number' ? countsObj.conflicts : conflicts.length,
          total: typeof countsObj.total === 'number' ? countsObj.total : entries.length,
        },
      }
    }
  }

  // ── Text fallback ────────────────────────────────────────────────────
  const textOutput =
    typeof (data as Record<string, unknown> | undefined)?.output === 'string'
      ? (data as Record<string, unknown>).output as string
      : typeof ctx.rawResult === 'string'
        ? safeExtractOutput(ctx.rawResult)
        : ''

  if (textOutput) {
    return { branch: '', entries: parseGitStatusShort(textOutput), counts: { pending: 0, approved: 0, conflicts: 0, total: 0 } }
  }

  return { branch: '', entries: [], counts: { pending: 0, approved: 0, conflicts: 0, total: 0 } }
}

/** Try to extract `output` from a raw JSON string envelope */
function safeExtractOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const d = parsed.data
    if (typeof d === 'string') return d
    if (d && typeof d === 'object') {
      const dObj = d as Record<string, unknown>
      if (typeof dObj.output === 'string') return dObj.output
    }
  } catch { /* not JSON */ }
  return ''
}

/** Parse `git status --short` style output (XY PATH) — text fallback only */
function parseGitStatusShort(text: string): StatusEntry[] {
  return text
    .split('\n')
    .filter(l => l.trim())
    .map(line => ({
      code: line.slice(0, 2).trim() || '?',
      path: line.slice(3).trim(),
      stage: 'pending' as const,
    }))
    .filter(e => e.path)
}

// ── Shared UI pieces ───────────────────────────────────────────────────────

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2 space-y-1">
      {[60, 50, 70].map((w, i) => (
        <div key={i} className="h-3 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" style={{ width: w + '%' }} />
      ))}
    </div>
  )
}

// ── Renderer registration ──────────────────────────────────────────────────

registerRenderer({
  name: 'snapshot_status',
  icon: <GitBranch className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const t = useT()
    if (ctx.isExecuting) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_status</code>
          <span className="text-xs text-blue-500">{t('common.loading')}</span>
        </>
      )
    }

    const { branch, counts } = extractStatus(ctx)
    const label = branch ? `snapshot_status(${branch})` : 'snapshot_status'

    const parts: string[] = []
    if (counts.pending > 0) parts.push(`${counts.pending} pending`)
    if (counts.approved > 0) parts.push(`${counts.approved} syncing`)
    if (counts.conflicts > 0) parts.push(`${counts.conflicts} conflicts`)

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">{label}</code>
        <span className="ml-auto text-xs text-neutral-400 shrink-0">
          {parts.length > 0 ? parts.join(', ') : 'clean'}
        </span>
      </>
    )
  },
  Detail(ctx) {
    const { branch, entries } = extractStatus(ctx)

    if (entries.length === 0) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return (
        <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          Working tree clean
          {branch && <span className="ml-1">on <strong>{branch}</strong></span>}
        </div>
      )
    }

    // Group entries by stage for visual separation
    const pendingEntries = entries.filter(e => e.stage === 'pending')
    const approvedEntries = entries.filter(e => e.stage === 'approved')
    const failedEntries = entries.filter(e => e.stage === 'failed')

    return (
      <div className="px-3 py-2 space-y-2">
        {branch && (
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
            On branch <strong className="text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">{branch}</strong>
          </div>
        )}

        {pendingEntries.length > 0 && (
          <div>
            <div className="text-xs text-yellow-600 dark:text-yellow-400 mb-0.5 font-medium">
              Awaiting review ({pendingEntries.length})
            </div>
            {pendingEntries.map((entry, i) => (
              <FileLine key={i} entry={entry} />
            ))}
          </div>
        )}

        {approvedEntries.length > 0 && (
          <div>
            <div className="text-xs text-green-600 dark:text-green-400 mb-0.5 font-medium">
              Syncing to disk ({approvedEntries.length})
            </div>
            {approvedEntries.map((entry, i) => (
              <FileLine key={i} entry={entry} />
            ))}
          </div>
        )}

        {failedEntries.length > 0 && (
          <div>
            <div className="text-xs text-red-600 dark:text-red-400 mb-0.5 font-medium">
              Sync conflicts ({failedEntries.length})
            </div>
            {failedEntries.map((entry, i) => (
              <FileLine key={i} entry={entry} showError />
            ))}
          </div>
        )}
      </div>
    )
  },
})

// ── Single file row ────────────────────────────────────────────────────────

function FileLine({ entry, showError }: { entry: StatusEntry; showError?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className={stageColors[entry.stage] ?? 'text-neutral-400'}>
        {entry.code.padEnd(2)}
      </span>
      <span className="truncate text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">{entry.path}</span>
      {showError && entry.error && (
        <span className="truncate text-red-400 text-[10px]">— {entry.error}</span>
      )}
    </div>
  )
}
