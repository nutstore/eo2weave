import { beforeEach, describe, expect, it, vi } from 'vitest'

const { modeState, pageActionState } = vi.hoisted(() => ({
  modeState: {
    value: 'act' as 'plan' | 'act',
    byWorkspace: {} as Record<string, 'plan' | 'act'>,
  },
  pageActionState: {
    pageActionYolo: true,
    setPageActionYolo(pageActionYolo: boolean) {
      this.pageActionYolo = pageActionYolo
    },
  },
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  getCurrentWorkspaceAgentMode: () => modeState.value,
  setCurrentWorkspaceAgentMode: (mode: 'plan' | 'act') => {
    modeState.value = mode
  },
  getAgentModeForWorkspace: (workspaceId: string) => modeState.byWorkspace[workspaceId] ?? 'act',
  setAgentModeForWorkspace: (mode: 'plan' | 'act', workspaceId?: string | null) => {
    if (workspaceId) modeState.byWorkspace[workspaceId] = mode
    else modeState.value = mode
  },
}))

vi.mock('@/store/page-action-session.store', () => ({
  usePageActionSessionStore: {
    getState: () => pageActionState,
  },
}))

import { createSwitchModeExecutor } from '../switch-mode.tool'

describe('switch_agent_mode', () => {
  beforeEach(() => {
    pageActionState.pageActionYolo = true
    modeState.byWorkspace = {}
  })

  it.each(['plan', 'act'] as const)('turns off YOLO when switching to %s', async (mode) => {
    modeState.value = mode === 'plan' ? 'act' : 'plan'

    await createSwitchModeExecutor()({ mode, reason: 'test mode transition' }, {} as never)

    expect(pageActionState.pageActionYolo).toBe(false)
  })

  it('switches the mode of the conversation that called it, not the open one', async () => {
    // Two conversations: A owns the run, B is what the user is looking at.
    modeState.byWorkspace = { 'conv-a': 'act', 'conv-b': 'act' }
    modeState.value = 'act'

    const result = JSON.parse(
      await createSwitchModeExecutor()(
        { mode: 'plan', reason: 'review the plan first' },
        { workspaceId: 'conv-a' } as never
      )
    )

    expect(result.success).toBe(true)
    expect(modeState.byWorkspace['conv-a']).toBe('plan')
    // Switching in A must not relabel the conversation on screen.
    expect(modeState.byWorkspace['conv-b']).toBe('act')
    expect(modeState.value).toBe('act')
  })
})
