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

  it('retries initialization after a transient failure instead of giving up', async () => {
    vi.useFakeTimers()
    try {
      // First two ProjectManager resolves fail (transient bridge hiccups),
      // the third succeeds.
      mocks.getProject.mockImplementationOnce(async () => {
        throw new Error('bridge hiccup 1')
      })
      mocks.getProject.mockImplementationOnce(async () => {
        throw new Error('bridge hiccup 2')
      })

      renderHook(() => useProjectAgentsInit())

      // Attempt 1 fails; the retry is scheduled, not abandoned.
      await vi.waitFor(() => expect(useAgentsStore.getState().error).toBe('bridge hiccup 1'))
      expect(useAgentsStore.getState().isInitialized).toBe(false)

      // Attempt 2 (after the 5s backoff) also fails.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await vi.waitFor(() => expect(useAgentsStore.getState().error).toBe('bridge hiccup 2'))

      // Attempt 3 succeeds — the catalog becomes available without a project
      // change or reload.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      await vi.waitFor(() => expect(useAgentsStore.getState().isInitialized).toBe(true))
      expect(useAgentsStore.getState().loadedProjectId).toBe('project-a')
      expect(useAgentsStore.getState().agents.map((a) => a.id)).toContain('project-a-agent')
      expect(useAgentsStore.getState().error).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying after three failed attempts', async () => {
    vi.useFakeTimers()
    try {
      mocks.getProject.mockImplementation(async () => {
        throw new Error('bridge down')
      })

      renderHook(() => useProjectAgentsInit())

      // 3 attempts total, each 5s apart — after the last one no further
      // ProjectManager resolutions may be scheduled.
      for (let i = 0; i < 3; i++) {
        await vi.waitFor(() =>
          expect(useAgentsStore.getState().error).toBe('bridge down')
        )
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      }
      const attemptsAfterRetries = mocks.getProject.mock.calls.length
      expect(attemptsAfterRetries).toBe(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(mocks.getProject.mock.calls.length).toBe(attemptsAfterRetries)
    } finally {
      vi.useRealTimers()
    }
  })
})
