/**
 * Workspace Preferences Store - manages UI layout and user preferences.
 *
 * Persists to localStorage using zustand persist middleware.
 * Handles panel sizes, active panels, recent files, and display settings.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { enableMapSet } from 'immer'
import { useWorkspaceStore } from './workspace.store'

// Enable Immer Map/Set support
enableMapSet()

/**
 * Recent file entry with metadata
 */
export interface RecentFile {
  path: string
  timestamp: number
  directoryHandleName?: string
}

/**
 * Panel size configuration
 */
export interface PanelSizes {
  sidebarWidth: number // px
  conversationRatio: number // percentage
  previewRatio: number // percentage
}

/**
 * Panel state configuration
 */
export interface PanelState {
  sidebarCollapsed: boolean
  activeResourceTab: 'files' | 'plugins' | 'changes'
  toolsPanelOpen: boolean
  skillsManagerOpen: boolean
  quickActionsOpen: boolean
}

/**
 * Display preferences
 */
export interface DisplayPreferences {
  fontSize: 'small' | 'medium' | 'large'
  showLineNumbers: boolean
  wordWrap: boolean
  showMiniMap: boolean
}

/**
 * Complete workspace preferences
 */
export interface WorkspacePreferences {
  panelSizes: PanelSizes
  panelState: PanelState
  display: DisplayPreferences
  recentFiles: RecentFile[]
  onboardingCompleted: boolean
  /** Agent execution mode per workspace: 'plan' (read-only) or 'act' (full access) */
  agentMode: 'plan' | 'act'
  /** Persisted mode map keyed by workspace ID */
  agentModeByWorkspace: Record<string, 'plan' | 'act'>
  /** Whether a normally completed run should apply its eligible changes to disk. */
  autoApplyOnRunComplete: boolean
  /** Persisted auto-apply policy keyed by workspace ID. */
  autoApplyOnRunCompleteByWorkspace: Record<string, boolean>
  /** Pinned workspace IDs — pinned items show at top of sidebar */
  pinnedWorkspaceIds: string[]
  /** File preview display mode: 'split' = side-by-side with conversation (default), 'overlay' = full-width drawer on top */
  filePreviewMode: 'split' | 'overlay'
  /** User dismissed the input-area "generate image" quick chip — persistently remembered. */
  imageGenChipDismissed: boolean
}

/**
 * Default preferences
 */
const DEFAULT_PREFERENCES: WorkspacePreferences = {
  panelSizes: {
    sidebarWidth: 260,
    conversationRatio: 50,
    previewRatio: 38,
  },
  panelState: {
    sidebarCollapsed: false,
    activeResourceTab: 'files',
    toolsPanelOpen: false,
    skillsManagerOpen: false,
    quickActionsOpen: false,
  },
  display: {
    fontSize: 'medium',
    showLineNumbers: true,
    wordWrap: false,
    showMiniMap: true,
  },
  recentFiles: [],
  onboardingCompleted: false,
  agentMode: 'act',
  agentModeByWorkspace: {},
  autoApplyOnRunComplete: false,
  autoApplyOnRunCompleteByWorkspace: {},
  pinnedWorkspaceIds: [],
  filePreviewMode: 'split',
  imageGenChipDismissed: false,
}

/**
 * Workspace preferences store state
 */
interface WorkspacePreferencesState extends WorkspacePreferences {
  // Panel sizes actions
  setSidebarWidth: (width: number) => void
  setConversationRatio: (ratio: number) => void
  setPreviewRatio: (ratio: number) => void
  resetPanelSizes: () => void

  // Panel state actions
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveResourceTab: (tab: 'files' | 'plugins' | 'changes') => void
  setToolsPanelOpen: (open: boolean) => void
  setSkillsManagerOpen: (open: boolean) => void
  setQuickActionsOpen: (open: boolean) => void

  // Display preferences actions
  setFontSize: (size: 'small' | 'medium' | 'large') => void
  setShowLineNumbers: (show: boolean) => void
  setWordWrap: (wrap: boolean) => void
  setShowMiniMap: (show: boolean) => void

  // Recent files actions
  addRecentFile: (file: RecentFile) => void
  removeRecentFile: (path: string) => void
  clearRecentFiles: () => void

  // Onboarding actions
  setOnboardingCompleted: (completed: boolean) => void

  // Agent mode actions
  setAgentMode: (mode: 'plan' | 'act') => void
  syncAgentModeForWorkspace: (workspaceId: string | null) => void

  // Run completion application policy
  setAutoApplyOnRunComplete: (enabled: boolean) => void
  syncAutoApplyOnRunCompleteForWorkspace: (workspaceId: string | null) => void

  // Pinned workspaces actions
  setPinnedWorkspaceIds: (ids: string[]) => void

  // File preview mode actions
  setFilePreviewMode: (mode: 'split' | 'overlay') => void

  // Quick-chip dismissal (image generation)
  setImageGenChipDismissed: (dismissed: boolean) => void

