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

import { useState, useCallback, useEffect } from 'react'
import { ChevronUp, ChevronDown, X, Pencil, Paperclip } from 'lucide-react'
import { useT } from '@/i18n'
import { InlineMessageEditor } from './InlineMessageEditor'
import type { FileMentionItem } from './FileMentionExtension'
import type { AssetMeta } from '@/types/asset'
import { readAssetBlob } from './asset-utils'
import { writePendingAssetsToOPFS } from '@/services/asset.service'
import { useWorkspaceStore } from '@/store/workspace.store'
import { toast } from 'sonner'

interface QueuedMessageCardProps {
  /** Conversation ID */
  conversationId: string
  /** Index of this message in the queue (0-based, 0 = next to be sent) */
  index: number
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

function QueuedAssetThumbnail({ asset }: { asset: AssetMeta }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const mime = asset.mimeType || ''
  const isImage = mime.startsWith('image/')

  useEffect(() => {
    if (!isImage) return
    let cancelled = false
    let blobUrl: string | null = null
    readAssetBlob(asset.name).then((blob) => {
      if (blob && !cancelled) {
        blobUrl = URL.createObjectURL(blob)
        setImageUrl(blobUrl)
      }
    })
    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [isImage, asset.name])

  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-primary-200/60 bg-white/60 px-2 py-1 dark:border-primary-700/30 dark:bg-primary-900/20">
      {isImage && imageUrl ? (
        <img src={imageUrl} alt={asset.name} className="h-8 w-8 rounded object-cover" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary-100 dark:bg-primary-900/40">
          <Paperclip className="h-3.5 w-3.5 text-primary-500 dark:text-primary-400" />
        </div>
      )}
      <span className="max-w-[100px] truncate text-[11px] text-primary-600 dark:text-primary-300">
        {asset.name}
      </span>
    </div>
  )
}

// ─── QueuedMessageCard ─────────────────────────────────────────────────────

export function QueuedMessageCard({
  conversationId,
  index,
  total,
  text,
  assets,
  mentionAgents,
  onSearchFiles,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: QueuedMessageCardProps) {
  const t = useT()
  const [isEditing, setIsEditing] = useState(false)

  const handleStartEdit = useCallback(() => setIsEditing(true), [])
  const handleCancelEdit = useCallback(() => setIsEditing(false), [])

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
      onUpdate(index, {
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
                <QueuedAssetThumbnail key={asset.id} asset={asset} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
