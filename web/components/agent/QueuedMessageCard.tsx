/**
 * QueuedMessageCard — renders a single message waiting in the per-conversation
 * queue (shown while the agent is processing). Supports:
 *   - Inline editing (text + attachments) via InlineMessageEditor
 *   - Reorder (move up / move down)
 *   - Remove from queue
 *   - Attachment / image display (thumbnails)
 *
 * This replaces the old minimal bubble that only showed text + a delete button.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown, X, Pencil, Paperclip, Image as ImageIcon } from 'lucide-react'
import { useT } from '@/i18n'
import { InlineMessageEditor } from './InlineMessageEditor'
import { Lightbox } from './Lightbox'
import type { FileMentionItem } from './FileMentionExtension'
import type { AssetMeta } from '@/types/asset'
import { inferMimeType } from '@/types/asset'
import { readAssetBlob } from './asset-utils'
import { writePendingAssetsToOPFS } from '@/services/asset.service'
import { useWorkspaceStore } from '@/store/workspace.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { toast } from 'sonner'

interface QueuedMessageCardProps {
  /** Conversation ID */
  conversationId: string
  /** Index of this message in the queue (0-based, 0 = next to be sent) */
  index: number
  /**
   * Enqueue timestamp — the entry's identity in the queue. The edit path awaits
   * an upload, so a concurrent move/remove can invalidate `index`; resolving the
   * entry by this stamp keeps the edit on the prompt the user actually opened.
   */
  enqueuedAt?: number
  /** Total number of queued messages */
  total: number
  /** Message text */
  text: string
  /** Message assets (if any) */
  assets?: AssetMeta[]
  /** Agent candidates for @ mention in edit mode */
  mentionAgents: { id: string; name?: string }[]
  /** Async file search callback for # file mention in edit mode */
  onSearchFiles?: (query: string) => Promise<FileMentionItem[]>
  /** Open the shared FilePreview drawer with a pre-loaded blob (queued attachments) */
  onPreviewAsset?: (name: string, blob: Blob) => void
  /** Update the message (text + assets) */
  onUpdate: (index: number, patch: { text: string; assets?: AssetMeta[] }) => void
  /** Remove from queue */
  onRemove: (index: number) => void
  /** Move up in the queue */
  onMoveUp: (index: number) => void
  /** Move down in the queue */
  onMoveDown: (index: number) => void
}

// ─── Asset thumbnail (for queued message attachments) ──────────────────────

/**
 * Queued attachment chip with preview support.
 *
 * Queued assets are already written to the conversation's OPFS assets dir
 * before the message is enqueued, so both preview paths can read the blob:
 *   - images → click opens the shared Lightbox (click-to-enlarge)
 *   - other files → click delegates to `onPreviewAsset` (FilePreview drawer)
 */
