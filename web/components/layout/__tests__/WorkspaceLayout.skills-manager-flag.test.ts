import { describe, expect, it, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'

// The /skill-install error view arms `panelState.skillsManagerOpen` and
// navigates to a project workspace; WorkspaceLayout must consume the flag on
// mount (open the manager once, clear the persisted flag) — regression guard
// for the requirement-5 Skill Manager link on #126.
//
// Two layers are covered:
// 1. Store contract (real workspace-preferences store, getState/setState).
// 2. Consumer wiring (Sourcery round-18 finding): WorkspaceLayout is RENDERED
//    with the flag armed and the test asserts the SkillsManager dialog
//    actually opens (stubbed component receives open=true), that the
//    persisted flag is cleared by the component's own mount effect, and that
//    the consume is one-shot (remount does not re-open). This fails if the
//    effect that consumes the flag is removed or broken.

// ── Heavy child components: trivial stubs ────────────────────────────────────
vi.mock('@/components/layout/TopBar', () => ({ TopBar: () => null }))
vi.mock('@/components/layout/Sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/components/layout/FolderPermissionBanner', () => ({
  FolderPermissionBanner: () => null,
}))
vi.mock('@/components/agent/ConversationView', () => ({ ConversationView: () => null }))
vi.mock('@/components/agent/AgentProfileDrawer', () => ({ AgentProfileDrawer: () => null }))
vi.mock('@/components/file-viewer/FilePreview', () => ({ FilePreview: () => null }))
vi.mock('@/components/WelcomeScreen', () => ({ WelcomeScreen: () => null }))
vi.mock('@/components/sync', () => ({
  SyncPreviewPanel: () => null,
  SharedSyncDialogs: () => null,
}))
vi.mock('@/components/ui/drawer', () => ({
  Drawer: (props: { open?: boolean; children?: React.ReactNode }) =>
    props.open ? React.createElement('div', null, props.children) : null,
}))
vi.mock('@/components/tools', () => ({
  ToolsPanel: () => null,
  QuickActionsPanel: () => null,
}))
vi.mock('@/components/workspace', () => ({
  CommandPalette: () => null,
  KeyboardShortcutsHelp: () => null,
  GoToFileDialog: () => null,
  buildEnhancedCommands: () => [],
}))
vi.mock('@/components/export', () => ({
  ExportPanel: () => null,
  useExport: () => ({
    isExportPanelOpen: false,
    exportData: null,
    exportFilename: 'export',
    closeExport: vi.fn(),
  }),
}))
vi.mock('@/components/extension', () => ({
  ExtensionBanner: () => null,
  ExtensionOutdatedBanner: () => null,
}))
vi.mock('@/components/mcp', () => ({ MCPSettingsDialog: () => null }))
vi.mock('@/components/settings/SettingsDialog', () => ({ SettingsDialog: () => null }))
vi.mock('@/components/schedule/ScheduleDrawer', () => ({ ScheduleDrawer: () => null }))
vi.mock('@/components/webcontainer/WebContainerPanel', () => ({ WebContainerPanel: () => null }))

// SkillsManager: stub that EXPOSES the `open` prop — the consumer assertion
// reads `data-open` off this stub.
vi.mock('@/components/skills/SkillsManager', () => ({
  SkillsManager: (props: { open?: boolean }) =>
    React.createElement('div', {
      'data-testid': 'skills-manager',
      'data-open': String(!!props.open),
    }),
}))

// ── Browser-only hooks / services ────────────────────────────────────────────
vi.mock('@/components/mobile/useMobile', () => ({ useMobile: () => false }))
vi.mock('@/hooks/useUnloadGuard', () => ({ useUnloadGuard: () => undefined }))
vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
  useLocale: () => ['en-US', vi.fn()] as const,
}))
vi.mock('@/lib/extension-distribution', () => ({
  isMobileDeviceForExtension: () => false,
}))
vi.mock('@/skills/skill-scanner', () => ({
  scanProjectSkills: vi.fn(async () => ({ skills: [], resources: [], errors: [] })),
  syncResourcesToOPFS: vi.fn(async () => {}),
  syncProjectSkillsToActiveWorkspace: vi.fn(async () => {}),
}))
vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: () => ({
    clearProjectSkills: vi.fn(),
    setProjectSkills: vi.fn(),
  }),
}))
vi.mock('@/opfs', () => ({
  getWorkspaceManager: async () => ({ getWorkspace: async () => null }),
}))
vi.mock('@/native-fs/directory-handle-manager', () => ({
  getRuntimeHandlesForProject: () => new Set<string>(),
}))
// Dynamic imports fired by mount effects.
vi.mock('@/services/schedule-heartbeat', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}))
vi.mock('@/store/schedule.store', () => ({
  useScheduleStore: { getState: () => ({ refresh: vi.fn() }) },
}))
vi.mock('@/python/api', () => ({
  pythonExecutor: { warmup: vi.fn() },
}))

