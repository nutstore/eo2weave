/**
 * SyncPreviewPanel Component
 *
 * Main control panel for sync preview UI.
 * Orchestrates FileChangeList and FileDiffViewer.
 * Provides sync/cancel actions.
 *
 * Part of Phase 3: Sync Preview UI
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { type FileChange, type SyncResult } from '@/opfs/types/opfs-types'
import { useConversationContextStore, getActiveConversation } from '@/store/conversation-context.store'
import { useSettingsStore } from '@/store/settings.store'
import { isCredentialPending } from '@/agent/providers/credential-state'
import { BrandButton } from '@creatorweave/ui'
import { Badge } from '@/components/ui/badge'
import { PendingFileList } from './PendingFileList'
import { FileDiffViewer } from './FileDiffViewer'
import { ArrowLeft, AlertCircle, Sparkles, MessageSquare, ChevronDown, ChevronUp, Trash2, Send } from 'lucide-react'
import { sendChangeReviewToConversation } from './review-request'
import {
  useSyncDialogStore,
  type SyncExecutor,
  type NotifyFn,
} from '@/store/sync-dialog.store'
import { toast } from 'sonner'
import { pauseHmr, resumeHmr } from '@/lib/sync-guard'
import { useT } from '@/i18n'
import { type LineComment } from './comment-types'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useAgentStore } from '@/store/agent.store'
import { createUserMessage } from '@/agent/message-types'

/**
 * Empty state when no changes detected
 */
