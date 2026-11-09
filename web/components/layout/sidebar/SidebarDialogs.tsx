import { createPortal } from 'react-dom'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
} from '@creatorweave/ui'
import type { ConversationActions } from './useConversationActions'
import type { FileActions } from './useFileActions'

interface SidebarDialogsProps {
  conversationActions: ConversationActions
  fileActions: FileActions
  scopedConversationIds: string[]
  /** Resolved title of the conversation awaiting delete confirmation */
  confirmDeleteTitle: string
  t: (key: string, params?: Record<string, string | number>) => string
}

/**
 * The sidebar's confirmation surfaces: clear-workspace dialog, file delete
 * popover and conversation delete popover. Presentational only — all state
 * lives in useConversationActions / useFileActions.
 */
export function SidebarDialogs({
  conversationActions,
  fileActions,
  scopedConversationIds,
  confirmDeleteTitle,
  t,
}: SidebarDialogsProps) {
  const {
    clearConversationsDialogOpen,
    setClearConversationsDialogOpen,
    clearingConversations,
    handleClearConversations,
    confirmDeleteId,
    confirmDeletePos,
    deleteConfirmRef,
    handleConfirmDeleteConversation,
    closeConfirmDelete,
  } = conversationActions
  const {
    deleteFileDialogOpen,
    pendingDeleteTarget,
    deleteFilePos,
    deleteFileConfirmRef,
    handleConfirmDeleteFile,
    closeDeleteFileConfirm,
  } = fileActions

  return (
    <>
      <BrandDialog
        open={clearConversationsDialogOpen}
        onOpenChange={setClearConversationsDialogOpen}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('sidebar.clearWorkspaceTitle')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="text-secondary text-sm">{t('sidebar.confirmClearWorkspace')}</p>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              disabled={clearingConversations}
              onClick={() => setClearConversationsDialogOpen(false)}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={() => {
                void handleClearConversations()
              }}
              disabled={scopedConversationIds.length === 0 || clearingConversations}
            >
              {clearingConversations ? t('sidebar.clearing') : t('sidebar.clear')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Delete File Confirmation Portal */}
      {deleteFileDialogOpen && deleteFilePos && pendingDeleteTarget && createPortal(
        <div
          ref={deleteFileConfirmRef}
          className="fixed z-[9999] rounded-lg border border-danger/30 bg-card p-3 shadow-xl"
          style={{
            left: Math.max(8, deleteFilePos.x - 80),
            top: Math.max(8, deleteFilePos.y - 60),
          }}
        >
          <p className="mb-2 text-xs text-secondary">
            {t('fileTree.deleteConfirm', { name: pendingDeleteTarget.fileName })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger hover:bg-danger/20"
              onClick={() => {
                void handleConfirmDeleteFile()
              }}
            >
              {t('fileTree.deleteFile')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-200 bg-white px-3 py-1 text-xs text-secondary hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              onClick={closeDeleteFileConfirm}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirmation portal - rendered at body level */}
      {confirmDeleteId && confirmDeletePos && createPortal(
        <div
          ref={deleteConfirmRef}
          className="fixed z-[9999] rounded-lg border border-danger/30 bg-card p-3 shadow-xl"
          style={{
            left: Math.max(8, confirmDeletePos.x - 80),
            top: Math.max(8, confirmDeletePos.y - 60),
          }}
        >
          <p className="mb-2 text-xs text-secondary">
            {t('sidebar.confirmDeleteWorkspace', { name: confirmDeleteTitle })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger hover:bg-danger/20"
              onClick={() => {
                void handleConfirmDeleteConversation()
              }}
            >
              {t('common.delete')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-200 bg-white px-3 py-1 text-xs text-secondary hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              onClick={closeConfirmDelete}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