// ── Zustand stores: callable mock serving selector + getState shapes ────────
vi.mock('@/store/conversation.store', () => {
  const conversationState = {
    activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string }>,
    loaded: true,
    loadError: null as string | null,
    loadFromDB: vi.fn(async () => {}),
    createNew: vi.fn(() => ({ id: 'conv-new' })),
    setActive: vi.fn(async () => {}),
  }
  const useConversationStoreMock = ((selector?: (s: typeof conversationState) => unknown) =>
    selector ? selector(conversationState) : { ...conversationState }) as unknown as typeof import('@/store/conversation.store').useConversationStore
  ;(useConversationStoreMock as unknown as { getState: () => typeof conversationState }).getState =
    () => conversationState
  return { useConversationStore: useConversationStoreMock }
})

vi.mock('@/store/asset.store', () => {
  const assetState = { pendingAssets: [] as Array<{ name: string }> }
  const useAssetStoreMock = ((selector?: (s: typeof assetState) => unknown) =>
    selector ? selector(assetState) : { ...assetState }) as unknown as typeof import('@/store/asset.store').useAssetStore
  ;(useAssetStoreMock as unknown as { getState: () => typeof assetState }).getState = () => assetState
  return { useAssetStore: useAssetStoreMock }
})

vi.mock('@/store/flow.store', () => {
  const flowState = { setPanelOpen: vi.fn() }
  const useFlowStoreMock = ((selector?: (s: typeof flowState) => unknown) =>
    selector ? selector(flowState) : { ...flowState }) as unknown as typeof import('@/store/flow.store').useFlowStore
  ;(useFlowStoreMock as unknown as { getState: () => typeof flowState }).getState = () => flowState
  return { useFlowStore: useFlowStoreMock }
})

vi.mock('@/store/agent.store', () => {
  const agentState = { directoryHandle: null as FileSystemDirectoryHandle | null }
  const useAgentStoreMock = ((selector?: (s: typeof agentState) => unknown) =>
    selector ? selector(agentState) : { ...agentState }) as unknown as typeof import('@/store/agent.store').useAgentStore
  ;(useAgentStoreMock as unknown as { getState: () => typeof agentState }).getState = () => agentState
  return { useAgentStore: useAgentStoreMock }
})

vi.mock('@/store/project.store', () => {
  const projectState = { activeProjectId: null as string | null, isLoading: false }
  const useProjectStoreMock = ((selector?: (s: typeof projectState) => unknown) =>
    selector ? selector(projectState) : { ...projectState }) as unknown as typeof import('@/store/project.store').useProjectStore
  ;(useProjectStoreMock as unknown as { getState: () => typeof projectState }).getState = () => projectState
  return { useProjectStore: useProjectStoreMock }
})

vi.mock('@/store/settings.store', () => {
  const settingsState = {
    providerType: 'openai' as string,
    modelName: 'gpt-test' as string,
    syncModelForWorkspace: vi.fn(),
    ensureValidModelSelection: vi.fn(),
    saveModelOverrideForWorkspace: vi.fn(),
    getAvailableProviders: vi.fn(async () => []),
  }
  const useSettingsStoreMock = ((selector?: (s: typeof settingsState) => unknown) =>
    selector ? selector(settingsState) : { ...settingsState }) as unknown as typeof import('@/store/settings.store').useSettingsStore
  ;(useSettingsStoreMock as unknown as { getState: () => typeof settingsState }).getState = () => settingsState
  return { useSettingsStore: useSettingsStoreMock }
})

