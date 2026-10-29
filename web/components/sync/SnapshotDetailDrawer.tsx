/**
 * SnapshotDetailDrawer — right-side drawer for viewing snapshot details.
 *
 * Uses the project's Drawer component.
 * Layout: top-down single column — header → metadata bar → file list with inline diff.
 * Click a file to expand and view diff (LazyDiffViewer).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getFSOverlayRepository,
  type SnapshotFileMetaRecord,
  type SnapshotFileRecord,
  type SnapshotRecord,
} from '@/sqlite/repositories/fs-overlay.repository'
import { useT } from '@/i18n'
import { Drawer } from '@/components/ui/drawer'
import LazyDiffViewer from '@/components/sync/LazyDiffViewer'
import { Binary, Trash2, Plus, ArrowRightLeft, Copy, Check, ChevronRight, ChevronDown } from 'lucide-react'
import { formatBytes } from '@/lib/utils'

// ── Helpers ──────────────────────────────────────────────────────────────

function formatTime(ts: number | null): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

function getSnapshotTitle(snapshot: Pick<SnapshotRecord, 'summary' | 'opCount'>, t: ReturnType<typeof useT>): string {
  return snapshot.summary || t('sidebar.snapshotList.autoSnapshotTitle', { count: snapshot.opCount })
}

function getOpIcon(opType: string) {
  switch (opType) {
    case 'create': return <Plus className="h-3 w-3 text-emerald-500" />
    case 'modify': return <ArrowRightLeft className="h-3 w-3 text-blue-500" />
    case 'delete': return <Trash2 className="h-3 w-3 text-red-500" />
    default: return null
  }
}

function getOpBadgeCls(opType: string): string {
  switch (opType) {
    case 'create': return 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400'
    case 'modify': return 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400'
    case 'delete': return 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
    default: return 'bg-muted text-secondary'
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])
  return (
    <button
      type="button"
      className="shrink-0 rounded p-0.5 text-tertiary transition-colors hover:bg-muted hover:text-primary"
      onClick={handleCopy}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

// ── Types ────────────────────────────────────────────────────────────────

interface SnapshotDetailDrawerProps {
  open: boolean
  onClose: () => void
  snapshot: SnapshotRecord | null
}

// ── Main Component ───────────────────────────────────────────────────────

export const SnapshotDetailDrawer: React.FC<SnapshotDetailDrawerProps> = ({
  open,
  onClose,
  snapshot,
}) => {
  const t = useT()
  const [files, setFiles] = useState<SnapshotFileMetaRecord[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [fileContent, setFileContent] = useState<SnapshotFileRecord | null>(null)
  const [fileContentLoading, setFileContentLoading] = useState(false)
  const [fileContentError, setFileContentError] = useState<string | null>(null)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  // Load file list when snapshot changes
  useEffect(() => {
    if (!open || !snapshot) {
      setFiles([])
      setFileContent(null)
      setExpandedFile(null)
      return
    }
    let cancelled = false
    setFilesLoading(true)
    setFileContent(null)
    setExpandedFile(null)
    const repo = getFSOverlayRepository()
    repo.listSnapshotFiles(snapshot.id).then((result) => {
      if (!cancelled) { setFiles(result); setFilesLoading(false) }
    }).catch(() => { if (!cancelled) setFilesLoading(false) })
    return () => { cancelled = true }
  }, [open, snapshot])

  // Toggle file expansion
  const handleToggleFile = useCallback(async (path: string) => {
    if (!snapshot) return
    if (expandedFile === path) { setExpandedFile(null); return }
    setExpandedFile(path)
    setFileContent(null)
    setFileContentError(null)
    setFileContentLoading(true)
    try {
      const repo = getFSOverlayRepository()
      const content = await repo.getSnapshotFileContent(snapshot.id, path)
      setFileContent(content)
    } catch (err) {
      setFileContentError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setFileContentLoading(false)
    }
  }, [snapshot, expandedFile])

  const diffContent = useMemo(() => {
    if (!fileContent) return null
    return {
      original: fileContent.beforeContentText ?? '',
      modified: fileContent.afterContentText ?? '',
      path: fileContent.path,
    }
  }, [fileContent])

  const isTextDiff = useMemo(() => {
    if (!fileContent) return false
    return (
      (fileContent.beforeContentKind === 'text' || fileContent.beforeContentKind === 'none') &&
      (fileContent.afterContentKind === 'text' || fileContent.afterContentKind === 'none')
    )
  }, [fileContent])

  const isBinary = useMemo(() => {
    if (!fileContent) return false
    return fileContent.beforeContentKind === 'binary' || fileContent.afterContentKind === 'binary'
  }, [fileContent])

  const stats = useMemo(() => ({
    create: files.filter((f) => f.opType === 'create').length,
    modify: files.filter((f) => f.opType === 'modify').length,
    delete: files.filter((f) => f.opType === 'delete').length,
  }), [files])

  const statusMap: Record<string, { label: string; dot: string }> = {
    approved: { label: t('sidebar.snapshotList.approved'), dot: 'bg-emerald-400' },
    committed: { label: t('sidebar.snapshotList.committed'), dot: 'bg-blue-400' },
    draft: { label: t('sidebar.snapshotList.draft'), dot: 'bg-amber-400' },
    rolled_back: { label: t('sidebar.snapshotList.rolledBack'), dot: 'bg-neutral-400' },
  }

  if (!snapshot) return null

  const status = statusMap[snapshot.status] || { label: snapshot.status, dot: 'bg-neutral-400' }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={getSnapshotTitle(snapshot, t)}
      width="clamp(480px, 60vw, 800px)"
    >
      <div className="flex h-full flex-col">
      {/* Metadata row */}
      <div className="flex items-center gap-2.5 border-b border-subtle px-5 py-1.5 text-[11px] shrink-0 text-secondary whitespace-nowrap overflow-x-auto">
        <span className="flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        {snapshot.isCurrent && (
          <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
            {t('sidebar.snapshotList.current')}
          </span>
        )}
        <span className="text-tertiary">{snapshot.workspaceName || snapshot.workspaceId}</span>
        <span className="text-tertiary">{formatTime(snapshot.committedAt || snapshot.createdAt)}</span>
        <span className="flex items-center gap-0.5 font-mono text-tertiary">
          {snapshot.id.slice(0, 8)}
          <CopyButton text={snapshot.id} />
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {stats.create > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{stats.create}</span>}
          {stats.modify > 0 && <span className="text-blue-600 dark:text-blue-400">~{stats.modify}</span>}
          {stats.delete > 0 && <span className="text-red-600 dark:text-red-400">-{stats.delete}</span>}
          <span className="text-tertiary">{files.length} {t('sidebar.snapshotDetail.files')}</span>
        </span>
      </div>

      {/* File list with inline diff */}
      <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
        {filesLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-secondary">{t('sidebar.snapshotList.loadingDetails')}</p>
          </div>
        )}
        {!filesLoading && files.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-secondary">{t('sidebar.snapshotList.noDetails')}</p>
          </div>
        )}
        {!filesLoading && files.map((file) => {
          const isExpanded = expandedFile === file.path
          return (
            <div key={file.path} className="border-b border-subtle last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2 text-[11px] transition-colors hover:bg-muted/40"
                onClick={() => handleToggleFile(file.path)}
              >
                <span className="shrink-0 text-tertiary">
                  {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </span>
                {getOpIcon(file.opType)}
                <span className="min-w-0 flex-1 truncate text-left text-secondary" title={file.path}>
                  {file.path}
                </span>
                <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${getOpBadgeCls(file.opType)}`}>
                  {t(`sidebar.snapshotList.fileOp${file.opType.charAt(0).toUpperCase() + file.opType.slice(1)}`)}
                </span>
                <span className="shrink-0 text-tertiary">
                  {file.beforeContentSize > 0 ? formatBytes(file.beforeContentSize) : ''}
                  {file.beforeContentSize > 0 && file.afterContentSize > 0 ? ' → ' : ''}
                  {file.afterContentSize > 0 ? formatBytes(file.afterContentSize) : ''}
                </span>
              </button>
              {isExpanded && (
                <div className="border-t border-subtle max-h-[60vh] overflow-y-auto">
                  {fileContentLoading && (
                    <div className="flex items-center justify-center py-8">
                      <p className="text-xs text-secondary">{t('sidebar.snapshotDetail.loadingFile')}</p>
                    </div>
                  )}
                  {fileContentError && (
                    <div className="flex items-center justify-center py-8">
                      <p className="text-xs text-destructive">{fileContentError}</p>
                    </div>
                  )}
                  {fileContent && isTextDiff && diffContent && (
                    <LazyDiffViewer
                      original={diffContent.original}
                      modified={diffContent.modified}
                      path={diffContent.path}
                      defaultContext={3}
                    />
                  )}
                  {fileContent && isBinary && (
                    <div className="flex flex-col items-center justify-center gap-2 py-8">
                      <Binary className="h-6 w-6 text-secondary" />
                      <p className="text-xs text-secondary">{t('sidebar.snapshotDetail.binaryFileHint')}</p>
                    </div>
                  )}
                  {fileContent && !isTextDiff && !isBinary && fileContent.opType === 'delete' && (
                    <div className="flex flex-col items-center justify-center gap-2 py-8">
                      <Trash2 className="h-6 w-6 text-red-400" />
                      <p className="text-xs text-secondary">{t('sidebar.snapshotDetail.fileDeletedHint')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      </div>
    </Drawer>
  )
}
