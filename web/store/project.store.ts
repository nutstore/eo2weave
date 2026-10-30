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

// Module-level serialization for deleteProject's host-rebind critical
// section: overlapping deletions chain onto this promise so the second one
// re-reads project state only after the first has finished rebinding (see
// deleteProject for why concurrent selection would strand host rows on
// projects that are themselves being deleted).
let projectDeletionRebindChain: Promise<void> = Promise.resolve()

// In-memory retry list for OPFS workspace-data deletions that failed AFTER
// the DB row was already committed. Best-effort DEFERRED cleanup only —
// deliberately NOT persisted (storage-light rule): at that point the data is
// unreferenced, so a failed cleanup leaves orphaned files, never data loss.
// Dropped on page reload by design.
const pendingOpfsProjectDeletions = new Set<string>()

// Upper bound for one OPFS cleanup attempt. Cleanup is best-effort (the DB
// row is already gone, so a skipped cleanup only leaves orphaned files), but
// it is awaited INSIDE the serialized deletion chain: a cleanup that never
// settles would hold the chain forever and block every later project
// deletion in this tab. The race bounds that wait — on timeout the project
// id stays in (or is added to) the retry list and the chain moves on.
const OPFS_CLEANUP_TIMEOUT_MS = 10_000

// Overall wall-clock budget for ONE flush pass over the retry queue. Each
// queued cleanup is already bounded per-attempt, but the flush loop is
// awaited INSIDE the serialized deletion chain: without a pass-level cap a
// large retry backlog would serialize N × 10s of waits into the chain and
// delay every later project deletion in this tab. One pass spends at most
// this much time; leftovers stay queued for the next flush (best-effort —
// the data is unreferenced, so deferred cleanup is orphaned files only).
const OPFS_FLUSH_BUDGET_MS = 10_000

/**
 * Await `promise` with a hard deadline. Resolves with `false` if the
 * underlying promise does not settle within `timeoutMs` (the promise keeps
 * running in the background — its late result is ignored, never a leak of
 * failure into the caller's error path).
 */
