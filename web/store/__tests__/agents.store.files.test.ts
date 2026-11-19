import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentsStore } from '../agents.store'

/**
 * useAgentsStore — Agent profile reading
 *
 * The store resolves the active project's AgentManager through the
 * ProjectManager, so the whole chain is stubbed here. Tests must never
 * touch real OPFS.
 */

const readSoul = vi.fn(async () => 'SOUL')
const readIdentity = vi.fn(async () => 'IDENTITY')
const readAgents = vi.fn(async () => 'AGENTS')
const readUser = vi.fn(async () => 'USER')
const readMemory = vi.fn(async () => 'MEMORY')
const listDiaries = vi.fn(async () => ['2026-10-22'])
const readPath = vi.fn(async () => 'diary body')
const writePath = vi.fn(async () => {})

const agentManager = {
  readSoul,
  readIdentity,
  readAgents,
  readUser,
  readMemory,
  listDiaries,
  readPath,
  writePath,
}

const getProject = vi.fn(async () => ({ agentManager }))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../project.store', () => ({
  useProjectStore: {
    getState: () => ({ activeProjectId: 'p1' }),
  },
}))

describe('useAgentsStore.readAgentFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readSoul.mockResolvedValue('SOUL')
    useAgentsStore.setState({ projectManager: { getProject } as never })
  })

  it('reads the five agent files and the diary list', async () => {
    const files = await useAgentsStore.getState().readAgentFiles('default')

    expect(files).toEqual({
      soul: 'SOUL',
      identity: 'IDENTITY',
      agents: 'AGENTS',
      user: 'USER',
      memory: 'MEMORY',
      diaries: ['2026-10-22'],
    })
    expect(readSoul).toHaveBeenCalledWith('default')
    expect(listDiaries).toHaveBeenCalledWith('default')
  })

  it('returns null when the agent cannot be read', async () => {
    readSoul.mockRejectedValueOnce(new Error('boom'))

    expect(await useAgentsStore.getState().readAgentFiles('default')).toBeNull()
  })

  it('returns null when there is no project manager', async () => {
    useAgentsStore.setState({ projectManager: null })

    expect(await useAgentsStore.getState().readAgentFiles('default')).toBeNull()
  })

  it('returns null when the project cannot be resolved', async () => {
    getProject.mockResolvedValueOnce(null as never)

    expect(await useAgentsStore.getState().readAgentFiles('default')).toBeNull()
  })
})

describe('useAgentsStore.readAgentDiary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readPath.mockResolvedValue('diary body')
    useAgentsStore.setState({ projectManager: { getProject } as never })
  })

  it('reads a diary entry by date', async () => {
    const body = await useAgentsStore.getState().readAgentDiary('default', '2026-10-21')

    expect(body).toBe('diary body')
    expect(readPath).toHaveBeenCalledWith('default', 'memory/2026-10-21.md')
  })

  it('returns null when the project manager is missing', async () => {
    useAgentsStore.setState({ projectManager: null })

    expect(await useAgentsStore.getState().readAgentDiary('default', '2026-10-21')).toBeNull()
  })
})

describe('useAgentsStore.updateAgentDiary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAgentsStore.setState({ projectManager: { getProject } as never })
  })

  it('writes the diary body to the dated memory file', async () => {
    const ok = await useAgentsStore.getState().updateAgentDiary('default', '2026-10-21', 'new body')

    expect(ok).toBe(true)
    expect(writePath).toHaveBeenCalledWith('default', 'memory/2026-10-21.md', 'new body')
  })

  it('returns false when the project manager is missing', async () => {
    useAgentsStore.setState({ projectManager: null })

    expect(await useAgentsStore.getState().updateAgentDiary('default', '2026-10-21', 'x')).toBe(false)
  })

  it('returns false when the write fails', async () => {
    writePath.mockRejectedValueOnce(new Error('boom'))

    expect(await useAgentsStore.getState().updateAgentDiary('default', '2026-10-21', 'x')).toBe(false)
  })
})

describe('useAgentsStore.bumpAgentsRevision', () => {
  it('increments the revision counter', () => {
    const before = useAgentsStore.getState().agentsRevision

    useAgentsStore.getState().bumpAgentsRevision()

    expect(useAgentsStore.getState().agentsRevision).toBe(before + 1)
  })
})
