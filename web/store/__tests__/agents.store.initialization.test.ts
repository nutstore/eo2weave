import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectManager } from '@/opfs'

const mocks = vi.hoisted(() => ({ route: { activeProjectId: 'project-a' } }))
vi.mock('@/store/project.store', () => ({ useProjectStore: { getState: () => mocks.route } }))
vi.mock('@/opfs', () => ({ ProjectManager: {} }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
import { useAgentsStore } from '@/store/agents.store'

function project(id: string) {
  return {
    agentManager: {
      listAgents: vi.fn(async () => [
        { id: 'default', name: id },
        { id: `${id}-agent`, name: id },
      ]),
      getAgent: vi.fn(async (agentId: string) => ({ id: agentId })),
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}

describe('project Agent catalog initialization', () => {
  beforeEach(async () => {
    await useAgentsStore.getState().initialize('')
    mocks.route.activeProjectId = 'project-a'
  })

  it('coalesces simultaneous callers, and loads the new project after an initialized one', async () => {
    const getProject = vi.fn(async (id: string) => project(id))
    useAgentsStore.getState().setProjectManager({ getProject } as unknown as ProjectManager)
    await Promise.all([
      useAgentsStore.getState().initialize('project-a'),
      useAgentsStore.getState().initialize('project-a'),
    ])
    expect(getProject).toHaveBeenCalledTimes(1)
    mocks.route.activeProjectId = 'project-b'
    await useAgentsStore.getState().initialize('project-b')
    expect(useAgentsStore.getState()).toMatchObject({
      loadedProjectId: 'project-b',
      agents: [{ name: 'project-b' }, { id: 'project-b-agent' }],
    })
  })

  it('ignores a slow old project completion after the new project finishes', async () => {
    const old = deferred<ReturnType<typeof project>>()
    const getProject = vi.fn(async (id: string) => (id === 'project-a' ? old.promise : project(id)))
    useAgentsStore.getState().setProjectManager({ getProject } as unknown as ProjectManager)
    const first = useAgentsStore.getState().initialize('project-a')
    mocks.route.activeProjectId = 'project-b'
    await useAgentsStore.getState().initialize('project-b')
    old.resolve(project('project-a'))
    await first
    expect(useAgentsStore.getState().loadedProjectId).toBe('project-b')
    expect(useAgentsStore.getState().agents.map((a) => a.id)).toContain('project-b-agent')
    await useAgentsStore.getState().initialize('project-a')
    expect(useAgentsStore.getState().loadedProjectId).toBe('project-b')
  })

  it('can retry after the manager is provided and does not initialize-loop for an empty catalog', async () => {
    useAgentsStore.setState({ projectManager: null })
    await useAgentsStore.getState().initialize('project-a')
    expect(useAgentsStore.getState().isInitialized).toBe(false)
    const getProject = vi.fn(async () => ({ agentManager: { listAgents: async () => [] } }))
    useAgentsStore.getState().setProjectManager({ getProject } as unknown as ProjectManager)
    await useAgentsStore.getState().initialize('project-a')
    await useAgentsStore.getState().initialize('project-a')
    expect(getProject).toHaveBeenCalledTimes(1)
    expect(useAgentsStore.getState()).toMatchObject({
      isInitialized: true,
      loadedProjectId: 'project-a',
      agents: [],
    })
  })

  it('times out a never-settling initialization and releases the in-flight slot for retry', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<ReturnType<typeof project>>(() => {})
      const getProject = vi.fn(async () => never)
      useAgentsStore.getState().setProjectManager({ getProject } as unknown as ProjectManager)

      const stuck = useAgentsStore.getState().initialize('project-a')
      expect(useAgentsStore.getState().isLoading).toBe(true)

      await vi.advanceTimersByTimeAsync(16_000)
      // The timeout surfaces as an error state (initialize resolves; the
      // catch writes the failure into the store) and releases the in-flight
      // slot so a subsequent call starts a NEW attempt.
      await stuck
      expect(useAgentsStore.getState().isLoading).toBe(false)
      expect(useAgentsStore.getState().isInitialized).toBe(false)
      expect(useAgentsStore.getState().error).toMatch(/timed out/)

      getProject.mockImplementation(async () => project('project-a'))
      await useAgentsStore.getState().initialize('project-a')
      expect(getProject).toHaveBeenCalledTimes(2)
      expect(useAgentsStore.getState().loadedProjectId).toBe('project-a')
    } finally {
      vi.useRealTimers()
    }
  })
})