  // Reset actions
  resetAll: () => void
  resetToDefaults: () => void
}

export const useWorkspacePreferencesStore = create<WorkspacePreferencesState>()(
  persist(
    immer((set) => ({
      ...DEFAULT_PREFERENCES,

      // Panel sizes actions (rounded to integers — drag gestures produce floats)
      setSidebarWidth: (width) =>
        set((state) => {
          state.panelSizes.sidebarWidth = Math.round(Math.max(200, Math.min(400, width)))
        }),

      setConversationRatio: (ratio) =>
        set((state) => {
          state.panelSizes.conversationRatio = Math.round(Math.max(20, Math.min(80, ratio)))
        }),

      setPreviewRatio: (ratio) =>
        set((state) => {
          state.panelSizes.previewRatio = Math.round(Math.max(30, Math.min(80, ratio)))
        }),

      resetPanelSizes: () =>
        set((state) => {
          state.panelSizes = { ...DEFAULT_PREFERENCES.panelSizes }
        }),

      // Panel state actions
      setSidebarCollapsed: (collapsed) =>
        set((state) => {
          state.panelState.sidebarCollapsed = collapsed
        }),

      setActiveResourceTab: (tab) =>
        set((state) => {
          state.panelState.activeResourceTab = tab
        }),

      setToolsPanelOpen: (open) =>
        set((state) => {
          state.panelState.toolsPanelOpen = open
        }),

      setSkillsManagerOpen: (open) =>
        set((state) => {
          state.panelState.skillsManagerOpen = open
        }),

      setQuickActionsOpen: (open) =>
        set((state) => {
          state.panelState.quickActionsOpen = open
        }),

      // Display preferences actions
      setFontSize: (size) =>
        set((state) => {
          state.display.fontSize = size
        }),

      setShowLineNumbers: (show) =>
        set((state) => {
          state.display.showLineNumbers = show
        }),

      setWordWrap: (wrap) =>
        set((state) => {
          state.display.wordWrap = wrap
        }),

      setShowMiniMap: (show) =>
        set((state) => {
          state.display.showMiniMap = show
        }),

      // Recent files actions
      addRecentFile: (file) =>
        set((state) => {
          // Remove existing entry if present
          state.recentFiles = state.recentFiles.filter((f) => f.path !== file.path)
          // Add to beginning
          state.recentFiles.unshift(file)
          // Keep only 10 most recent
          if (state.recentFiles.length > 10) {
            state.recentFiles = state.recentFiles.slice(0, 10)
          }
        }),

      removeRecentFile: (path) =>
        set((state) => {
          state.recentFiles = state.recentFiles.filter((f) => f.path !== path)
        }),

      clearRecentFiles: () =>
        set((state) => {
          state.recentFiles = []
        }),

      // Onboarding actions
      setOnboardingCompleted: (completed) =>
        set((state) => {
          state.onboardingCompleted = completed
        }),

      // Agent mode actions
      setAgentMode: (mode) =>
        set((state) => {
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
          state.agentMode = mode
          if (workspaceId) {
            state.agentModeByWorkspace[workspaceId] = mode
          }
        }),

      syncAgentModeForWorkspace: (workspaceId) =>
        set((state) => {
          const hasMappedWorkspaceMode = workspaceId ? state.agentModeByWorkspace[workspaceId] !== undefined : false
          const hasLegacyGlobalModeOnly =
            Object.keys(state.agentModeByWorkspace).length === 0 &&
            state.agentMode !== DEFAULT_PREFERENCES.agentMode

          // One-time migration for users upgrading from global mode storage:
          // bind legacy mode to the first active workspace we observe.
          if (workspaceId && !hasMappedWorkspaceMode && hasLegacyGlobalModeOnly) {
            state.agentModeByWorkspace[workspaceId] = state.agentMode
          }

          state.agentMode = workspaceId
            ? state.agentModeByWorkspace[workspaceId] ?? DEFAULT_PREFERENCES.agentMode
            : DEFAULT_PREFERENCES.agentMode
        }),

      // Run completion application policy
      setAutoApplyOnRunComplete: (enabled) =>
        set((state) => {
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId
          state.autoApplyOnRunComplete = enabled
          if (workspaceId) {
            state.autoApplyOnRunCompleteByWorkspace[workspaceId] = enabled
          }
        }),

      syncAutoApplyOnRunCompleteForWorkspace: (workspaceId) =>
        set((state) => {
          state.autoApplyOnRunComplete = workspaceId
            ? state.autoApplyOnRunCompleteByWorkspace[workspaceId] ?? DEFAULT_PREFERENCES.autoApplyOnRunComplete
            : DEFAULT_PREFERENCES.autoApplyOnRunComplete
        }),

      // Pinned workspaces actions
      setPinnedWorkspaceIds: (ids) =>
        set((state) => {
          state.pinnedWorkspaceIds = ids
        }),

      // File preview mode actions
      setFilePreviewMode: (mode) =>
        set((state) => {
          state.filePreviewMode = mode
        }),

      // Quick-chip dismissal (image generation)
      setImageGenChipDismissed: (dismissed) =>
        set((state) => {
          state.imageGenChipDismissed = dismissed
        }),

      // Reset actions
      resetAll: () =>
        set((state) => {
          Object.assign(state, DEFAULT_PREFERENCES)
        }),

      resetToDefaults: () =>
        set((state) => {
          state.panelSizes = { ...DEFAULT_PREFERENCES.panelSizes }
          state.display = { ...DEFAULT_PREFERENCES.display }
        }),
    })),
    {
      name: 'bfosa-workspace-preferences',
      version: 7, // Bump version for completion auto-apply policy; v7: round panel sizes to integers
      partialize: (state) => ({
        panelSizes: state.panelSizes,
        panelState: state.panelState,
        display: state.display,
        recentFiles: state.recentFiles,
        onboardingCompleted: state.onboardingCompleted,
        agentMode: state.agentMode,
        agentModeByWorkspace: state.agentModeByWorkspace,
        autoApplyOnRunComplete: state.autoApplyOnRunComplete,
        autoApplyOnRunCompleteByWorkspace: state.autoApplyOnRunCompleteByWorkspace,
        pinnedWorkspaceIds: state.pinnedWorkspaceIds,
        filePreviewMode: state.filePreviewMode,
        imageGenChipDismissed: state.imageGenChipDismissed,
      }),
      migrate: (persistedState) => {
        const state = (persistedState || {}) as Partial<WorkspacePreferences>
        // v7: legacy drag gestures may have persisted fractional panel sizes — normalize to integers
        const panelSizes = state.panelSizes
          ? {
              sidebarWidth: Math.round(state.panelSizes.sidebarWidth),
              conversationRatio: Math.round(state.panelSizes.conversationRatio),
              previewRatio: Math.round(state.panelSizes.previewRatio),
            }
          : DEFAULT_PREFERENCES.panelSizes
        return {
          ...DEFAULT_PREFERENCES,
          ...state,
          panelSizes,
          agentModeByWorkspace: state.agentModeByWorkspace || {},
          autoApplyOnRunCompleteByWorkspace: state.autoApplyOnRunCompleteByWorkspace || {},
          autoApplyOnRunComplete: state.autoApplyOnRunComplete ?? DEFAULT_PREFERENCES.autoApplyOnRunComplete,
          pinnedWorkspaceIds: (state as Record<string, unknown>).pinnedWorkspaceIds as string[] || [],
          filePreviewMode: state.filePreviewMode || 'split',
        }
      },
    }
  )
)

