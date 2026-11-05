import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConversationTarget } from '@/services/conversation-target'
import { resolveConversationAgentId } from '@/agent/conversation-agent-routing'

const mocks = vi.hoisted(() => ({
  route: { activeProjectId: 'project-a' },
  context: { activeWorkspaceId: 'chat-a' as string | null },
  ui: { loadedProjectId: 'project-a', activeAgentId: 'alpha' },
  preferences: {
    agentIdByWorkspace: {} as Record<string, string>,
    setWorkspaceAgentId: vi.fn((id: string, agentId: string) => {
      mocks.preferences.agentIdByWorkspace[id] = agentId
    }),
  },
  findWorkspace: vi.fn(async (id: string) => {
    const projectId = ({ 'chat-a': 'project-a', 'chat-b': 'project-b' } as Record<string, string>)[
      id
    ]
    return projectId ? { id, projectId } : null
  }),
  getProject: vi.fn(async (id: string) => {
    const catalogs: Record<string, { id: string; name: string }[]> = {
      'project-a': [
        { id: 'default', name: 'Default' },
        { id: 'alpha', name: 'Alpha' },
      ],
      'project-b': [
        { id: 'default', name: 'Default' },
        { id: 'resource-loop', name: 'Resource Loop' },
      ],
    }
    return catalogs[id] ? { agentManager: { listAgents: async () => catalogs[id] } } : null
  }),
  findProject: vi.fn(async (id: string) =>
    ['project-a', 'project-b'].includes(id) ? { id, name: id, status: 'active' } : null
  ),
}))

vi.mock('@/opfs', () => ({
  ProjectManager: { create: async () => ({ getProject: mocks.getProject }) },
}))
vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({ findWorkspaceById: mocks.findWorkspace }),
}))
vi.mock('@/sqlite/repositories/project.repository', () => ({
  getProjectRepository: () => ({ findById: mocks.findProject }),
}))
vi.mock('@/store/project.store', () => ({ useProjectStore: { getState: () => mocks.route } }))
vi.mock('@/store/conversation-context.store', () => ({
  useConversationContextStore: { getState: () => mocks.context },
}))
vi.mock('@/store/agents.store', () => ({ useAgentsStore: { getState: () => mocks.ui } }))
vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: { getState: () => mocks.preferences },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.activeProjectId = 'project-a'
  mocks.context.activeWorkspaceId = 'chat-a'
  mocks.ui.loadedProjectId = 'project-a'
  mocks.ui.activeAgentId = 'alpha'
  mocks.preferences.agentIdByWorkspace = {}
})

describe('conversation target resolution', () => {
  it('defaults to the open workspace and returns only its project catalog and selection', async () => {
    expect(await resolveConversationTarget()).toEqual({
      projectId: 'project-a',
      projectName: 'project-a',
      workspaceId: 'chat-a',
      agentId: 'alpha',
      agents: [
        { id: 'default', name: 'Default' },
        { id: 'alpha', name: 'Alpha' },
      ],
    })
    expect(mocks.preferences.setWorkspaceAgentId).not.toHaveBeenCalled()
  })

  it('queries an explicit other workspace without changing the UI or using its Agent list', async () => {
    expect(await resolveConversationTarget({ workspaceId: 'chat-b' })).toMatchObject({
      projectId: 'project-b',
      workspaceId: 'chat-b',
      agentId: 'default',
      agents: [{ id: 'default' }, { id: 'resource-loop' }],
    })
    expect(mocks.context.activeWorkspaceId).toBe('chat-a')
    expect(mocks.route.activeProjectId).toBe('project-a')
  })

  it('explicit project overrides the open context and a matching workspace/project pair is accepted', async () => {
    expect(await resolveConversationTarget({ projectId: 'project-b' })).toMatchObject({
      projectId: 'project-b',
      workspaceId: null,
    })
    expect(
      await resolveConversationTarget({ workspaceId: 'chat-b', projectId: 'project-b' })
    ).toMatchObject({ projectId: 'project-b' })
  })

  it('rejects mismatched, missing, and unavailable targets without falling back to the open project', async () => {
    await expect(
      resolveConversationTarget({ workspaceId: 'chat-b', projectId: 'project-a' })
    ).rejects.toThrow('does not belong')
    await expect(resolveConversationTarget({ workspaceId: 'missing' })).rejects.toThrow(
      'Workspace not found'
    )
    await expect(resolveConversationTarget({ projectId: 'missing' })).rejects.toThrow(
      'Project not found'
    )
  })

  it('reads a conversation-specific Agent selection rather than the other conversation UI selection', async () => {
    mocks.preferences.agentIdByWorkspace['chat-a'] = 'default'
    expect((await resolveConversationTarget()).agentId).toBe('default')
  })

  it('supports a project without a selected conversation and snapshots it across UI changes', async () => {
    mocks.context.activeWorkspaceId = null
    mocks.findProject.mockImplementationOnce(async (id) => {
      mocks.route.activeProjectId = 'project-b'
      mocks.ui.activeAgentId = 'default'
      return { id, name: id, status: 'active' }
    })
    expect(await resolveConversationTarget()).toMatchObject({
      projectId: 'project-a',
      workspaceId: null,
      agentId: 'alpha',
    })
    mocks.route.activeProjectId = ''
    await expect(resolveConversationTarget()).rejects.toThrow('No open project')
  })
})