function EmptyState({ t }: { t: ReturnType<typeof useT> }): React.ReactNode {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-16 px-6">
      <div className="w-16 h-16 rounded-xl bg-primary-50/80 dark:bg-primary-50/20 flex items-center justify-center mb-4 shadow-sm">
        <svg
          className="w-10 h-10 text-primary-500 dark:text-primary-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 7h12m0 0l-4-4m4 4l4 4m0 6H4m0 0l4 4m-4-4l-4 4"
          />
        </svg>
      </div>
      <h2 className="text-xl font-semibold text-foreground mb-3">{t('settings.syncPanel.syncPreview.emptyStateTitle')}</h2>
      <p className="text-sm text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400 max-w-md leading-relaxed">
        {t('settings.syncPanel.syncPreview.emptyStateDescription')}
      </p>
      <div className="mt-8 grid grid-cols-1 gap-4 max-w-sm">
        <div className="flex items-start gap-3 p-4 bg-primary-50 dark:bg-primary-50/20 rounded-lg">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-100/40 flex items-center justify-center text-primary-600 dark:text-primary-700 text-sm font-medium">
            1
          </div>
          <div className="text-left">
            <h3 className="text-sm font-medium text-foreground mb-1">
              {t('settings.syncPanel.syncPreview.step1Title')}
            </h3>
            <p className="text-xs text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400">
              {t('settings.syncPanel.syncPreview.step1Desc')}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 bg-primary-50 dark:bg-primary-50/20 rounded-lg">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-100/40 flex items-center justify-center text-primary-600 dark:text-primary-700 text-sm font-medium">
            2
          </div>
          <div className="text-left">
            <h3 className="text-sm font-medium text-foreground mb-1">
              {t('settings.syncPanel.syncPreview.step2Title')}
            </h3>
            <p className="text-xs text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400">
              {t('settings.syncPanel.syncPreview.step2Desc')}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 bg-primary-50 dark:bg-primary-50/20 rounded-lg">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-100/40 flex items-center justify-center text-primary-600 dark:text-primary-700 text-sm font-medium">
            3
          </div>
          <div className="text-left">
            <h3 className="text-sm font-medium text-foreground mb-1">
              {t('settings.syncPanel.syncPreview.step3Title')}
            </h3>
            <p className="text-xs text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400">
              {t('settings.syncPanel.syncPreview.step3Desc')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export interface SyncPreviewPanelProps {
  /** Callback when sync is confirmed */
  onSync?: () => void
  /** Callback when sync is cancelled (kept for compatibility, but drawer handles close) */
  onCancel?: () => void
}

export const SyncPreviewPanel: React.FC<SyncPreviewPanelProps> = ({
  onSync,
  onCancel,
}) => {
  const t = useT()
  const pendingChanges = useConversationContextStore((state) => state.pendingChanges)
  const previewSelectedPath = useConversationContextStore((state) => state.previewSelectedPath)
  const clearPreviewSelectedPath = useConversationContextStore((state) => state.clearPreviewSelectedPath)
  const discardPendingPath = useConversationContextStore((state) => state.discardPendingPath)
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null)
  const selectedPath = selectedFile?.path
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [isReviewing, setIsReviewing] = useState(false)
  // conflictPaths lives in the shared store so both the badge renderer and
  // the (singleton) conflict dialog stay in sync.
  const conflictPaths = useSyncDialogStore((s) => s.conflictPaths)
  const setConflictPaths = useCallback(
    (
      updater: Set<string> | ((prev: Set<string>) => Set<string>),
    ) => {
      const store = useSyncDialogStore.getState()
      const prev = store.conflictPaths
      const next = typeof updater === 'function' ? (updater as (p: Set<string>) => Set<string>)(prev) : updater
      store.setConflictPaths(next)
    },
    [],
  )

  // Selection state for selective sync
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())

  // Global comment state (lifted from FileDiffViewer)
  const [commentsByPath, setCommentsByPath] = useState<Record<string, LineComment[]>>({})
  const [commentsExpanded, setCommentsExpanded] = useState(false)
  const allComments = useMemo(
    () => Object.values(commentsByPath).flat().sort((a, b) => a.createdAt - b.createdAt),
    [commentsByPath]
  )
  const commentedFileCount = Object.keys(commentsByPath).filter(k => commentsByPath[k].length > 0).length

  const mergeSyncResult = useCallback((a: SyncResult, b: SyncResult): SyncResult => ({
    success: a.success + b.success,
    failed: a.failed + b.failed,
    skipped: a.skipped + b.skipped,
    conflicts: [...a.conflicts, ...b.conflicts],
  }), [])

  /**
   * Handle file selection from list
   */
  const handleSelectFile = useCallback((file: FileChange) => {
    setSelectedFile(file)
    setSyncError(null)
  }, [])

  useEffect(() => {
    if (!previewSelectedPath || !pendingChanges) return
    const target = pendingChanges.changes.find((c) => c.path === previewSelectedPath)
    if (target) {
      setSelectedFile(target)
      clearPreviewSelectedPath()
    }
  }, [previewSelectedPath, pendingChanges, clearPreviewSelectedPath])

  useEffect(() => {
    let cancelled = false

    const refreshConflictPaths = async () => {
      if (!pendingChanges || pendingChanges.changes.length === 0) {
        if (!cancelled) setConflictPaths(new Set())
        return
      }

      try {
        const activeConversation = await getActiveConversation()
        if (!activeConversation) {
          if (!cancelled) setConflictPaths(new Set())
          return
        }
        const nativeDir = await activeConversation.conversation.getNativeDirectoryHandle()
        const paths = pendingChanges.changes.map((c) => c.path)
        const conflicts = await activeConversation.conversation.detectSyncConflicts(nativeDir, paths)
        if (!cancelled) {
          setConflictPaths(new Set(conflicts.map((c) => c.path)))
        }
      } catch {
        if (!cancelled) {
          setConflictPaths(new Set())
        }
      }
    }

    void refreshConflictPaths()
    return () => {
      cancelled = true
    }
  }, [pendingChanges])

  /** Sync executor injected into the shared sync-dialog store. */
  const syncExecutor = useCallback<SyncExecutor>(async (
    filesToSync: FileChange[],
    overwritePathSet: Set<string>
  ): Promise<boolean> => {
    if (!pendingChanges || isSyncing) return false

    setIsSyncing(true)
    setSyncError(null)

    // Extract approved paths upfront so it's available in finally block
    const approvedPaths = filesToSync.map((c) => c.path)

    try {
      // Get active workspace
      const activeConversation = await getActiveConversation()
      if (!activeConversation) {
        throw new Error('No active workspace')
      }

      // Browser roots provide a handle; Native Host roots are resolved by the
      // workspace's persisted scope ID and intentionally have none.
      const { conversation } = activeConversation
      const nativeDir = await conversation.getNativeDirectoryHandle()

      // Preserve the synchronization boundary around native-disk writes.
      await pauseHmr(approvedPaths)

      // Create snapshot (conflicts should have been handled before this point)
      let snapshotResult: { snapshotId: string } | null = null
      if (approvedPaths.length > 0) {
        snapshotResult = await conversation.createApprovedSnapshotForPaths(
          approvedPaths,
          undefined,
          nativeDir
        )
      }

      const forceOverwriteList = approvedPaths.filter((path) => overwritePathSet.has(path))
      const regularList = approvedPaths.filter((path) => !overwritePathSet.has(path))

      let pendingResult: SyncResult = {
        success: 0,
        failed: 0,
        skipped: 0,
        conflicts: [],
      }
      if (regularList.length > 0) {
        pendingResult = mergeSyncResult(pendingResult, await conversation.syncToDisk(nativeDir, regularList))
      }
      if (forceOverwriteList.length > 0) {
        pendingResult = mergeSyncResult(
          pendingResult,
          await conversation.syncToDisk(nativeDir, forceOverwriteList, true)
        )
      }

      // Show sync result
      if (pendingResult.failed > 0) {
        const conflictHint =
          pendingResult.conflicts.length > 0
            ? t('settings.syncPanel.syncPreview.conflictHint', { count: pendingResult.conflicts.length })
            : ''
        setSyncError(t('settings.syncPanel.syncPreview.syncFailedCount', { failed: pendingResult.failed, conflicts: conflictHint }))
        setConflictPaths(new Set(pendingResult.conflicts.map((c) => c.path)))
        return false
      }

      // A partial or conflicted batch must remain recoverable as an unsynced
      // snapshot. Only mark it synced once every selected path reached disk.
      if (
        snapshotResult?.snapshotId &&
        pendingResult.conflicts.length === 0 &&
        pendingResult.success === approvedPaths.length
      ) {
        await conversation.markSnapshotAsSynced(snapshotResult.snapshotId)
      }

      // Refresh pending snapshot after sync (supports partial sync)
      await useConversationContextStore.getState().refreshPendingChanges(true)
      const latestChanges = useConversationContextStore.getState().pendingChanges?.changes ?? []
      if (!latestChanges.some((c) => c.path === selectedPath)) {
        setSelectedFile(null)
      }
      setConflictPaths((prev) => {
        const approvedPathSet = new Set(approvedPaths)
        const next = new Set<string>()
        for (const path of prev) {
          if (!approvedPathSet.has(path)) next.add(path)
        }
        return next
      })
      // Clean up comments for synced files
      setCommentsByPath((prev) => {
        const next = { ...prev }
        for (const path of approvedPaths) {
          delete next[path]
        }
        return Object.keys(next).length > 0 ? next : {}
      })
      onSync?.()
      return true
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : t('settings.syncPanel.syncPreview.approvalFailed'))
      return false
    } finally {
      await resumeHmr(approvedPaths)
      setIsSyncing(false)
      // Clear selection after sync
      setSelectedItems(new Set())
    }
  }, [pendingChanges, isSyncing, mergeSyncResult, onSync, selectedPath, t])

  // Notify callback injected into the shared sync-dialog store.
  const notify = useCallback<NotifyFn>((kind, detail) => {
    if (kind === 'noFilesAfterConflict') {
      toast.info(t('settings.syncPanel.syncPreview.noFilesAfterConflict'))
    } else if (kind === 'keepNativeFailed') {
      const err = (detail as { error?: unknown })?.error
      const message = err instanceof Error ? err.message : t('settings.syncPanel.syncPreview.keepNativeFailed')
      toast.error(message)
    }
  }, [t])

  const handleSync = useCallback(async (selectedPaths: string[] = []) => {
    if (!pendingChanges || isSyncing) return

    const filesToSync = selectedPaths.length > 0
      ? pendingChanges.changes.filter((c) => selectedPaths.includes(c.path))
      : pendingChanges.changes
    if (filesToSync.length === 0) return

    setSyncError(null)

    // Delegate the approval flow (conflict detection + dialog state) to the
    // shared sync-dialog store. Dialogs are rendered once at WorkspaceLayout.
    await useSyncDialogStore.getState().beginApprovalFlow(filesToSync, {
      ctx: {
        syncExecutor,
        discardPending: discardPendingPath,
        notify,
      },
      detect: async () => {
        try {
          const activeConversation = await getActiveConversation()
          if (!activeConversation) return []
          const nativeDir = await activeConversation.conversation.getNativeDirectoryHandle()
          const filePaths = filesToSync.map((c) => c.path)
          return await activeConversation.conversation.detectSyncConflicts(nativeDir, filePaths)
        } catch {
          return []
        }
      },
    })
  }, [pendingChanges, isSyncing, syncExecutor, discardPendingPath, notify])

  const handleReview = useCallback(async () => {
    if (!pendingChanges || pendingChanges.changes.length === 0 || isReviewing) return

    const filesToReview = selectedItems.size > 0
      ? pendingChanges.changes.filter((c) => selectedItems.has(c.path))
      : pendingChanges.changes

    if (filesToReview.length === 0) return

    setIsReviewing(true)
    try {
      await sendChangeReviewToConversation(filesToReview)
      toast.success(t('settings.syncPanel.syncPreview.reviewRequestSent'))
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.syncPanel.syncPreview.reviewRequestFailed')
      toast.error(message)
    } finally {
      setIsReviewing(false)
    }
  }, [pendingChanges, selectedItems, isReviewing, t])

  /**
   * Handle clear all pending changes (user decides not to sync)
   */
  const handleClear = useCallback(async (selectedPaths: string[]) => {
    if (selectedPaths.length === 0) return
    const { discardPendingPaths } = useConversationContextStore.getState()
    await discardPendingPaths(selectedPaths)
    setSelectedFile(null)
    setSyncError(null)
    setSelectedItems(new Set())
    setConflictPaths(new Set())
    setCommentsByPath((prev) => {
      const next = { ...prev }
      for (const p of selectedPaths) delete next[p]
      return next
    })
  }, [])

  /**
   * Handle removing a single file from pending list
   */
  const handleRemoveFile = useCallback(async (path: string) => {
    await discardPendingPath(path)
    setConflictPaths((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    // Clean up comments for the removed file
    setCommentsByPath((prev) => {
      if (!prev[path]) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }, [discardPendingPath])

  /** Send comments to AI: close drawer, inject user message, trigger agent run */
  const sendCommentsToAI = useCallback(async () => {
    if (allComments.length === 0) return

    const payload = allComments
      .map((item) => {
        const sideLabel = item.side === 'modified' ? t('sidebar.fileDiffViewer.changedVersion') : t('sidebar.fileDiffViewer.currentFile')
        const lineLabel = item.startLine === item.endLine
          ? `L${item.startLine}`
          : `L${item.startLine}-L${item.endLine}`
        return `- ${item.path} [${sideLabel} ${lineLabel}] ${item.text}`
      })
      .join('\n')

    const prompt = `Please review the following inline comments I left on the diff:\n\n${payload}`

    const settings = useSettingsStore.getState()
    if (!settings.providerType || !settings.modelName) {
      toast.error(t('conversation.toast.noModel'))
      return
    }
    if (!settings.hasApiKey && !isCredentialPending(settings.providerType)) {
      toast.error(t('conversation.toast.noApiKey'))
      return
    }

    // Close drawer first
    onCancel?.()

    // Ensure conversation exists
    const conversationStore = useConversationStore.getState()
    const { directoryHandle } = useAgentStore.getState()
    let targetConvId = conversationStore.activeConversationId
    if (!targetConvId) {
      const conv = conversationStore.createNew('Diff Comments Review')
      targetConvId = conv.id
      await conversationStore.setActive(targetConvId)
    }

    if (conversationStore.isConversationRunning(targetConvId)) {
      // Queue the message instead of rejecting
      const result = useConversationRuntimeStore.getState().enqueueMessage(targetConvId, {
        text: prompt,
        enqueuedAt: Date.now(),
      })
      if (result.enqueued) {
        setCommentsByPath({})
      } else {
        toast.error(t('conversation.toast.queueFull'))
      }
      return
    }

    const userMessage = createUserMessage(prompt)
    const currentConv = conversationStore.conversations.find((c) => c.id === targetConvId)
    const currentMessages = currentConv ? [...currentConv.messages, userMessage] : [userMessage]
    conversationStore.updateMessages(targetConvId, currentMessages)

    // Clear comments after sending
    setCommentsByPath({})

    await conversationStore.runAgent(
      targetConvId,
      settings.providerType,
      settings.modelName,
      settings.maxTokens,
      directoryHandle
    )
  }, [allComments, t, onCancel])

  /** Remove a single comment by id */
  const removeComment = useCallback((id: string) => {
    setCommentsByPath((prev) => {
      const next: Record<string, LineComment[]> = {}
      for (const [path, comments] of Object.entries(prev)) {
        const filtered = comments.filter((c) => c.id !== id)
        if (filtered.length > 0) {
          next[path] = filtered
        }
      }
      return next
    })
  }, [])

  /** Clear all comments */
  const clearAllComments = useCallback(() => {
    setCommentsByPath({})
  }, [])

  const hasSelection = Boolean(selectedFile)
  const hasPending = Boolean(pendingChanges && pendingChanges.changes.length > 0)

  // Show empty state when no changes and no selected snapshot file
  if (!hasPending && !hasSelection) {
    return <EmptyState t={t} />
  }

  const totalFiles = pendingChanges?.changes.length || 0

  return (
    <>
      <div className="flex flex-col h-full bg-background">
        {/* Header - simplified for Drawer (title and close handled by Drawer) */}
        <div className="border-b px-4 py-3 bg-card">
        {/* Summary */}
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {t('settings.syncPanel.syncPreview.detectedFiles', { count: totalFiles })}
          </span>
          <div className="flex items-center gap-2 text-xs">
            {(pendingChanges?.added || 0) > 0 && (
              <Badge variant="success" className="gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                {pendingChanges?.added} {t('settings.syncPanel.syncPreview.added')}
              </Badge>
            )}
            {(pendingChanges?.modified || 0) > 0 && (
              <Badge variant="outline" className="gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />
                {pendingChanges?.modified} {t('settings.syncPanel.syncPreview.modified')}
              </Badge>
            )}
            {(pendingChanges?.deleted || 0) > 0 && (
              <Badge variant="error" className="gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                {pendingChanges?.deleted} {t('settings.syncPanel.syncPreview.deleted')}
              </Badge>
            )}
          </div>
          {syncError && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5" />
              {syncError}
            </span>
          )}
          <div className="ml-auto">
            <BrandButton
              variant="outline"
              className="h-7 px-3 text-xs"
              onClick={handleReview}
              disabled={isSyncing || isReviewing || totalFiles === 0}
              aria-label={t('settings.syncPanel.syncPreview.reviewChanges')}
            >
              {isReviewing ? (
                t('settings.syncPanel.syncPreview.reviewing')
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('settings.syncPanel.syncPreview.reviewChanges')}
                </>
              )}
            </BrandButton>
          </div>
        </div>
        </div>

        {/* Global Comments Summary Bar */}
        {allComments.length > 0 && (
          <div className="border-b bg-amber-50/80 px-4 py-2 dark:bg-amber-950/20">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t('sidebar.fileDiffViewer.commentsSummary', { files: commentedFileCount, comments: allComments.length })}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setCommentsExpanded((v) => !v)}
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-100/80 dark:text-amber-400 dark:hover:bg-amber-900/30"
              >
                {commentsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <button
                type="button"
                onClick={clearAllComments}
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-amber-600 transition-colors hover:bg-amber-100/80 dark:text-amber-400 dark:hover:bg-amber-900/30"
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={sendCommentsToAI}
                className="inline-flex h-6 items-center gap-1 rounded bg-amber-600 px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
              >
                <Send className="h-3 w-3" />
                {t('sidebar.fileDiffViewer.copyCommentsToAI')}
              </button>
            </div>
            {commentsExpanded && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {allComments.map((item) => (
                  <div
                    key={item.id}
                    className="inline-flex max-w-full items-center gap-1 rounded border border-amber-200 bg-white px-2 py-1 text-xs dark:border-amber-800 dark:bg-amber-950/40"
                  >
                    <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                      {item.path.split('/').pop()}
                    </span>
                    <span className="shrink-0 text-[10px] text-amber-500 dark:text-amber-500">
                      {item.side === 'modified' ? t('sidebar.fileDiffViewer.modified') : t('sidebar.fileDiffViewer.current')}{' '}
                      {item.startLine === item.endLine ? `L${item.startLine}` : `L${item.startLine}-L${item.endLine}`}
                    </span>
                    <span className="max-w-[240px] truncate text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300" title={item.text}>
                      {item.text}
                    </span>
                    <button
                      className="shrink-0 text-neutral-400 hover:text-red-500 text-neutral-500 text-neutral-500 dark:text-neutral-500 dark:hover:text-red-400"
                      onClick={() => removeComment(item.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Main Content - Split View */}
        {!selectedFile ? (
        // Show compact list (when no file selected)
        <div className="flex-1 overflow-hidden">
          {pendingChanges && (
            <PendingFileList
              changes={pendingChanges}
              onSelectFile={handleSelectFile}
              selectedPath={undefined}
              onSync={handleSync}
              onClear={handleClear}
              onRemoveFile={handleRemoveFile}
              isSyncing={isSyncing}
              selectedItems={selectedItems}
              onSelectionChange={setSelectedItems}
              conflictPaths={conflictPaths}
            />
          )}
        </div>
        ) : (
        // Show diff comparison (after file selected)
        <div className="flex-1 flex overflow-hidden">
          {/* Back to List Button */}
          <div className="w-12 flex-shrink-0 border-r flex items-center justify-center bg-muted/50">
            <BrandButton variant="ghost" onClick={() => {
              setSelectedFile(null)
            }} title={t('settings.syncPanel.syncPreview.backToList')}>
              <ArrowLeft className="w-5 h-5" />
            </BrandButton>
          </div>

          {/* Diff Viewer */}
          <div className="flex-1">
            <FileDiffViewer
              fileChange={selectedFile}
              commentsByPath={commentsByPath}
              onCommentsChange={setCommentsByPath}
            />
          </div>
        </div>
        )}
      </div>
    </>
  )
}
