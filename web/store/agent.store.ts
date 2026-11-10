/**
 * Agent store - manages global agent configuration.
 *
 * @deprecated 使用 folder-access.store 替代
 * 此文件保留作为向后兼容层，内部委托给 folder-access.store
 */

import { create } from 'zustand'
import { toast } from 'sonner'
import { i18nText } from './conversation-message-ops'

interface AgentState {
  /** @deprecated 使用 folder-access.store */
  activeProjectId: string
  /** @deprecated 使用 folder-access.store */
  directoryHandle: FileSystemDirectoryHandle | null
  /** @deprecated 使用 folder-access.store */
  directoryName: string | null
  /** @deprecated 使用 folder-access.store */
  isRestoringHandle: boolean
  /** @deprecated 使用 folder-access.store */
  pendingHandle: FileSystemDirectoryHandle | null

  setActiveProject: (projectId: string) => Promise<void>
  /** @deprecated 使用 folder-access.store */
  setDirectoryHandle: (handle: FileSystemDirectoryHandle | null) => void
  /** @deprecated */
  restoreDirectoryHandle: () => Promise<void>
  /** @deprecated 使用 folder-access.store */
  requestPendingHandlePermission: () => Promise<boolean>
}

/**
 * 同步 agent.store 状态到 folder-access.store
 * 需要在应用初始化时调用
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

    // 同步到 folder-access.store
    try {
      const { useFolderAccessStore } = await import('./folder-access.store')
      await useFolderAccessStore.getState().setActiveProject(projectId || null)

      // 同步状态回来
      await syncFromFolderAccess()
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
        // 保存传入的 handle 到 folder-access.store
        await folderStore.setHandle(activeProjectId, handle)
        // 同步状态
        await syncFromFolderAccess()
      } else {
        await folderStore.release(activeProjectId)
        // 同步清空状态
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
// 初始化同步
// ============================================================================

// 当 folder-access.store 变化时，同步到 agent.store
import { useFolderAccessStore } from './folder-access.store'

// 订阅 folder-access.store 变化并同步
let previousStatus: string | null = null

// 在 store 初始化后检查状态变化
const checkAndSync = () => {
  const folderRecord = useFolderAccessStore.getState().getRecord()
  if (!folderRecord) return

  const currentStatus = folderRecord.status
  if (currentStatus !== previousStatus) {
    previousStatus = currentStatus
    syncFromFolderAccess()
  }
}

// 创建定时器检查状态变化
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
