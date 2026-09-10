/**
 * Project Store
 *
 * Phase 2 (minimal): manage active project selection while keeping current UI behavior.
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  getProjectRepository,
  type Project,
  type ProjectStats,
  DEFAULT_PROJECT_ID,
} from '@/sqlite/repositories/project.repository'
import { ProjectManager } from '@/opfs'

//=============================================================================
// Cross-Tab Synchronization
//=============================================================================

const PROJECT_CHANGE_CHANNEL = 'creatorweave-project-changes'
const PROJECT_PASSIVE_REFRESH_INTERVAL_MS = 1000

type ProjectChangeMessage =
  | { type: 'created'; projectId: string }
  | { type: 'updated'; projectId: string }
  | { type: 'deleted'; projectId: string }
  | { type: 'refresh' }

let projectChangeChannel: BroadcastChannel | null = null
let projectSyncInitialized = false
let lastProjectPassiveRefreshAt = 0

function getProjectChangeChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (!projectChangeChannel) {
    projectChangeChannel = new BroadcastChannel(PROJECT_CHANGE_CHANNEL)
  }
  return projectChangeChannel
}

function broadcastProjectChange(message: ProjectChangeMessage): void {
  const channel = getProjectChangeChannel()
  if (channel) {
    try {
      channel.postMessage(message)
    } catch (e) {
      console.warn('[ProjectStore] Failed to broadcast project change:', e)
    }
  }
}

function setupProjectChangeListener(onChange: () => void): () => void {
  const channel = getProjectChangeChannel()
  if (!channel) return () => {}

  const handler = (_event: MessageEvent<ProjectChangeMessage>) => {
    // Always refresh on any change from another tab
    onChange()
  }
  channel.addEventListener('message', handler)
  return () => channel.removeEventListener('message', handler)
}

function setupProjectSync(onChange: () => void): () => void {
  if (projectSyncInitialized) return () => {}
  projectSyncInitialized = true

  const unsubChannel = setupProjectChangeListener(() => {
    console.log('[ProjectStore] Received cross-tab change, refreshing...')
    onChange()
  })

  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

  const refreshOnTabActivation = () => {
    const now = Date.now()
    if (now - lastProjectPassiveRefreshAt < PROJECT_PASSIVE_REFRESH_INTERVAL_MS) return
    lastProjectPassiveRefreshAt = now
    console.log('[ProjectStore] Tab activated, refreshing projects...')
    onChange()
  }

  window.addEventListener('focus', refreshOnTabActivation)
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') {
      refreshOnTabActivation()
    }
  }
  document.addEventListener('visibilitychange', handleVisibility)

  // Return cleanup function so callers can tear down listeners on unmount.
  return () => {
    unsubChannel()
    window.removeEventListener('focus', refreshOnTabActivation)
    document.removeEventListener('visibilitychange', handleVisibility)
    projectSyncInitialized = false
  }
}

interface ProjectState {
  activeProjectId: string
  projects: Project[]
  projectStats: Record<string, ProjectStats>
  initialized: boolean
  isLoading: boolean
  error: string | null

  initialize: () => Promise<void>
  setActiveProject: (projectId: string) => Promise<boolean>
  refreshProjects: () => Promise<void>
  createProject: (name: string) => Promise<Project | null>
  renameProject: (projectId: string, name: string) => Promise<boolean>
  setProjectArchived: (projectId: string, archived: boolean) => Promise<boolean>
  deleteProject: (projectId: string) => Promise<boolean>
}

/**
 * localStorage key for tracking whether we've already auto-created a default
 * project for this browser.
 *
 * Set once after the first auto-creation. If the user later deletes all
 * projects, we DON'T auto-create again — they've expressed intent to have
 * zero projects.
 */
const AUTO_DEFAULT_CREATED_KEY = 'creatorweave:auto-default-project-created'

/**
 * Get a localized default project name without React hooks (for use in store).
 */
