import { useCallback, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import { projectWorkspacePath } from '@/lib/route-paths'
import { useConversationStore } from '@/store/conversation.store'
import { createAttemptTokenSource } from '@/components/layout/sidebar-retry-guard'
import { ConversationItem, NewWorkspaceButton } from './ConversationItem'
import type { ConversationActions } from './useConversationActions'

interface ConversationListItem {
  id: string
  title: string
  kind?: 'project' | 'direct'
}

interface ConversationListProps {
  conversations: ConversationListItem[]
  showNewWorkspace: boolean
  onCreateNewWorkspace: () => void
  activeProjectId: string
  activeWorkspaceId: string | null
  runningSet: Set<string>
  pendingCountByConversationId: Map<string, number>
  workspaceStatusMap: Map<string, string>
  pinnedIds: string[]
  workspaceScheduleCount: Map<string, number>
  reduceMotion: boolean | null
  actions: ConversationActions
  t: (key: string, params?: Record<string, string | number>) => string
}

/**
 * Conversation list body: the "new workspace" row, the load-error banner and
 * the conversation rows. Moved out of Sidebar without changing the markup or
 * the item-memoization contract.
 */
export function ConversationList({
  conversations,
  showNewWorkspace,
  onCreateNewWorkspace,
  activeProjectId,
  activeWorkspaceId,
  runningSet,
  pendingCountByConversationId,
  workspaceStatusMap,
  pinnedIds,
  workspaceScheduleCount,
  reduceMotion,
  actions,
  t,
}: ConversationListProps) {
  // Issue #147: a failed loadFromDB leaves `conversations` empty with
  // `loadError` set. Rendering the list here would show an empty sidebar that
  // reads as "history wiped" — render an error banner with Retry instead,
  // mirroring the projects-page fix (PR #133).
  const conversationLoadError = useConversationStore((s) => s.loadError)
  // The scope tells the UI WHICH part failed (issue #147, PR #149 review):
  //  - 'metadata' — the conversation list itself is unavailable; the rows
  //    must stay hidden, otherwise the sidebar reads as "history wiped".
  //  - 'transcript' — the list loaded fine and only the ACTIVE
  //    conversation's transcript read failed. The rows are usable: hiding
  //    them would strand the user on the failing conversation with no way
  //    to pick another one.
  //  - 'workspace' — the list loaded, but the active workspace could not
  //    be opened. Keep the rows available while Retry remains visible.
  // An unknown scope (null / undefined) is treated like 'metadata' — the
  // conservative choice that never shows an empty list as if it were fine.
  const conversationLoadErrorScope = useConversationStore((s) => s.loadErrorScope)
  const suppressConversationList =
    conversationLoadError !== null &&
    conversationLoadErrorScope !== 'transcript' &&
    conversationLoadErrorScope !== 'workspace'
  // Explicit retry: bypass the in-flight guard so a load wedged past the
  // timeout below starts a FRESH run instead of re-awaiting the stuck
  // promise, which would leave Retry a no-op (PR #149 round-4 review,
  // "Retry cannot restart stuck load").
  const retryConversationsLoad = useConversationStore((s) => s.retryLoadFromDB)
  // Keep the banner (and its disabled Retry button) mounted while a retry is
  // in flight — loadFromDB clears loadError only after the active transcript
  // read succeeded, so the empty list never flashes as a false "no history"
  // state (PR #133 semantics).
  const [isRetryingLoad, setIsRetryingLoad] = useState(false)
  // Module-stable attempt-token source for the retry button's in-flight flag
  // (see the onClick handler below for why it exists).
  const retryTokenSource = useRef(createAttemptTokenSource()).current

  const {
    editingId,
    editingTitle,
    composing,
    setComposing,
    renameInputRef,
    handleEditingTitleChange,
    startRename,
    confirmRename,
    handleRenameBlur,
    cancelRename,
    handleItemSelect,
    handleItemDeleteClick,
    handleItemTogglePin,
    handleItemExport,
    handleItemArchive,
    handleItemDelete,
    handleItemGenerateTitle,
  } = actions

  // Row renderer — extracted from the previously-duplicated inline map so the
  // sidebar list body stays a single source of truth.
  const renderConversationItem = useCallback((conv: { id: string; title: string; kind?: 'project' | 'direct' }) => {
    const isRunning = runningSet.has(conv.id)
    const isActive = conv.id === activeWorkspaceId
    const pendingReviewCount = pendingCountByConversationId.get(conv.id) || 0
    const isEditing = editingId === conv.id
    const isArchived = workspaceStatusMap.get(conv.id) === 'archived'
    const isPinned = pinnedIds.includes(conv.id)

    return (
      <motion.div
        key={conv.id}
        layout={reduceMotion ? false : 'position'}
        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 35, mass: 0.8 }}
        className="mb-0.5"
      >
        <ConversationItem
          id={conv.id}
          title={conv.title}
          isRunning={isRunning}
          isActive={isActive}
          pendingReviewCount={pendingReviewCount}
          isEditing={isEditing}
          isArchived={isArchived}
          isPinned={isPinned}
          hasSchedule={(workspaceScheduleCount.get(conv.id) ?? 0) > 0}
          href={projectWorkspacePath(activeProjectId, conv.id)}
          onSelect={handleItemSelect}
          onStartRename={startRename}
          onDeleteClick={handleItemDeleteClick}
          onTogglePin={handleItemTogglePin}
          onExport={handleItemExport}
          onArchive={handleItemArchive}
          onDelete={handleItemDelete}
          onGenerateTitle={handleItemGenerateTitle}
          editingTitle={editingTitle}
          onEditingTitleChange={handleEditingTitleChange}
          onConfirmRename={confirmRename}
          onCancelRename={cancelRename}
          onRenameBlur={handleRenameBlur}
          composing={composing}
          onComposingChange={setComposing}
          renameInputRef={renameInputRef}
          workspaceLabel={t('sidebar.workspaceLabel', { name: conv.title })}
          t={t}
        />
      </motion.div>
    )
  }, [runningSet, activeWorkspaceId, pendingCountByConversationId, editingId, workspaceStatusMap, pinnedIds, workspaceScheduleCount, activeProjectId, reduceMotion, handleItemSelect, startRename, handleItemDeleteClick, handleItemTogglePin, handleItemExport, handleItemArchive, handleItemDelete, handleItemGenerateTitle, editingTitle, handleEditingTitleChange, confirmRename, cancelRename, handleRenameBlur, composing, setComposing, renameInputRef, t])

  return (
    <>
      {showNewWorkspace && (
        <NewWorkspaceButton
          onClick={onCreateNewWorkspace}
          label={t('sidebar.newWorkspace')}
        />
      )}

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        {conversationLoadError !== null && (
          <div
            role="alert"
            data-testid="conversation-load-error"
            className="mx-1 my-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <p className="mb-1 font-medium text-foreground">
              {conversationLoadErrorScope === 'workspace'
                ? t('sidebar.workspaceLoadFailed')
                : t('sidebar.historyLoadFailed')}
            </p>
            <p className="mb-2 break-words text-xs text-muted-foreground">
              {/* An Error with an empty message must not render a blank
                  failure line — fall back to a generic reason. */}
              {conversationLoadError || t('sidebar.historyLoadUnknownError')}
            </p>
            <button
              type="button"
              onClick={() => {
                setIsRetryingLoad(true)
                // Attempt-token guard: when retry #1 exceeds the 15s
                // timeout and retry #2 starts, #1's settle must NOT
                // re-enable the button while #2 is still pending — that
                // allowed overlapping retries (PR #149 round-6 review,
                // "Retry re-enables prematurely"). Only the LATEST
                // attempt may clear the in-flight flag.
                const attempt = retryTokenSource.next()
                // Bound the retry: a loadFromDB that never settles must
                // not leave the button disabled ("Retrying…") forever.
                // Re-enable on settle OR after ~15s, whichever comes
                // first (issue #147, PR #149 review).
                const settled = retryConversationsLoad().catch(() => {})
                // Keep the timer handle: when the retry settles first the
                // pending 15s timeout must be cleared, not left scheduled
                // (PR #149 round-6 review, "Stale retries overwrite
                // recovered state"). Clearing an already-fired timer is a
                // harmless no-op on the timeout path.
                let timerId: number | undefined
                const timeout = new Promise<void>((resolve) => {
                  timerId = window.setTimeout(resolve, 15_000)
                })
                void Promise.race([settled, timeout]).finally(() => {
                  if (timerId !== undefined) window.clearTimeout(timerId)
                  if (retryTokenSource.isCurrent(attempt)) {
                    setIsRetryingLoad(false)
                  }
                })
              }}
              disabled={isRetryingLoad}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw aria-hidden className={`h-3 w-3 ${isRetryingLoad ? 'animate-spin' : ''}`} />
              {isRetryingLoad ? t('sidebar.historyRetrying') : t('app.retry')}
            </button>
          </div>
        )}
        {/* A transcript-only failure keeps the loaded rows usable — the
            user must be able to switch to another conversation (issue #147,
            PR #149 review). A metadata failure hides them: the list is
            genuinely empty and rendering it would read as "history
            wiped". */}
        {!suppressConversationList &&
        conversations.map((conv) => {
          return renderConversationItem(conv)
        })}
      </div>
    </>
  )
}
