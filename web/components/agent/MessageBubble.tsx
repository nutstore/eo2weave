/**
 * MessageBubble - renders a single message (user or assistant) with optional streaming state.
 *
 * Handles both user and assistant messages in one unified component.
 * Streaming is just a transient state prop, not a different component.
 */

import { useState, memo } from 'react'
import { User, Bot, Trash2, Pencil, Download, Forward, Globe, ImageIcon } from 'lucide-react'
import type { Message } from '@/agent/message-types'
import { ReasoningSection } from './ReasoningSection'
import { MarkdownContent } from './MarkdownContent'
import { ToolCallDisplay } from './ToolCallDisplay'
import { CopyButton } from './CopyButton'
import { RegenerateButton } from './RegenerateButton'
import { AssetList } from './AssetCard'
import { InlineMessageEditor } from './InlineMessageEditor'
import { downloadImage } from './image-utils'
import { Lightbox } from './Lightbox'
import { useT } from '@/i18n'
import { PageContextCard } from './PageContextCard'

/** Format token count: 999 → "999", 1234 → "1.2K" */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(n < 10000 ? 2 : 1) + 'K'
}

interface StreamingState {
  /** Reasoning is actively streaming */
  reasoning?: boolean
  /** Content is actively streaming */
  content?: boolean
}

interface MessageBubbleProps {
  /** The message to display */
  message: Message
  conversationId?: string

  /** Optional streaming state (only applies when processing this message) */
  streaming?: StreamingState

  /** Whether to show avatar (default: true) */
  showAvatar?: boolean

  /** For assistant messages: collapse reasoning section when not streaming */
  reasoningCollapsed?: boolean

  /** For assistant messages: tool results map */
  toolResults?: Map<string, string>
  /** For user messages: delete this user message and its whole agent loop */
  onDeleteAgentLoop?: (userMessageId: string) => void
  /** Disable delete action */
  disableDeleteActions?: boolean
  /** Regenerate callback */
  onRegenerate?: (userMessageId: string) => void
  /** Cancel current streaming output callback */
  onCancel?: () => void
  /** Whether is processing (streaming output) */
  isProcessing?: boolean
  /** Edit and resend callback */
  onEditAndResend?: (userMessageId: string, newContent: string) => void
  /** Agent candidates for @ mention in edit mode */
  mentionAgents?: { id: string; name?: string }[]
  /** Async file search callback for # file mention in edit mode */
  onSearchFiles?: (query: string) => Promise<import('./FileMentionExtension').FileMentionItem[]>
  /** Open the shared FilePreview drawer with a pre-loaded blob */
  onPreviewAsset?: (name: string, blob: Blob) => void
}

