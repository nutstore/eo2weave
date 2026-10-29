/**
 * Offline Queue Store
 *
 * Manages offline sync tasks for PWA functionality.
 * Tasks are persisted to localStorage and sync when online.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { formatBytes as formatFileSize } from '@/lib/utils'

//=============================================================================
// Types
//=============================================================================

export type OfflineTaskType = 'upload' | 'download' | 'sync' | 'analysis'
export type OfflineTaskStatus = 'pending' | 'syncing' | 'completed' | 'failed'

export interface OfflineTask {
  id: string
  type: OfflineTaskType
  name: string
  description?: string
  status: OfflineTaskStatus
  progress: number
  size?: number
  createdAt: number
  updatedAt: number
  error?: string
  metadata?: Record<string, unknown>
}

interface OfflineQueueState {
  // Queue management
  tasks: OfflineTask[]
  isOnline: boolean
  isSyncing: boolean

  // Actions
  addTask: (task: Omit<OfflineTask, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateTask: (id: string, updates: Partial<OfflineTask>) => void
  removeTask: (id: string) => void
  retryTask: (id: string) => void
  clearCompleted: () => void
  clearFailed: () => void
  clearAll: () => void
  setOnline: (online: boolean) => void
  setSyncing: (syncing: boolean) => void
  processQueue: () => Promise<void>

  // Selectors
  getPendingTasks: () => OfflineTask[]
  getSyncingTasks: () => OfflineTask[]
  getFailedTasks: () => OfflineTask[]
  getCompletedTasks: () => OfflineTask[]
  getTaskCounts: () => { pending: number; syncing: number; failed: number; completed: number }
}

//=============================================================================
// Utility Functions
//=============================================================================

function generateId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

//=============================================================================
// Store Implementation
//=============================================================================

export const useOfflineQueueStore = create<OfflineQueueState>()(
  persist(
    (set, get) => ({
      tasks: [],
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      isSyncing: false,

      addTask: (taskData) => {
        const id = generateId()
        const now = Date.now()
        const task: OfflineTask = {
          ...taskData,
          id,
          createdAt: now,
          updatedAt: now,
        }

        set((state) => ({
          tasks: [...state.tasks, task],
        }))

        console.log(`[OfflineQueue] Task added: ${task.name} (${task.type})`)
        return id
      },

      updateTask: (id, updates) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === id ? { ...task, ...updates, updatedAt: Date.now() } : task
          ),
        }))
      },

      removeTask: (id) => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id),
        }))
      },

      retryTask: (id) => {
        const state = get()
        const task = state.tasks.find((t) => t.id === id)

        if (task && task.status === 'failed') {
          get().updateTask(id, {
            status: 'pending',
            progress: 0,
            error: undefined,
          })
          console.log(`[OfflineQueue] Task retry queued: ${task.name}`)
        }
      },

      clearCompleted: () => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.status !== 'completed'),
        }))
      },

      clearFailed: () => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.status !== 'failed'),
        }))
      },

      clearAll: () => {
        set({ tasks: [] })
      },

      setOnline: (online) => {
        set({ isOnline: online })
        console.log(`[OfflineQueue] Online status: ${online}`)
      },

      setSyncing: (syncing) => {
        set({ isSyncing: syncing })
      },

      processQueue: async () => {
        const state = get()

        if (!state.isOnline || state.isSyncing) {
          return
        }

        const pendingTasks = state.tasks.filter((t) => t.status === 'pending')

        if (pendingTasks.length === 0) {
          return
        }

        set({ isSyncing: true })
        console.log(`[OfflineQueue] Processing ${pendingTasks.length} pending tasks`)

        // Process tasks sequentially
        for (const task of pendingTasks) {
          if (!get().isOnline) {
            break
          }

          get().updateTask(task.id, { status: 'syncing' })

          try {
            await simulateTaskSync(task, get().updateTask)
          } catch (error) {
            get().updateTask(task.id, {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Unknown error',
            })
          }
        }

        set({ isSyncing: false })
      },

      getPendingTasks: () => {
        return get().tasks.filter((t) => t.status === 'pending')
      },

      getSyncingTasks: () => {
        return get().tasks.filter((t) => t.status === 'syncing')
      },

      getFailedTasks: () => {
        return get().tasks.filter((t) => t.status === 'failed')
      },

      getCompletedTasks: () => {
        return get().tasks.filter((t) => t.status === 'completed')
      },

      getTaskCounts: () => {
        const tasks = get().tasks
        return {
          pending: tasks.filter((t) => t.status === 'pending').length,
          syncing: tasks.filter((t) => t.status === 'syncing').length,
          failed: tasks.filter((t) => t.status === 'failed').length,
          completed: tasks.filter((t) => t.status === 'completed').length,
        }
      },
    }),
    {
      name: 'offline-queue',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tasks: state.tasks,
        isOnline: state.isOnline,
        isSyncing: state.isSyncing,
      }),
    }
  )
)

//=============================================================================
// Simulated Sync Logic (for demo purposes)
//=============================================================================

async function simulateTaskSync(
  task: OfflineTask,
  updateTask: (id: string, updates: Partial<OfflineTask>) => void
): Promise<void> {
  // Simulate progress updates
  const totalSteps = 10
  for (let step = 0; step <= totalSteps; step++) {
    if (!navigator.onLine) {
      throw new Error('Network connection lost')
    }

    updateTask(task.id, {
      progress: Math.round((step / totalSteps) * 100),
    })

    // Simulate async operation
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // Mark as completed
  updateTask(task.id, {
    status: 'completed',
    progress: 100,
  })

  console.log(`[OfflineQueue] Task completed: ${task.name}`)
}

//=============================================================================
// Online/Offline Monitoring
//=============================================================================

export function setupOfflineMonitoring(): () => void {
  const setOnline = useOfflineQueueStore.getState().setOnline

  const handleOnline = () => {
    setOnline(true)
    // Attempt to process queue when coming back online
    setTimeout(() => {
      useOfflineQueueStore.getState().processQueue()
    }, 1000)
  }

  const handleOffline = () => {
    setOnline(false)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Initial state
    setOnline(navigator.onLine)
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }
}

//=============================================================================
// Task Factory Helpers
//=============================================================================

export function createUploadTask(
  name: string,
  size?: number,
  metadata?: Record<string, unknown>
): Omit<OfflineTask, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'upload',
    name,
    description: `Upload ${name}${size ? ` (${formatFileSize(size)})` : ''}`,
    status: 'pending',
    progress: 0,
    size,
    metadata,
  }
}

export function createDownloadTask(
  name: string,
  size?: number,
  metadata?: Record<string, unknown>
): Omit<OfflineTask, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'download',
    name,
    description: `Download ${name}${size ? ` (${formatFileSize(size)})` : ''}`,
    status: 'pending',
    progress: 0,
    size,
    metadata,
  }
}

export function createSyncTask(
  name: string,
  description?: string,
  metadata?: Record<string, unknown>
): Omit<OfflineTask, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'sync',
    name,
    description: description || `Sync ${name}`,
    status: 'pending',
    progress: 0,
    metadata,
  }
}

export function createAnalysisTask(
  name: string,
  metadata?: Record<string, unknown>
): Omit<OfflineTask, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'analysis',
    name,
    description: `Analyze ${name}`,
    status: 'pending',
    progress: 0,
    metadata,
  }
}
