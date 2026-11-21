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
import { collectContextSources } from '@/agent/context/journal'

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
