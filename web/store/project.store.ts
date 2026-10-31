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
import { PROJECT_STORE_INIT_ERROR_KEY } from '@/lib/app-storage-keys'

/**
 * Classification of a project-store initialization failure.
 *
 * 'transient'  — the error matches a KNOWN retryable-contention signature
 *                (OPFS sync-handle busy, SQLITE_BUSY/LOCKED, worker startup
 *                hiccup). Retrying usually fixes it; user data is safe.
 * 'corruption' — the error text matches a known database/storage corruption
 *                signature. Data may NOT be safe — copy must not reassure.
 * 'unknown'    — anything else (I/O errors, unrecognized failures). There is
 *                no basis to promise the data is safe, so the copy must be
 *                neutral: state what happened and offer Retry + Diagnostics
 *                WITHOUT the "projects are safe" reassurance.
 */
export type ProjectInitErrorKind = 'transient' | 'corruption' | 'unknown'

const CORRUPTION_ERROR_PATTERNS = [
  /database\s*(?:file\s*)?(?:is\s*)?corrupt/i,
  /corrupt(?:ed)?\s*database/i,
  /malformed/i,
  /not\s*a\s*database/i,
  /sqlite\[(?:SQLITE_CORRUPT|SQLITE_NOTADB)\]/i,
]

/**
 * KNOWN transient (retryable-contention) signatures — kept in sync with the
 * busy-error detection in sqlite-worker.ts (isOpfsBusyError). Only these earn
 * the "projects are safe, retrying usually fixes it" reassurance.
 *
 * NOTE (Sourcery: "Persistent open failures promise safe data"): CANTOPEN and
 * database_inaccessible are deliberately NOT here — they can mean a persistent
 * path/access problem, not just temporary contention. They fall through to
 * 'unknown' (neutral copy) in classifyProjectInitError below.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /opfs\s*pool\s*busy/i,
  /nomodificationallowederror/i,
  /modifications\s*are\s*not\s*allowed/i,
  /sync\s*handle/i,
  /getsynchandleerror/i,
  /sqlite_busy/i,
  /sqlite_locked/i,
  /database\s*is\s*locked/i,
  /result\s*code\s*[56]\b/i,
]

export function classifyProjectInitError(message: string): ProjectInitErrorKind {
  if (CORRUPTION_ERROR_PATTERNS.some((p) => p.test(message))) return 'corruption'
  // Only explicitly recognized contention failures get the reassurance
  // classification. Unknown storage failures (e.g. I/O errors) fall through
  // to 'unknown' — the copy must not promise the data is safe (Sourcery:
  // "Storage damage gets reassurance").
  if (TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))) return 'transient'
  return 'unknown'
}

/**
 * Persist an init failure outside the console so it survives into the
 * diagnostics report (runDiagnostics only reads console-free state) and
 * users can attach it to bug reports even after a reload. Shared by
 * initialize()'s catch path and reportInitFailure() so both failure origins
 * land in the same sessionStorage record.
 */
function persistInitErrorRecord(message: string, stack?: string): void {
  try {
    sessionStorage.setItem(
      PROJECT_STORE_INIT_ERROR_KEY,
      JSON.stringify({
        message,
        kind: classifyProjectInitError(message),
        stack,
        at: new Date().toISOString(),
      })
    )
  } catch {
    // sessionStorage unavailable (SSR / disabled storage) — console is enough.
  }
}

/**
 * Module-level in-flight marker for initialize(): concurrent callers join the
 * same attempt (see the guard inside initialize). Cleared in a `finally` so
 * a completed/failed attempt never poisons the next retry.
 */
let initInFlight: Promise<void> | undefined

//=============================================================================
// Cross-Tab Synchronization
//=============================================================================

const PROJECT_CHANGE_CHANNEL = 'creatorweave-project-changes'
const PROJECT_PASSIVE_REFRESH_INTERVAL_MS = 1000

/** Web Locks scope serializing first-run default-project auto-create. */
const AUTO_DEFAULT_LOCK_SCOPE = 'creatorweave:project-store:auto-default'

/**
 * Serialize first-run default-project auto-create across tabs
 * (Sourcery: "Tabs create duplicate projects").
 *
 * Web Locks is the ONLY cross-tab-safe mechanism: plain localStorage has no
 * atomic compare-and-swap, so every non-locks claim scheme can in principle
 * be interleaved by another tab. When Web Locks is unavailable this helper
 * FAILS CLOSED — it does not run the create callback, and the caller adopts
 * whatever another tab created via its post-lock re-read (or the user
 * Retries). Web Locks ships in every Chromium/Firefox/Safari release since
 * 2022/2023, so this fallback only affects legacy browsers.
 */