function getLocalizedDefaultProjectName(): string {
  try {
    const stored = localStorage.getItem('bfosa-i18n')
    const locale = stored ? (JSON.parse(stored)?.state?.locale as string) : undefined
    if (locale === 'en-US') return 'My Project'
    if (locale === 'ja-JP') return 'マイプロジェクト'
    if (locale === 'ko-KR') return '내 프로젝트'
    return '我的项目' // zh-CN default
  } catch {
    return '我的项目'
  }
}

async function bootstrapProjectOpfs(projectId: string): Promise<void> {
  if (!projectId) return
  if (typeof navigator === 'undefined') return
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return

  try {
    const pm = await ProjectManager.create()
    await pm.getOrCreateProjectById(projectId)
  } catch (error) {
    console.warn('[ProjectStore] Failed to bootstrap OPFS project:', error)
  }
}

async function syncAgentsForProject(projectId: string): Promise<void> {
  if (!projectId) return
  try {
    const [agentsModule, pm] = await Promise.all([
      import('./agents.store'),
      ProjectManager.create(),
    ])
    const agentsStore = agentsModule.useAgentsStore
    // Reset so initialize() will re-run (needed for project switch)
    agentsStore.setState({ isInitialized: false, agents: [] })
    const state = agentsStore.getState()
    state.setProjectManager(pm)
    await state.initialize(projectId)
  } catch (error) {
    console.warn('[ProjectStore] Failed to sync agents store:', error)
  }
}

