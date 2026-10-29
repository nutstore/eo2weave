/**
 * ExportConversationDialog - Modal dialog for exporting conversation records.
 *
 * Supports JSON, Markdown, and HTML formats with configurable options.
 */

import { useState, useCallback, useEffect } from 'react'
import {
  Download,
  FileJson,
  FileText,
  Globe,
  Check,
  AlertCircle,
  Loader2,
} from 'lucide-react'
// Canonical size formatter (Sourcery #125: the local copy here escalated only
// to MB and drifted from every other size display in the app).
import { formatSize } from '@/lib/utils'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
} from '@creatorweave/ui'
import { useConversationStore } from '@/store/conversation.store'
import { getMessageRepository } from '@/sqlite'
import type { Message } from '@/agent/message-types'
import { useT } from '@/i18n'
import { isHumanUserMessage } from '@/agent/message-types'
import { selectConversationExportMessages } from '@/agent/message-projections'
import {
  exportConversation,
  type ConversationExportFormat,
  type ConversationExportResult,
} from '@/services/export/conversation-export'

// ============================================================================
// Types
// ============================================================================

interface ExportConversationDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback to toggle open state */
  onOpenChange: (open: boolean) => void
  /** Conversation ID to export */
  conversationId: string
}

// ============================================================================
// Component
// ============================================================================

