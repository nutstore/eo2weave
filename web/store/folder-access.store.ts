/**
 * Folder Access Store - Single source of truth
 *
 * Unified folder permission state management, solving:
 * 1. Scattered state
 * 2. Permission records not deleted after release()
 * 3. Re-add not showing picker after release
 *
 * Multi-root support:
 * - Each project can have multiple roots (folder handles)
 * - One root per project is marked as `isDefault`
 * - Roots stored in SQLite via ProjectRootRepository
 * - Handles stored in IndexedDB via DirectoryHandleManager
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { toast } from 'sonner'
import type { FolderAccessRecord, FolderAccessStatus, FolderAccessStore, RootInfo } from '@/types/folder-access'
import { folderAccessRepo } from '@/services/folder-access.repository'
import { selectFolderReadWrite } from '@/services/fsAccess.service'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import {
  bindRuntimeDirectoryHandle,
  unbindRuntimeDirectoryHandle,
  getRuntimeHandlesForProject,
} from '@/native-fs'
import type { ProjectRoot } from '@/sqlite/repositories/project-root.repository'
import { getProjectRootRepository } from '@/sqlite'
import { isNativeHostAvailable } from '@/opfs/native-disk/executor'
import { NativeHostExecutor } from '@/opfs/native-disk/executor-native-host'
import { t as translateStatic } from '@creatorweave/i18n'
import { useI18nStore } from '@/i18n/store'

function i18nText(key: string, fallback: string, params?: Record<string, string | number>): string {
  const translated = translateStatic(useI18nStore.getState().locale, key, params)
  return translated === key ? fallback : translated
}

/**
 * Create an empty record
 * @param projectId Project ID
 * @param rootName Root name (defaults to projectId for backward compat)
 */
