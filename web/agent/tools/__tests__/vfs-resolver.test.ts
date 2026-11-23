import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../tool-types'
import { isProtectedAgentCoreFile, resolveVfsTarget } from '../vfs-resolver'

const { getProjectMock, getWorkspaceMock, createProjectManagerMock, getWorkspaceManagerMock, activeAgentState } = vi.hoisted(() => {
  const getProjectMockInner = vi.fn()
  const getWorkspaceMockInner = vi.fn()
  const createProjectManagerMockInner = vi.fn(async () => ({
    getProject: getProjectMockInner,
  }))
  const getWorkspaceManagerMockInner = vi.fn(async () => ({
    getWorkspace: getWorkspaceMockInner,
  }))
  const activeAgentStateInner: { activeAgentId: string | null } = {
    activeAgentId: 'default',
  }
  return {
    getProjectMock: getProjectMockInner,
    getWorkspaceMock: getWorkspaceMockInner,
    createProjectManagerMock: createProjectManagerMockInner,
    getWorkspaceManagerMock: getWorkspaceManagerMockInner,
    activeAgentState: activeAgentStateInner,
  }
})

vi.mock('@/opfs', () => ({
  ProjectManager: {
    create: createProjectManagerMock,
  },
  getWorkspaceManager: getWorkspaceManagerMock,
}))

vi.mock('@/store/agents.store', () => ({
  useAgentsStore: {
    getState: () => activeAgentState,
  },
}))

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    directoryHandle: null,
    projectId: 'project-1',
    workspaceId: 'conv-1',
    currentAgentId: 'default',
    ...overrides,
  }
}

describe('vfs-resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeAgentState.activeAgentId = 'default'
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  it('resolves non-vfs path to workspace namespace', async () => {
    const result = await resolveVfsTarget('src/a.ts', makeContext(), 'read')
    expect(result.kind).toBe('workspace')
    if (result.kind === 'workspace') {
      expect(result.path).toBe('src/a.ts')
    }
    expect(createProjectManagerMock).not.toHaveBeenCalled()
  })

  it('resolves vfs workspace path', async () => {
    const result = await resolveVfsTarget('vfs://workspace/src/a.ts', makeContext(), 'read')
    expect(result.kind).toBe('workspace')
    if (result.kind === 'workspace') {
      expect(result.path).toBe('src/a.ts')
    }
  })

  it('resolves the WebMCP namespace without a workspace', async () => {
    const result = await resolveVfsTarget('vfs://external/webmcp/reports/result.txt', makeContext({ workspaceId: null }), 'write')
    expect(result.kind).toBe('external')
    expect(result.path).toBe('reports/result.txt')
    expect(result.backend.label).toBe('provider')

    const root = await resolveVfsTarget('vfs://external/webmcp/', makeContext(), 'list', { allowEmptyPath: true })
    expect(root.kind).toBe('external')
    expect(root.path).toBe('')

    await expect(resolveVfsTarget('vfs://external/webmcp/../agents/default/SOUL.md', makeContext(), 'read'))
      .rejects.toThrow('Path cannot include')
  })

  it('resolves vfs agent write with default agent permissions', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget(
      'vfs://agents/frontend/SOUL.md',
      makeContext({ currentAgentId: 'default' }),
      'write'
    )

    expect(result.kind).toBe('agent')
    if (result.kind === 'agent') {
      expect(result.agentId).toBe('frontend')
      expect(result.path).toBe('SOUL.md')
      expect(result.projectId).toBe('project-1')
      expect(result.agentManager).toBe(agentManager)
    }
  })

  it('accepts Chinese agent id in vfs path', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget(
      'vfs://agents/墨染/IDENTITY.md',
      makeContext({ currentAgentId: 'default' }),
      'write'
    )

    expect(result.kind).toBe('agent')
    if (result.kind === 'agent') {
      expect(result.agentId).toBe('墨染')
      expect(result.path).toBe('IDENTITY.md')
    }
  })

  it('supports agents root path when allowEmptyPath is enabled', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget('vfs://agents/default', makeContext(), 'list', {
      allowEmptyPath: true,
    })

    expect(result.kind).toBe('agent')
    if (result.kind === 'agent') {
      expect(result.path).toBe('')
      expect(result.agentId).toBe('default')
    }
  })

  it('supports agents namespace root list path vfs://agents', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget('vfs://agents', makeContext(), 'list', {
      allowEmptyPath: true,
    })

    expect(result.kind).toBe('agent')
    if (result.kind === 'agent') {
      expect(result.path).toBe('')
      expect(result.agentId).toBe('')
    }
  })

  it('keeps compatibility with legacy vfs://agent alias', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget('vfs://agent/default/SOUL.md', makeContext(), 'read')
    expect(result.kind).toBe('agent')
    if (result.kind === 'agent') {
      expect(result.agentId).toBe('default')
      expect(result.path).toBe('SOUL.md')
    }
  })

  it('rejects cross-agent write for non-default actor', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    await expect(
      resolveVfsTarget(
        'vfs://agents/agent-b/SOUL.md',
        makeContext({ currentAgentId: 'agent-a' }),
        'write'
      )
    ).rejects.toThrow('Forbidden')
  })

  it('requires active project for agent namespace path', async () => {
    await expect(
      resolveVfsTarget(
        'vfs://agents/default/SOUL.md',
        makeContext({ projectId: null }),
        'read'
      )
    ).rejects.toThrow('No active project')
  })

  it('returns explicit agent id constraints for invalid agent id', async () => {
    await expect(
      resolveVfsTarget(
        'vfs://agents/墨 染/IDENTITY.md',
        makeContext({ currentAgentId: 'default' }),
        'read'
      )
    ).rejects.toThrow('Allowed agentId chars')
  })

  it('uses active agent id from store when context is missing actor id', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })
    activeAgentState.activeAgentId = 'agent-self'

    const result = await resolveVfsTarget(
      'vfs://agents/agent-self/IDENTITY.md',
      makeContext({ currentAgentId: null }),
      'write'
    )

    expect(result.kind).toBe('agent')
  })

  it('detects protected core files', () => {
    for (const path of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md']) {
      expect(isProtectedAgentCoreFile(path)).toBe(true)
    }
    expect(isProtectedAgentCoreFile('skills/debug.md')).toBe(false)
  })

  it('denies subagents access to protected agent core files', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })
    const subagentContext = makeContext({ isSubagent: true } as any)

    for (const path of ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md']) {
      await expect(
        resolveVfsTarget(`vfs://agents/default/${path}`, subagentContext, 'read')
      ).rejects.toThrow('PERMISSION_DENIED')
    }
    await expect(
      resolveVfsTarget('vfs://agents/default', subagentContext, 'list', { allowEmptyPath: true })
    ).rejects.toThrow('PERMISSION_DENIED')
  })

  it('allows subagents to read non-core agent files', async () => {
    const agentManager = { readPath: vi.fn(), writePath: vi.fn(), deletePath: vi.fn() }
    getProjectMock.mockResolvedValue({ agentManager })

    const result = await resolveVfsTarget(
      'vfs://agents/default/skills/review.md',
      makeContext({ isSubagent: true } as any),
      'read'
    )

    expect(result.kind).toBe('agent')
  })
})