export function ExportConversationDialog({
  open,
  onOpenChange,
  conversationId,
}: ExportConversationDialogProps) {
  const t = useT()
  const conversation = useConversationStore((state) => {
    const conv = state.conversations.find((c) => c.id === conversationId)
    // We need messages too for export, get from the actual conversation
    return conv
  })

  const [selectedFormat, setSelectedFormat] = useState<ConversationExportFormat>('markdown')
  const [isExporting, setIsExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<ConversationExportResult | null>(null)

  // Options state
  const [options, setOptions] = useState({
    includeToolCalls: true,
    includeReasoning: true,
    includeUsage: false,
    includeImages: true,
    addTimestamp: true,
  })

  // Metadata-only conversations (never opened, or evicted from memory) have an
  // empty in-memory `messages` array — load the real history from SQLite so the
  // export is complete instead of failing with "No messages to export".
  const [dbMessages, setDbMessages] = useState<Message[] | null>(null)
  const messagesLoaded = conversation?.messagesLoaded !== false
  useEffect(() => {
    setDbMessages(null)
    if (!open || !conversation || conversation.messagesLoaded !== false) return
    let cancelled = false
    void getMessageRepository()
      .findByConversation(conversation.id)
      .then((rows) => {
        if (!cancelled) setDbMessages(rows as Message[])
      })
      .catch((err) => {
        console.error('[ExportConversationDialog] Failed to load messages from DB:', err)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversation?.id, messagesLoaded])

  /** Full message list for export/preview: in-memory when trusted, DB-loaded otherwise. */
  const exportSource: Message[] = messagesLoaded
    ? (conversation?.messages ?? [])
    : (dbMessages ?? [])
  const exportConversationData = conversation
    ? { ...conversation, messages: exportSource }
    : null

  const formatOptions: Array<{
    value: ConversationExportFormat
    label: string
    description: string
    icon: React.ElementType
  }> = [
    {
      value: 'markdown',
      label: 'Markdown',
      description: t('conversation.export.markdownDesc') || 'Readable, great for sharing',
      icon: FileText,
    },
    {
      value: 'json',
      label: 'JSON',
      description: t('conversation.export.jsonDesc') || 'Structured data, good for backup',
      icon: FileJson,
    },
    {
      value: 'html',
      label: 'HTML',
      description: t('conversation.export.htmlDesc') || 'Styled page, good for printing',
      icon: Globe,
    },
  ]

  const handleExport = useCallback(async () => {
    if (!exportConversationData) return

    setIsExporting(true)
    setProgress(0)
    setStatus(t('conversation.export.preparing') || 'Preparing...')
    setError(null)

    try {
      const result = await exportConversation(exportConversationData, {
        format: selectedFormat,
        includeToolCalls: options.includeToolCalls,
        includeReasoning: options.includeReasoning,
        includeUsage: options.includeUsage,
        includeImages: options.includeImages,
        addTimestamp: options.addTimestamp,
        onProgress: (p, s) => {
          setProgress(p)
          setStatus(s)
        },
      })

      setLastResult(result)

      if (result.success) {
        setStatus(t('conversation.export.complete') || 'Export complete!')
        setProgress(100)
      } else {
        setError(result.error || t('conversation.export.failed') || 'Export failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsExporting(false)
    }
  }, [exportConversationData, selectedFormat, options, t])

  const handleClose = useCallback(() => {
    onOpenChange(false)
    // Reset state after close animation
    setTimeout(() => {
      setError(null)
      setLastResult(null)
      setProgress(0)
      setStatus('')
    }, 200)
  }, [onOpenChange])

  // If conversation was deleted while dialog is open, auto-close
  if (!conversation) {
    onOpenChange(false)
    return null
  }

  const exportMessages = selectConversationExportMessages(exportSource, options)
  const messageCount = exportMessages.length
  const userMessages = exportMessages.filter(isHumanUserMessage).length
  const assistantMessages = exportMessages.filter((m) => m.role === 'assistant').length

  return (
    <BrandDialog open={open} onOpenChange={onOpenChange}>
      <BrandDialogContent className="max-w-md">
        <BrandDialogHeader>
          <BrandDialogTitle>
            {t('conversation.export.title') || 'Export Conversation'}
          </BrandDialogTitle>
        </BrandDialogHeader>

        <BrandDialogBody className="space-y-4">
          {/* Conversation info */}
          <div className="rounded-lg bg-muted/50 p-3">
            <div className="font-medium text-sm truncate">{conversation.title}</div>
            <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
              <span>{messageCount} {t('conversation.export.messages') || 'messages'}</span>
              <span>{userMessages} {t('conversation.export.user') || 'user'}</span>
              <span>{assistantMessages} {t('conversation.export.assistant') || 'assistant'}</span>
            </div>
          </div>

          {/* Format selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              {t('conversation.export.format') || 'Format'}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {formatOptions.map((opt) => {
                const Icon = opt.icon
                const isSelected = selectedFormat === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setSelectedFormat(opt.value)}
                    className={`flex flex-col items-center gap-1 rounded-lg border p-3 text-center transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:bg-muted text-secondary'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-xs font-medium">{opt.label}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatOptions.find((f) => f.value === selectedFormat)?.description}
            </p>
          </div>

          {/* Options */}
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              {t('conversation.export.options') || 'Options'}
            </label>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.includeToolCalls}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, includeToolCalls: e.target.checked }))
                  }
                  className="rounded"
                />
                <span>{t('conversation.export.includeToolCalls') || 'Include tool calls'}</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.includeReasoning}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, includeReasoning: e.target.checked }))
                  }
                  className="rounded"
                />
                <span>{t('conversation.export.includeReasoning') || 'Include reasoning'}</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.includeImages}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, includeImages: e.target.checked }))
                  }
                  className="rounded"
                />
                <span>{t('conversation.export.includeImages') || 'Include images & attachments'}</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.addTimestamp}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, addTimestamp: e.target.checked }))
                  }
                  className="rounded"
                />
                <span>{t('conversation.export.addTimestamp') || 'Add timestamp to filename'}</span>
              </label>
            </div>
          </div>

          {/* Progress */}
          {isExporting && (
            <div className="space-y-2">
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>{status}</span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Success */}
          {lastResult?.success && !isExporting && (
            <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-700 dark:bg-green-950/30 dark:text-green-300">
              <Check className="h-4 w-4 shrink-0" />
              <span>
                {t('conversation.export.saved') || 'Saved'}: {lastResult.filename}
                ({formatSize(lastResult.size)})
                {lastResult.bundledFileCount ?
                  ` · ${lastResult.bundledFileCount} ${t('conversation.export.files') || 'files'}` : ''}
              </span>
            </div>
          )}
        </BrandDialogBody>

        <BrandDialogFooter>
          <BrandButton variant="ghost" onClick={handleClose} disabled={isExporting}>
            {t('common.close') || 'Close'}
          </BrandButton>
          <BrandButton
            variant="primary"
            onClick={handleExport}
            disabled={isExporting || messageCount === 0}
          >
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {status}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {t('conversation.export.button') || 'Export'}
              </>
            )}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialogContent>
    </BrandDialog>
  )
}

// ============================================================================
// Utility
// ============================================================================
// formatSize is imported from '@/lib/utils' (the canonical formatter) — the
// local copy that only escalated to MB was removed (Sourcery #125).
