import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { projectWorkspacePath } from '@/lib/route-paths'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useWorkspaceStore } from '@/store/workspace.store'

/** Tracks conversations currently generating a title, to prevent duplicate clicks. */
const generatingTitleIds = new Set<string>()

interface ConversationListItem {
  id: string
  title: string
  kind?: 'project' | 'direct'
}

interface UseConversationActionsOptions {
  t: (key: string, params?: Record<string, string | number>) => string
  router: ReturnType<typeof useRouter>
  activeProjectId: string
  scopedConversations: ConversationListItem[]
  scopedConversationIds: string[]
  closeMobileSidebar: () => void
  onSelectWorkspace?: (workspaceId: string) => void
}

/**
 * Conversation row actions and their dialogs/popovers: rename, pin, export,
 * archive, delete, generate-title, plus the clear-workspace dialog state.
 * Extracted from Sidebar without changing any handler semantics.
 */
export function useConversationActions({
  t,
  router,
  activeProjectId,
  scopedConversations,
  scopedConversationIds,
  closeMobileSidebar,
  onSelectWorkspace,
}: UseConversationActionsOptions) {
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const deleteConversations = useConversationStore((s) => s.deleteConversations)
  const updateTitle = useConversationStore((s) => s.updateTitle)
  const generateTitle = useConversationStore((s) => s.generateTitle)
  const togglePin = useWorkspaceStore((state) => state.togglePin)

  const [clearConversationsDialogOpen, setClearConversationsDialogOpen] = useState(false)
  const [clearingConversations, setClearingConversations] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [composing, setComposing] = useState(false)
  const [exportConvId, setExportConvId] = useState<string | null>(null)
  const [batchExportOpen, setBatchExportOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmDeletePos, setConfirmDeletePos] = useState<{ x: number; y: number } | null>(null)
  const deleteConfirmRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Track the target rename ID to prevent click interference
  const pendingRenameIdRef = useRef<string | null>(null)

  // Rename handlers
  const startRename = useCallback((convId: string, currentTitle: string) => {
    pendingRenameIdRef.current = convId
    setEditingId(convId)
    setEditingTitle(currentTitle)
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [])

  const confirmRename = useCallback(() => {
    if (editingId && editingTitle.trim()) {
      const trimmedTitle = editingTitle.trim()
      const conv = scopedConversations.find((c) => c.id === editingId)
      if (conv && conv.title !== trimmedTitle) {
        updateTitle(editingId, trimmedTitle)
      }
    }
    setEditingId(null)
    setEditingTitle('')
    pendingRenameIdRef.current = null
  }, [editingId, editingTitle, updateTitle, scopedConversations])

  const handleRenameBlur = useCallback(() => {
    setTimeout(() => {
      if (document.activeElement !== renameInputRef.current) {
        confirmRename()
      }
    }, 150)
  }, [confirmRename])

  const cancelRename = useCallback(() => {
    setEditingId(null)
    setEditingTitle('')
    setComposing(false)
    pendingRenameIdRef.current = null
  }, [])

  // Close delete confirmation when clicking outside
  useEffect(() => {
    if (!confirmDeleteId) return

    const handleClick = (e: MouseEvent) => {
      if (deleteConfirmRef.current && !deleteConfirmRef.current.contains(e.target as Node)) {
        setConfirmDeleteId(null)
        setConfirmDeletePos(null)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmDeleteId(null)
        setConfirmDeletePos(null)
      }
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [confirmDeleteId])

  // Stable callback for editing title change
  const handleEditingTitleChange = useCallback((title: string) => setEditingTitle(title), [])

  // Stable callbacks for ConversationItem memoization
  // Side effects for clicking a conversation row. Navigation itself is
  // handled by the <Link href> the row renders as; this callback only touches
  // the last-accessed timestamp (so the item sorts to the top) and closes the
  // mobile sidebar. It deliberately does NOT call onSelectWorkspace/
  // switchWorkspace — that would push a second navigation on top of the link.
  const handleItemSelect = useCallback((id: string) => {
    if (pendingRenameIdRef.current === id) return
    // NOTE: clicking a conversation must NOT change its sort position.
    // Ordering only moves to the top when the user sends a new message
    // (a new agent loop), which bumps lastAccessedAt in the store.
    closeMobileSidebar()
  }, [closeMobileSidebar])

  const handleItemDeleteClick = useCallback((id: string, x: number, y: number) => {
    setConfirmDeleteId(id)
    setConfirmDeletePos({ x, y })
  }, [])

  const handleItemTogglePin = useCallback((id: string) => {
    togglePin(id)
  }, [togglePin])

  const handleItemGenerateTitle = useCallback(async (id: string) => {
    if (generatingTitleIds.has(id)) return
    generatingTitleIds.add(id)
    const toastId = toast.loading(t('sidebar.generatingTitle'))
    try {
      const result = await generateTitle(id, true)
      if (result.ok) {
        if (result.changed) {
          toast.success(t('sidebar.titleGenerated'), { id: toastId })
        } else {
          // Model produced a valid title but it happens to equal the current one.
          toast.info(t('sidebar.titleUnchanged'), { id: toastId })
        }
      } else {
        // Map every failure reason to a precise, actionable toast message.
        const messageKey =
          result.reason === 'no_provider' || result.reason === 'no_model'
            ? 'sidebar.titleGenerateNoProvider'
            : result.reason === 'no_api_key'
            ? 'sidebar.titleGenerateNoApiKey'
            : 'sidebar.titleGenerateFailed'
        toast.error(t(messageKey), { id: toastId })
      }
    } catch (error) {
      console.error('[Sidebar] Failed to generate title:', error)
      toast.error(t('sidebar.titleGenerateFailed'), { id: toastId })
    } finally {
      generatingTitleIds.delete(id)
    }
  }, [generateTitle, t])

  const handleItemExport = useCallback((id: string) => {
    setExportConvId(id)
  }, [])

  const handleItemArchive = useCallback(async (id: string, _isArchived: boolean) => {
    const { archiveWorkspace, unarchiveWorkspace } = useConversationContextStore.getState()
    try {
      if (_isArchived) {
        await unarchiveWorkspace(id)
        toast.success(t('sidebar.workspaceUnarchived'))
      } else {
        await archiveWorkspace(id)
        toast.success(t('sidebar.workspaceArchived'))
      }
    } catch (error) {
      console.error('[Sidebar] Failed to toggle archive:', error)
      toast.error(_isArchived ? t('sidebar.unarchiveFailed') : t('sidebar.archiveFailed'))
    }
  }, [t])

  const handleItemDelete = useCallback(async (id: string) => {
    try {
      await deleteConversation(id)
      toast.success(t('sidebar.workspaceDeleted'))
      // After deleting, navigate to the new active workspace (resolved by workspace store)
      // so that syncFromRoute runs the full switchWorkspace flow (OPFS init, file tree, etc.)
      const newActiveId = useConversationContextStore.getState().activeWorkspaceId
      if (newActiveId && onSelectWorkspace) {
        onSelectWorkspace(newActiveId)
      } else if (!newActiveId) {
        // Last conversation deleted: fall back to the bare project URL so
        // syncFromRoute settles the WelcomeScreen (empty) state.
        if (activeProjectId) {
          router.push(projectWorkspacePath(activeProjectId))
        }
      }
    } catch (error) {
      console.error('[Sidebar] Failed to delete conversation:', error)
      toast.error(t('sidebar.deleteWorkspaceFailed'))
    }
  }, [deleteConversation, t, onSelectWorkspace, activeProjectId, router])

  // Confirm-popover delete: the destructive action of the conversation
  // delete confirmation portal.
  const handleConfirmDeleteConversation = useCallback(async () => {
    if (confirmDeleteId) {
      try {
        await deleteConversation(confirmDeleteId)
        toast.success(t('sidebar.workspaceDeleted'))
        // Navigate to the new active workspace (resolved by workspace store)
        // so that syncFromRoute runs the full switchWorkspace flow
        const newActiveId = useConversationContextStore.getState().activeWorkspaceId
        if (newActiveId && onSelectWorkspace) {
          onSelectWorkspace(newActiveId)
        } else if (!newActiveId && activeProjectId) {
          // Last conversation deleted: settle on the bare
          // project URL (WelcomeScreen state).
          router.push(projectWorkspacePath(activeProjectId))
        }
      } catch (error) {
        console.error('[Sidebar] Failed to delete conversation:', error)
        toast.error(t('sidebar.deleteWorkspaceFailed'))
      }
    }
    setConfirmDeleteId(null)
    setConfirmDeletePos(null)
  }, [confirmDeleteId, deleteConversation, t, onSelectWorkspace, activeProjectId, router])

  const closeConfirmDelete = useCallback(() => {
    setConfirmDeleteId(null)
    setConfirmDeletePos(null)
  }, [])

  // Clear-all confirmation dialog's destructive action.
  const handleClearConversations = useCallback(async () => {
    try {
      setClearingConversations(true)
      const result = await deleteConversations(scopedConversationIds)
      if (result.failed.length === 0) {
        toast.success(t('sidebar.clearedCount', { count: result.successIds.length }))
        setClearConversationsDialogOpen(false)
      } else if (result.successIds.length === 0) {
        toast.error(t('sidebar.clearFailed', { count: result.failed.length }))
      } else {
        toast.error(t('sidebar.deletePartial', { success: result.successIds.length, failed: result.failed.length }))
      }
    } finally {
      setClearingConversations(false)
    }
  }, [deleteConversations, scopedConversationIds, t])

  return {
    editingId,
    editingTitle,
    composing,
    setComposing,
    renameInputRef,
    exportConvId,
    setExportConvId,
    batchExportOpen,
    setBatchExportOpen,
    confirmDeleteId,
    confirmDeletePos,
    deleteConfirmRef,
    clearConversationsDialogOpen,
    setClearConversationsDialogOpen,
    clearingConversations,
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
    handleConfirmDeleteConversation,
    closeConfirmDelete,
    handleClearConversations,
  }
}

export type ConversationActions = ReturnType<typeof useConversationActions>
