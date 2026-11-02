/**
 * AssetsPopover — a small floating button in the conversation view
 * that expands to show all assets in the current workspace.
 *
 * Preview is delegated to the shared FilePreview panel via `onPreviewAsset`.
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import {
  Paperclip,
  X,
  Download,
  Eye,
  Trash2,
  FileText,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  FileSpreadsheet,
  FileCode,
  FileArchive,
  Music,
  Video,
  Trash,
} from 'lucide-react'
import { useT } from '@/i18n'
import { useAssetInventoryStore } from '@/store/asset-inventory.store'
import type { AssetInventoryItem } from '@/store/asset-inventory.store'
import { inferMimeType } from '@/types/asset'
import { readAssetBlob, downloadAssetBlob } from './asset-utils'
import { formatBytes as formatFileSize } from '@/lib/utils'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function downloadAsset(asset: AssetInventoryItem): Promise<void> {
  await downloadAssetBlob(asset.path, asset.name)
}

function getFileIcon(mime: string) {
  if (mime.startsWith('image/')) return <ImageIcon className="h-4 w-4 text-blue-500" />
  if (mime.includes('spreadsheet') || mime.includes('excel'))
    return <FileSpreadsheet className="h-4 w-4 text-green-600" />
  if (mime.includes('presentation') || mime.includes('powerpoint'))
    return <FileText className="h-4 w-4 text-orange-500" />
  if (mime.includes('word') || mime.includes('document'))
    return <FileText className="h-4 w-4 text-blue-600" />
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('typescript'))
    return <FileCode className="h-4 w-4 text-neutral-400" />
  if (mime.startsWith('audio/')) return <Music className="h-4 w-4 text-purple-500" />
  if (mime.startsWith('video/')) return <Video className="h-4 w-4 text-red-500" />
  if (mime.includes('zip') || mime.includes('gzip') || mime.includes('tar'))
    return <FileArchive className="h-4 w-4 text-yellow-600" />
  return <FileText className="h-4 w-4 text-neutral-400" />
}

// ─── Asset Row ──────────────────────────────────────────────────────────────

function AssetRow({
  asset,
  onDelete,
  onPreview,
}: {
  asset: AssetInventoryItem
  onDelete: (path: string) => void
  onPreview: (name: string, blob: Blob) => void
}) {
  const t = useT()
  const mime = asset.mimeType || inferMimeType(asset.path)
  const isImage = mime.startsWith('image/')
  const [previewing, setPreviewing] = useState(false)

  // Image thumbnail
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    readAssetBlob(asset.path).then((blob) => {
      if (blob && !cancelled) setThumbUrl(URL.createObjectURL(blob))
    })
    return () => { cancelled = true }
  }, [isImage, asset.path])
  useEffect(() => {
    return () => { if (thumbUrl) URL.revokeObjectURL(thumbUrl) }
  }, [thumbUrl])

  const handlePreview = useCallback(async () => {
    if (previewing) return
    setPreviewing(true)
    try {
      const blob = await readAssetBlob(asset.path)
      if (blob) onPreview(asset.name, blob)
    } finally {
      setPreviewing(false)
    }
  }, [asset.name, asset.path, onPreview, previewing])

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-700/50 group/row rounded-md">
      {/* Thumbnail or icon */}
      {isImage && thumbUrl ? (
        <button
          type="button"
          onClick={handlePreview}
          className="h-7 w-7 flex-shrink-0 rounded overflow-hidden bg-neutral-100 dark:bg-neutral-900 cursor-pointer"
        >
          <img src={thumbUrl} alt={asset.name} className="h-full w-full object-cover" />
        </button>
      ) : (
        <span className="flex-shrink-0 h-7 w-7 flex items-center justify-center">
          {getFileIcon(mime)}
        </span>
      )}

      {/* File name + meta */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-neutral-700 dark:text-foreground">
          {asset.name}
        </div>
        {asset.path !== asset.name && (
          <div className="truncate text-[10px] text-neutral-400">
            {asset.path}
          </div>
        )}
        <div className="text-[10px] text-neutral-400">
          {formatFileSize(asset.size)} · {formatTime(asset.lastModified)}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewing}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-600 dark:hover:text-neutral-300 disabled:opacity-50"
          title={t('assets.preview', { defaultValue: 'Preview' })}
        >
          {previewing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={() => downloadAsset(asset)}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-600 dark:hover:text-neutral-300"
          title={t('assets.download', { defaultValue: 'Download' })}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(asset.path)}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-600 dark:hover:text-neutral-300"
          title={t('assets.delete', { defaultValue: 'Delete' })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface AssetsPopoverProps {
  /** Active conversation ID to scope assets */
  convId: string | undefined
  /** Open the shared FilePreview drawer with a pre-loaded blob */
  onPreviewAsset?: (fileName: string, blob: Blob) => void
}

export const AssetsPopover = memo(function AssetsPopover({ convId, onPreviewAsset }: AssetsPopoverProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const items = useAssetInventoryStore((s) => s.items)
  const loading = useAssetInventoryStore((s) => s.loading)
  const loadedWorkspaceId = useAssetInventoryStore((s) => s.loadedWorkspaceId)
  const refresh = useAssetInventoryStore((s) => s.refresh)
  const deleteAsset = useAssetInventoryStore((s) => s.deleteAsset)
  const clearAll = useAssetInventoryStore((s) => s.clearAll)

  const [confirmClear, setConfirmClear] = useState(false)

  // Refresh when convId changes (initial load & workspace switch)
  // Also refresh when popover opens if workspace changed since last load
  useEffect(() => {
    if (convId && convId !== loadedWorkspaceId) {
      refresh()
    }
  }, [convId, loadedWorkspaceId, refresh])

  // Always refresh on open so newly saved plugin assets appear without page reload.
  useEffect(() => {
    if (!open) return
    refresh()
  }, [open, refresh])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const handleDelete = useCallback(
    async (path: string) => {
      await deleteAsset(path)
    },
    [deleteAsset],
  )

  const handlePreview = useCallback(
    (name: string, blob: Blob) => {
      if (onPreviewAsset) {
        onPreviewAsset(name, blob)
        setOpen(false) // close popover after opening preview
      }
    },
    [onPreviewAsset],
  )

  const handleRefresh = useCallback(async () => {
    await refresh()
  }, [refresh])


  return (
    <>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`absolute bottom-3 left-4 z-20 rounded-full p-1.5 shadow-sm backdrop-blur-sm transition-all ${
          open
            ? 'bg-primary-600/90 text-white hover:bg-primary-700/90'
            : 'bg-neutral-800/60 text-white hover:bg-neutral-700/70 dark:bg-neutral-200/60 dark:text-neutral-900 dark:hover:bg-neutral-200/80'
        } ${items.length > 0 && !open ? 'ring-1 ring-white/20 dark:ring-neutral-400/30' : ''}`}
        title={t('assets.title', { defaultValue: 'Assets' })}
      >
        <Paperclip className="h-3.5 w-3.5" />
        {items.length > 0 && !open && (
          <span className="absolute -top-1 -right-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary-500 px-0.5 text-[8px] font-bold leading-none text-white">
            {items.length > 99 ? '99+' : items.length}
          </span>
        )}
      </button>

      {/* Expanded panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute bottom-20 left-4 z-30 w-80 max-h-72 flex flex-col rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-800"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-700 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-secondary">
              {t('assets.title', { defaultValue: 'Assets' })}
            </span>
            <div className="flex items-center gap-1">
              {confirmClear ? (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-red-500 font-medium">
                    {t('assets.confirmClearAll', { defaultValue: 'Clear all?' })}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setConfirmClear(false); clearAll() }}
                    className="rounded px-1 py-0.5 text-[10px] font-medium text-white bg-red-500 hover:bg-red-600"
                  >
                    {t('common.confirm', { defaultValue: 'Confirm' })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="rounded px-1 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    {t('common.cancel', { defaultValue: 'Cancel' })}
                  </button>
                </div>
              ) : items.length > 0 ? (
                <button
                  type="button"
                  onClick={() => { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 4000) }}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
                  title={t('assets.clearAll', { defaultValue: 'Clear all' })}
                >
                  <Trash className="h-3 w-3" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleRefresh}
                disabled={loading}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
                title={t('assets.refresh', { defaultValue: 'Refresh' })}
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-700 dark:hover:text-neutral-300"
                title={t('common.close', { defaultValue: 'Close' })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-neutral-400">
                <Paperclip className="mb-2 h-5 w-5" />
                <span className="text-xs">
                  {t('assets.empty', { defaultValue: 'No assets yet' })}
                </span>
              </div>
            ) : (
              items.map((asset) => (
                <AssetRow key={asset.path} asset={asset} onDelete={handleDelete} onPreview={handlePreview} />
              ))
            )}
          </div>

          {/* Footer */}
          {items.length > 0 && (
            <div className="border-t border-neutral-100 dark:border-neutral-700 px-3 py-1.5">
              <span className="text-[10px] text-neutral-400">
                {items.length} {t('assets.files', { defaultValue: 'files' })} ·{' '}
                {formatFileSize(items.reduce((sum, a) => sum + a.size, 0))}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  )
})
