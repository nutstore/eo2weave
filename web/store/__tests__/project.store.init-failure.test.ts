import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────
// project.store.initialize() touches: the project repository (SQLite),
// ProjectManager (OPFS), and — on the success path — agent stores via
// dynamic import. Only the repository matters for these tests.

const {
  findAllProjects,
  findProjectStats,
  createProject,
} = vi.hoisted(() => ({
  findAllProjects: vi.fn(),
  findProjectStats: vi.fn(),
  createProject: vi.fn(),
}))

vi.mock('@/sqlite/repositories/project.repository', () => ({
  DEFAULT_PROJECT_ID: 'default-project',
  getProjectRepository: () => ({
    findAllProjects,
    findProjectStats,
    createProject,
    deleteProject: vi.fn(),
  }),
}))

vi.mock('@/opfs', () => ({
  ProjectManager: { create: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), info: vi.fn() },
}))

import { useProjectStore } from '@/store/project.store'

describe('project.store initialize() failure semantics (issue #131)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Reset the store to a pristine snapshot before each test. Zustand +
    // immer freezes state objects, so always pass plain snapshots.
    useProjectStore.setState({
      activeProjectId: '',
      projects: [],
      projectStats: {},
      initialized: false,
      isLoading: false,
      error: null,
      initError: null,
      initErrorKind: 'transient',
      initializingRetry: false,
    })
    sessionStorage.clear()
    localStorage.clear()
    // Auto-create now FAILS initialize() (Sourcery round 4), so make sure the
    // first-run flag from an earlier test never leaks into the next one.
    localStorage.removeItem('creatorweave:auto-default-project-created')
    // happy-dom has no Web Locks API; the store's fail-closed helper needs one
    // to run the auto-create callback. Stub an immediately-acquired lock.
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      locks: {
        request: async (_scope: string, cb: () => Promise<void>) => {
          await cb()
        },
      },
    })
    // Default: a healthy repository returning an empty list. createProject
    // resolves a fresh default project — the auto-create path fires in these
    // tests (empty list + cleared first-run flag) and must succeed.
    findAllProjects.mockResolvedValue([])
    findProjectStats.mockResolvedValue([])
    createProject.mockResolvedValue({
      id: 'default-project',
      name: 'My Project',
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })
  })

  it('does NOT set initialized:true on failure and exposes initError', async () => {
    findAllProjects.mockRejectedValue(new Error('OPFS pool busy'))

    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initialized).toBe(false)
    expect(state.error).toBe('OPFS pool busy')
    expect(state.initError).toBe('OPFS pool busy')
    // Known retryable-contention signature → reassurance classification.
    expect(state.initErrorKind).toBe('transient')
    expect(state.isLoading).toBe(false)
  })

  it('classifies unrecognizable storage failures as kind:"unknown" (no reassurance)', async () => {
    // Sourcery round 2 ("Storage damage gets reassurance"): an I/O error or
    // any unrecognized storage failure must NOT get the transient
    // "projects are safe, retrying usually fixes it" classification — the
    // code has no basis to promise the data is safe.
    findAllProjects.mockRejectedValue(new Error('Storage I/O error'))

    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initError).toBe('Storage I/O error')
    expect(state.initErrorKind).toBe('unknown')
  })

  it('classifies corruption-class errors as kind:"corruption"', async () => {
    findAllProjects.mockRejectedValue(new Error('Database file is corrupt'))

    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initErrorKind).toBe('corruption')
    const raw = sessionStorage.getItem('creatorweave:project-store-init-error')
    expect(JSON.parse(raw as string)).toMatchObject({ kind: 'corruption' })
  })

  it('classifies persistent open failures (CANTOPEN) as unknown — no reassurance', async () => {
    // Sourcery round 3 ("Persistent open failures promise safe data"):
    // CANTOPEN / database_inaccessible can be a persistent path or access
    // problem, not temporary contention — they must not get the transient
    // "projects are safe, retrying usually fixes it" classification.
    findAllProjects.mockRejectedValue(new Error('SQLite error: CANTOPEN'))

    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initError).toBe('SQLite error: CANTOPEN')
    expect(state.initErrorKind).toBe('unknown')
  })

  it('classifies database_inaccessible as unknown — no reassurance', async () => {
    findAllProjects.mockRejectedValue(new Error('database_inaccessible'))

    await useProjectStore.getState().initialize()

    expect(useProjectStore.getState().initErrorKind).toBe('unknown')
  })

  it('reportInitFailure surfaces storage-layer startup failures like init failures', () => {
    // Sourcery round 3 ("Worker startup failures bypass the banner"):
    // AppBootstrap records initStorage() failures via reportInitFailure —
    // they must land in the same banner/diagnostics state.
    useProjectStore.getState().reportInitFailure('OPFS worker failed to start')

    const state = useProjectStore.getState()
    expect(state.initialized).toBe(false)
    expect(state.initError).toBe('OPFS worker failed to start')
    expect(state.initErrorKind).toBe('unknown')
    expect(state.isLoading).toBe(false)
    const raw = sessionStorage.getItem('creatorweave:project-store-init-error')
    expect(JSON.parse(raw as string)).toMatchObject({
      message: 'OPFS worker failed to start',
    })
  })

  it('reportInitFailure classifies contention signatures as transient', () => {
    useProjectStore.getState().reportInitFailure('opfs pool busy')
    expect(useProjectStore.getState().initErrorKind).toBe('transient')
  })

  it('persists the error stack in the diagnostics record when available', () => {
    // Sourcery round 4 ("Persist the full stack"): the sessionStorage record
    // must carry the stack so an attached diagnostic report includes the
    // full failure detail.
    const err = new Error('boom')
    useProjectStore.getState().reportInitFailure(err.message, err.stack)

    const raw = sessionStorage.getItem('creatorweave:project-store-init-error')
    expect(JSON.parse(raw as string)).toMatchObject({ stack: err.stack })
  })

  it('fails initialization when the first-run auto-create fails', async () => {
    // Sourcery round 4 ("First-run storage failures still look empty"):
    // swallowing auto-create errors marked init complete with an empty
    // list while the created row stayed hidden until reload. The failure
    // must propagate into the normal init-failure path instead.
    findAllProjects.mockResolvedValue([])
    findProjectStats.mockResolvedValue([])
    // Auto-create only fires for a first-time browser (no localStorage flag).
    localStorage.removeItem('creatorweave:auto-default-project-created')
    createProject.mockRejectedValue(new Error('OPFS bootstrap failed'))

    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initialized).toBe(false)
    expect(state.initError).toBe('OPFS bootstrap failed')
    expect(state.projects).toEqual([])

    // A later initialize() must not hit the auto-create path again.
    createProject.mockResolvedValue({
      id: 'default-project',
      name: 'My Project',
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })
    await useProjectStore.getState().initialize()
    expect(useProjectStore.getState().initialized).toBe(true)
  })

  it('retries the full init when initialize() runs again after a failure', async () => {
    findAllProjects.mockRejectedValueOnce(new Error('opfs pool busy'))
    await useProjectStore.getState().initialize()
    expect(useProjectStore.getState().initialized).toBe(false)

    // Second call must actually query the repository again (retry path).
    // The extra calls come from the auto-create lock's re-read probe.
    await useProjectStore.getState().initialize()

    expect(findAllProjects.mock.calls.length).toBeGreaterThanOrEqual(2)
    const state = useProjectStore.getState()
    expect(state.initialized).toBe(true)
    expect(state.error).toBeNull()
    expect(state.initError).toBeNull()
    expect(state.initializingRetry).toBe(false)
  })

  it('de-duplicates concurrent initialize() calls into one attempt', async () => {
    // Sourcery "Retry can become a no-op": overlapping calls must JOIN one
    // attempt, never race a success against a later failure. The shared
    // in-flight promise eliminates the overlap race at the source.
    let calls = 0
    findAllProjects.mockImplementation(async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 10))
      return []
    })

    await Promise.all([
      useProjectStore.getState().initialize(),
      useProjectStore.getState().initialize(),
    ])

    // The FIRST repository query is issued by exactly one attempt — the
    // auto-create probe only runs afterwards, in the successful tail.
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(useProjectStore.getState().initialized).toBe(true)
    // Only ONE createProject: the second caller sees the winner's project.
    expect(createProject).toHaveBeenCalledTimes(1)
  })

  it('persists the failure to sessionStorage for diagnostics', async () => {
    findAllProjects.mockRejectedValue(new Error('storage I/O failure'))

    await useProjectStore.getState().initialize()

    const raw = sessionStorage.getItem('creatorweave:project-store-init-error')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({
      message: 'storage I/O failure',
    })
  })

  it('marks the persisted failure record resolved after a successful init', async () => {
    // Sourcery round 7 ("Startup failure details disappear"): success keeps
    // the record (marked resolved) instead of deleting it, so a user who
    // reloaded into a working app can still attach the ORIGINAL failure.
    findAllProjects.mockRejectedValueOnce(new Error('opfs pool busy'))
    await useProjectStore.getState().initialize()
    expect(
      sessionStorage.getItem('creatorweave:project-store-init-error')
    ).not.toBeNull()
    expect(
      JSON.parse(sessionStorage.getItem('creatorweave:project-store-init-error') as string)
    ).toMatchObject({ message: 'opfs pool busy' })
    expect(
      JSON.parse(sessionStorage.getItem('creatorweave:project-store-init-error') as string).resolved
    ).toBeFalsy()

    await useProjectStore.getState().initialize()

    const raw = sessionStorage.getItem('creatorweave:project-store-init-error')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toMatchObject({
      resolved: true,
      message: 'opfs pool busy',
    })
  })

  it('still succeeds (initialized:true) when the repository works', async () => {
    await useProjectStore.getState().initialize()

    const state = useProjectStore.getState()
    expect(state.initialized).toBe(true)
    expect(state.error).toBeNull()
    expect(state.initError).toBeNull()
  })

  it('does NOT create a duplicate default when another tab created before the lock was granted (Sourcery round 13)', async () => {
    // Simulate the race: the PRE-lock snapshot is empty, but by the time the
    // lock callback runs, another tab has already created the default
    // project and set the first-run flag. The in-lock re-check must adopt
    // the other tab's project and skip creation entirely.
    createProject.mockResolvedValue({
      id: 'my-duplicate-default',
      name: 'My Project',
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
    })
    // First findAllProjects call: pre-lock check (empty). The in-lock
    // re-check call sees the winner's project.
    findAllProjects
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'winner-tab-default', name: 'My Project', status: 'active' as const, createdAt: 0, updatedAt: 0 },
      ])
    findProjectStats.mockResolvedValue([])

    await useProjectStore.getState().initialize()

    expect(createProject).not.toHaveBeenCalled()
    const state = useProjectStore.getState()
    expect(state.projects.map((p) => p.id)).toEqual(['winner-tab-default'])
    expect(state.initialized).toBe(true)
    expect(state.initError).toBeNull()
  })

  it('does NOT create when the first-run flag was set between the pre-lock check and the lock grant', async () => {
    // The lock callback stub sets the flag (as the winning tab would) just
    // before granting — the in-lock re-check must bail on the flag alone.
    const locks = (globalThis.navigator as any).locks
    locks.request = async (_scope: string, cb: () => Promise<void>) => {
      localStorage.setItem('creatorweave:auto-default-project-created', '1')
      await cb()
    }

    await useProjectStore.getState().initialize()

    expect(createProject).not.toHaveBeenCalled()
    expect(useProjectStore.getState().initialized).toBe(true)
  })
})