function QueuedAssetThumbnail({
  asset,
  onPreviewAsset,
}: {
  asset: AssetMeta
  onPreviewAsset?: (name: string, blob: Blob) => void
}) {
  const t = useT()
  const mime = asset.mimeType || inferMimeType(asset.name)
  const isImage = mime.startsWith('image/')

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  // Blob cache — avoids re-reading OPFS when the user clicks after mount.
  const blobRef = useRef<Blob | null>(null)

  // Auto-load image thumbnails on mount.
  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    readAssetBlob(asset.name).then((blob) => {
      if (!blob || cancelled) return
      blobRef.current = blob
      setImageUrl(URL.createObjectURL(blob))
    })
    return () => {
      cancelled = true
    }
  }, [isImage, asset.name])

  // Revoke the object URL when it is replaced or the chip unmounts — the
  // Lightbox keeps using it while open, so it must outlive the click.
  useEffect(() => {
    if (!imageUrl) return
    return () => URL.revokeObjectURL(imageUrl)
  }, [imageUrl])

  const loadBlob = useCallback(async (): Promise<Blob | null> => {
    if (blobRef.current) return blobRef.current
    setLoading(true)
    try {
      const blob = await readAssetBlob(asset.name)
      if (blob) blobRef.current = blob
      return blob
    } finally {
      setLoading(false)
    }
  }, [asset.name])

  const handleOpen = useCallback(async () => {
    if (isImage) {
      if (imageUrl) {
        setLightboxOpen(true)
        return
      }
      // Thumbnail still loading / failed — retry on demand.
      const blob = await loadBlob()
      if (!blob) return
      setImageUrl(URL.createObjectURL(blob))
      setLightboxOpen(true)
      return
    }
    if (!onPreviewAsset) return
    const blob = await loadBlob()
    if (blob) onPreviewAsset(asset.name, blob)
  }, [asset.name, imageUrl, isImage, loadBlob, onPreviewAsset])

  const interactive = isImage || Boolean(onPreviewAsset)
  const previewLabel = t('filePreview.preview')

  const chipClassName = [
    'flex items-center gap-1.5 rounded-lg border border-primary-200/60 bg-white/60 px-2 py-1 text-left dark:border-primary-700/30 dark:bg-primary-900/20',
    interactive
      ? 'cursor-pointer transition-colors hover:border-primary-300 hover:bg-primary-50 dark:hover:border-primary-600/50 dark:hover:bg-primary-900/40'
      : '',
    loading ? 'opacity-60' : '',
  ].filter(Boolean).join(' ')

  const content = (
    <>
      {isImage && imageUrl ? (
        <img
          src={imageUrl}
          alt={asset.name}
          loading="lazy"
          className="h-8 w-8 rounded object-cover"
        />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary-100 dark:bg-primary-900/40">
          {isImage ? (
            <ImageIcon className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" />
          ) : (
            <Paperclip className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" />
          )}
        </div>
      )}
      <span className="max-w-[100px] truncate text-[11px] text-primary-600 dark:text-primary-300">
        {asset.name}
      </span>
    </>
  )

  return (
    <>
      {interactive ? (
        <button
          type="button"
          onClick={handleOpen}
          disabled={loading}
          className={chipClassName}
          title={previewLabel}
          aria-label={`${previewLabel}: ${asset.name}`}
        >
          {content}
        </button>
      ) : (
        <div className={chipClassName}>{content}</div>
      )}
      {lightboxOpen && imageUrl && (
        <Lightbox src={imageUrl} alt={asset.name} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  )
}

// ─── QueuedMessageCard ─────────────────────────────────────────────────────

export function QueuedMessageCard({
  conversationId,
  index,
  enqueuedAt,
  total,
  text,
  assets,
  mentionAgents,
  onSearchFiles,
  onPreviewAsset,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: QueuedMessageCardProps) {
  const t = useT()
  const [isEditing, setIsEditing] = useState(false)

  const handleStartEdit = useCallback(() => setIsEditing(true), [])
  const handleCancelEdit = useCallback(() => setIsEditing(false), [])

  /**
   * Current index of THIS entry, or null when it left the queue while an async
   * step of the edit (workspace switch, attachment upload) was in flight.
   */
  const resolveQueueIndex = useCallback((): number | null => {
    if (enqueuedAt === undefined) return index
    const queue = useConversationRuntimeStore.getState().pendingMessageQueues.get(conversationId)
    const current = queue?.findIndex((entry) => entry.enqueuedAt === enqueuedAt) ?? -1
    return current >= 0 ? current : null
  }, [conversationId, enqueuedAt, index])

  const handleSubmitEdit = useCallback(
    async (newText: string, files: File[]) => {
      const trimmed = newText.trim()
      if (!trimmed) {
        setIsEditing(false)
        return true
      }
      let addedAssets: AssetMeta[] = []
      if (files.length > 0) {
        try {
          const workspace = useWorkspaceStore.getState()
          if (workspace.activeWorkspaceId !== conversationId) {
            await workspace.switchWorkspace(conversationId)
          }
          addedAssets = await writePendingAssetsToOPFS(
            files.map((file) => ({ name: file.name, file }))
          )
        } catch (error) {
          toast.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      }
      const currentIndex = resolveQueueIndex()
      if (currentIndex === null) {
        // The prompt left the queue while the async step ran — nothing to edit.
        setIsEditing(false)
        return true
      }
      onUpdate(currentIndex, {
        text: trimmed,
        assets: addedAssets.length > 0 ? [...(assets ?? []), ...addedAssets] : undefined,
      })
      setIsEditing(false)
      return true
    },
    [assets, conversationId, index, onUpdate]
  )

  const canMoveUp = index > 0
  const canMoveDown = index < total - 1

  if (isEditing) {
    return (
      <div className="ml-auto max-w-[90%]">
        <InlineMessageEditor
          initialContent={text}
          agents={mentionAgents}
          onSearchFiles={onSearchFiles}
          onSubmit={handleSubmitEdit}
          onCancel={handleCancelEdit}
          cancelLabel={t('common.cancel')}
          submitLabel={t('conversation.queue.save')}
        />
      </div>
    )
  }

  return (
    <div className="group/queued ml-auto max-w-[85%]">
      <div className="relative flex flex-col gap-1">
        {/* Position badge + toolbar */}
        <div className="flex items-center justify-end gap-1">
          {/* Order badge */}
          <span className="rounded-full bg-primary-100/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary-600 dark:bg-primary-900/30 dark:text-primary-300">
            #{index + 1}
          </span>

          {/* Action buttons (hover-visible) */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/queued:opacity-100">
            <button
              type="button"
              onClick={() => onMoveUp(index)}
              disabled={!canMoveUp}
              className="flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-primary-100 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-primary-900/40"
              title={t('conversation.queue.moveUp')}
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onMoveDown(index)}
              disabled={!canMoveDown}
              className="flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-primary-100 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-primary-900/40"
              title={t('conversation.queue.moveDown')}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={handleStartEdit}
              className="flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-primary-100 hover:text-primary-600 dark:hover:bg-primary-900/40"
              title={t('conversation.queue.edit')}
            >
              <Pencil className="h-2.5 w-2.5" />
            </button>
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-900/40 dark:hover:text-red-400"
              title={t('conversation.queue.remove')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Message bubble */}
        <div className="rounded-2xl rounded-br-sm border border-primary-200/50 bg-primary-50/60 px-4 py-2.5 text-sm text-neutral-700 dark:border-primary-800/30 dark:bg-primary-900/20 dark:text-neutral-200">
          <p className="whitespace-pre-wrap break-words">{text}</p>
          {/* Attachments */}
          {assets && assets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {assets.map((asset) => (
                <QueuedAssetThumbnail
                  key={asset.id}
                  asset={asset}
                  onPreviewAsset={onPreviewAsset}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
