import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCurrentWorkspaceAgentMode,
  useWorkspacePreferencesStore,
} from '../workspace-preferences.store'
import { useWorkspaceStore } from '../workspace.store'

describe('workspace-preferences.store agent mode isolation', () => {
  beforeEach(() => {
    localStorage.clear()
    useWorkspaceStore.setState({ activeWorkspaceId: null })
    useWorkspacePreferencesStore.setState({
      agentMode: 'act',
      agentModeByWorkspace: {},
      autoApplyOnRunComplete: false,
      autoApplyOnRunCompleteByWorkspace: {},
    })
  })

  it('isolates agent mode by workspace when switching active workspace', () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' })
    useWorkspacePreferencesStore.getState().setAgentMode('plan')

    expect(getCurrentWorkspaceAgentMode()).toBe('plan')

    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' })
    expect(getCurrentWorkspaceAgentMode()).toBe('act')

    useWorkspacePreferencesStore.getState().setAgentMode('act')

    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' })
    expect(getCurrentWorkspaceAgentMode()).toBe('plan')
  })

  it('persists independent Agent identities across rehydration', async () => {
    const store = useWorkspacePreferencesStore.getState()
    store.setWorkspaceAgentId('chat-a', 'resource-loop')
    store.setWorkspaceAgentId('chat-b', 'default')
    const persisted = localStorage.getItem('bfosa-workspace-preferences')!
    expect(JSON.parse(persisted).state.agentIdByWorkspace).toMatchObject({ 'chat-a': 'resource-loop', 'chat-b': 'default' })
    useWorkspacePreferencesStore.setState({ agentIdByWorkspace: {} })
    localStorage.setItem('bfosa-workspace-preferences', persisted)
    await useWorkspacePreferencesStore.persist.rehydrate()
    expect(useWorkspacePreferencesStore.getState().agentIdByWorkspace).toMatchObject({ 'chat-a': 'resource-loop', 'chat-b': 'default' })
  })

  it('isolates completion auto-apply by workspace', () => {
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' })
    useWorkspacePreferencesStore.getState().setAutoApplyOnRunComplete(true)

    expect(useWorkspacePreferencesStore.getState().autoApplyOnRunComplete).toBe(true)
    expect(useWorkspacePreferencesStore.getState().autoApplyOnRunCompleteByWorkspace['ws-a']).toBe(true)

    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-b' })
    expect(useWorkspacePreferencesStore.getState().autoApplyOnRunComplete).toBe(false)

    useWorkspacePreferencesStore.getState().setAutoApplyOnRunComplete(true)
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-a' })

    expect(useWorkspacePreferencesStore.getState().autoApplyOnRunComplete).toBe(true)
    expect(useWorkspacePreferencesStore.getState().autoApplyOnRunCompleteByWorkspace).toEqual({
      'ws-a': true,
      'ws-b': true,
    })
  })
})

describe('workspace-preferences.store panel sizes rounding', () => {
  beforeEach(() => {
    localStorage.clear()
    useWorkspacePreferencesStore.setState({
      panelSizes: { sidebarWidth: 260, conversationRatio: 50, previewRatio: 38 },
    })
  })

  it('rounds conversation ratio to integer when drag commits a float', () => {
    useWorkspacePreferencesStore.getState().setConversationRatio(52.71828)
    expect(useWorkspacePreferencesStore.getState().panelSizes.conversationRatio).toBe(53)
  })

  it('rounds preview ratio to integer when drag commits a float', () => {
    useWorkspacePreferencesStore.getState().setPreviewRatio(41.3)
    expect(useWorkspacePreferencesStore.getState().panelSizes.previewRatio).toBe(41)
  })

  it('rounds sidebar width to integer and clamps to bounds', () => {
    useWorkspacePreferencesStore.getState().setSidebarWidth(313.6)
    expect(useWorkspacePreferencesStore.getState().panelSizes.sidebarWidth).toBe(314)

    useWorkspacePreferencesStore.getState().setSidebarWidth(999.9)
    expect(useWorkspacePreferencesStore.getState().panelSizes.sidebarWidth).toBe(400)
  })

  it('rounds fractional panel sizes persisted by legacy versions on rehydrate', async () => {
    localStorage.setItem(
      'bfosa-workspace-preferences',
      JSON.stringify({
        state: {
          panelSizes: { sidebarWidth: 277.4, conversationRatio: 51.6, previewRatio: 39.5 },
        },
        version: 6,
      })
    )
    // Re-import a fresh module instance to trigger persist rehydration + migrate
    vi.resetModules()
    const { useWorkspacePreferencesStore: fresh } = await import('../workspace-preferences.store')
    const { panelSizes } = fresh.getState()
    expect(panelSizes.sidebarWidth).toBe(277)
    expect(panelSizes.conversationRatio).toBe(52)
    expect(panelSizes.previewRatio).toBe(40)
  })
})

describe('workspace-preferences.store one-shot open requests', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('does not persist a pending settings open request', () => {
    useWorkspacePreferencesStore.getState().setSettingsOpenRequest(true)
    expect(useWorkspacePreferencesStore.getState().panelState.settingsOpenRequest).toBe(true)

    const persisted = JSON.parse(localStorage.getItem('bfosa-workspace-preferences')!)
    expect(persisted.state.panelState.settingsOpenRequest).toBe(false)
  })

  it('drops a pending settings open request persisted by an older build', async () => {
    localStorage.setItem(
      'bfosa-workspace-preferences',
      JSON.stringify({
        state: { panelState: { settingsOpenRequest: true, sidebarCollapsed: false } },
        version: 6,
      })
    )
    vi.resetModules()
    const { useWorkspacePreferencesStore: fresh } = await import('../workspace-preferences.store')
    expect(fresh.getState().panelState.settingsOpenRequest).toBe(false)
    expect(fresh.getState().panelState.sidebarCollapsed).toBe(false)
  })
})
