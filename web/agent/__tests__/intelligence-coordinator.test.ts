import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IntelligenceCoordinator } from '../intelligence-coordinator'

const {
  recommendMock,
  getToolRecommendationsForPromptMock,
  getProjectMock,
  buildAgentPromptMock,
} = vi.hoisted(() => {
  return {
    recommendMock: vi.fn(() => []),
    getToolRecommendationsForPromptMock: vi.fn(() => ''),
    getProjectMock: vi.fn(),
    buildAgentPromptMock: vi.fn(() => 'AGENT_PROMPT'),
  }
})

vi.mock('../tools/tool-recommendation', () => ({
  getRecommendationEngine: () => ({
    recommend: recommendMock,
    getAllTools: vi.fn(() => ({})),
  }),
  getToolRecommendationsForPrompt: getToolRecommendationsForPromptMock,
}))

vi.mock('@/opfs', () => ({
  ProjectManager: {
    create: vi.fn(async () => ({
      getProject: getProjectMock,
    })),
  },
}))

vi.mock('../prompt-builder', () => ({
  buildAgentPrompt: buildAgentPromptMock,
}))

function createAgentInfo(id = 'default') {
  return {
    id,
    meta: { id, name: id, createdAt: Date.now(), lastAccessedAt: Date.now() },
    soul: '# SOUL',
    identity: '# IDENTITY',
    agents: '# AGENTS',
    user: '# USER',
    memory: '# MEMORY',
  }
}

describe('IntelligenceCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProjectMock.mockResolvedValue(null)
  })

  it('injects agent prompt when projectId is provided', async () => {
    const agentInfo = createAgentInfo('default')
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: vi.fn(async () => agentInfo),
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', { projectId: 'proj-store' })

    expect(result.agentInfo?.id).toBe('default')
    expect(result.systemPrompt).toContain('BASE_PROMPT\n\n---\n\nAGENT_PROMPT')
    expect(getProjectMock).toHaveBeenCalledWith('proj-store')
  })

  it('injects routed agent prompt when currentAgentId is provided', async () => {
    const routedAgent = createAgentInfo('novel-editor')
    const defaultAgent = createAgentInfo('default')
    const getAgentMock = vi.fn(async (id: string) =>
      id === 'novel-editor' ? routedAgent : defaultAgent
    )
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: getAgentMock,
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
          { id: 'novel-editor', name: 'Novel Editor', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', {
      projectId: 'proj-store',
      currentAgentId: 'novel-editor',
    })

    expect(getAgentMock).toHaveBeenCalledWith('novel-editor')
    expect(result.agentInfo?.id).toBe('novel-editor')
    // Agent catalog should be injected and appear BEFORE the persona block
    expect(result.systemPrompt).toContain('## Available Agents')
    expect(result.systemPrompt).toContain('`novel-editor`')
    // Persona still appears at the end, separated by `---`
    expect(result.systemPrompt).toContain('---\n\nAGENT_PROMPT')
    // And base prompt is the very first thing
    expect(result.systemPrompt.startsWith('BASE_PROMPT')).toBe(true)
  })

  it('falls back to default agent prompt when routed agent is missing', async () => {
    const defaultAgent = createAgentInfo('default')
    const getAgentMock = vi.fn(async (id: string) => (id === 'default' ? defaultAgent : null))
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: getAgentMock,
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', {
      projectId: 'proj-store',
      currentAgentId: 'novel-editor',
    })

    expect(getAgentMock).toHaveBeenCalledWith('novel-editor')
    expect(getAgentMock).toHaveBeenCalledWith('default')
    expect(result.agentInfo?.id).toBe('default')
    expect(result.systemPrompt).toContain('BASE_PROMPT\n\n---\n\nAGENT_PROMPT')
  })

  it('injects available-agents catalog when project has multiple agents', async () => {
    const defaultAgent = createAgentInfo('default')
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: vi.fn(async () => defaultAgent),
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
          { id: 'backend-engineer', name: 'Backend Engineer', createdAt: 0, lastAccessedAt: 0 },
          { id: 'frontend-lead', name: 'Frontend Lead', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', { projectId: 'proj-store' })

    expect(result.systemPrompt).toContain('## Available Agents')
    expect(result.systemPrompt).toContain('`backend-engineer` — Backend Engineer')
    expect(result.systemPrompt).toContain('`frontend-lead` — Frontend Lead')
    expect(result.systemPrompt).toContain('spawn_subagent')
  })

  it('does not inject agents catalog when only default agent exists', async () => {
    const defaultAgent = createAgentInfo('default')
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: vi.fn(async () => defaultAgent),
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', { projectId: 'proj-store' })

    expect(result.systemPrompt).not.toContain('## Available Agents')
  })

  it('routes by @mention in userMessage with Chinese agent id', async () => {
    const routedAgent = createAgentInfo('墨染')
    const defaultAgent = createAgentInfo('default')
    const getAgentMock = vi.fn(async (id: string) => (id === '墨染' ? routedAgent : defaultAgent))
    getProjectMock.mockResolvedValue({
      agentManager: {
        getAgent: getAgentMock,
        readTodayLog: vi.fn(async () => null),
        listAgents: vi.fn(async () => [
          { id: 'default', name: 'Default', createdAt: 0, lastAccessedAt: 0 },
          { id: '墨染', name: '墨染', createdAt: 0, lastAccessedAt: 0 },
        ]),
      },
    })

    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT', {
      projectId: 'proj-store',
      userMessage: '请 @墨染 帮我改这段',
    })

    expect(getAgentMock).toHaveBeenCalledWith('墨染')
    expect(result.agentInfo?.id).toBe('墨染')
  })

  it('does not inject agent prompt when no projectId is provided', async () => {
    const coordinator = new IntelligenceCoordinator()
    const result = await coordinator.enhanceSystemPrompt('BASE_PROMPT')

    expect(result.agentInfo).toBeNull()
    expect(result.systemPrompt).toBe('BASE_PROMPT')
    expect(buildAgentPromptMock).not.toHaveBeenCalled()
  })
})
