import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useOPFSStore } from '@/store/opfs.store'

interface PendingDeleteTarget {
  rootName: string
  path: string
  fileName: string
  handle: FileSystemFileHandle | FileSystemDirectoryHandle | null
}

interface UseFileActionsOptions {
  t: (key: string, params?: Record<string, string | number>) => string
  activeProjectId: string
}

/**
 * File-tree delete confirmation state machine: the in-place confirm popover
 * and the OPFS delete it triggers. Extracted from Sidebar unchanged.
 */
export function useFileActions({ t, activeProjectId }: UseFileActionsOptions) {
  const [deleteFileDialogOpen, setDeleteFileDialogOpen] = useState(false)
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<PendingDeleteTarget | null>(null)
  const [deleteFilePos, setDeleteFilePos] = useState<{ x: number; y: number } | null>(null)
  const deleteFileConfirmRef = useRef<HTMLDivElement>(null)

  // Close file delete confirmation when clicking outside or pressing Escape
  useEffect(() => {
    if (!deleteFileDialogOpen) return

    const handleClick = (e: MouseEvent) => {
      if (deleteFileConfirmRef.current && !deleteFileConfirmRef.current.contains(e.target as Node)) {
        setDeleteFileDialogOpen(false)
        setPendingDeleteTarget(null)
        setDeleteFilePos(null)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDeleteFileDialogOpen(false)
        setPendingDeleteTarget(null)
        setDeleteFilePos(null)
      }
    }

    // Delay to avoid the triggering click that opened the confirm
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', handleKeyDown)
    })
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [deleteFileDialogOpen])

  const handleFileDelete = useCallback(
    (rootName: string, path: string, node: { kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle | null }, pos: { x: number; y: number }) => {
      const fileName = path.split('/').pop() || path
      setPendingDeleteTarget({ rootName, path, fileName, handle: node.handle })
      setDeleteFilePos(pos)
      setDeleteFileDialogOpen(true)
    },
    []
  )

  const closeDeleteFileConfirm = useCallback(() => {
    setDeleteFileDialogOpen(false)
    setPendingDeleteTarget(null)
    setDeleteFilePos(null)
  }, [])

  const handleConfirmDeleteFile = useCallback(async () => {
    if (!pendingDeleteTarget) return
    try {
      const { rootName, path, handle } = pendingDeleteTarget
      // Virtual OPFS root sentinel: paths are already workspace-relative.
      const fullPath = rootName === '__opfs__' ? path : `${rootName}/${path}`
      const workspaceId = useConversationContextStore.getState().activeWorkspaceId
      await useOPFSStore.getState().deleteFile(fullPath, handle instanceof FileSystemDirectoryHandle ? handle : null, workspaceId, activeProjectId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'))
    }
    setDeleteFileDialogOpen(false)
    setPendingDeleteTarget(null)
    setDeleteFilePos(null)
  }, [pendingDeleteTarget, activeProjectId, t])

  return {
    deleteFileDialogOpen,
    pendingDeleteTarget,
    deleteFilePos,
    deleteFileConfirmRef,
    handleFileDelete,
    closeDeleteFileConfirm,
    handleConfirmDeleteFile,
  }
}

export type FileActions = ReturnType<typeof useFileActions>
