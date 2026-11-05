/**
 * Renderer for `snapshot_diff` tool — file change summary with +/- stats.
 *
 * Consumes structured GitDiffResult from ctx.result.data.diff directly,
 * instead of parsing text patches.
 */

import { GitBranch } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

// ── Types (mirrors opfs/git/index.ts) ──

interface DiffFile {
  path: string
  kind: 'add' | 'delete' | 'modify'
  additions?: number
  deletions?: number
  hunks: Array<{ header: string; lines: Array<{ type: 'add' | 'delete' | 'context'; content: string }> }>
}

interface GitDiffResult {
  workspaceId: string
  from: string | null
  to: string | null
  files: DiffFile[]
  summary: { filesChanged: number; insertions: number; deletions: number }
}

// ── Helpers ──

/** Safely parse the envelope from either ctx.result or rawResult fallback */
function parseEnvelope(ctx: ToolRenderCtx): Record<string, unknown> | null {
  if (ctx.result && typeof ctx.result === 'object') return ctx.result
  if (ctx.rawResult) {
    try { return JSON.parse(ctx.rawResult) as Record<string, unknown> } catch (e) {
      console.error('[SnapshotDiffRenderer] JSON.parse failed:', (e as Error).message)
      console.error('[SnapshotDiffRenderer] rawResult type:', typeof ctx.rawResult, 'length:', ctx.rawResult.length)
      console.error('[SnapshotDiffRenderer] rawResult first 200 chars:', ctx.rawResult.slice(0, 200))
    }
  }
  return null
}

/** Extract structured GitDiffResult from the tool envelope */
function extractDiffData(ctx: ToolRenderCtx): GitDiffResult | undefined {
  const envelope = parseEnvelope(ctx)
  const data = envelope?.data
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, unknown>
  const diff = obj.diff
  if (diff && typeof diff === 'object' && Array.isArray((diff as GitDiffResult).files)) {
    return diff as GitDiffResult
  }
  return undefined
}

/** Extract text output for copy button */
function extractOutputText(ctx: ToolRenderCtx): string {
  const envelope = parseEnvelope(ctx)
  const data = envelope?.data
  if (!data || typeof data !== 'object') return ''
  const obj = data as Record<string, unknown>
  return typeof obj.output === 'string' ? obj.output : ''
}

function kindToStatus(kind: DiffFile['kind']): string {
  return kind === 'add' ? 'A' : kind === 'delete' ? 'D' : 'M'
}

const MODE_LABELS: Record<string, string> = {
  cached: '已暂存',
  snapshot: '历史快照',
}

// ── Renderer ──

registerRenderer({
  name: 'snapshot_diff',
  icon: <GitBranch className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const t = useT()
    const mode = typeof ctx.args.mode === 'string' ? ctx.args.mode : 'working'
    const path = typeof ctx.args.path === 'string' ? ctx.args.path : undefined
    const diff = extractDiffData(ctx)

    if (!diff) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_diff</code>
          {MODE_LABELS[mode] && <span className="text-xs text-neutral-400">{MODE_LABELS[mode]}</span>}
          {path && <span className="max-w-[200px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{path}</span>}
          {ctx.isExecuting && <span className="ml-auto text-xs text-blue-500 shrink-0">{t('common.loading')}</span>}
        </>
      )
    }

    const { filesChanged, insertions, deletions } = diff.summary

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">snapshot_diff</code>
        {MODE_LABELS[mode] && <span className="text-xs text-neutral-400">{MODE_LABELS[mode]}</span>}
        {path && <span className="max-w-[200px] truncate font-mono text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{path}</span>}
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <span className="text-xs text-neutral-400">{filesChanged} file{filesChanged !== 1 ? 's' : ''}</span>
          {insertions > 0 && <span className="text-xs text-green-500 dark:text-green-400">+{insertions}</span>}
          {deletions > 0 && <span className="text-xs text-red-400 dark:text-red-500">-{deletions}</span>}
        </span>
      </>
    )
  },
  Detail(ctx) {
    const diff = extractDiffData(ctx)
    const mode = typeof ctx.args.mode === 'string' ? ctx.args.mode : 'working'
    const path = typeof ctx.args.path === 'string' ? ctx.args.path : undefined

    if (!diff) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return (
        <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No changes</div>
      )
    }

    if (diff.files.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No changes</div>
      )
    }

    const diffText = extractOutputText(ctx)

    return (
      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
          {MODE_LABELS[mode] && <span>{MODE_LABELS[mode]}</span>}
          {path && <span className="font-mono truncate">{path}</span>}
        </div>

        <div className="space-y-0.5">
          {diff.files.map((f, i) => {
            const status = kindToStatus(f.kind)
            return (
              <div key={i} className="flex items-center gap-2 text-xs font-mono" style={{ animation: `tool-row-in .2s ease-out ${i * 40}ms backwards` }}>
                <span className={
                  status === 'A' ? 'text-green-500' :
                  status === 'D' ? 'text-red-500' :
                  'text-yellow-500'
                }>{status}</span>
                <span className="truncate text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">{f.path}</span>
                {(f.additions ?? 0) > 0 && <span className="text-green-500 text-[10px] ml-auto">+{f.additions}</span>}
                {(f.deletions ?? 0) > 0 && <span className="text-red-400 text-[10px]">-{f.deletions}</span>}
              </div>
            )
          })}
        </div>

        <div className="flex justify-end">
          <CopyIconButton content={diffText} />
        </div>
      </div>
    )
  },
})

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2 space-y-1">
      {[50, 70, 40, 60].map((w, i) => (
        <div key={i} className="h-3 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" style={{ width: w + '%' }} />
      ))}
    </div>
  )
}