export const MessageBubble = memo(function MessageBubble({
  message,
  conversationId,
  streaming,
  showAvatar = true,
  reasoningCollapsed = true,
  toolResults,
  onDeleteAgentLoop,
  disableDeleteActions = false,
  onRegenerate,
  onCancel,
  isProcessing = false,
  onEditAndResend,
  mentionAgents = [],
  onSearchFiles,
  onPreviewAsset,
}: MessageBubbleProps) {
  const t = useT()
  const isUser = message.role === 'user'
  const isStreamingReasoning = streaming?.reasoning ?? false
  const isStreamingContent = streaming?.content ?? false

  // Edit state for user messages
  const [isEditing, setIsEditing] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  // Page-context inspector (side-panel mode only)
  const [showPageContext, setShowPageContext] = useState(false)

  const handleStartEdit = () => {
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
  }

  const handleSubmitEdit = (newContent: string) => {
    const trimmed = newContent.trim()
    if (trimmed && onEditAndResend) {
      onEditAndResend(message.id, trimmed)
    }
    setIsEditing(false)
  }

  if (message.subagentCompletion) {
    return (
      <div className="my-2 min-w-0 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-700">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t('conversation.backgroundTasks.result')}</span>
        </div>
        <div className="max-h-56 overflow-auto break-words text-sm text-neutral-700 dark:text-neutral-300">
          <MarkdownContent content={message.content ?? ''} />
        </div>
      </div>
    )
  }

  // Delegation note: synthetic user-role message injected by delegate_to
  // handoff. Render as a centered card so it's visually distinct from
  // real user input — not a right-aligned chat bubble.
  if (isUser && message.delegationNote) {
    const note = message.delegationNote
    return (
      <div className="my-3 flex justify-center">
        <div className="max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            <Forward className="h-3.5 w-3.5" />
            <span>Delegated by {note.fromAgentName ?? note.fromAgentId}</span>
          </div>
          <div className="whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-300">
            {note.task}
          </div>
          {note.reason && (
            <div className="mt-1 text-xs italic text-neutral-500 dark:text-neutral-400">
              {note.reason}
            </div>
          )}
        </div>
      </div>
    )
  }

  // User message rendering
  if (isUser) {
    const readImageParts = message.readImageHandoff
      ? message.contentParts?.filter((part): part is { type: 'image'; data: string; mimeType: string } => part.type === 'image') ?? []
      : []
    const handoffPreview = message.readImageHandoff?.imageData
      ? {
          data: message.readImageHandoff.imageData,
          mimeType: message.readImageHandoff.mimeType,
        }
      : readImageParts[0]
    return (
      <div className="flex flex-row-reverse gap-3">
        {/* Avatar */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300">
          <User className="h-4 w-4" />
        </div>

        {/* Content */}
        <div className={`min-w-0 flex flex-col ${isEditing ? 'flex-1' : 'max-w-[90%] items-end'}`}>
          {isEditing ? (
            <InlineMessageEditor
              initialContent={message.content || ''}
              agents={mentionAgents}
              onSearchFiles={onSearchFiles}
              onSubmit={handleSubmitEdit}
              onCancel={handleCancelEdit}
              cancelLabel={t('common.cancel')}
              submitLabel={t('conversation.buttons.send')}
            />
          ) : (message.content ?? '').trim() !== '' ? (
            <div className="w-fit max-w-full rounded-lg bg-primary-600 px-4 py-2 text-base text-white">
              <div className="whitespace-pre-wrap break-words overflow-x-auto">{message.content}</div>
            </div>
          ) : null}

          {/* Agent-read image handoff — uses user role for API compatibility but
              remains visibly distinct from a human-authored upload. */}
          {message.readImageHandoff && (
            <div className="mt-1 w-full max-w-md rounded-lg border border-sky-200 bg-sky-50 p-3 text-left text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/20 dark:text-sky-100">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
                <ImageIcon className="h-3.5 w-3.5" />
                <span>{t('conversation.readImage.label')}</span>
              </div>
              {handoffPreview && (() => {
                const src = handoffPreview.data.startsWith('data:')
                  ? handoffPreview.data
                  : `data:${handoffPreview.mimeType};base64,${handoffPreview.data}`
                return (
                  <button
                    type="button"
                    className="block w-full overflow-hidden rounded-md border border-sky-200 bg-white text-left dark:border-sky-900/50 dark:bg-neutral-900"
                    onClick={() => setLightboxSrc(src)}
                    aria-label={t('conversation.readImage.preview')}
                  >
                    <img
                      src={src}
                      alt={t('conversation.readImage.alt', { path: message.readImageHandoff?.path ?? '' })}
                      className="block max-h-72 w-full object-contain"
                    />
                  </button>
                )
              })()}
              <div className="mt-2 break-all text-xs text-sky-700 dark:text-sky-300">
                {message.readImageHandoff.path}
              </div>
              {readImageParts.length === 0 && (
                <div className="mt-1 text-xs text-sky-700 dark:text-sky-300">
                  {t('conversation.readImage.ocrFallback')}
                </div>
              )}
            </div>
          )}

          {/* User uploaded assets */}
          {message.assets && message.assets.length > 0 && (
            <div className="mt-1">
              <AssetList assets={message.assets} compact onPreview={onPreviewAsset} />
            </div>
          )}

          {/* Page context inspector (side-panel mode) — structured preview of
              the upstream page snapshot frozen into this message. */}
          {message.pageContext && showPageContext && (
            <PageContextCard pageContext={message.pageContext} />
          )}

          {/* Timestamp + Copy + Delete buttons */}
          <div className="mt-1 flex items-center justify-end gap-2 text-xs text-neutral-400">
            <span>
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            {/* Page context toggle (side-panel mode only) */}
            {message.pageContext && (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                onClick={() => setShowPageContext((v) => !v)}
                title={showPageContext ? t('conversation.hidePageContext') : t('conversation.viewPageContext')}
                aria-label={t('conversation.viewPageContext')}
                aria-expanded={showPageContext}
              >
                <Globe className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Edit button */}
            {onEditAndResend && !isEditing && (
              <button
                type="button"
                className="inline-flex items-center rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                disabled={isProcessing}
                onClick={handleStartEdit}
                title={t('conversation.editAndResend')}
                aria-label={t('conversation.editAndResend')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Order: Regenerate → Copy → Delete */}
            {onRegenerate && !isEditing && (
              <RegenerateButton
                userMessageId={message.id}
                messageContent={message.content || ''}
                conversationId={''}
                onRegenerate={onRegenerate}
                onCancel={onCancel}
                isRunning={isProcessing}
              />
            )}
            {!isEditing && <CopyButton content={message.content || ''} title={t('common.copy')} />}
            {onDeleteAgentLoop && !isEditing && (
              <button
                type="button"
                className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                disabled={disableDeleteActions}
                onClick={() => onDeleteAgentLoop(message.id)}
                title={t('conversation.buttons.deleteTurn')}
                aria-label={t('conversation.buttons.deleteTurn')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        {lightboxSrc && (
          <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
        )}
      </div>
    )
  }

  // Assistant message rendering
  const hasReasoning = !!(message.reasoning && (!reasoningCollapsed || isStreamingReasoning))
  const hasContent = !!message.content
  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0

  // For assistant, avatar is on the left
  return (
    <div className="flex gap-3">
      {/* Avatar */}
      {showAvatar && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-700">
          <Bot className="h-4 w-4" />
        </div>
      )}

      {/* Content area */}
      <div className="min-w-0 w-[90%] space-y-2">
        {/* Reasoning */}
        {hasReasoning && (
          <ReasoningSection
            reasoning={message.reasoning!}
            streaming={isStreamingReasoning}
            durationMs={message.reasoningDurationMs}
          />
        )}

        {/* Content */}
        {hasContent && (
          <div className="inline-block max-w-full rounded-lg bg-white px-4 py-2 text-base text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700">
            <div className="prose max-w-none break-words overflow-x-auto">
              <MarkdownContent content={message.content!} />
            </div>
            {/* Cursor when streaming */}
            {isStreamingContent && (
              <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-neutral-400 align-text-bottom" />
            )}
          </div>
        )}

        {/* Generated images — inline display */}
        {message.images && message.images.length > 0 && (
          <div className="space-y-3">
            {message.images.map((img, idx) => (
              <div
                key={idx}
                className="group relative overflow-hidden rounded-lg ring-1 ring-neutral-200 dark:ring-neutral-700"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`Generated image ${idx + 1}`}
                  className="block max-w-full h-auto cursor-zoom-in"
                  onClick={() => setLightboxSrc(`data:${img.mimeType};base64,${img.data}`)}
                />
                {/* Hover overlay with action buttons */}
                <div className="absolute inset-0 flex items-end justify-end gap-1.5 bg-gradient-to-t from-black/40 via-transparent to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    className="rounded-md bg-white/90 p-1.5 text-neutral-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-white dark:bg-neutral-800/90 dark:text-neutral-200 dark:hover:bg-neutral-700"
                    title={t('conversation.imageGen.downloadImage')}
                    aria-label={t('conversation.imageGen.downloadImage')}
                    onClick={() => downloadImage(img.data, img.mimeType, `image-${idx + 1}`)}
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Agent generated assets */}
        {message.assets && message.assets.length > 0 && (
          <AssetList assets={message.assets} onPreview={onPreviewAsset} />
        )}

        {/* Tool calls */}
        {hasToolCalls && (
          <div className="space-y-1">
            {message.toolCalls!.map((tc) => (
              <ToolCallDisplay key={tc.id} conversationId={conversationId} toolCall={tc} result={toolResults?.get(tc.id)} />
            ))}
          </div>
        )}

        {/* Token usage (only show for completed messages, not streaming) */}
        {!isStreamingReasoning && !isStreamingContent && message.usage && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span
              title={t('conversation.usage.tokenUsage', { promptTokens: message.usage.promptTokens, completionTokens: message.usage.completionTokens, totalTokens: message.usage.totalTokens })}
            >
              ↑{formatTokens(message.usage.promptTokens)} ↓
              {formatTokens(message.usage.completionTokens)}
            </span>
            {message.content && <CopyButton content={message.content} />}
          </div>
        )}

        {/* Copy button for completed messages with content but no usage */}
        {!isStreamingReasoning && !isStreamingContent && !message.usage && message.content && (
          <CopyButton content={message.content} />
        )}
      </div>

      {/* Lightbox overlay for click-to-enlarge images */}
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
})