async function withTimeout(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function tryDeleteOpfsProject(projectId: string): Promise<boolean> {
  try {
    const pm = await ProjectManager.create()
    await pm.deleteProject(projectId)
    return true
  } catch (error) {
    console.warn('[ProjectStore] Failed to delete OPFS project directory (will retry):', projectId, error)
    return false
  }
}

/** Best-effort bounded OPFS cleanup: false on failure OR on timeout. */
function tryDeleteOpfsProjectBounded(projectId: string): Promise<boolean> {
  return withTimeout(tryDeleteOpfsProject(projectId), OPFS_CLEANUP_TIMEOUT_MS)
}

async function flushPendingOpfsProjectDeletions(): Promise<void> {
  if (pendingOpfsProjectDeletions.size === 0) return
  const deadline = Date.now() + OPFS_FLUSH_BUDGET_MS
  for (const id of [...pendingOpfsProjectDeletions]) {
    if (Date.now() >= deadline) break
    // eslint-disable-next-line no-await-in-loop -- sequential retries keep OPFS contention predictable
    if (await tryDeleteOpfsProjectBounded(id)) {
      pendingOpfsProjectDeletions.delete(id)
    }
  }
  // Leftover ids stay queued: the next flush pass retries them under a
  // fresh budget.
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

        // 1c. Revalidate the project row IMMEDIATELY before publishing the
        //     active id: a deleteProject can commit between the initial
        //     existence check above and this point (activation awaits OPFS
        //     bootstrap and several store resets in between). If deletion
        //     read the OLD active pointer and skipped repair, publishing the
        //     deleted id here would strand the UI on a project whose row is
        //     gone. The re-check and the publish in step 2 run in ONE
        //     synchronous continuation (no await between them), so within
        //     this tab a concurrent deletion cannot slip between the check
        //     and the commit.
        const stillExists = await repo.findById(projectId)
        if (!stillExists) {
          await get().refreshProjects()
          set({
            error: `Project not found: ${projectId}`,
            isLoading: false,
          })
          return false
        }

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

        // Standalone chats keep a hidden host workspace row pointing at the
        // deleted project. Rebind ALL host rows (including the direct-chat
        // ones, which project-scoped listings filter out) BEFORE the project
        // row is deleted: if a rebind fails here the deletion aborts with a
        // visible error and stays retryable — already-rebound rows no longer
        // match the findAll query, so the loop is idempotent on retry. When
        // the deleted project is the LAST project, hosts are rebound to empty
        // string, which every consumer treats as "no project" (falsy
        // projectId checks, e.g. resolvedProjectId in conversation-agent-run).
        //
        // Overlapping deletions are SERIALIZED on a module-level promise
        // chain around the rebind+delete critical section: two concurrent
        // deletions computing their replacement host from the same
        // not-yet-updated project table would each rebind the other's
        // standalone-chat hosts to a project that is about to be deleted.
        // Inside the section the successor is re-read from the repository
        // (fresh state — the in-memory `projects` snapshot predates any
        // awaits), the host rows are re-bound, AND the project row is
        // deleted — all before the next chained deletion's selection runs,
        // so it can never pick a project whose row is already gone.
        //
        // The predecessor's rejection is SWALLOWED before this section is
        // attached (`.catch(() => {})`): a plain `.then(...)` chain would
        // skip every queued section after a failure, leaving those projects
        // undeleted while their callers saw... nothing resolve. With the
        // swallow, every queued deletion runs regardless — but this caller
        // still observes its own failure, because the local `section` link
        // this function awaits carries the section's rejection. Ordering is
        // preserved: sections execute strictly in queue order whether or not
        // earlier ones failed.
        const section = projectDeletionRebindChain
          .catch(() => {
            // A failed predecessor must not strand this deletion: its error
            // was already reported to ITS caller via its own rejected link.
          })
          .then(async () => {
            const remaining = await repo.findAllProjects()
            const nextProjectId = remaining.find((p) => p.id !== projectId)?.id || ''
            const { getWorkspaceRepository } = await import('@/sqlite/repositories/workspace.repository')
            const workspaceRepo = getWorkspaceRepository()
            const orphaned = await workspaceRepo.findAllWorkspacesByProjectIncludingDirect(projectId)
            // Rebind ALL host rows off the deleted project AND delete the
            // project row in ONE SQLite transaction (repository method): an
            // interruption mid-section can no longer leave the project row
            // alive with some workspaces already assigned to the successor —
            // rebinds and the row deletion commit (or roll back) together, so
            // a retry observes the pre-deletion state and re-runs cleanly.
            await repo.deleteProjectIncludingHostRebind(
              projectId,
              nextProjectId,
              orphaned.map((ws) => ws.id)
            )

              // ── OPFS workspace-data cleanup — AFTER the DB commit ──
              // Deliberately deferred and best-effort: the row is gone, so the
              // OPFS data is unreferenced — a failed cleanup leaves orphaned
              // files, NOT data loss. Deleting it BEFORE the commit (the old
              // order) destroyed workspace files on a failed deletion that the
              // rollback path could not restore. Failures are logged and
              // queued in an in-memory retry list (not persisted — storage-
              // light rule); the next successful deletion flushes the queue.
              // The wait is BOUNDED (timeout race): a hung cleanup must not
              // hold the serialized deletion chain forever and strand every
              // later deletion — on timeout the id is queued for retry and
              // the chain proceeds (tradeoff: possible orphaned OPFS files
              // until a later flush succeeds).
              if (!(await tryDeleteOpfsProjectBounded(projectId))) {
                pendingOpfsProjectDeletions.add(projectId)
              }
              await flushPendingOpfsProjectDeletions()

            // ── Post-delete repair — INSIDE the serialized section ──
            // The check must run AFTER this deletion committed, and inside
            // the chain: reading `get().activeProjectId` before the chain
            // takes a stale snapshot (an earlier chained deletion may have
            // rebound the active pointer to THIS project after this caller
            // was invoked), and running the repair outside the chain lets two
            // concurrent repairs interleave with each other's row deletion.
            // `!activeId` covers the last-project case: the previous deletion
            // cleared the pointer, and this deletion must not leave hosts
            // pointing at empty while survivors exist (or vice versa).
            //
            // The row is GONE at this point, so nothing here may flip the
            // caller's result to false: a repair crash is logged (and still
            // surfaced via the outer non-fatal refresh below), never
            // rethrown — a thrown repair would make the caller report
            // failure for a deletion that already committed. Each step is
            // guarded independently so a failure in one does not skip the
            // others.
            const activeId = get().activeProjectId
            if (!activeId || activeId === projectId) {
              // A repair crash must not flip the deletion's result: the row
              // is already gone, so a rejection here would report failure for
              // a committed deletion (and the queued callers' prefix would
              // swallow it while the UI showed a stale list). Log and move
              // on — refreshProjects below re-syncs the list from SQLite.
              try {
                const { useAgentStore } = await import('@/store/agent.store')
                const { useConversationContextStore } = await import('@/store/conversation-context.store')

                // Re-read survivors AFTER the deletion committed: the host
                // rebind's value described pre-deletion state, and a concurrent
                // deletion may have removed that project in the meantime.
                const remainingAfterDelete = await repo.findAllProjects()
                const successorId = remainingAfterDelete.find((p) => p.id !== projectId)?.id || ''
                if (successorId) {
                  await repo.setActiveProject(successorId)
                  set({ activeProjectId: successorId })
                  await useAgentStore.getState().setActiveProject(successorId)
                } else {
                  await repo.clearActiveProject()
                  set({ activeProjectId: '' })
                  await useAgentStore.getState().setActiveProject('')
                }

                await useConversationContextStore.getState().refreshWorkspaces()
              } catch (repairError) {
                // The deletion HAS committed — never rethrow. Repair the
                // in-memory pointer defensively before returning success:
                // without this the active pointer stays on the deleted id
                // (refreshProjects() re-syncs the LIST but not the pointer),
                // so the UI keeps a project that no longer exists.
                console.error('[ProjectStore] Post-delete active-pointer repair failed (deletion committed):', repairError)
                const fallbackId = (await repo.findAllProjects().catch(() => [] as Project[]))
                  .find((p) => p.id !== projectId)?.id || ''
                set({ activeProjectId: fallbackId })
                // Re-sync dependent workspace state for the fallback pointer.
                try {
                  const { useConversationContextStore } = await import('@/store/conversation-context.store')
                  useConversationContextStore.setState({
                    activeWorkspaceId: null,
                    workspaces: [],
                    initialized: false,
                  })
                  await useConversationContextStore.getState().refreshWorkspaces()
                } catch (refreshError) {
                  console.warn('[ProjectStore] Failed to refresh workspaces after failed repair:', refreshError)
                }
              }
            }
          })
        // The module-level chain keeps the section's rejection until the
        // NEXT caller's `.catch` prefix swallows it, so awaiting the local
        // link propagates this section's failure to THIS caller's catch
        // (retryable), while later callers are insulated by their own
        // prefix and keep draining.
        projectDeletionRebindChain = section
        // The section only rejects when the ROW DELETION itself failed (the
        // post-delete repair above never rethrows). Before reporting the
        // failure, refresh the list so the UI does not keep a project that
        // may or may not have been removed by an interrupted run.
        await section.catch(async (sectionError: unknown) => {
          await get().refreshProjects()
          throw sectionError
        })

        await get().refreshProjects()

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
