import { beforeEach, describe, expect, it, vi } from 'vitest'

// deleteProject's host-rebind loop must run BEFORE the project row is
// committed for deletion: a rebind failure has to abort the deletion
// (observable + retryable), and the last-project case must rebind hosts to
// empty string (falsy everywhere projectId is consumed) instead of leaving
// the deleted id stranded on hidden host rows. Overlapping deletions are
// serialized on a module-level promise chain, so the second deletion's
// successor selection re-reads the project table only after the first
// deletion's rebind — and its project row deletion — has completed.

const findAllProjectsMock = vi.hoisted(() => vi.fn())
const findProjectStatsMock = vi.hoisted(() => vi.fn(async () => []))
const deleteProjectMock = vi.hoisted(() => vi.fn(async () => {}))
const findAllWorkspacesByProjectIncludingDirectMock = vi.hoisted(() => vi.fn(async () => []))
const deleteProjectIncludingHostRebindMock = vi.hoisted(() => vi.fn(async () => {}))
const projectRepoMock = vi.hoisted(() => ({
  findAllProjects: findAllProjectsMock,
  findProjectStats: findProjectStatsMock,
  deleteProject: deleteProjectMock,
  deleteProjectIncludingHostRebind: deleteProjectIncludingHostRebindMock,
  createProject: vi.fn(),
  updateProject: vi.fn(),
  setActiveProject: vi.fn(async () => {}),
  clearActiveProject: vi.fn(async () => {}),
  // Activation's existence checks: tests that exercise setActiveProject
  // replace this with a live spy (default: never found).
  findById: vi.fn(async () => null),
}))

const projectManagerDeleteMock = vi.hoisted(() => vi.fn(async () => {}))
const ProjectManagerMock = vi.hoisted(() => ({
  create: vi.fn(async () => ({ deleteProject: projectManagerDeleteMock })),
}))
vi.mock('@/sqlite/repositories/project.repository', () => ({
  getProjectRepository: () => projectRepoMock,
  DEFAULT_PROJECT_ID: 'default',
}))
vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({
    findAllWorkspacesByProjectIncludingDirect: findAllWorkspacesByProjectIncludingDirectMock,
  }),
}))
vi.mock('@/opfs', () => ({ ProjectManager: ProjectManagerMock }))

// Lazy imports inside deleteProject (only on the active-project branch —
// these tests never make the deleted project active, but mock defensively).
// setState is included because setActiveProject's step 1 also touches these
// stores (the activation-overlapping-deletion test exercises that path).
vi.mock('@/store/agent.store', () => ({
  useAgentStore: {
    getState: () => ({ setActiveProject: vi.fn(async () => {}) }),
    setState: vi.fn(),
  },
}))
vi.mock('@/store/conversation-context.store', () => ({
  useConversationContextStore: {
    getState: () => ({ refreshWorkspaces: vi.fn(async () => {}) }),
    setState: vi.fn(),
  },
}))

import { useProjectStore } from '@/store/project.store'

const project = (id: string) => ({
  id, name: id, status: 'active' as const, createdAt: 1, updatedAt: 1,
})