function withAutoCreateLock(fn: () => Promise<void>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(AUTO_DEFAULT_LOCK_SCOPE, async () => {
      await fn()
    })
  }
  // Fail closed: skip creation (see docblock above).
  void fn
  return Promise.resolve()
}

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
  /**
   * Initialization-specific failure (issue #131). Deliberately SEPARATE from
   * `error`, which also carries project-action failures (rename/delete/…):
   * gating the init-failure UI on `error` locked the whole projects page
   * whenever any later project action failed. Only `initError` shows the
   * init banner / drives the root-page redirect.
   */
  initError: string | null
  /** Classification of the current initError (copy tone: reassurance vs corruption guidance). */
  initErrorKind: ProjectInitErrorKind
  /**
   * True from the moment a retry attempt STARTS until it resolves. The init
   * banner must stay visible during a retry (Sourcery: clearing the error
   * upfront makes an empty list flash "No projects yet" while loading).
   */
  initializingRetry: boolean

  initialize: () => Promise<void>
  /**
   * Record a storage-layer startup failure (SQLite worker / OPFS) detected
   * OUTSIDE initialize() — AppBootstrap's initStorage() gate fails before
   * initialize() ever runs. Routing it through the store gives those
   * failures the SAME user-visible flow as repository-read failures: the
   * init banner, a working Retry (initialize() re-opens the SQLite
   * worker), and the persisted diagnostics record (Sourcery: "Worker
   * startup failures bypass the banner").
   */
  reportInitFailure: (message: string, stack?: string) => void
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

  // Propagate failures (Sourcery: "Projects appear without storage").
  // Swallowing them used to let initialize() mark first-run setup complete
  // with a project whose OPFS directory was never created — the user would
  // only discover the missing storage later, on the first write. Callers
  // that must stay resilient wrap this call in their own try/catch.
  const pm = await ProjectManager.create()
  await pm.getOrCreateProjectById(projectId)
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
    initError: null,
    initErrorKind: 'transient',
    initializingRetry: false,

    initialize: async () => {
      // setupProjectSync is idempotent — returns the previous cleanup if already
      // initialised, so calling initialize() multiple times is safe.
      setupProjectSync(() => {
        void get().refreshProjects()
      })
      if (get().initialized) return
      // Concurrent-attempt guard (Sourcery: "Retry can become a no-op"): two
      // overlapping initialize() calls could otherwise race — one succeeds
      // and pins `initialized: true`, the later one fails afterwards and sets
      // the error without resetting the flag, leaving Retry dead at the guard
      // above. Sharing ONE in-flight promise makes concurrent callers join the
      // same attempt instead of racing.
      if (initInFlight) return initInFlight

      const started = performance.now()
      console.log('[ProjectStore] initialize start')
      // initializingRetry keeps the init-failure banner rendered while a retry
      // is in flight (Sourcery: without it, clearing the error upfront lets
      // the "No projects yet" empty state flash while the DB reads finish).
      set({
        isLoading: true,
        error: null,
        initializingRetry: get().initError !== null,
      })
      const attempt = (async () => {
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
        //
        // Cross-tab mutual exclusion (Sourcery: "Tabs create duplicate
        // projects"): initInFlight only coordinates callers inside THIS tab.
        // Two tabs first-opening a fresh profile would both see an empty list
        // + unset flag and insert two different default projects. A
        // navigator.locks (Web Locks API) hold on the auto-create scope makes
        // the losing tab re-read the list after the winner finishes, so only
        // one default project is ever created. Browsers without Web Locks
        // fall through (single-tab risk only, as before).
        if (
          normalizedProjects.length === 0 &&
          !localStorage.getItem(AUTO_DEFAULT_CREATED_KEY)
        ) {
          const runAutoCreate = async (): Promise<void> => {
            try {
              // Re-check INSIDE the lock (Sourcery: "Concurrent tabs create
              // duplicate defaults"): the pre-lock snapshot above can be
              // stale by the time this callback is granted the lock —
              // another tab may have created the default project while this
              // one queued, and a callback whose wait timed out can still be
              // granted the lock later. Re-reading the shared list + the
              // first-run flag here makes creation idempotent: only the tab
              // that observes an empty store under the lock creates.
              if (localStorage.getItem(AUTO_DEFAULT_CREATED_KEY)) return
              const freshProjects = await repo.findAllProjects()
              if (freshProjects.length > 0) {
                // Another tab already created — adopt its project instead
                // of duplicating it.
                normalizedProjects = freshProjects
                normalizedStats = await repo.findProjectStats()
                return
              }
              const defaultName = getLocalizedDefaultProjectName()
              const defaultProject = await repo.createProject({ name: defaultName })
              // Re-throw when createProject returns nothing — the OPFS
              // bootstrap below needs the id, and silently continuing would
              // mark init complete with a phantom empty list (Sourcery round 4).
              if (!defaultProject) {
                throw new Error('Project store: createProject returned no project')
              }
              await bootstrapProjectOpfs(defaultProject.id)
              localStorage.setItem(AUTO_DEFAULT_CREATED_KEY, '1')
              normalizedProjects = [defaultProject]
              normalizedStats = [{
                projectId: defaultProject.id,
                workspaceCount: 0,
              }]
              console.log('[ProjectStore] Auto-created default project:', defaultProject.id)
            } catch (err) {
              // Re-throw as an init failure (Sourcery: "First-run storage
              // failures still look empty"). Swallowing it here used to mark
              // init complete with an empty list while the created project row
              // stayed hidden until reload; failing loudly puts the user on the
              // init banner with a Retry that re-runs the whole flow.
              throw err instanceof Error ? err : new Error(String(err))
            }
          }

          // Serialized by Web Locks when available (Sourcery: "Tabs create
          // duplicate projects"); without Web Locks the helper fails closed
          // (never creates) and the re-read below adopts the other tab's
          // default project. The wait is bounded (Sourcery: "Lock wait can
          // stall first-run initialization"): a hung holder must not wedge
          // this tab's initialize() forever — after the deadline this tab
          // skips auto-creation and either adopts the winner's project from
          // the re-read or the user can Retry.
          const AUTO_CREATE_LOCK_TIMEOUT_MS = 5000
          const lockAndCreate = withAutoCreateLock(runAutoCreate)
          const timeout = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), AUTO_CREATE_LOCK_TIMEOUT_MS)
          )
          await Promise.race([lockAndCreate, timeout])
          if (normalizedProjects.length === 0) {
            // This tab lost the race, timed out, or skipped creation (no Web
            // Locks): pick up the winner's default project.
            normalizedProjects = await repo.findAllProjects()
            normalizedStats = await repo.findProjectStats()
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
          initError: null,
          initializingRetry: false,
        })

        // Success MARKS the previous failure record resolved instead of
        // deleting it (Sourcery: "Startup failure details disappear") — a
        // user who reloaded into a working app and then ran Diagnostics must
        // still be able to attach the ORIGINAL startup failure report. The
        // record is only removed by initialize()'s own failure path (which
        // overwrites it) or a fresh session (sessionStorage lifetime).
        try {
          const raw = sessionStorage.getItem(PROJECT_STORE_INIT_ERROR_KEY)
          if (raw) {
            const record = JSON.parse(raw) as { resolved?: boolean }
            sessionStorage.setItem(
              PROJECT_STORE_INIT_ERROR_KEY,
              JSON.stringify({ ...record, resolved: true })
            )
          }
        } catch {
          // sessionStorage unavailable / malformed — leave the record as is.
        }

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
        // Do NOT pin `initialized: true` on failure — that would make the
        // failure terminal for the whole session: no route change, redirect,
        // or consumer (ProjectHomeView) would ever re-run initialize() and
        // the projects page would stay silently blank. Leaving it false lets
        // any subsequent initialize() call retry (issue #131). Belt-and-braces
        // for the overlap case: a failed attempt also invalidates `initialized`
        // pinned by a concurrent attempt that already returned (Sourcery).
        set({
          error: message,
          initialized: false,
          isLoading: false,
          initError: message,
          initErrorKind: classifyProjectInitError(message),
          initializingRetry: false,
        })
        const detail = e instanceof Error ? (e.stack ?? message) : message
        console.error(
          `[ProjectStore] initialize failed (${Math.round(performance.now() - started)}ms):`,
          detail
        )
        // Persist the failure (incl. the stack — Sourcery: "Persist the full
        // stack") so diagnostics reports carry the full failure detail.
        persistInitErrorRecord(message, e instanceof Error ? e.stack : undefined)
      }
      })()

      initInFlight = attempt
      try {
        await attempt
      } finally {
        // Clear the in-flight marker regardless of outcome so the NEXT call
        // starts a fresh attempt (retry path) instead of joining a dead one.
        initInFlight = undefined
      }
    },

    reportInitFailure: (message: string, stack?: string) => {
      // Storage-layer (initStorage) failures arrive here via AppBootstrap.
      // Same state shape the initialize() catch path sets, so the banner,
      // Retry and diagnostics treat both failure origins identically.
      set({
        error: message,
        initialized: false,
        isLoading: false,
        initError: message,
        initErrorKind: classifyProjectInitError(message),
        initializingRetry: false,
      })
      persistInitErrorRecord(message, stack)
      console.error('[ProjectStore] storage init failed:', stack ?? message)
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