// Export types
export type { WorkspacePreferencesState }

// =============================================================================
// Agent Mode helpers - workspace-aware mode management
// =============================================================================

/**
 * Get the current workspace's agent mode.
 * Reads from workspace store to get activeWorkspaceId.
 */
export function getCurrentWorkspaceAgentMode(): 'plan' | 'act' {
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const state = useWorkspacePreferencesStore.getState()
  if (!activeWorkspaceId) {
    return DEFAULT_PREFERENCES.agentMode
  }
  return state.agentModeByWorkspace[activeWorkspaceId] ?? DEFAULT_PREFERENCES.agentMode
}

/**
 * Set the current workspace's agent mode.
 * Reads from workspace store to identify the active workspace.
 */
export function setCurrentWorkspaceAgentMode(mode: 'plan' | 'act'): void {
  useWorkspacePreferencesStore.getState().setAgentMode(mode)
}

// Keep current UI mode in sync with active workspace changes.
// Lazy-init to avoid TDZ from circular dependency with workspace.store.ts:
// workspace-preferences.store → (static import) → workspace.store
// workspace.store → (dynamic import) → workspace-preferences.store
// If we eagerly subscribe at module load, useWorkspaceStore may not yet be initialized.
let workspaceModeSyncInitialized = false
function ensureWorkspaceModeSync() {
  if (workspaceModeSyncInitialized) return
  workspaceModeSyncInitialized = true

  useWorkspaceStore.subscribe((state, prevState) => {
    if (state.activeWorkspaceId === prevState.activeWorkspaceId) return
    const preferences = useWorkspacePreferencesStore.getState()
    preferences.syncAgentModeForWorkspace(state.activeWorkspaceId)
    preferences.syncAutoApplyOnRunCompleteForWorkspace(state.activeWorkspaceId)
  })

  const preferences = useWorkspacePreferencesStore.getState()
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
  preferences.syncAgentModeForWorkspace(activeWorkspaceId)
  preferences.syncAutoApplyOnRunCompleteForWorkspace(activeWorkspaceId)
}

// Defer sync setup to the next microtask so the module graph finishes
// initializing first. This breaks the synchronous TDZ reference.
queueMicrotask(() => ensureWorkspaceModeSync())