describe('per-conversation Agent routing', () => {
  it('requires a bound project before claiming a requested Agent identity', async () => {
    await expect(
      resolveConversationAgentId(null, 'unbound', null, '@resource-loop hello')
    ).rejects.toThrow('bound project')
  })

  it('does not overwrite a newer UI selection while resolving this run', async () => {
    mocks.preferences.agentIdByWorkspace['chat-b'] = 'resource-loop'
    const getProject = mocks.getProject.getMockImplementation()!
    mocks.getProject.mockImplementationOnce(async (id: string) => {
      mocks.preferences.agentIdByWorkspace['chat-b'] = 'default'
      return getProject(id)
    })
    expect(await resolveConversationAgentId('project-b', 'chat-b', null, '继续')).toBe(
      'resource-loop'
    )
    expect(mocks.preferences.agentIdByWorkspace['chat-b']).toBe('default')
  })

  it('loads an @ identity from the target project, even when another project is open', async () => {
    expect(
      await resolveConversationAgentId('project-b', 'chat-b', null, '@RESOURCE-LOOP\n介绍自己')
    ).toBe('resource-loop')
    expect(mocks.preferences.agentIdByWorkspace['chat-b']).toBe('resource-loop')
    // Follow-up has no mention and the UI still selects another project's Agent.
    expect(await resolveConversationAgentId('project-b', 'chat-b', null, '继续')).toBe(
      'resource-loop'
    )
    expect(mocks.ui.activeAgentId).toBe('alpha')
  })

  it('does not persist a transient (delegated handoff) override as the saved selection', async () => {
    // A delegated handoff forces the target persona via overrideId for THIS
    // run only — it must not replace the conversation's saved Agent.
    expect(
      await resolveConversationAgentId('project-b', 'chat-b', 'resource-loop', '继续', {
        transient: true,
      })
    ).toBe('resource-loop')
    expect(mocks.preferences.agentIdByWorkspace['chat-b']).toBeUndefined()

    // Non-transient behavior is unchanged: an explicit override persists.
    await resolveConversationAgentId('project-b', 'chat-b', 'resource-loop', '继续')
    expect(mocks.preferences.agentIdByWorkspace['chat-b']).toBe('resource-loop')
  })

  it('explicit selection takes priority over @, and an unknown explicit identity fails', async () => {
    expect(
      await resolveConversationAgentId('project-b', 'chat-b', 'default', '@resource-loop hello')
    ).toBe('default')
    await expect(
      resolveConversationAgentId('project-b', 'chat-b', 'alpha', 'hello')
    ).rejects.toThrow('Agent not found')
  })

  it('does not silently turn a deleted saved Agent into a generic assistant', async () => {
    mocks.preferences.agentIdByWorkspace['chat-b'] = 'deleted-agent'
    await expect(resolveConversationAgentId('project-b', 'chat-b', null, '继续')).rejects.toThrow(
      'no longer exists'
    )
  })

  it('keeps two conversations independently selected across later turns', async () => {
    await resolveConversationAgentId('project-b', 'first', 'resource-loop', 'hello')
    await resolveConversationAgentId('project-b', 'second', 'default', 'hello')
    expect(await resolveConversationAgentId('project-b', 'first', null, 'continue')).toBe(
      'resource-loop'
    )
    expect(await resolveConversationAgentId('project-b', 'second', null, 'continue')).toBe(
      'default'
    )
  })
})
