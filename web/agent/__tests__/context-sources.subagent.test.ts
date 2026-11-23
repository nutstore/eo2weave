import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  project: {
    agentManager: {
      listAgents: async () => [{ id: 'gatekeeper', name: '守门员' }],
      getAgent: async (id: string) => (id === 'default'
        ? { id: 'default', name: 'default', soul: 'SOUL BODY', identity: '', agents: '', user: '', memory: '' }
        : null),
      readTodayLog: async () => 'TODAY LOG',
    },
  },
}))

vi.mock('@/opfs', () => ({
  ProjectManager: { create: async () => ({ getProject: async () => fixture.project }) },
}))

import { createRuntimeContextSources } from '@/agent/context/sources'
import { collectContextSources, foldContext, reconcileContext } from '@/agent/context/journal'
import { ProjectManager } from '@/opfs'
import { AgentManager } from '@/opfs/agent/agent-manager'

function actorStorage() {
  const today = new Date()
  const logName = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`
  const logPath = `default/memory/${logName}`
  const state = { failedPath: '' }
  const files: Record<string, string> = {
    'default/meta.json': JSON.stringify({ id: 'default', name: 'default', createdAt: 1, lastAccessedAt: 1 }),
    'default/SOUL.md': 'SOUL BODY',
    [logPath]: 'TODAY LOG',
  }
  const unavailable = new DOMException('Storage unavailable', 'NotReadableError')
  const missing = () => new DOMException('Not found', 'NotFoundError')
  const directory = (path: string): FileSystemDirectoryHandle => ({
    getDirectoryHandle: async (name: string) => {
      const child = path ? `${path}/${name}` : name
      if (state.failedPath === child) throw unavailable
      if (child !== 'default' && child !== 'default/memory') throw missing()
      return directory(child)
    },
    getFileHandle: async (name: string) => {
      const filePath = `${path}/${name}`
      if (!(filePath in files)) throw missing()
      return { getFile: async () => ({ text: async () => {
        if (state.failedPath === filePath) throw unavailable
        return files[filePath]
      } }) }
    },
  }) as unknown as FileSystemDirectoryHandle
  return { manager: new AgentManager(directory('')), state, logPath, files }
}

function source(id: string, toolContext: Record<string, unknown>) {
  const input = {
    baseSystemPrompt: 'base',
    messages: [],
    mode: 'act' as const,
    toolContext: { directoryHandle: null, projectId: 'proj-1', ...toolContext },
  }
  return createRuntimeContextSources(() => input).find(item => item.id === id)!
}

/** Merge every observation's entries; an opted-out source yields no entries at all. */
async function entriesOf(id: string, toolContext: Record<string, unknown>) {
  const observations = await collectContextSources([source(id, toolContext)])
  return Object.assign({}, ...observations.map(item => item.entries))
}

describe('agent persona injection boundaries', () => {
  it('treats an explicit null persona as anonymous instead of falling back to default', async () => {
    expect(await entriesOf('agent-persona', { currentAgentId: null })).toEqual({})
    expect(await entriesOf('today-log', { currentAgentId: null })).toEqual({})
  })

  it('still falls back to the default agent when the persona field is absent', async () => {
    const observations = await collectContextSources([source('agent-persona', {})])
    expect(observations).toHaveLength(1)
    expect(JSON.stringify(observations)).toContain('SOUL BODY')
  })

  it('fails closed when the requested actor no longer exists', async () => {
    // Impersonating the default agent would be worse than running anonymous.
    expect(await entriesOf('agent-persona', { currentAgentId: 'ghost-agent' })).toEqual({})
  })

  it.each([null, 'ghost-agent'])('withdraws prior actor context when switching to %s', async currentAgentId => {
    const actorSources = (actorId: string | null) => ['agent-persona', 'today-log']
      .map(id => source(id, { currentAgentId: actorId }))
    const initial = reconcileContext([], await collectContextSources(actorSources('default')), 'fixed')!
    const previous = foldContext([initial])
    expect(previous.get('agent-persona')!.entries.value).toContain('SOUL BODY')
    expect(previous.get('today-log')!.entries.value).toBe('TODAY LOG')

    const observations = await collectContextSources(actorSources(currentAgentId))
    const withdrawal = reconcileContext([initial], observations, 'fixed')
    expect(withdrawal).toBeDefined()
    expect(withdrawal!.contextCommit!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'agent-persona', removed: ['value'] }),
      expect.objectContaining({ sourceId: 'today-log', removed: ['value'] }),
    ]))
    const current = foldContext([initial, withdrawal!])
    expect(current.get('agent-persona')!.entries).toEqual({})
    expect(current.get('today-log')!.entries).toEqual({})
  })

  it.each(['directory', 'metadata', 'persona', 'day-log'])('preserves published actor context when reading %s fails', async location => {
    const storage = actorStorage()
    const lookup = vi.spyOn(ProjectManager, 'create').mockResolvedValue({
      getProject: async () => ({ agentManager: storage.manager }),
    } as never)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const actorSources = ['agent-persona', 'today-log'].map(id => source(id, { currentAgentId: 'default' }))
      const initial = reconcileContext([], await collectContextSources(actorSources), 'fixed')!
      expect(foldContext([initial]).get('agent-persona')!.entries.value).toContain('SOUL BODY')
      expect(foldContext([initial]).get('today-log')!.entries.value).toBe('TODAY LOG')
      storage.state.failedPath = {
        directory: 'default', metadata: 'default/meta.json', persona: 'default/SOUL.md', 'day-log': storage.logPath,
      }[location]!
      const observations = await collectContextSources(actorSources)
      if (location === 'day-log') expect(observations.map(item => item.sourceId)).toEqual(['agent-persona'])
      else expect(observations).toEqual([])
      expect(reconcileContext([initial], observations, 'fixed')).toBeUndefined()
      expect(foldContext([initial]).get('today-log')!.entries.value).toBe('TODAY LOG')
    } finally {
      lookup.mockRestore()
      warning.mockRestore()
    }
  })

  it('withdraws actor context after a real actor lookup reports NotFoundError', async () => {
    const storage = actorStorage()
    const lookup = vi.spyOn(ProjectManager, 'create').mockResolvedValue({
      getProject: async () => ({ agentManager: storage.manager }),
    } as never)
    try {
      const actorSources = (currentAgentId: string) => ['agent-persona', 'today-log'].map(id => source(id, { currentAgentId }))
      const initial = reconcileContext([], await collectContextSources(actorSources('default')), 'fixed')!
      const withdrawal = reconcileContext([initial], await collectContextSources(actorSources('missing')), 'fixed')!
      const current = foldContext([initial, withdrawal])
      expect(current.get('agent-persona')!.entries).toEqual({})
      expect(current.get('today-log')!.entries).toEqual({})
    } finally {
      lookup.mockRestore()
    }
  })

  it('keeps legacy agent reads forgiving when no strict option was requested', async () => {
    const storage = actorStorage()
    storage.state.failedPath = 'default/SOUL.md'
    expect((await storage.manager.getAgent('default'))!.soul).toBe('')
    storage.state.failedPath = 'default/meta.json'
    expect(await storage.manager.getAgent('default')).toBeNull()
    storage.state.failedPath = storage.logPath
    expect(await storage.manager.readTodayLog('default')).toBeNull()
  })

  it('preserves published actor context when the requested project is unavailable', async () => {
    const actorSources = ['agent-persona', 'today-log'].map(id => source(id, { currentAgentId: 'default' }))
    const initial = reconcileContext([], await collectContextSources(actorSources), 'fixed')!
    const lookup = vi.spyOn(ProjectManager, 'create').mockResolvedValue({ getProject: async () => null } as never)
    try {
      const observations = await collectContextSources(actorSources)
      expect(observations).toEqual([])
      expect(reconcileContext([initial], observations, 'fixed')).toBeUndefined()
    } finally {
      lookup.mockRestore()
    }
  })

  it('hides the peer roster from subagents', async () => {
    expect(await entriesOf('agents', { isSubagent: true })).toEqual({})
  })

  it('exposes the peer roster to the top-level agent', async () => {
    const observations = await collectContextSources([source('agents', {})])
    expect(JSON.stringify(observations)).toContain('gatekeeper')
  })
})

describe('capability-aligned context sources', () => {
  it('hides the bash manual when bash is outside the capability boundary', async () => {
    // Documenting a door the execution cannot open makes the model try it.
    const observations = await collectContextSources([source('bash-commands', { capabilityClasses: ['read'] })])
    expect(observations).toHaveLength(0)
  })

  it('still publishes the bash manual when nothing restricts it', async () => {
    const observations = await collectContextSources([source('bash-commands', {})])
    expect(observations).toHaveLength(1)
  })

  it('hides the external tool catalogue when call_tool is not allowed', async () => {
    const observations = await collectContextSources([source('external-tools', { capabilityClasses: ['read', 'write'] })])
    expect(observations).toHaveLength(0)
  })
})

describe('team board section', () => {
  const runKey = 'conv-1-turn-1'

  it('publishes nothing when the execution has no board', async () => {
    expect(await entriesOf('team-board', {})).toEqual({})
  })

  it('tells the lead to run a team inside one run_code call', async () => {
    const text = JSON.stringify(await entriesOf('team-board', { teamRunKey: runKey }))
    // The board is a review surface, not a document the model maintains: telling
    // a lead to hand-write manifest.json cost more tool calls than the actual
    // work in a real run.
    expect(text).toContain('run_code')
    expect(text).toContain('task_id')
    expect(text).toContain('maintains itself')
    expect(text).not.toContain('Only you write it')
    expect(text).not.toContain('manifest.json')
  })

  it('points a member at its own directory and says the rest is read-only', async () => {
    const text = JSON.stringify(await entriesOf('team-board', {
      teamRunKey: runKey,
      isSubagent: true,
      currentAgentId: 'member-a',
    }))
    expect(text).toContain(`vfs://team/${runKey}/by/member-a/`)
    expect(text).toContain('read-only')
    // The final message is the primary channel; the slot is for long artifacts.
    expect(text).toContain('Answer in your final message')
    expect(text).not.toContain('Only you write it')
  })

  it('does not invite a read-only execution to write', async () => {
    const text = JSON.stringify(await entriesOf('team-board', {
      teamRunKey: runKey,
      isSubagent: true,
      currentAgentId: 'member-a',
      capabilityClasses: ['read'],
    }))
    expect(text).toContain('read-only')
    expect(text).not.toContain('/by/member-a/')
  })

  it('announces the same slot the ACL enforces for an anonymous member', async () => {
    // The board snapshot, the task section and the ACL must not disagree: an
    // invented `by/anonymous/` here told a member a path it could not use.
    const text = JSON.stringify(await entriesOf('team-board', {
      teamRunKey: runKey,
      isSubagent: true,
      currentAgentId: null,
      teamTaskId: 't1',
    }))
    expect(text).toContain(`vfs://team/${runKey}/by/t1/`)
    expect(text).not.toContain('anonymous')
  })

  it('says there is no write area instead of naming one that does not exist', async () => {
    const text = JSON.stringify(await entriesOf('team-board', {
      teamRunKey: runKey,
      isSubagent: true,
      currentAgentId: null,
    }))
    expect(text).toContain('no write area')
  })
})