export const useProjectStore = create<ProjectState>()(
  immer((set, get) => ({
    activeProjectId: '',
    projects: [],
    projectStats: {},
    initialized: false,
    isLoading: false,
    error: null,

    initialize: async () => {
      // setupProjectSync is idempotent — returns the previous cleanup if already
      // initialised, so calling initialize() multiple times is safe.
      setupProjectSync(() => {
        void get().refreshProjects()
      })
      if (get().initialized) return

      const started = performance.now()
      console.log('[ProjectStore] initialize start')
      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()
        const [projects, stats] = await Promise.all([
          repo.findAllProjects(),
          repo.findProjectStats(),
        ])
        let normalizedProjects = projects
        let normalizedStats = stats
        // PR-B: active project is URL-driven, NOT restored from a persisted
        // singleton. Leave activeProjectId empty here; App.tsx's syncFromRoute
        // (driven by the URL :projectId param) sets it after init.
        const normalizedActiveProjectId = ''

        // Dev-phase hard cleanup: remove legacy seeded default project if it exists.
        const hasLegacyDefault = normalizedProjects.some((project) => project.id === DEFAULT_PROJECT_ID)
        if (hasLegacyDefault) {
          // Delete OPFS directory for legacy default project
          try {
            const pm = await ProjectManager.create()
            await pm.deleteProject(DEFAULT_PROJECT_ID)
          } catch (err) {
            console.warn('[ProjectStore] Failed to delete legacy OPFS project directory:', err)
          }
          await repo.deleteProject(DEFAULT_PROJECT_ID)
          normalizedProjects = normalizedProjects.filter((project) => project.id !== DEFAULT_PROJECT_ID)
          normalizedStats = normalizedStats.filter((entry) => entry.projectId !== DEFAULT_PROJECT_ID)
        }

        // Active project is now URL-driven. Do NOT auto-pick projects[0] here —
        // that would race with the URL and cause cross-tab desync. If there's no
        // URL project, the user lands on /projects and picks one.
        // (bootstrapProjectOpfs now happens in setActiveProject, called by syncFromRoute.)

        // ── Auto-create default project for first-time users ──────────────
        // If this is a brand-new user with zero projects, automatically create
        // one so they can start chatting immediately instead of being blocked
        // by an empty ProjectHome that demands a project name decision.
        //
        // Only fires ONCE per browser (tracked by localStorage flag). If the
        // user deletes all projects later, we respect that decision and don't
        // auto-create again.
        if (
          normalizedProjects.length === 0 &&
          !localStorage.getItem(AUTO_DEFAULT_CREATED_KEY)
        ) {
          try {
            const defaultName = getLocalizedDefaultProjectName()
            const defaultProject = await repo.createProject({ name: defaultName })
            await bootstrapProjectOpfs(defaultProject.id)
            localStorage.setItem(AUTO_DEFAULT_CREATED_KEY, '1')
            normalizedProjects = [defaultProject]
            normalizedStats = [{
              projectId: defaultProject.id,
              workspaceCount: 0,
            }]
            console.log('[ProjectStore] Auto-created default project:', defaultProject.id)
          } catch (err) {
            console.warn('[ProjectStore] Failed to auto-create default project:', err)
          }
        }

        const projectStats = Object.fromEntries(
          normalizedStats.map((entry) => [entry.projectId, entry])
        )

        set({
          projects: normalizedProjects,
          projectStats,
          activeProjectId: normalizedActiveProjectId,
          initialized: true,
          isLoading: false,
        })

        try {
          const { useAgentStore } = await import('./agent.store')
          await useAgentStore.getState().setActiveProject(normalizedActiveProjectId)
        } catch (error) {
          console.warn('[ProjectStore] Failed to sync agent store active project:', error)
        }
        await syncAgentsForProject(normalizedActiveProjectId)

        console.log(`[ProjectStore] initialize done (${Math.round(performance.now() - started)}ms)`)
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to initialize projects'
        set({
          error: message,
          initialized: true,
          isLoading: false,
        })
        console.error(
          `[ProjectStore] initialize failed (${Math.round(performance.now() - started)}ms):`,
          message
        )
      }
    },

    setActiveProject: async (projectId: string) => {
      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()

        const targetProject = await repo.findById(projectId)
        if (!targetProject) {
          await get().refreshProjects()
          set({
            error: `Project not found: ${projectId}`,
            isLoading: false,
          })
          return false
        }

        await repo.setActiveProject(projectId)
        await bootstrapProjectOpfs(projectId)
        const now = Date.now()

        // 1. Clear stale workspace context atomically BEFORE updating activeProjectId.
        //    This prevents the URL sync effect from firing with the old project's workspace.
        //    Also reset `initialized` so refreshWorkspaces() will fully reload.
        //    Uses the shared PENDING_RESET_PATCH so the badge count, pending file
        //    list, unsynced-snapshot list, etc. can never leak across project
        //    switches (Bug 2: stale badge count from old workspace).
        const { useConversationContextStore } = await import('./conversation-context.store')
        const { PENDING_RESET_PATCH } = await import('./workspace.store')
        useConversationContextStore.setState({
          ...PENDING_RESET_PATCH,
          activeWorkspaceId: null,
          workspaces: [],
          initialized: false,
        })

        // 1b. Clear active pointer only; keep conversation cache in memory so
        //     runs from other projects can continue without being torn down.
        const { useConversationStoreSQLite } = await import('./conversation.store.sqlite')
        useConversationStoreSQLite.setState({
          activeConversationId: null,
        })

        // 2. Update activeProjectId (keep isLoading=true until workspaces loaded).
        //    CRITICAL: setting isLoading=false here would race with syncFromRoute
        //    in App.tsx — the effect subscribes to isLoading, and if it sees
        //    isLoading=false while workspaces is still empty (cleared in step 1,
        //    not yet refilled by refreshWorkspaces in step 4), it would resolve
        //    no target workspace and navigate to the bare project URL, stripping
        //    :workspaceId from the URL on page refresh.
        set({
          activeProjectId: projectId,
          projects: get().projects.map((project) =>
            project.id === projectId
              ? {
                  ...project,
                  updatedAt: now,
                }
              : project
          ),
        })

        // 3. Sync dependent stores.
        const { useAgentStore } = await import('./agent.store')
        await useAgentStore.getState().setActiveProject(projectId)
        await syncAgentsForProject(projectId)

        // 4. Load workspace list for the new project.
        //    Do NOT pick a specific workspace here — the route sync effect
        //    (syncFromRoute in App.tsx) is responsible for selecting the
        //    correct workspace based on the URL.
        await useConversationContextStore.getState().refreshWorkspaces()

        // 4b. Refresh projectStats so the per-project conversation/workspace
        //     badge count reflects the freshly loaded project (otherwise it
        //     stays at the stale snapshot from initialize and shows e.g. "5"
        //     when the DB actually has 6).
        await get().refreshProjects()

        // 5. Loading complete — signal syncFromRoute effect to proceed.
        set({ isLoading: false })

        broadcastProjectChange({ type: 'updated', projectId })
        return true
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to set active project'
        set({
          error: message,
          isLoading: false,
        })
        return false
      }
    },

    refreshProjects: async () => {
      try {
        const repo = getProjectRepository()
        const [projects, stats] = await Promise.all([repo.findAllProjects(), repo.findProjectStats()])
        const projectStats = Object.fromEntries(stats.map((entry) => [entry.projectId, entry]))
        set({ projects, projectStats })
      } catch (e) {
        console.error('[ProjectStore] Failed to refresh projects:', e)
      }
    },

    createProject: async (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return null

      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()
        const project = await repo.createProject({ name: trimmed })
        await bootstrapProjectOpfs(project.id)
        const [projects, stats] = await Promise.all([repo.findAllProjects(), repo.findProjectStats()])
        const projectStats = Object.fromEntries(stats.map((entry) => [entry.projectId, entry]))
        set({
          projects,
          projectStats,
          isLoading: false,
        })
        broadcastProjectChange({ type: 'created', projectId: project.id })
        return project
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to create project'
        set({
          error: message,
          isLoading: false,
        })
        return null
      }
    },

    renameProject: async (projectId: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return false

      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()
        const existing = await repo.findById(projectId)
        if (!existing) {
          set({ isLoading: false, error: 'Project not found' })
          return false
        }

        await repo.updateProject({
          ...existing,
          name: trimmed,
          updatedAt: Date.now(),
        })
        await get().refreshProjects()
        set({ isLoading: false })
        broadcastProjectChange({ type: 'refresh' })
        return true
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to rename project'
        set({
          error: message,
          isLoading: false,
        })
        return false
      }
    },

    setProjectArchived: async (projectId: string, archived: boolean) => {
      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()
        const existing = await repo.findById(projectId)
        if (!existing) {
          set({ isLoading: false, error: 'Project not found' })
          return false
        }

        await repo.updateProject({
          ...existing,
          status: archived ? 'archived' : 'active',
          updatedAt: Date.now(),
        })
        await get().refreshProjects()
        set({ isLoading: false })
        broadcastProjectChange({ type: 'refresh' })
        return true
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to update project status'
        set({
          error: message,
          isLoading: false,
        })
        return false
      }
    },

    deleteProject: async (projectId: string) => {
      set({ isLoading: true, error: null })
      try {
        const repo = getProjectRepository()
        const activeProjectId = get().activeProjectId

        // Delete OPFS project directory (workspaces, agents, etc.)
        try {
          const pm = await ProjectManager.create()
          await pm.deleteProject(projectId)
        } catch (err) {
          console.warn('[ProjectStore] Failed to delete OPFS project directory:', err)
        }

        await repo.deleteProject(projectId)
        await get().refreshProjects()

        if (activeProjectId === projectId) {
          const remainingProjects = get().projects
          const nextProjectId = remainingProjects[0]?.id || ''
          const { useAgentStore } = await import('./agent.store')
          const { useConversationContextStore } = await import('./conversation-context.store')

          if (nextProjectId) {
            await repo.setActiveProject(nextProjectId)
            set({ activeProjectId: nextProjectId })
            await useAgentStore.getState().setActiveProject(nextProjectId)
          } else {
            await repo.clearActiveProject()
            set({ activeProjectId: '' })
            await useAgentStore.getState().setActiveProject('')
          }

          await useConversationContextStore.getState().refreshWorkspaces()
        }

        set({ isLoading: false })
        broadcastProjectChange({ type: 'deleted', projectId })
        return true
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to delete project'
        set({
          error: message,
          isLoading: false,
        })
        return false
      }
    },
  }))
)

export type { ProjectState }