function createEmptyRecord(projectId: string, rootName?: string): FolderAccessRecord {
  return {
    projectId,
    rootName: rootName ?? projectId,
    folderName: null,
    handle: null,
    persistedHandle: null,
    status: 'idle',
    error: undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

async function notifyWorkspaceNativeDirectoryGranted(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const { useWorkspaceStore } = await import('./workspace.store')
    await useWorkspaceStore.getState().onNativeDirectoryGranted(handle)
  } catch (error) {
    console.warn('[FolderAccessStore] Failed to notify workspace native handle grant:', error)
  }
}

/**
 * Reconcile the SQLite `project_roots` table with the folder handles that exist
 * in IndexedDB (folderAccessRepo) and/or are bound in the runtime handle map.
 *
 * WHY: `resolvePath()` / `ensureRootMap()` / `syncToDiskMultiRoot()` rely on the
 * SQLite `project_roots` table to route multi-root paths. If a root is present
 * in IndexedDB (handle persisted) but missing from SQLite (e.g. SQLite was reset
 * during schema migration, or a root was bound via `bindRuntimeDirectoryHandle`
 * without a corresponding `createRoot`), `resolvePath` falls back to the default
 * root, causing files to be synced to the WRONG disk location (root prefix not
 * stripped) or silently skipped.
 *
 * This is called on hydrate / loadRoots to self-heal the SQLite table so that
 * every persisted handle has a matching `project_roots` row.
 */
async function reconcileProjectRoots(projectId: string): Promise<void> {
  try {
    const rootRepo = getProjectRootRepository()
    const dbRoots = await rootRepo.findByProject(projectId)
    const dbRootNames = new Set(dbRoots.map((r) => r.name))

    // Collect root names from ALL persistence sources
    const rootNamesToEnsure = new Set<string>()

    // Source 1: runtime handle map (bound via bindRuntimeDirectoryHandle)
    const runtimeHandles = getRuntimeHandlesForProject(projectId)
    for (const name of runtimeHandles.keys()) {
      rootNamesToEnsure.add(name)
    }

    // Source 2: IndexedDB folderAccessRepo (persisted across refreshes)
    const persistedRecords = await folderAccessRepo.loadAllForProject(projectId)
    for (const rec of persistedRecords) {
      const name = rec.rootName ?? rec.folderName
      if (name) rootNamesToEnsure.add(name)
    }

    let created = 0
    for (const name of rootNamesToEnsure) {
      if (!dbRootNames.has(name)) {
        await rootRepo.createRoot({ projectId, name })
        created++
        console.warn(
          `[FolderAccessStore] reconcileProjectRoots: created missing project_roots row "${name}" for project ${projectId} (data drift between IndexedDB and SQLite detected, self-healed)`
        )
      }
    }

    // Invalidate workspace-runtime root map cache so the next resolvePath()
    // picks up the repaired table instead of a stale cached map.
    if (created > 0) {
      try {
        const { getWorkspaceManager } = await import('@/opfs')
        ;(await getWorkspaceManager()).invalidateRootMapCache(projectId)
      } catch {
        /* manager not ready yet — resolvePath will lazily rebuild */
      }
    }
  } catch (error) {
    console.warn('[FolderAccessStore] reconcileProjectRoots failed:', error)
  }
}

/**
 * Module-level dedup: prevents concurrent ensureFilePaths for the same project
 */
const _filePathPromises: Map<string, Promise<string[]>> = new Map()

/**
 * LRU eviction for allFilePaths cache.
 * Keeps at most MAX_CACHED_PROJECTS entries. Evicts the least-recently-written
 * project when the limit is exceeded.
 */
const MAX_CACHED_PROJECTS = 10
/** Insertion-order of project IDs (most recent at the end) */
const _cacheOrder: string[] = []

function evictLRU(
  state: { allFilePaths: Record<string, string[]> },
  justWrittenId: string
): void {
  // Move just-written ID to the end (most recently used)
  const idx = _cacheOrder.indexOf(justWrittenId)
  if (idx >= 0) _cacheOrder.splice(idx, 1)
  _cacheOrder.push(justWrittenId)

  // Evict oldest entries that exceed the limit
  while (_cacheOrder.length > MAX_CACHED_PROJECTS) {
    const oldest = _cacheOrder.shift()!
    // Don't evict the project we just wrote — break instead of infinite loop
    if (oldest === justWrittenId) {
      _cacheOrder.push(oldest)
      break
    }
    if (state.allFilePaths[oldest]) {
      delete state.allFilePaths[oldest]
    }
  }
}

export const useFolderAccessStore = create<FolderAccessStore>()(
  immer((set, get) => ({
    activeProjectId: null,
    records: {},
    allFilePaths: {},
    // Defaulted to false so WelcomeScreen and other consumers don't render
    // the "no folder mounted" step until loadRoots() has actually resolved
    // for the current active project. Mirrors `hasApiKeyLoaded` in
    // `useSettingsStore` — see types/folder-access.ts for details.
    rootsHydrated: false,

    // ========================================================================
    // Actions
    // ========================================================================

    /**
     * Set active project and hydrate.
     * For same-project switches, avoid full hydrate but still reload roots to
     * keep runtime handle/roots view consistent.
     */
    setActiveProject: async (projectId: string | null) => {
      const prevId = get().activeProjectId
      set((state) => {
        state.activeProjectId = projectId
        // Reset hydration flag on project switch so WelcomeScreen shows its
        // loading state until loadRoots() completes for the new project.
        // Same-project re-entry (prevId === projectId) leaves the flag alone:
        // the existing roots list is still authoritative and loadRoots() will
        // set rootsHydrated=true again at the end.
        if (prevId !== projectId) {
          state.roots = []
          state.rootsHydrated = false
        }
      })

      if (!projectId) return

      // Same-project fast path:
      // Skip full hydrate, but still reload roots so UI/runtime bindings stay fresh.
      if (prevId === projectId) {
        const record = get().records[projectId]
        if (record && (record.status === 'ready' || record.status === 'needs_user_activation')) {
          await get().loadRoots()
          return
        }
      }

      // Create empty record if none exists yet
      if (!get().records[projectId]) {
        set((state) => {
          state.records[projectId] = createEmptyRecord(projectId)
        })
      }

      await get().hydrateProject(projectId)

      // Load multi-root state
      await get().loadRoots()
    },

    /**
     * Hydrate project data (restore from IndexedDB)
     */
    hydrateProject: async (projectId: string) => {
      set((state) => {
        const record = state.records[projectId]
        if (record) {
          record.status = 'checking'
        }
      })

      try {
        // Load record from IndexedDB
        const existing = await folderAccessRepo.load(projectId)

        if (!existing || !existing.persistedHandle) {
          // No record -> idle
          set((state) => {
            state.records[projectId] = createEmptyRecord(projectId)
          })
          return
        }

        // Has persisted handle -> check permission status
        const handle = existing.persistedHandle

        try {
          const permission = await handle.queryPermission({ mode: 'readwrite' })

          if (permission === 'granted') {
            // Permission already granted -> ready
            set((state) => {
              state.records[projectId] = {
                ...existing,
                rootName: existing.rootName ?? handle.name ?? projectId,
                handle,
                status: 'ready',
                updatedAt: Date.now(),
              }
            })
            // Multi-root: bind with rootName (handle.name or existing rootName)
            const rootName = existing.rootName ?? handle.name ?? projectId
            bindRuntimeDirectoryHandle(projectId, rootName, handle)
            await notifyWorkspaceNativeDirectoryGranted(handle)
            // Self-heal: ensure the SQLite `project_roots` table has a row for
            // this root. IndexedDB (folderAccessRepo) and SQLite can drift
            // apart after schema migrations / DB resets, leaving a handle
            // bound in memory but unresolvable by resolvePath() → sync-to-disk
            // routes to the wrong root. reconcileProjectRoots is idempotent.
            await reconcileProjectRoots(projectId)
            console.log('[FolderAccessStore] Permission granted, handle ready:', handle.name)
          } else if (permission === 'prompt') {
            // Needs user activation -> needs_user_activation
            set((state) => {
              state.records[projectId] = {
                ...existing,
                handle: null,
                status: 'needs_user_activation',
                updatedAt: Date.now(),
              }
            })
            console.log('[FolderAccessStore] Permission prompt, needs activation:', handle.name)
          } else {
            // Permission denied -> delete record, back to idle
            console.log('[FolderAccessStore] Permission denied, clearing record')
            await folderAccessRepo.delete(projectId)
            set((state) => {
              state.records[projectId] = createEmptyRecord(projectId)
            })
          }
        } catch (permError) {
          // Permission query failed, handle may have expired
          console.error('[FolderAccessStore] Permission query failed:', permError)
          await folderAccessRepo.delete(projectId)
          set((state) => {
            state.records[projectId] = createEmptyRecord(projectId)
          })
        }
      } catch (error) {
        console.error('[FolderAccessStore] Hydrate failed:', error)
        set((state) => {
          const record = state.records[projectId]
          if (record) {
            record.status = 'error'
            record.error = error instanceof Error ? error.message : 'Unknown error'
          }
        })
      }
    },

    /**
     * Pick a new folder (shows folder picker dialog)
     */
    pickDirectory: async (projectId: string) => {
      set((state) => {
        const record = state.records[projectId]
        if (record) {
          record.status = 'requesting'
        }
      })

      try {
        const handle = await selectFolderReadWrite()

        if (!handle) {
          // User cancelled -> restore previous state
          set((state) => {
            const record = state.records[projectId]
            if (record) {
              // Fix: if there's a valid handle, keep ready status
              // Only set idle/needs_user_activation when no persisted handle exists
              if (record.handle || record.persistedHandle) {
                record.status = 'ready'
              } else {
                record.status = 'idle'
              }
            }
          })
          return false
        }

        const record: FolderAccessRecord = {
          projectId,
          rootName: handle.name,
          folderName: handle.name,
          handle,
          persistedHandle: handle,
          status: 'ready',
          error: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        // Persist
        await folderAccessRepo.save(record)
        // Multi-root: bind with rootName = handle.name for per-root lookup
        bindRuntimeDirectoryHandle(projectId, handle.name, handle)
        await notifyWorkspaceNativeDirectoryGranted(handle)

        set((state) => {
          state.records[projectId] = record
        })

        toast.success(`Folder selected: ${handle.name}`)

        // Ensure a ProjectRoot record exists so loadRoots() can find it
        const rootRepo = getProjectRootRepository()
        const existingRoots = await rootRepo.findByProject(projectId)
        if (!existingRoots.some((r) => r.name === handle.name)) {
          await rootRepo.createRoot({ projectId, name: handle.name })
        }

        // Reload roots so sidebar FileTreePanel picks up the new handle
        await get().loadRoots()

        // Clear file path cache so the local file tree reloads on next search.
        get().clearFilePaths()

        return true
      } catch (error) {
        console.error('[FolderAccessStore] Pick directory failed:', error)

        if (error instanceof Error && error.message === 'User cancelled') {
          // User cancelled, don't set error state
          set((state) => {
            const record = state.records[projectId]
            if (record) {
              // Fix: if there's a valid handle, keep ready status
              // Only set idle/needs_user_activation when no persisted handle exists
              if (record.handle || record.persistedHandle) {
                record.status = 'ready'
              } else {
                record.status = 'idle'
              }
            }
          })
          return false
        }

        set((state) => {
          const record = state.records[projectId]
          if (record) {
            record.status = 'error'
            record.error = error instanceof Error ? error.message : 'Unknown error'
          }
        })

        toast.error('Failed to select folder: ' + (error instanceof Error ? error.message : 'Unknown error'))
        return false
      }
    },

    /**
     * Set folder handle directly (no dialog, for externally obtained handles)
     */
    setHandle: async (projectId: string, handle: FileSystemDirectoryHandle) => {
      set((state) => {
        const record = state.records[projectId]
        if (record) {
          record.status = 'ready'
          record.error = undefined
        }
      })

      const record: FolderAccessRecord = {
        projectId,
        rootName: handle.name,
        folderName: handle.name,
        handle,
        persistedHandle: handle,
        status: 'ready',
        error: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      // Persist
      await folderAccessRepo.save(record)
      // Multi-root: bind with rootName = handle.name
      bindRuntimeDirectoryHandle(projectId, handle.name, handle)
      await notifyWorkspaceNativeDirectoryGranted(handle)

      set((state) => {
        state.records[projectId] = record
      })

      console.log('[FolderAccessStore] Handle set directly:', handle.name)

      // Ensure a ProjectRoot record exists so loadRoots() can find it
      const rootRepo = getProjectRootRepository()
      const existingRoots = await rootRepo.findByProject(projectId)
      if (!existingRoots.some((r) => r.name === handle.name)) {
        await rootRepo.createRoot({ projectId, name: handle.name })
      }

      // Reload roots so sidebar FileTreePanel picks up the new handle
      await get().loadRoots()

      // Clear file path cache so the local file tree reloads on next search.
      get().clearFilePaths()
    },

    /**
     * Request permission restoration (from needs_user_activation state)
     */
    requestPermission: async (projectId: string) => {
      const record = get().records[projectId]
      if (!record?.persistedHandle) {
        console.warn('[FolderAccessStore] No persisted handle to request permission')
        return false
      }

      set((state) => {
        const r = state.records[projectId]
        if (r) r.status = 'requesting'
      })

      try {
        const handle = record.persistedHandle
        const result = await handle.requestPermission({ mode: 'readwrite' })

        if (result === 'granted') {
          set((state) => {
            const r = state.records[projectId]
            if (r) {
              r.handle = handle
              r.status = 'ready'
              r.error = undefined
              r.updatedAt = Date.now()
            }
          })

          // Update persistence
          await folderAccessRepo.save(get().records[projectId])
          const rootName = record.rootName ?? handle.name ?? projectId
          bindRuntimeDirectoryHandle(projectId, rootName, handle)
          await notifyWorkspaceNativeDirectoryGranted(handle)

          toast.success('Folder permission restored')
          get().clearFilePaths()
          return true
        } else {
          toast.error('Permission denied')
          set((state) => {
            const r = state.records[projectId]
            if (r) r.status = 'needs_user_activation'
          })
          return false
        }
      } catch (error) {
        console.error('[FolderAccessStore] Request permission failed:', error)

        if (error instanceof Error && error.name === 'SecurityError') {
          // Requires user interaction
          set((state) => {
            const r = state.records[projectId]
            if (r) r.status = 'needs_user_activation'
          })
          toast.info('Please click the button again to restore permission')
        } else {
          set((state) => {
            const r = state.records[projectId]
            if (r) {
              r.status = 'error'
              r.error = error instanceof Error ? error.message : 'Unknown error'
            }
          })
          toast.error('Failed to restore permission')
        }
        return false
      }
    },

    /**
     * Fully release (delete record)
     * Critical: must delete IndexedDB record so next add shows the picker
     */
    release: async (projectId: string) => {
      set((state) => {
        const record = state.records[projectId]
        if (record) {
          record.status = 'releasing'
        }
      })

      try {
        // Critical: fully delete IndexedDB record
        await folderAccessRepo.delete(projectId)
        const record = get().records[projectId]
        const rootName = record?.rootName ?? projectId
        unbindRuntimeDirectoryHandle(projectId, rootName)

        set((state) => {
          state.records[projectId] = createEmptyRecord(projectId)
        })

        get().clearFilePaths()
        toast.success('Folder permission released')
        console.log('[FolderAccessStore] Released and deleted record for project:', projectId)
      } catch (error) {
        console.error('[FolderAccessStore] Release failed:', error)
        set((state) => {
          const record = state.records[projectId]
          if (record) {
            record.status = 'error'
            record.error = error instanceof Error ? error.message : 'Unknown error'
          }
        })
      }
    },

    /**
     * Clear error state
     */
    clearError: (projectId: string) => {
      set((state) => {
        const record = state.records[projectId]
        if (record) {
          record.status = record.persistedHandle ? 'needs_user_activation' : 'idle'
          record.error = undefined
        }
      })
    },

    // ========================================================================
    // Selectors
    // ========================================================================

    /**
     * Get current project record
     */
    getRecord: (): FolderAccessRecord | null => {
      const { activeProjectId, records } = get()
      if (!activeProjectId) return null
      return records[activeProjectId] ?? null
    },

    /**
     * Get current project status
     */
    getCurrentStatus: (): FolderAccessStatus | null => {
      const { activeProjectId, records } = get()
      if (!activeProjectId) return null
      return records[activeProjectId]?.status ?? null
    },

    /**
     * Get current project handle
     */
    getCurrentHandle: (): FileSystemDirectoryHandle | null => {
      const { activeProjectId, records } = get()
      if (!activeProjectId) return null
      return records[activeProjectId]?.handle ?? null
    },

    /**
     * Whether the current project is ready
     */
    isReady: (): boolean => {
      const status = get().getCurrentStatus()
      return status === 'ready'
    },

    // ========================================================================
    // Shared file path cache
    // ========================================================================

    ensureFilePaths: async () => {
      const projectId = get().activeProjectId
      if (!projectId) return []
      // Return cache if already exists for this project
      const existing = get().allFilePaths[projectId]
      if (existing && existing.length > 0) return existing
      // Dedup: concurrent calls share the same traversal Promise
      if (_filePathPromises.has(projectId)) return _filePathPromises.get(projectId)!
      const promise = get().refreshFilePaths().finally(() => {
        _filePathPromises.delete(projectId)
      })
      _filePathPromises.set(projectId, promise)
      return promise
    },

    refreshFilePaths: async () => {
      const { getRuntimeHandlesForProject } = await import('@/native-fs')
      const projectId = get().activeProjectId
      if (!projectId) return []

      // Multi-root: traverse all root handles and prefix paths with rootName
      const allHandles = getRuntimeHandlesForProject(projectId)
      if (allHandles.size === 0) {
        // Fallback: no root handles in memory, try current handle
        const handle = get().getCurrentHandle()
        if (!handle) {
          // Last resort: native-host roots (no FS Access handle)
          const nativeHostPaths = await get().refreshFilePathsNativeHost(projectId)
          set((state) => {
            state.allFilePaths[projectId] = nativeHostPaths
            evictLRU(state, projectId)
          })
          return nativeHostPaths
        }
        const { traverseDirectory } = await import('../services/traversal.service')
        const paths: string[] = []
        for await (const entry of traverseDirectory(handle)) {
          paths.push(entry.path)
          if (paths.length >= 5000) break
        }
        set((state) => {
          state.allFilePaths[projectId] = paths
          evictLRU(state, projectId)
        })
        return paths
      }

      const { traverseDirectory } = await import('../services/traversal.service')
      const paths: string[] = []
      for (const [rootName, handle] of allHandles) {
        // Add the root folder itself so it appears in # file mention suggestions
        paths.push(rootName)
        if (paths.length >= 5000) break
        for await (const entry of traverseDirectory(handle)) {
          // Prefix with rootName for multi-root routing
          paths.push(`${rootName}/${entry.path}`)
          if (paths.length >= 5000) break
        }
      }

      // Also scan native-host roots that have no FS Access handle
      const nativeHostPaths = await get().refreshFilePathsNativeHost(projectId)
      if (nativeHostPaths.length > 0) {
        paths.push(...nativeHostPaths)
      }

      set((state) => {
        state.allFilePaths[projectId] = paths
        evictLRU(state, projectId)
      })
      return paths
    },

    /**
     * Scan native-host roots for file paths (no FileSystemDirectoryHandle).
     * Uses the WorkspaceRuntime's diskExec.listDir to traverse.
     */
    refreshFilePathsNativeHost: async (projectId: string) => {
      try {
        const { getProjectRootRepository } = await import('@/sqlite/repositories/project-root.repository')
        const repo = getProjectRootRepository()
        const roots = await repo.findByProject(projectId)
        const nativeHostRoots = roots.filter((r: any) => r.backend === 'native-host')
        if (nativeHostRoots.length === 0) return []

        // Use WorkspaceManager to access diskExec
        const { getWorkspaceManager } = await import('@/opfs')
        const manager = await getWorkspaceManager()

        const paths: string[] = []
        for (const root of nativeHostRoots) {
          paths.push(root.name)
          // Find a workspace for this project to access the runtime
          const workspaces = manager.getAllWorkspaces()
          const projectWs = workspaces.find((ws: any) => ws.projectId === projectId)
          if (!projectWs) continue
          const workspace = await manager.getWorkspace(projectWs.workspaceId)
          if (!workspace) continue
          try {
            // Pass root name as path prefix so resolvePath can match it
            const entries = await workspace.scanDiskTree(root.name, 10, projectId, { maxEntries: 5000 })
            if (entries) {
              for (const entry of entries) {
                if (entry.type === 'file') {
                  paths.push(`${root.name}/${entry.path}`)
                  if (paths.length >= 5000) break
                }
              }
            }
          } catch {
            // skip workspace scan failures
          }
        }
        console.log('[folder-access] refreshFilePathsNativeHost found', paths.length, 'paths for', nativeHostRoots.length, 'native-host roots')
        return paths
      } catch {
        return []
      }
    },

    clearFilePaths: () => {
      const projectId = get().activeProjectId
      if (projectId) {
        _filePathPromises.delete(projectId)
        // Remove from LRU order tracking
        const idx = _cacheOrder.indexOf(projectId)
        if (idx >= 0) _cacheOrder.splice(idx, 1)
        set((state) => {
          delete state.allFilePaths[projectId]
        })
      } else {
        _filePathPromises.clear()
        _cacheOrder.length = 0
        set((state) => {
          state.allFilePaths = {}
        })
      }
      // Reload multi-root state in case handles changed
      const pid = get().activeProjectId
      if (pid) {
        get().loadRoots()
      }
    },

    // ========================================================================
    // Multi-root actions
    // ========================================================================

    roots: [],

    loadRoots: async () => {
      const projectId = get().activeProjectId
      // Mark hydration complete even when there's no active project (so the
      // empty roots state isn't mistaken for "still loading" by the UI).
      // We use a single set() at exit so subscribers see a consistent
      // (roots, rootsHydrated) pair.
      try {
        if (!projectId) {
          set({ roots: [] })
          return
        }

        // Self-heal SQLite `project_roots` before reading: IndexedDB handles and
        // the SQLite table can drift (e.g. after a DB reset / migration), which
        // makes resolvePath() fall back to the wrong root on sync-to-disk.
        await reconcileProjectRoots(projectId)

        // Load from SQLite
        const dbRoots: ProjectRoot[] = await getProjectRootRepository().findByProject(projectId)

        // Load handles from DirectoryHandleManager
        const runtimeHandles = getRuntimeHandlesForProject(projectId)

        const roots: RootInfo[] = await Promise.all(
          dbRoots.map(async (dbRoot) => {
            if (dbRoot.backend === 'native-host') {
              const ready = dbRoot.scopeId && isNativeHostAvailable()
                ? await new NativeHostExecutor().hydrateRoot(projectId, dbRoot.scopeId)
                : false
              return {
                id: dbRoot.id,
                name: dbRoot.name,
                isDefault: dbRoot.isDefault,
                readOnly: dbRoot.readOnly,
                backend: 'native-host',
                scopeId: dbRoot.scopeId,
                handle: null,
                persistedHandle: null,
                status: ready ? 'ready' : 'idle',
                error: ready ? undefined : 'Native Host is unavailable or this folder authorization no longer exists',
              }
            }

            const runtimeHandle = runtimeHandles.get(dbRoot.name)
            let handle = runtimeHandle ?? null

            // Try to restore persisted handle
            let persistedHandle: FileSystemDirectoryHandle | null = null
            let status: FolderAccessStatus = 'idle'
            let error: string | undefined

            if (handle) {
              status = 'ready'
            } else {
              try {
                const record = await folderAccessRepo.findByProjectAndRoot(projectId, dbRoot.name)
                if (record?.persistedHandle) {
                  persistedHandle = record.persistedHandle
                  // Auto-check if browser still has cached permission
                  const permission = await persistedHandle.queryPermission({ mode: 'readwrite' })
                  if (permission === 'granted') {
                    handle = persistedHandle
                    status = 'ready'
                    bindRuntimeDirectoryHandle(projectId, dbRoot.name, handle)
                  } else {
                    status = 'needs_user_activation'
                  }
                } else {
                  status = 'idle'
                }
              } catch {
                status = 'idle'
              }
            }

            return {
              id: dbRoot.id,
              name: dbRoot.name,
              isDefault: dbRoot.isDefault,
              readOnly: dbRoot.readOnly,
              backend: 'fsaccess',
              scopeId: null,
              handle,
              persistedHandle,
              status,
              error,
            }
          })
        )

        set({ roots })

        // Sync first ready handle to agent.store for backward compat
        const firstReady = roots.find((r) => r.status === 'ready' && r.handle)
        if (firstReady?.handle) {
          try {
            const { useAgentStore } = await import('./agent.store')
            useAgentStore.setState({
              directoryHandle: firstReady.handle,
              directoryName: firstReady.name,
            })
          } catch { /* ignore */ }
        }
      } finally {
        // Always mark hydration complete on exit (success or failure), so the
        // UI's "no folder mounted" prompt doesn't flash for users who actually
        // have a root mounted. Mirrors hasApiKeyLoaded in settings.store.
        set({ rootsHydrated: true })
      }
    },

    addRoot: async () => {
      const projectId = get().activeProjectId
      if (!projectId) return false

      // Check if we have directory picker capability
      const capability = getRuntimeCapability()
      if (!capability.canPickDirectory) {
        toast.error('Directory picker not available in this browser')
        return false
      }

      // Pick folder
      const handle = await selectFolderReadWrite()
      if (!handle) return false

      const rootName = handle.name

      // Check for duplicate name
      const existing = get().roots
      if (existing.some((r) => r.name === rootName)) {
        toast.error(`A root named "${rootName}" already exists`)
        return false
      }

      // Create root in SQLite FIRST. If this throws (e.g. UNIQUE constraint,
      // DB error), we bail before binding the handle or persisting to
      // IndexedDB — avoiding orphaned handles with no project_roots row
      // (the exact drift class that breaks syncToDiskMultiRoot routing).
      try {
        await getProjectRootRepository().createRoot({ projectId, name: rootName })
      } catch (createError) {
        console.error('[FolderAccessStore] addRoot: createRoot failed, aborting before handle bind:', createError)
        toast.error(`Failed to add root "${rootName}": ${createError instanceof Error ? createError.message : 'database error'}`)
        return false
      }

      // SQLite row committed — now bind runtime handle and persist to IndexedDB.
      // If either of these fails we log but keep going: the SQLite row exists,
      // and the handle can be re-granted via loadRoots()/needs_user_activation.

      // Bind handle to runtime
      bindRuntimeDirectoryHandle(projectId, rootName, handle)

      // Persist handle
      await folderAccessRepo.save({
        projectId,
        rootName,
        handle,
        persistedHandle: handle,
        folderName: rootName,
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      // Reload roots
      await get().loadRoots()

      // Invalidate workspace-runtime root map cache so that resolvePath()
      // picks up the new root immediately. Without this, the cached _rootMap
      // (keyed by projectId) keeps serving the pre-addRoot snapshot, so read/
      //write/edit tools fail to resolve paths under the new root until the
      // page is refreshed and the runtime is rebuilt from scratch.
      try {
        const { getWorkspaceManager } = await import('@/opfs')
        ;(await getWorkspaceManager()).invalidateRootMapCache(projectId)
      } catch {
        /* manager not ready yet — resolvePath will lazily rebuild */
      }

      // Sync first root to agent.store (used by some tools as default handle)
      try {
        const { useAgentStore } = await import('./agent.store')
        useAgentStore.setState({
          directoryHandle: handle,
          directoryName: rootName,
        })
      } catch { /* ignore */ }

      // Clear the local file path cache after adding a root.
      get().clearFilePaths()

      toast.success(`Added root "${rootName}"`)
      return true
    },

    addNativeHostRoot: async (projectIdOverride?: string) => {
      // Explicit override wins (e.g. exec's in-flow authorization passes the
      // CONVERSATION's project: the global active-project pointer can change
      // mid-run, and a root bound to the wrong project would be invisible to
      // resolveScopeId). Falls back to the UI pointer for direct user clicks.
      const projectId = projectIdOverride ?? get().activeProjectId
      if (!projectId || !isNativeHostAvailable()) {
        toast.error(i18nText('projectRoots.nativeHostUnavailable', 'Local connection is unavailable'))
        return false
      }

      try {
        const root = await new NativeHostExecutor().authorizeRoot(projectId)
        if (!root) return false
        if (get().roots.some((item) => item.name === root.displayName)) {
          toast.error(i18nText('projectRoots.rootAlreadyExists', `A folder named "${root.displayName}" already exists`, { name: root.displayName }))
          return false
        }
        // Host-side scopes are GLOBAL: if another project already added this
        // same local folder, the Rust host returns the SAME scope_id (scope.rs
        // add_scope dedupes by canonical path) and we simply create another
        // project binding for it — no extra error handling needed here.
        await getProjectRootRepository().createRoot({
          projectId,
          name: root.displayName,
          backend: 'native-host',
          scopeId: root.id,
        })
        await get().loadRoots()
        try {
          const { getWorkspaceManager } = await import('@/opfs')
          ;(await getWorkspaceManager()).invalidateRootMapCache(projectId)
        } catch { /* manager not ready */ }
        get().clearFilePaths()
        toast.success(i18nText('projectRoots.nativeRootAdded', `Added "${root.displayName}" through local connection`, { name: root.displayName }))
        return true
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'unknown error'
        toast.error(i18nText('projectRoots.nativeRootAddFailed', `Failed to add local connection: ${errorMessage}`, { error: errorMessage }))
        return false
      }
    },

    removeRoot: async (rootId: string) => {
      const projectId = get().activeProjectId
      if (!projectId) return

      const root = get().roots.find((r) => r.id === rootId)
      if (!root) return

      // NOTE: native-host scopes are global on the host side (shared across
      // projects — adding the same local folder from another project reuses
      // the same scope_id), so revoking happens AFTER the local removal below,
      // guarded by a cross-project reference count.

      // A native-host row without scopeId (partial write / migration drift)
      // has nothing to revoke — remove locally and say so.
      if (root.backend === 'native-host' && !root.scopeId) {
        console.warn(
          '[FolderAccessStore] removeRoot: native-host root has no scopeId, removing locally only:',
          root.name
        )
        toast.info(i18nText(
          'projectRoots.nativeRootRemovedLocalOnly',
          'Removed this folder from the project (no local-connection authorization to revoke)'
        ))
      }

      // Unbind handle
      unbindRuntimeDirectoryHandle(projectId, root.name)

      // Delete from SQLite
      await getProjectRootRepository().deleteRoot(rootId)

      // Revoke the native-host scope only when this was the LAST project
      // binding that scope. Otherwise the scope is still in use by other
      // projects and must stay alive (it is global on the host side).
      // Best-effort only: NEVER abort or fail the local removal because the
      // revoke failed — a scope the host no longer knows (host reinstalled,
      // scopes file lost, or extension/background bridge dead) must not make
      // the root unremovable (the "unknown scope_id" deadlock).
      // Known limitation: this check-then-act is not atomic across concurrent
      // removeRoot calls (two tabs removing the last two bindings of one
      // scope can both observe a remaining binding and both skip the revoke,
      // leaving an orphaned host-side authorization). Accepted for the
      // single-user desktop model; an orphan has no local binding and the
      // next add of the same folder reuses the same scope_id.
      if (root.backend === 'native-host' && root.scopeId) {
        try {
          const allBindings = await getProjectRootRepository().findByScopeId(root.scopeId)
          if (allBindings.length === 0) {
            await new NativeHostExecutor().revokeRoot(projectId, root.scopeId)
            toast.info(i18nText(
              'projectRoots.nativeRootScopeRevoked',
              'Local-connection authorization revoked for this folder (no other project was using it)'
            ))
          } else {
            toast.info(i18nText(
              'projectRoots.nativeRootScopeStillShared',
              'Removed this folder from the project. Its local-connection authorization is kept because {count} other project(s) still use it.',
              { count: allBindings.length }
            ))
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'unknown error'
          console.warn(
            '[FolderAccessStore] removeRoot: revokeRoot failed, continuing with local removal:',
            errorMessage
          )
          toast.warning(i18nText(
            'projectRoots.nativeRootRevokeFailedRemovedLocally',
            'Removed this folder from the project, but revoking its local-connection authorization failed: {error}',
            { error: errorMessage }
          ))
        }
      }

      // Invalidate workspace-runtime root map cache (same rationale as addRoot).
      try {
        const { getWorkspaceManager } = await import('@/opfs')
        ;(await getWorkspaceManager()).invalidateRootMapCache(projectId)
      } catch {
        /* manager not ready yet */
      }

      // Delete handle record
      await folderAccessRepo.deleteByProjectAndRoot(projectId, root.name)

      // If this was the default root, promote another as default
      if (root.isDefault) {
        const remaining = get().roots.filter((r) => r.id !== rootId)
        if (remaining.length > 0) {
          await getProjectRootRepository().setDefaultRoot(projectId, remaining[0].id)
        }
      }

      // Reload roots
      await get().loadRoots()

      // Sync to agent.store: use first remaining root's handle
      try {
        const { useAgentStore } = await import('./agent.store')
        const remaining = get().roots
        if (remaining.length > 0 && remaining[0].handle) {
          useAgentStore.setState({
            directoryHandle: remaining[0].handle,
            directoryName: remaining[0].name,
          })
        } else {
          useAgentStore.setState({
            directoryHandle: null,
            directoryName: null,
          })
        }
      } catch { /* ignore */ }

      // Clear the local file path cache after removing a root.
      get().clearFilePaths()

      toast.success(`Removed root "${root.name}"`)
    },

    setDefaultRoot: async (rootId: string) => {
      const projectId = get().activeProjectId
      if (!projectId) return

      await getProjectRootRepository().setDefaultRoot(projectId, rootId)

      // Reload roots
      await get().loadRoots()
    },

    toggleReadOnly: async (rootId: string) => {
      const root = get().roots.find((r) => r.id === rootId)
      if (!root) return

      const dbRoot = await getProjectRootRepository().findById(rootId)
      if (!dbRoot) return
      await getProjectRootRepository().updateRoot({
        ...dbRoot,
        readOnly: !dbRoot.readOnly,
      })
      await get().loadRoots()
    },
  }))
)

// ============================================================================
// Convenience hook
// ============================================================================

/**
 * Convenience hook: get the current project's folder access state
 */
export function useCurrentFolderAccess() {
  const store = useFolderAccessStore()
  const { activeProjectId, records } = store

  const record = activeProjectId ? records[activeProjectId] : null

  return {
    ...store,
    record,
    projectId: activeProjectId,
    isReady: record?.status === 'ready',
    isIdle: record?.status === 'idle',
    isNeedsActivation: record?.status === 'needs_user_activation',
    isChecking: record?.status === 'checking',
    isRequesting: record?.status === 'requesting',
    isReleasing: record?.status === 'releasing',
    hasError: record?.status === 'error',
    folderName: record?.folderName ?? null,
    handle: record?.handle ?? null,
    error: record?.error,
  }
}