vi.mock('@/store/conversation-context.store', () => {
  const ctxState = {
    initialized: true,
    showPreview: false,
    hidePreviewPanel: vi.fn(),
    filePreviewRequestSeq: 0,
    filePreviewRequestPath: null as string | null,
  }
  const useConversationContextStoreMock = ((selector?: (s: typeof ctxState) => unknown) =>
    selector ? selector(ctxState) : { ...ctxState }) as unknown as typeof import('@/store/conversation-context.store').useConversationContextStore
  ;(useConversationContextStoreMock as unknown as { getState: () => typeof ctxState }).getState =
    () => ctxState
  return { useConversationContextStore: useConversationContextStoreMock }
})

vi.mock('@/store/agent-profile.store', () => {
  const profileState = { isOpen: false, close: vi.fn() }
  const useAgentProfileStoreMock = ((selector?: (s: typeof profileState) => unknown) =>
    selector ? selector(profileState) : { ...profileState }) as unknown as typeof import('@/store/agent-profile.store').useAgentProfileStore
  ;(useAgentProfileStoreMock as unknown as { getState: () => typeof profileState }).getState =
    () => profileState
  return { useAgentProfileStore: useAgentProfileStoreMock }
})

vi.mock('@/store/yolo-mode.store', () => {
  const yoloState = { yoloByConversation: {} as Record<string, boolean>, setYolo: vi.fn() }
  const useYoloModeStoreMock = ((selector?: (s: typeof yoloState) => unknown) =>
    selector ? selector(yoloState) : { ...yoloState }) as unknown as typeof import('@/store/yolo-mode.store').useYoloModeStore
  ;(useYoloModeStoreMock as unknown as { getState: () => typeof yoloState }).getState = () => yoloState
  return { useYoloModeStore: useYoloModeStoreMock, YOLO_WELCOME_SENTINEL: '__welcome__' }
})

vi.mock('@/store/page-action-session.store', () => {
  const pageActionState = { pageActionYolo: false }
  const usePageActionSessionStoreMock = ((selector?: (s: typeof pageActionState) => unknown) =>
    selector ? selector(pageActionState) : { ...pageActionState }) as unknown as typeof import('@/store/page-action-session.store').usePageActionSessionStore
  ;(usePageActionSessionStoreMock as unknown as { getState: () => typeof pageActionState }).getState =
    () => pageActionState
  return { usePageActionSessionStore: usePageActionSessionStoreMock }
})

vi.mock('@/store/skills.store', () => {
  const skillsState = { skillsScanVersion: 0, loaded: true, loadSkills: vi.fn(async () => {}) }
  const useSkillsStoreMock = ((selector?: (s: typeof skillsState) => unknown) =>
    selector ? selector(skillsState) : { ...skillsState }) as unknown as typeof import('@/store/skills.store').useSkillsStore
  ;(useSkillsStoreMock as unknown as { getState: () => typeof skillsState }).getState = () => skillsState
  return { useSkillsStore: useSkillsStoreMock }
})

vi.mock('@/store/theme.store', () => {
  const themeState = { mode: 'dark' as 'dark' | 'light', setTheme: vi.fn() }
  const useThemeStoreMock = ((selector?: (s: typeof themeState) => unknown) =>
    selector ? selector(themeState) : { ...themeState }) as unknown as typeof import('@/store/theme.store').useThemeStore
  ;(useThemeStoreMock as unknown as { getState: () => typeof themeState }).getState = () => themeState
  return { useThemeStore: useThemeStoreMock, initializeTheme: () => () => {} }
})

vi.mock('@/store/extension.store', () => {
  const extensionState = { openInstallGuide: vi.fn() }
  const useExtensionStoreMock = ((selector?: (s: typeof extensionState) => unknown) =>
    selector ? selector(extensionState) : { ...extensionState }) as unknown as typeof import('@/store/extension.store').useExtensionStore
  ;(useExtensionStoreMock as unknown as { getState: () => typeof extensionState }).getState =
    () => extensionState
  return { useExtensionStore: useExtensionStoreMock }
})

