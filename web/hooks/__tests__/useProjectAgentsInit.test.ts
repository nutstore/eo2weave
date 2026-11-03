import { act, renderHook, waitFor } from '@testing-library/react'
import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getProject: vi.fn() }))
vi.mock('@/opfs', () => ({
  ProjectManager: { create: async () => ({ getProject: mocks.getProject }) },
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store/project.store', () => ({
  useProjectStore: create(() => ({ activeProjectId: 'project-a' })),
}))

import { useProjectStore } from '@/store/project.store'
import { useAgentsStore } from '@/store/agents.store'
import { useProjectAgentsInit } from '@/hooks/useProjectAgentsInit'
import { selectMentionAgents } from '@/components/agent/useConversationLogic'

describe('useProjectAgentsInit', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await useAgentsStore.getState().initialize('')
    useProjectStore.setState({ activeProjectId: 'project-a' })
    mocks.getProject.mockImplementation(async (id: string) => ({
      agentManager: {
        listAgents: async () => [
          { id: 'default', name: id },
          { id: `${id}-agent`, name: id },
        ],
        getAgent: async (agentId: string) => ({ id: agentId }),
      },
    }))
  })

  it('gates the visible Agent catalog on loadedProjectId matching the active project', async () => {
    // The production selector is exercised directly (extracted pure from
    // useConversationLogic) — the composer exposes candidates only when the
    // loaded catalog belongs to the project the user is looking at.
    useProjectStore.setState({ activeProjectId: 'project-b' })
    // Mid-switch: the old project's catalog is still loaded — must be hidden.
    useAgentsStore.setState({
      loadedProjectId: 'project-a',
      agents: [{ id: 'old-agent', name: 'Old' }],
    } as never)
    expect(selectMentionAgents(
      useAgentsStore.getState(),
      useProjectStore.getState().activeProjectId
    )).toEqual([])

    // Initialization finished — the new catalog becomes selectable (the
    // built-in 'default' Agent is excluded from mention candidates).
    useAgentsStore.setState({
      loadedProjectId: 'project-b',
      agents: [{ id: 'default', name: 'New' }, { id: 'new-agent', name: 'New' }],
    } as never)
    expect(selectMentionAgents(
      useAgentsStore.getState(),
      useProjectStore.getState().activeProjectId
    ).map((a) => a.id)).toEqual(['new-agent'])
  })

  it('loads, refreshes candidates on a project change, and clears on project exit', async () => {
    const { rerender } = renderHook(() => useProjectAgentsInit())
    await waitFor(() => expect(useAgentsStore.getState().loadedProjectId).toBe('project-a'))
    rerender()
    expect(mocks.getProject).toHaveBeenCalledTimes(1)
    await act(async () => {
      useProjectStore.setState({ activeProjectId: 'project-b' })
    })
    await waitFor(() => expect(useAgentsStore.getState().loadedProjectId).toBe('project-b'))
    expect(useAgentsStore.getState().agents.map((a) => a.id)).toContain('project-b-agent')
    await act(async () => {
      useProjectStore.setState({ activeProjectId: '' })
    })
    expect(useAgentsStore.getState().agents).toEqual([])
  })

})
