/**
 * Agent store - manages global agent configuration.
 *
 * @deprecated Use folder-access.store instead
 * Kept as a backwards-compatibility layer that delegates to folder-access.store
 */

import { create } from 'zustand'
import { toast } from 'sonner'
import { i18nText } from './conversation-message-ops'

export interface AgentState {
  /** @deprecated Use folder-access.store */
  activeProjectId: string
  /** @deprecated Use folder-access.store */
  directoryHandle: FileSystemDirectoryHandle | null
  /** @deprecated Use folder-access.store */
  directoryName: string | null
  /** @deprecated Use folder-access.store */
  isRestoringHandle: boolean
  /** @deprecated Use folder-access.store */
  pendingHandle: FileSystemDirectoryHandle | null

  setActiveProject: (projectId: string) => Promise<void>
  /** @deprecated Use folder-access.store */
  setDirectoryHandle: (handle: FileSystemDirectoryHandle | null) => void
  /** @deprecated */
  restoreDirectoryHandle: () => Promise<void>
  /** @deprecated Use folder-access.store */
  requestPendingHandlePermission: () => Promise<boolean>
}

/**
 * Mirrors the agent.store state into folder-access.store
 * Must be called during app initialization
 */
async function syncFromFolderAccess() {
  try {
    const { useFolderAccessStore } = await import('./folder-access.store')
    const folderStore = useFolderAccessStore.getState()
    const folderRecord = folderStore.getRecord()

    // Use setState() to update state and trigger subscription notifications
    useAgentStore.setState({
      directoryHandle: folderRecord?.handle ?? null,
      directoryName: folderRecord?.folderName ?? null,
      pendingHandle: folderRecord?.persistedHandle ?? null,
      isRestoringHandle: folderRecord?.status === 'checking',
    })
  } catch (error) {
    console.error('[AgentStore] Failed to sync from folder-access:', error)
  }
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  activeProjectId: '',
  directoryHandle: null,
  directoryName: null,
  isRestoringHandle: false,
  pendingHandle: null,

  setActiveProject: async (projectId: string) => {
    set({ activeProjectId: projectId })

    // Mirror into folder-access.store
    // Each sub-await is timed because this whole call is the confirmed stall
    // point of project activation (issue #316): the parent trace names this
    // step, these lines say which sub-await inside it never settles.
    const folderStartedAt = performance.now()
    console.log('[AgentStore] folder-access mirror start', { projectId })
    try {
      const { useFolderAccessStore } = await import('./folder-access.store')
      console.log('[AgentStore] folder-access mirror: module imported', {
        elapsedMs: Math.round(performance.now() - folderStartedAt),
      })
      // Non-blocking: entering the project must not wait for the folder handle.
      // The folder store converges (ready / needs_user_activation) in the
      // background and the UI reacts to that (issue #316).
      await useFolderAccessStore.getState().setActiveProject(projectId || null, {
        awaitHydration: false,
      })
      console.log('[AgentStore] folder-access mirror: store updated', {
        elapsedMs: Math.round(performance.now() - folderStartedAt),
      })

      // Mirror the state back
      await syncFromFolderAccess()
      console.log('[AgentStore] folder-access mirror done', {
        elapsedMs: Math.round(performance.now() - folderStartedAt),
      })
    } catch (error) {
      console.error('[AgentStore] Failed to set active project in folder-access:', error)
    }
  },

  setDirectoryHandle: async (handle) => {
    const { activeProjectId } = get()
    if (!activeProjectId) {
      toast.error(i18nText('agent.toast.projectRequiredForFolder', '请先进入一个项目，再绑定文件夹'))
      return
    }

    try {
      const { useFolderAccessStore } = await import('./folder-access.store')
      const folderStore = useFolderAccessStore.getState()

      if (handle) {
        // Persist the incoming handle into folder-access.store
        await folderStore.setHandle(activeProjectId, handle)
        // Mirror the state
        await syncFromFolderAccess()
      } else {
        await folderStore.release(activeProjectId)
        // Mirror the cleared state
        set({
          directoryHandle: null,
          directoryName: null,
          pendingHandle: null,
        })
      }
    } catch (error) {
      console.error('[AgentStore] setDirectoryHandle failed:', error)
      const detail = error instanceof Error ? error.message : 'Unknown error'
      toast.error(
        i18nText('agent.toast.setFolderFailed', `设置文件夹失败: ${detail}`, { message: detail })
      )
    }
  },

  restoreDirectoryHandle: async () => {
    const { activeProjectId } = get()
    if (!activeProjectId) return

    set({ isRestoringHandle: true })

    try {
      const { useFolderAccessStore } = await import('./folder-access.store')
      await useFolderAccessStore.getState().hydrateProject(activeProjectId)
      await syncFromFolderAccess()
    } finally {
      set({ isRestoringHandle: false })
    }
  },

  requestPendingHandlePermission: async () => {
    const { activeProjectId, pendingHandle } = get()

    if (!pendingHandle || !activeProjectId) {
      return false
    }

    try {
      const { useFolderAccessStore } = await import('./folder-access.store')
      const result = await useFolderAccessStore.getState().requestPermission(activeProjectId)
      await syncFromFolderAccess()
      return result
    } catch (error) {
      console.error('[AgentStore] requestPendingHandlePermission failed:', error)
      return false
    }
  },
}))

// ============================================================================
// Initial sync
// ============================================================================

// When folder-access.store changes, mirror it into agent.store
import { useFolderAccessStore } from './folder-access.store'

// Subscribe to folder-access.store changes and mirror them
let previousStatus: string | null = null

// Check for state changes after the store initializes
const checkAndSync = () => {
  const folderRecord = useFolderAccessStore.getState().getRecord()
  if (!folderRecord) return

  const currentStatus = folderRecord.status
  if (currentStatus !== previousStatus) {
    previousStatus = currentStatus
    syncFromFolderAccess()
  }
}

// Poll for state changes on a timer
let syncInterval: ReturnType<typeof setInterval> | null = null

export function startFolderAccessSync() {
  if (syncInterval) return
  syncInterval = setInterval(checkAndSync, 1000)
}

export function stopFolderAccessSync() {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