describe('project.store deleteProject host rebind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])
    deleteProjectIncludingHostRebindMock.mockResolvedValue(undefined)
    projectManagerDeleteMock.mockResolvedValue(undefined)
    useProjectStore.setState({
      activeProjectId: '',
      projects: [],
      projectStats: {},
      initialized: true,
      isLoading: false,
      error: null,
    } as never)
  })

  it('rebind failure aborts deletion: project row survives and error is reported', async () => {
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    // Pre-seed store state used by deleteProject: activeProjectId '' so the
    // post-deletion active-project branch never runs.
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-a' } as never,
    ])
    deleteProjectIncludingHostRebindMock.mockRejectedValueOnce(new Error('rebind boom'))

    const ok = await useProjectStore.getState().deleteProject('p-a')

    expect(ok).toBe(false)
    expect(useProjectStore.getState().error).toContain('rebind boom')
    // Nothing was committed — the atomic transaction (rebinds + row delete)
    // rolled back, and the legacy deleteProject entry point was never used.
    expect(deleteProjectMock).not.toHaveBeenCalled()
  })

  it('a failed deletion does not strand already-queued deletions (queue keeps draining)', async () => {
    // Finding: the shared chain was attached with a bare `.then(...)`, so
    // when p-a's rebind failed the chain rejected and p-b's queued section
    // was SKIPPED — p-b's caller resolved false for a deletion never
    // attempted and the project stayed alive. Each queued section must
    // swallow the predecessor's rejection (the failed caller still sees its
    // own error via its own link) so the queue drains in order.
    let alive = new Set(['p-a', 'p-b'])
    findAllProjectsMock.mockImplementation(async () =>
      [...alive].map((id) => ({ id, name: id, status: 'active', createdAt: 1, updatedAt: 1 }))
    )
    deleteProjectIncludingHostRebindMock.mockImplementation((async (projectId: string) => {
      if (projectId === 'p-a') throw new Error('rebind boom')
      alive.delete(projectId)
    }) as never)
    // The workspace query is keyed by project (like production): p-a owns
    // host-1, p-b owns host-2. p-a's atomic transaction fails; p-b's section
    // must still run afterwards and must not inherit p-a's failure.
    findAllWorkspacesByProjectIncludingDirectMock.mockImplementation((async (projectId: string) =>
      projectId === 'p-a'
        ? [{ id: 'host-1', projectId: 'p-a' } as never]
        : [{ id: 'host-2', projectId: 'p-b' } as never]) as never)

    const [okA, okB] = await Promise.all([
      useProjectStore.getState().deleteProject('p-a'),
      useProjectStore.getState().deleteProject('p-b'),
    ])

    // The failed deletion reports failure to ITS caller only...
    expect(okA).toBe(false)
    expect(useProjectStore.getState().error).toContain('rebind boom')
    // ...and the queued deletion still RAN and succeeded. Its successor is
    // 'p-a' — p-a's transaction FAILED, so its row survives (atomicity) and
    // remains a valid host for p-b's orphans.
    expect(okB).toBe(true)
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenNthCalledWith(2, 'p-b', 'p-a', ['host-2'])
    expect(alive.has('p-b')).toBe(false)
  })

  it('last-project deletion rebinds hosts to empty string (no-project), not the dead id', async () => {
    // Only the project being deleted remains.
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-only')] } as never)
    findAllProjectsMock.mockResolvedValue([])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-only' } as never,
      { id: 'host-2', projectId: 'p-only' } as never,
    ])

    const ok = await useProjectStore.getState().deleteProject('p-only')

    expect(ok).toBe(true)
    // Hosts + row deletion went through ONE atomic transaction, with the
    // successor derived as '' for the last-project case.
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-only', '', ['host-1', 'host-2'])
    expect(deleteProjectMock).not.toHaveBeenCalled()
  })

  it('rebinds hosts to the next remaining project when other projects survive', async () => {
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-a' } as never,
    ])

    const ok = await useProjectStore.getState().deleteProject('p-a')

    expect(ok).toBe(true)
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-a', 'p-b', ['host-1'])
    expect(deleteProjectMock).not.toHaveBeenCalled()
  })

  it('overlapping deletions are serialized: the second rebind re-reads projects the first already deleted', async () => {
    // Two deletions fired concurrently (e.g. double-click on two sidebar
    // delete buttons). Without serialization both would compute their
    // successor from the same not-yet-updated project table and rebind the
    // OTHER's standalone-chat hosts to a project that is itself being
    // deleted — leaving those host rows pointing at a dead project id. The
    // module-level promise chain forces p-a's atomic rebind+delete to finish
    // before p-b's section reads the project table.
    let alive = new Set(['p-a', 'p-b'])
    findAllProjectsMock.mockImplementation(async () =>
      [...alive].map((id) => ({ id, name: id, status: 'active', createdAt: 1, updatedAt: 1 }))
    )
    // Gate the atomic transaction so both deleteProject calls are in flight
    // before either section's transaction begins: p-a's transaction blocks
    // until p-b has been INITIATED (both promises created), proving the chain
    // serializes the critical sections rather than the callers merely
    // sequencing. The gate resolver is assigned INSIDE the mock, which only
    // runs once the store's chained `.then` callbacks have executed — so the
    // test MUST yield a task boundary before invoking it; calling it
    // synchronously right after creating the two promises would dereference
    // null (Sourcery round-6: "Deletion test calls a null gate").
    let releaseASection: (() => void) | null = null
    const sectionOrder: string[] = []
    deleteProjectIncludingHostRebindMock.mockImplementation((async (projectId: string) => {
      if (projectId !== 'p-a') {
        // Reproduce the interleaving hazard: p-b's section starts only after
        // p-a's atomic transaction committed — if the sections overlapped,
        // p-a's hosts would pick p-b as successor here... and p-b would not
        // be alive to delete.
        alive.delete(projectId)
        sectionOrder.push(`commit:${projectId}`)
        return
      }
      sectionOrder.push(`enter:${projectId}`)
      await new Promise<void>((resolve) => {
        releaseASection = resolve
      })
      alive.delete(projectId)
      sectionOrder.push(`commit:${projectId}`)
    }) as never)
    findAllWorkspacesByProjectIncludingDirectMock.mockImplementation((async (projectId: string) =>
      projectId === 'p-a'
        ? [{ id: 'host-1', projectId: 'p-a' } as never]
        : [{ id: 'host-2', projectId: 'p-b' } as never]) as never)

    const deleteA = useProjectStore.getState().deleteProject('p-a')
    const deleteB = useProjectStore.getState().deleteProject('p-b')
    // Both callers are in flight; yield a macrotask so p-a's chained section
    // has actually RUN and assigned `releaseASection` before it is invoked.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(releaseASection).toBeTypeOf('function')
    expect(sectionOrder).toEqual(['enter:p-a'])
    // Now let p-a's transaction proceed. p-b's section must still run
    // entirely after p-a's FULL atomic commit (rebind + row deletion)
    // because each deletion enqueues the whole section on the shared chain
    // — so p-b's successor selection observes p-a's row already gone.
    releaseASection!()
    const [okA, okB] = await Promise.all([deleteA, deleteB])

    expect(okA).toBe(true)
    expect(okB).toBe(true)
    // Sections ran strictly in queue order: p-a entered (and was gated)
    // before p-b's transaction was ever reached.
    expect(sectionOrder).toEqual(['enter:p-a', 'commit:p-a', 'commit:p-b'])
    // p-a's hosts were rebound (inside its transaction) to the survivor p-b,
    // which was still alive at that point...
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-a', 'p-b', ['host-1'])
    // ...while p-b's section ran AFTER p-a's row deletion: its successor must
    // NOT be p-a (already deleted) — it must be '' here.
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-b', '', ['host-2'])
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenNthCalledWith(2, 'p-b', '', ['host-2'])
    expect(deleteProjectMock).not.toHaveBeenCalled()
  })

  it('queued deletion repairs a stale active pointer: an earlier chained deletion rebound active to THIS deletion target', async () => {
    // The old code snapshotted activeProjectId BEFORE waiting on the deletion
    // chain: p-a is active when deleteProject('p-b') is invoked, so the check
    // `activeProjectId === 'p-b'` was false and never re-ran — even though
    // p-a's deletion (running first on the chain) rebound the active pointer
    // to p-b, leaving the store pointing at the project p-b's deletion is
    // about to remove. The repair must re-read the LIVE pointer inside the
    // serialized section instead.
    const agentSetActiveProjectMock = vi.fn(async () => {})
    const refreshWorkspacesMock = vi.fn(async () => {})
    // Fresh module registry so THIS test's doMock factories are what the
    // store's dynamic imports observe: a prior test already imported the
    // dynamically-imported stores, and without the reset the cached module
    // (and its EARLIER spies) would be reused here. (Same pattern as
    // conversation.store.sqlite.test.ts's conversion tests.)
    vi.resetModules()
    vi.doMock('@/store/agent.store', () => ({
      useAgentStore: { getState: () => ({ setActiveProject: agentSetActiveProjectMock }) },
    }))
    vi.doMock('@/store/conversation-context.store', () => ({
      useConversationContextStore: { getState: () => ({ refreshWorkspaces: refreshWorkspacesMock }) },
    }))

    useProjectStore.setState({ activeProjectId: 'p-a', projects: [project('p-a'), project('p-b')] } as never)
    let alive = new Set(['p-a', 'p-b'])
    findAllProjectsMock.mockImplementation(async () =>
      [...alive].map((id) => ({ id, name: id, status: 'active', createdAt: 1, updatedAt: 1 }))
    )
    deleteProjectIncludingHostRebindMock.mockImplementation((async (projectId: string) => {
      alive.delete(projectId)
    }) as never)
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])

    // Both callers in flight: p-b snapshots nothing (the old code snapshotted
    // 'p-a' here) and queues behind p-a on the deletion chain.
    const deleteA = useProjectStore.getState().deleteProject('p-a')
    const deleteB = useProjectStore.getState().deleteProject('p-b')
    const [okA, okB] = await Promise.all([deleteA, deleteB])
    expect(okA).toBe(true)
    expect(okB).toBe(true)

    // p-a's section ran first and rebound the active pointer to the only
    // survivor, p-b. p-b's section then observed the LIVE pointer (p-b —
    // matching its own deletion target), NOT p-a: with the stale snapshot the
    // guard would have skipped the repair entirely, stranding the pointer on
    // a project whose row p-b's deletion just removed.
    expect(useProjectStore.getState().activeProjectId).toBe('')
    expect(projectRepoMock.clearActiveProject).toHaveBeenCalled()
    expect(agentSetActiveProjectMock).toHaveBeenCalledWith('')
    expect(refreshWorkspacesMock).toHaveBeenCalled()
  })

  it('survivor deletion selects a remaining project as the new active, ignoring its invocation-time snapshot', async () => {
    const agentSetActiveProjectMock = vi.fn(async () => {})
    // Fresh module registry: the previous test installed its own doMock
    // factories and dynamically imported the mocked stores — without the
    // reset this test's doMock would not take effect (cached module keeps
    // the earlier spies) and the assertion below could pass or fail against
    // the WRONG spy.
    vi.resetModules()
    vi.doMock('@/store/agent.store', () => ({
      useAgentStore: { getState: () => ({ setActiveProject: agentSetActiveProjectMock }) },
    }))
    vi.doMock('@/store/conversation-context.store', () => ({
      useConversationContextStore: { getState: () => ({ refreshWorkspaces: vi.fn(async () => {}) }) },
    }))

    // Active pointer is p-x at INVOCATION time — neither the deleted project
    // nor the eventual successor. The repair must run on the live pointer:
    // here it already points at the deleted project (the common case), so a
    // surviving project is selected.
    useProjectStore.setState({ activeProjectId: 'p-x', projects: [project('p-x'), project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])

    await useProjectStore.getState().deleteProject('p-x')

    expect(projectRepoMock.setActiveProject).toHaveBeenCalledWith('p-a')
    expect(useProjectStore.getState().activeProjectId).toBe('p-a')
    expect(agentSetActiveProjectMock).toHaveBeenCalledWith('p-a')
  })

  it('a transaction failure mid-deleteProject reports failure with nothing else touched', async () => {
    // Finding (superseded by the atomic transaction): when the SECOND rebind
    // (or the row deletion) failed, the already-rebound workspaces stayed
    // assigned to the successor project even though the deletion aborted.
    // The rebinds + row deletion now run inside ONE SQLite transaction, so
    // the ROLLBACK is the repository's job (covered by
    // sqlite-database.transaction tests): the store only has to report the
    // failure, skip any further writes, and stay retryable.
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-a' } as never,
      { id: 'host-2', projectId: 'p-a' } as never,
    ])
    deleteProjectIncludingHostRebindMock.mockRejectedValue(new Error('second rebind boom'))

    const ok = await useProjectStore.getState().deleteProject('p-a')

    expect(ok).toBe(false)
    expect(useProjectStore.getState().error).toContain('second rebind boom')
    // The legacy per-row entry point was never used, and no follow-up writes
    // (OPFS cleanup) ran — the transaction rolled everything back atomically.
    expect(deleteProjectMock).not.toHaveBeenCalled()
    expect(projectManagerDeleteMock).not.toHaveBeenCalled()
  })

  it('post-delete repair failure still returns success with a refreshed list', async () => {
    // Finding: a throw in the active-pointer repair AFTER the row deletion
    // committed made the caller see failure while the project was gone from
    // SQLite — and the outer catch skipped refreshProjects, so the UI kept
    // the deleted project. The repair must be non-fatal (deletion reports
    // success) and the list must be refreshed from the repository.
    const agentSetActiveProjectMock = vi.fn(async () => {
      throw new Error('repair boom')
    })
    // Fresh module registry — see the survivor-deletion test above.
    vi.resetModules()
    vi.doMock('@/store/agent.store', () => ({
      useAgentStore: { getState: () => ({ setActiveProject: agentSetActiveProjectMock }) },
    }))
    vi.doMock('@/store/conversation-context.store', () => ({
      useConversationContextStore: { getState: () => ({ refreshWorkspaces: vi.fn(async () => {}) }) },
    }))

    useProjectStore.setState({ activeProjectId: 'p-a', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])

    const ok = await useProjectStore.getState().deleteProject('p-a')

    // Deletion committed → success, despite the repair crash.
    expect(ok).toBe(true)
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-a', 'p-b', [])
    expect(useProjectStore.getState().error).toBeNull()
    // The UI list was refreshed AFTER the deletion committed: it reflects
    // the surviving projects, not the invocation-time snapshot.
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p-b'])
  })

  it('activation that overlaps a committed deletion does not republish the deleted id', async () => {
    // Finding: setActiveProject passed its initial existence check, then
    // paused during its awaits while deleteProject removed the row; when
    // deletion read the OLD active pointer it skipped repair, and activation
    // later published the deleted id into activeProjectId — the app stayed
    // pointed at a project whose row was gone. The row must be revalidated
    // immediately before the publish, and a vanished row must abort the
    // activation (false + error), never republish the dead id.
    let rowAlive = true
    findAllProjectsMock.mockImplementation(async () =>
      rowAlive ? [project('p-a'), project('p-b')] : [project('p-b')]
    )
    // findById reflects the live row existence (deletion removes it).
    projectRepoMock.findById = vi.fn(async (id: string) =>
      rowAlive ? project(id) : null
    ) as never
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-a' } as never,
    ])
    // happy-dom has no navigator.storage, so bootstrapProjectOpfs would
    // early-return; enable it so activation's OPFS bootstrap await hosts the
    // interleaving (this test only — restored at the end). The stub dir
    // handle is enough for ensureProject's getDirectoryHandle chain.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({
          getDirectoryHandle: async () => ({}),
        }),
      }),
    }
    // Suspend activation inside its OPFS bootstrap await — the window where
    // the overlapping deleteProject commits and removes the row.
    // (mockImplementationOnce REPLACES the base create for this call; the
    // instance must still expose deleteProject for later flush paths.)
    ProjectManagerMock.create.mockImplementationOnce(async () => ({
      getOrCreateProjectById: async () => {
        await useProjectStore.getState().deleteProject('p-a')
      },
      getProject: async () => null,
      deleteProject: projectManagerDeleteMock,
    }))
    // The overlapping deletion must actually REMOVE the row: once the atomic
    // transaction commits, both findAllProjects and findById observe it gone.
    deleteProjectIncludingHostRebindMock.mockImplementation((async () => {
      rowAlive = false
    }) as never)
    // Fresh registry + own doMock factories: earlier tests in this file
    // installed doMock factories WITHOUT setState for these stores and that
    // registration persists until unmocked/reset — activation's step 1
    // calls setState on both. folder-access is mocked because activation
    // step 3 reaches it through the real agent.store chain, and its
    // IndexedDB hydration never settles under the test-setup IDB mock.
    vi.resetModules()
    const activationAgentSetActiveMock = vi.fn(async () => {})
    const activationRefreshWorkspacesMock = vi.fn(async () => {})
    vi.doMock('@/store/agent.store', () => ({
      useAgentStore: {
        getState: () => ({ setActiveProject: activationAgentSetActiveMock }),
        setState: vi.fn(),
      },
    }))
    vi.doMock('@/store/conversation-context.store', () => ({
      useConversationContextStore: {
        getState: () => ({ refreshWorkspaces: activationRefreshWorkspacesMock }),
        setState: vi.fn(),
      },
    }))
    vi.doMock('@/store/folder-access.store', () => ({
      useFolderAccessStore: {
        getState: () => ({ setActiveProject: vi.fn(async () => {}) }),
        setState: vi.fn(),
      },
    }))
    vi.doMock('@/store/agents.store', () => ({
      useAgentsStore: {
        getState: () => ({
          setProjectManager: vi.fn(),
          initialize: vi.fn(async () => {}),
        }),
        setState: vi.fn(),
      },
    }))

    // Order matters: activation starts first (passes its initial check),
    // deletion queues behind it and commits during activation's awaits.
    const activation = useProjectStore.getState().setActiveProject('p-a')

    const ok = await activation
    // Activation aborts instead of publishing the deleted id...
    expect(ok).toBe(false)
    expect(useProjectStore.getState().activeProjectId).not.toBe('p-a')
    expect(useProjectStore.getState().error).toContain('Project not found: p-a')
    // ...and the store list was re-synced from the repository (p-b survives).
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p-b'])
    // Drop the navigator.storage stub so later tests keep the happy-dom
    // early-return behavior.
    delete (navigator as unknown as { storage?: unknown }).storage
  })

  it('OPFS cleanup runs only AFTER the DB row deletion commits', async () => {
    // Finding: the OPFS directory was deleted BEFORE repo.deleteProject — a
    // DB failure then lost the project's workspace files with no way back.
    // The order must be: rebinds → DB commit → OPFS cleanup (deferred,
    // best-effort: at that point the data is unreferenced, so a failed OPFS
    // cleanup is orphaned files, not data loss).
    const order: string[] = []
    deleteProjectIncludingHostRebindMock.mockImplementation((async (id: string) => {
      order.push(`db:${id}`)
    }) as never)
    projectManagerDeleteMock.mockImplementation((async (id: string) => {
      order.push(`opfs:${id}`)
    }) as never)
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a')] } as never)
    findAllProjectsMock.mockResolvedValue([])

    const ok = await useProjectStore.getState().deleteProject('p-a')

    expect(ok).toBe(true)
    expect(order).toEqual(['db:p-a', 'opfs:p-a'])
    expect(deleteProjectMock).not.toHaveBeenCalled()
  })

  it('a DB deletion failure never touches OPFS (workspace files survive for retry)', async () => {
    // Finding 1's data-loss half: with the old order the OPFS directory was
    // already destroyed when the DB deletion failed, so retrying a "failed"
    // deletion resurrected an empty project. Now OPFS cleanup happens only
    // after a committed deletion — a DB failure must leave OPFS untouched.
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([
      { id: 'host-1', projectId: 'p-a' } as never,
    ])
    deleteProjectIncludingHostRebindMock.mockRejectedValueOnce(new Error('db boom'))

    const ok = await useProjectStore.getState().deleteProject('p-a')

    expect(ok).toBe(false)
    expect(useProjectStore.getState().error).toContain('db boom')
    expect(projectManagerDeleteMock).not.toHaveBeenCalled()
  })

  it('post-delete repair failure still clears the stale active pointer and refreshes workspace state', async () => {
    // Finding: when the repair crashed (here: agent store sync), the store's
    // activeProjectId stayed on the DELETED id — refreshProjects() re-syncs
    // the list but not the pointer, so the UI kept pointing at a dead
    // project. The fallback must re-derive the pointer (first remaining
    // project, matching the store's existing normalization) and reset the
    // dependent workspace state, while the deletion still reports success.
    const agentSetActiveProjectMock = vi.fn(async () => {
      throw new Error('repair boom')
    })
    const refreshWorkspacesMock = vi.fn(async () => {})
    const contextSetStateMock = vi.fn()
    // Fresh module registry — see the survivor-deletion test above.
    vi.resetModules()
    vi.doMock('@/store/agent.store', () => ({
      useAgentStore: { getState: () => ({ setActiveProject: agentSetActiveProjectMock }) },
    }))
    vi.doMock('@/store/conversation-context.store', () => ({
      useConversationContextStore: {
        getState: () => ({ refreshWorkspaces: refreshWorkspacesMock }),
        setState: contextSetStateMock,
      },
    }))

    useProjectStore.setState({ activeProjectId: 'p-a', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])

    const ok = await useProjectStore.getState().deleteProject('p-a')

    // Deletion committed → still success.
    expect(ok).toBe(true)
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-a', 'p-b', [])
    // Pointer was re-derived away from the deleted id to the survivor.
    expect(useProjectStore.getState().activeProjectId).not.toBe('p-a')
    expect(useProjectStore.getState().activeProjectId).toBe('p-b')
    // Dependent workspace state was refreshed for the fallback pointer.
    expect(refreshWorkspacesMock).toHaveBeenCalled()
  })

  it('a hung OPFS cleanup does not block the deletion chain (bounded wait)', async () => {
    // Finding: tryDeleteOpfsProject was awaited unbounded INSIDE the
    // serialized deletion section — if ProjectManager.create() or
    // pm.deleteProject() never settled, every later project deletion in the
    // tab stayed queued forever. The cleanup wait is now raced against a
    // timeout: on timeout the id is queued for retry and the chain proceeds
    // (deletion still reports success — the row already committed).
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])
    projectManagerDeleteMock.mockImplementation(
      () => new Promise<void>(() => {
        /* never settles — the hang */
      }) as never
    )

    // Deletion must NOT hang: it resolves (success) once the bounded cleanup
    // times out, instead of blocking the chain forever.
    const ok = await useProjectStore.getState().deleteProject('p-a')
    expect(ok).toBe(true)

    // The DB row deletion still committed exactly once, and the timeout did
    // not turn into a failure or an error surface.
    expect(deleteProjectIncludingHostRebindMock).toHaveBeenCalledWith('p-a', 'p-b', [])
    expect(useProjectStore.getState().error).toBeNull()

    // A later deletion is NOT stranded behind the hung cleanup: it completes
    // normally after the first deletion's bounded wait expired.
    projectManagerDeleteMock.mockResolvedValue(undefined)
    const okB = await useProjectStore.getState().deleteProject('p-b')
    expect(okB).toBe(true)
    // The bounded waits are real-time (10s timeout + a 10s retry flush), so
    // this test legitimately needs more than the global 10s testTimeout.
  }, 30_000)

  it('a delayed (slow but settling) OPFS cleanup that finishes within the bound still counts as done', async () => {
    // Complement to the timeout test: cleanup that settles inside the bound
    // must still be treated as successful (no pointless retry queueing).
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])
    projectManagerDeleteMock.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 20)) as never
    )

    const ok = await useProjectStore.getState().deleteProject('p-a')
    expect(ok).toBe(true)
    expect(projectManagerDeleteMock).toHaveBeenCalledWith('p-a')
    expect(useProjectStore.getState().error).toBeNull()
  })

  it('a flush pass over a large retry backlog is capped by an overall budget', async () => {
    // Finding: flushPendingOpfsProjectDeletions awaited every queued cleanup
    // sequentially, each up to the per-attempt timeout — a large retry
    // backlog would serialize N × 10s of bounded waits INTO the serialized
    // deletion chain, delaying later project deletions ~10s per queued id.
    // One flush pass must spend at most OPFS_FLUSH_BUDGET_MS of wall time
    // overall; leftover ids stay queued for the next flush.
    //
    // Deterministic trace with never-settling cleanups (per-attempt timeout
    // and flush budget are both 10s, so each failed attempt costs 10s of
    // fake time):
    //   p-a section: attempt p-a → timeout@10s → queue={p-a}
    //     flush: deadline 10s+10s=20s; attempt p-a → timeout@20s; now >=
    //     deadline → STOP (unfixed code would be done here anyway with one
    //     queued id — the cap needs a second queued id to be observable).
    //   p-b section: attempt p-b → timeout@30s → queue={p-a,p-b}
    //     flush: deadline 30s+10s=40s; attempt p-a → timeout@40s; now >=
    //     deadline → STOP, leaving p-b queued.
    //   → attempted == [p-a, p-a, p-b, p-a]; the UNFIXED loop would grind
    //   on to a 5th attempt (p-b) inside the same pass.
    useProjectStore.setState({ activeProjectId: '', projects: [project('p-a'), project('p-b')] } as never)
    findAllProjectsMock.mockResolvedValue([project('p-a'), project('p-b')])
    findAllWorkspacesByProjectIncludingDirectMock.mockResolvedValue([])
    const attempted: string[] = []
    projectManagerDeleteMock.mockImplementation((async (id: string) => {
      attempted.push(id)
      await new Promise<void>(() => {
        /* never settles — every attempt runs to its per-attempt timeout */
      })
    }) as never)

    vi.useFakeTimers()
    try {
      const okA = useProjectStore.getState().deleteProject('p-a')
      const okB = useProjectStore.getState().deleteProject('p-b')
      // Wide margin past the full fixed-code trace (40s): with the cap the
      // pass ends itself; leftovers just remain queued.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await okA).toBe(true)
      expect(await okB).toBe(true)

      expect(attempted).toEqual(['p-a', 'p-a', 'p-b', 'p-a'])
      expect(useProjectStore.getState().error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  }, 30_000)
})