describe('vfs-resolver team namespace', () => {
  const runKey = 'conv-1-turn-1'
  const otherRunKey = 'conv-1-turn-2'

  function makeTeamProject() {
    const runDir = { name: runKey, kind: 'directory' }
    // The board now lives in the conversation's own workspace
    // (`workspaces/{conversationId}/team/{runKey}`), so the workspace runtime —
    // not the project manager — hands out the directory.
    const getTeamDir = vi.fn(async () => ({ getDirectoryHandle: async () => runDir }))
    getWorkspaceMock.mockResolvedValue({ getTeamDir })
    return getTeamDir
  }

  it('resolves the board from the executing conversation workspace', async () => {
    makeTeamProject()
    await resolveVfsTarget(`vfs://team/${runKey}/manifest.json`, makeContext({ teamRunKey: runKey }), 'read')
    expect(getWorkspaceMock).toHaveBeenCalledWith('conv-1')
  })

  it('reports the board missing when the conversation has no workspace', async () => {
    getWorkspaceMock.mockResolvedValue(null)
    await expect(
      resolveVfsTarget(`vfs://team/${runKey}/manifest.json`, makeContext({ teamRunKey: runKey }), 'read')
    ).rejects.toThrow('Team board not found')
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('refuses every team path when the execution has no run key', async () => {
    makeTeamProject()
    await expect(
      resolveVfsTarget(`vfs://team/${runKey}/by/me/notes.md`, makeContext(), 'write')
    ).rejects.toThrow('no active team run')
    await expect(
      resolveVfsTarget(`vfs://team/${runKey}/by/me/notes.md`, makeContext(), 'read')
    ).rejects.toThrow('no active team run')
  })

  it('requires a run key in the path', async () => {
    makeTeamProject()
    await expect(
      resolveVfsTarget('vfs://team', makeContext({ teamRunKey: runKey }), 'list')
    ).rejects.toThrow('requires a run key')
  })

  it('lets a member write inside its own actor directory', async () => {
    const getTeamDir = makeTeamProject()
    const result = await resolveVfsTarget(
      `vfs://team/${runKey}/by/member-a/notes.md`,
      makeContext({ teamRunKey: runKey, currentAgentId: 'member-a', isSubagent: true }),
      'write'
    )
    expect(result.kind).toBe('team')
    if (result.kind === 'team') {
      expect(result.runKey).toBe(runKey)
      expect(result.path).toBe('by/member-a/notes.md')
      expect(result.backend.label).toBe('team')
    }
    // A write may create the board; the directory is resolved with create.
    expect(getTeamDir).toHaveBeenCalledWith({ create: true })
  })

  it('refuses a member writing another actor directory or a reserved file', async () => {
    makeTeamProject()
    const member = makeContext({ teamRunKey: runKey, currentAgentId: 'member-a', isSubagent: true })
    await expect(
      resolveVfsTarget(`vfs://team/${runKey}/by/member-b/notes.md`, member, 'write')
    ).rejects.toThrow('PERMISSION_DENIED')
    await expect(
      resolveVfsTarget(`vfs://team/${runKey}/manifest.json`, member, 'write')
    ).rejects.toThrow('PERMISSION_DENIED')
  })

  it('lets the lead write reserved files and refuses cross-run writes', async () => {
    makeTeamProject()
    const lead = makeContext({ teamRunKey: runKey })
    const manifest = await resolveVfsTarget(`vfs://team/${runKey}/manifest.json`, lead, 'write')
    expect(manifest.kind).toBe('team')
    await expect(
      resolveVfsTarget(`vfs://team/${otherRunKey}/manifest.json`, lead, 'write')
    ).rejects.toThrow('PERMISSION_DENIED')
  })

  it('never creates the board on read', async () => {
    const getTeamDir = makeTeamProject()
    await resolveVfsTarget(`vfs://team/${runKey}/by/member-a/notes.md`, makeContext({ teamRunKey: runKey }), 'read')
    expect(getTeamDir).toHaveBeenCalledWith({ create: false })
  })
})