vi.mock('@/store/webcontainer.store', () => {
  const webContainerState = { isPanelOpen: false, closePanel: vi.fn() }
  const useWebContainerStoreMock = ((selector?: (s: typeof webContainerState) => unknown) =>
    selector ? selector(webContainerState) : { ...webContainerState }) as unknown as typeof import('@/store/webcontainer.store').useWebContainerStore
  ;(useWebContainerStoreMock as unknown as { getState: () => typeof webContainerState }).getState =
    () => webContainerState
  return { useWebContainerStore: useWebContainerStoreMock }
})

vi.mock('@/store/folder-access.store', () => {
  const folderAccessState = { roots: [] as Array<{ name: string; status: string; handle: FileSystemDirectoryHandle | null }> }
  const useFolderAccessStoreMock = ((selector?: (s: typeof folderAccessState) => unknown) =>
    selector ? selector(folderAccessState) : { ...folderAccessState }) as unknown as typeof import('@/store/folder-access.store').useFolderAccessStore
  ;(useFolderAccessStoreMock as unknown as { getState: () => typeof folderAccessState }).getState =
    () => folderAccessState
  return { useFolderAccessStore: useFolderAccessStoreMock }
})

// NOTE: @/store/workspace-preferences.store is deliberately NOT mocked —
// the real zustand+immer store is what the component must consume.

import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'

describe('skills-manager open-request flag (consume contract)', () => {
  beforeEach(() => {
    useWorkspacePreferencesStore.setState((state) => {
      state.panelState.skillsManagerOpen = false
    })
  })

  it('armed flag is visible to a consumer and clearable in the same pass', () => {
    useWorkspacePreferencesStore.getState().setSkillsManagerOpen(true)

    // Consumer reads the persisted flag (what WorkspaceLayout's effect does).
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(true)

    // Consume: open the dialog + clear the persisted flag.
    useWorkspacePreferencesStore.setState((state) => {
      state.panelState.skillsManagerOpen = false
    })
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })

  it('consumed flag stays cleared across a re-read (one-shot semantics)', () => {
    useWorkspacePreferencesStore.getState().setSkillsManagerOpen(true)
    useWorkspacePreferencesStore.setState((state) => {
      state.panelState.skillsManagerOpen = false
    })
    // Second mount / navigation must not see a stale armed flag.
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })

  it('unset flag is false by default (no spurious auto-open)', () => {
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })
})

describe('WorkspaceLayout consumes the persisted skills-manager flag on mount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspacePreferencesStore.setState((state) => {
      state.panelState.skillsManagerOpen = false
    })
  })

  function managerEl(): HTMLElement {
    const el = screen.getByTestId('skills-manager')
    expect(el).toBeTruthy()
    return el
  }

  it('renders the component with the flag armed: manager opens and the persisted flag is consumed', async () => {
    // Arm the persisted flag exactly like /skill-install does before navigating.
    useWorkspacePreferencesStore.getState().setSkillsManagerOpen(true)
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(true)

    render(React.createElement(WorkspaceLayout))

    // ① The component consumed the flag: SkillsManager received open=true.
    const el = await screen.findByTestId('skills-manager')
    expect(el.getAttribute('data-open')).toBe('true')

    // ② The persisted flag was cleared by the component's own mount effect
    //    (setSkillsManagerOpen(false)) — not by the test.
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })

  it('consume is one-shot: remount with the flag cleared does not re-open the manager', async () => {
    useWorkspacePreferencesStore.getState().setSkillsManagerOpen(true)

    const { unmount } = render(React.createElement(WorkspaceLayout))
    const el = await screen.findByTestId('skills-manager')
    expect(el.getAttribute('data-open')).toBe('true')
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)

    unmount()
    render(React.createElement(WorkspaceLayout))
    // Second mount must NOT see a stale armed flag.
    expect(managerEl().getAttribute('data-open')).toBe('false')
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })

  it('flag not armed: manager stays closed on mount', () => {
    render(React.createElement(WorkspaceLayout))
    expect(managerEl().getAttribute('data-open')).toBe('false')
    expect(useWorkspacePreferencesStore.getState().panelState.skillsManagerOpen).toBe(false)
  })
})
