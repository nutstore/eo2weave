/**
 * RunChangesCard — "what this run changed" card, rendered inline in the
 * message stream after a run that auto-applied its changes.
 *
 * Data source is the persisted auto-apply snapshot (fs_changesets +
 * fs_snapshot_files), the exact same data the Save-history sidebar reads —
 * so nothing here is duplicated or ephemeral. Expanding a file lazily loads
 * its before/after content and renders a diff.
 *
 * Handles large change sets: files beyond a threshold are collapsed behind a
 * "show all" toggle, multiple diffs can be expanded at once, and expanding
 * all streams loads through a small concurrency pool (no single request storm).
 */

import React, { useCallback, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  ChevronDown,
  Plus,
  ArrowRightLeft,
  Trash2,
  Files,
  Maximize2,
  Minimize2,
} from 'lucide-react'
import {
  getFSOverlayRepository,
  type SnapshotFileMetaRecord,
  type SnapshotFileRecord,
} from '@/sqlite/repositories/fs-overlay.repository'
import LazyDiffViewer from '@/components/sync/LazyDiffViewer'
import { useT } from '@/i18n'
// Canonical formatter — the former local copy returned '' for 0 bytes, which
// made a present zero-byte side render no label at all (Sourcery, PR #127).
import { formatBytes } from '@/lib/utils'

/** Above this many files the list collapses behind a "show all" toggle. */
const LIST_COLLAPSE_THRESHOLD = 5
/** Max concurrent diff-content loads when expanding everything at once. */
const LOAD_CONCURRENCY = 4

/** Shared focus ring so keyboard users can locate every control. Uses only
 *  color shades verified present in @creatorweave/config dist. */
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ' +
  'dark:focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-transparent'

function getOpBadgeCls(opType: string): string {
  switch (opType) {
    case 'create': return 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400'
    case 'modify': return 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400'
    case 'delete': return 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
    default: return 'bg-muted text-secondary'
  }
}

function getOpIcon(opType: string) {
  switch (opType) {
    case 'create': return <Plus className="h-3 w-3 text-emerald-500" />
    case 'modify': return <ArrowRightLeft className="h-3 w-3 text-blue-500" />
    case 'delete': return <Trash2 className="h-3 w-3 text-red-500" />
    default: return null
  }
}

interface RunChangesCardProps {
  snapshotId: string
}

export const RunChangesCard: React.FC<RunChangesCardProps> = ({ snapshotId }) => {
  const t = useT()
  const [files, setFiles] = useState<SnapshotFileMetaRecord[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Multiple files can be expanded at once. Contents are cached per path so
  // collapsing/expanding does not re-fetch, and collapse-all is instant.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [contents, setContents] = useState<Record<string, SnapshotFileRecord>>({})
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  // Whole card collapsed (just the header row).
  const [collapsed, setCollapsed] = useState(false)

  // Lazy-load the file list on first mount.
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const repo = getFSOverlayRepository()
    repo
      .listSnapshotFiles(snapshotId)
      .then((rows) => {
        if (!cancelled) {
          setFiles(rows)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [snapshotId])

  const loadFile = useCallback(async (path: string) => {
    const repo = getFSOverlayRepository()
    setLoadingPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
    try {
      const content = await repo.getSnapshotFileContent(snapshotId, path)
      if (!content) return
      setContents((prev) => {
        if (prev[path]) return prev
        return { ...prev, [path]: content }
      })
    } catch {
      // Leave content missing so the row shows "no diff" rather than crashing.
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [snapshotId])

  // Load contents through a small concurrency pool so "expand all" never fires
  // N simultaneous DB reads / blocks the main thread on a large batch.
  const loadFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    let nextIndex = 0
    const worker = async () => {
      while (nextIndex < paths.length) {
        const path = paths[nextIndex++]
        await loadFile(path)
      }
    }
    const workers = Math.min(LOAD_CONCURRENCY, paths.length)
    void Promise.all(Array.from({ length: workers }, () => worker()))
  }, [loadFile])

  const handleToggleFile = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    // Eagerly load this file's content so the diff is ready when expanded.
    void loadFile(path)
  }, [loadFile])

  const handleExpandAll = useCallback(() => {
    if (!files) return
    setExpandedPaths(new Set(files.map((f) => f.path)))
    // Mark all expanded first (instant UI), stream the content loads.
    loadFiles(files.map((f) => f.path))
  }, [files, loadFiles])

  const handleCollapseAll = useCallback(() => {
    setExpandedPaths(new Set())
  }, [])

  const stats = useMemo(() => {
    const list = files || []
    return {
      create: list.filter((f) => f.opType === 'create').length,
      modify: list.filter((f) => f.opType === 'modify').length,
      delete: list.filter((f) => f.opType === 'delete').length,
      total: list.length,
    }
  }, [files])

  const isTextDiff = useCallback((content: SnapshotFileRecord) => {
    return (
      (content.beforeContentKind === 'text' || content.beforeContentKind === 'none') &&
      (content.afterContentKind === 'text' || content.afterContentKind === 'none')
    )
  }, [])

  const isBinary = useCallback((content: SnapshotFileRecord) => {
    return content.beforeContentKind === 'binary' || content.afterContentKind === 'binary'
  }, [])

  const fileOpLabel = useCallback((opType: string) => {
    return opType === 'create'
      ? t('runChanges.fileOpCreate')
      : opType === 'modify'
        ? t('runChanges.fileOpModify')
        : t('runChanges.fileOpDelete')
  }, [t])

  const visibleFiles = useMemo(() => {
    if (!files) return []
    if (files.length > LIST_COLLAPSE_THRESHOLD && !showAll) {
      return files.slice(0, LIST_COLLAPSE_THRESHOLD)
    }
    return files
  }, [files, showAll])

  const hiddenCount = useMemo(() => {
    if (!files) return 0
    return Math.max(0, files.length - visibleFiles.length)
  }, [files, visibleFiles])

  const hasExpanded = expandedPaths.size > 0

  return (
    <div className="overflow-hidden rounded-lg border border-primary-500/20 bg-primary-50/40 dark:border-primary-500/20 dark:bg-primary-800/20">
      {/* Header */}
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button
          type="button"
          className={`flex min-w-0 flex-1 items-center gap-2 rounded text-left transition-colors ${FOCUS_RING}`}
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
        >
          <span className="shrink-0 text-primary-500" aria-hidden="true">{collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
          <Files className="h-3.5 w-3.5 shrink-0 text-primary-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-primary-700 dark:text-primary-400">
            {t('runChanges.title')}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-secondary">
          {stats.create > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{stats.create}</span>}
          {stats.modify > 0 && <span className="text-blue-600 dark:text-blue-400">~{stats.modify}</span>}
          {stats.delete > 0 && <span className="text-red-600 dark:text-red-400">-{stats.delete}</span>}
          <span className="inline-flex items-center gap-0.5 text-primary-600 dark:text-primary-400">
            <Check className="h-3 w-3" aria-hidden="true" />
            {stats.total}
          </span>
        </span>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="border-t border-primary-500/10">
          {loading && (
            <p className="px-3 py-2 text-[11px] text-secondary" role="status">{t('runChanges.loading')}</p>
          )}
          {!loading && error && (
            <p className="px-3 py-2 text-[11px] text-destructive" role="alert">{error}</p>
          )}
          {!loading && !error && files && files.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-secondary">{t('runChanges.noFiles')}</p>
          )}
          {!loading && !error && files && files.length > 0 && (
            <>
              {/* Toolbar: expand/collapse all diffs */}
              <div className="flex items-center justify-end gap-1 border-b border-primary-500/10 px-2 py-1">
                {hasExpanded ? (
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-secondary transition-colors hover:bg-white/60 hover:text-primary dark:hover:bg-white/5 ${FOCUS_RING}`}
                    onClick={handleCollapseAll}
                  >
                    <Minimize2 className="h-3 w-3" aria-hidden="true" />
                    {t('runChanges.collapseAllDiffs')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-secondary transition-colors hover:bg-white/60 hover:text-primary dark:hover:bg-white/5 ${FOCUS_RING}`}
                    onClick={handleExpandAll}
                  >
                    <Maximize2 className="h-3 w-3" aria-hidden="true" />
                    {t('runChanges.expandAllDiffs')}
                  </button>
                )}
              </div>

              <ul className="divide-y divide-neutral-100/70 dark:divide-neutral-800/70">
                {visibleFiles.map((file) => {
                  const isExpanded = expandedPaths.has(file.path)
                  const content = contents[file.path]
                  const isContentLoading = loadingPaths.has(file.path)
                  const diffId = `run-changes-diff-${file.path}`
                  const diffContent =
                    content && isTextDiff(content)
                      ? {
                          original: content.beforeContentText ?? '',
                          modified: content.afterContentText ?? '',
                          path: content.path,
                        }
                      : null
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-white/60 dark:hover:bg-white/5 ${FOCUS_RING}`}
                        onClick={() => handleToggleFile(file.path)}
                        aria-expanded={isExpanded}
                        aria-controls={diffId}
                      >
                        <span className="shrink-0 text-tertiary" aria-hidden="true">
                          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                        </span>
                        {getOpIcon(file.opType)}
                        <span className="min-w-0 flex-1 truncate font-mono text-secondary" title={file.path}>
                          {file.path}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${getOpBadgeCls(file.opType)}`}>
                          {fileOpLabel(file.opType)}
                        </span>
                        <span className="shrink-0 text-tertiary">
                          {/* Side PRESENCE (contentKind !== 'none'), not byte size,
                              decides whether a side's label renders: a real
                              zero-byte file is 'text' with size 0 and must show
                              its "0 B" label, not be treated as absent (#124). */}
                          {file.beforeContentKind !== 'none' && formatBytes(file.beforeContentSize)}
                          {file.beforeContentKind !== 'none' && file.afterContentKind !== 'none' ? ' → ' : ''}
                          {file.afterContentKind !== 'none' && formatBytes(file.afterContentSize)}
                        </span>
                      </button>
                      {isExpanded && (
                        <div id={diffId} className="border-t border-neutral-100/70 px-3 py-2 dark:border-neutral-800/70">
                          {isContentLoading && (
                            <p className="text-[11px] text-secondary" role="status">{t('runChanges.loadingFile')}</p>
                          )}
                          {!isContentLoading && diffContent && (
                            <LazyDiffViewer
                              original={diffContent.original}
                              modified={diffContent.modified}
                              path={diffContent.path}
                              defaultContext={3}
                            />
                          )}
                          {!isContentLoading && content && isBinary(content) && (
                            <p className="text-[11px] text-secondary">{t('runChanges.binaryFileHint')}</p>
                          )}
                          {!isContentLoading && content && !isTextDiff(content) && !isBinary(content) && file.opType === 'delete' && (
                            <p className="text-[11px] text-secondary">{t('runChanges.fileDeletedHint')}</p>
                          )}
                          {!isContentLoading && !content && (
                            <p className="text-[11px] text-secondary">{t('runChanges.noDiff')}</p>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              {/* Collapsed list footer */}
              {hiddenCount > 0 && (
                <div className="border-t border-primary-500/10 px-3 py-1.5">
                  <button
                    type="button"
                    className={`rounded text-[11px] font-medium text-primary-600 transition-colors hover:underline dark:text-primary-400 ${FOCUS_RING}`}
                    onClick={() => setShowAll(true)}
                  >
                    {t('runChanges.showAllFiles', { count: hiddenCount })}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
