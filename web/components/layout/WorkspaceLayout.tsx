/**
 * WorkspaceLayout - main layout for the AI workbench.
 *
 * Composes: TopBar + Sidebar + Main content (ConversationView | WelcomeScreen) + SyncPreviewPanel
 *
 * Preview panels use Drawer overlays:
 * - File preview opens as an overlay drawer (does not squeeze conversation)
 * - Sync preview opens as an overlay drawer
 * - ESC or close button dismisses the preview
 *
 * When user sends a message from WelcomeScreen:
 * 1. WelcomeScreen calls onStartConversation(text)
 * 2. WorkspaceLayout creates a new conversation, sets it active, stores pendingMessage
 * 3. React re-renders → ConversationView mounts with initialMessage prop
 * 4. ConversationView's useEffect picks up initialMessage and calls sendMessage()
 * 5. pendingMessage is cleared via onInitialMessageConsumed callback
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useConversationStore } from '@/store/conversation.store'
import { useFlowStore } from '@/store/flow.store'
import { useAgentStore } from '@/store/agent.store'
import { useProjectStore } from '@/store/project.store'
import { useSettingsStore } from '@/store/settings.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useMobile } from '@/components/mobile/useMobile'
import { useUnloadGuard } from '@/hooks/useUnloadGuard'
import { TopBar } from './TopBar'
import { Sidebar } from './Sidebar'
import { ConversationView } from '@/components/agent/ConversationView'
import { FilePreview } from '@/components/file-viewer/FilePreview'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { SyncPreviewPanel } from '@/components/sync'
import { SharedSyncDialogs } from '@/components/sync/SharedSyncDialogs'
import { Drawer } from '@/components/ui/drawer'
import { SkillsManager } from '@/components/skills/SkillsManager'
import { ToolsPanel, QuickActionsPanel } from '@/components/tools'
import { scanProjectSkills, syncResourcesToOPFS, syncProjectSkillsToActiveWorkspace } from '@/skills/skill-scanner'
import type { Skill, SkillResource } from '@/skills/skill-types'
import { getSkillManager } from '@/skills/skill-manager'
import { useSkillsStore } from '@/store/skills.store'
import {
  CommandPalette,
  KeyboardShortcutsHelp,
  RecentFilesPanel,
  GoToFileDialog,
  buildEnhancedCommands,
  type Command,
} from '@/components/workspace'
import { ExportPanel, useExport } from '@/components/export'
import { initializeTheme, useThemeStore } from '@/store/theme.store'
import { useExtensionStore } from '@/store/extension.store'
import { ExtensionBanner, ExtensionOutdatedBanner } from '@/components/extension'
import { MCPSettingsDialog } from '@/components/mcp'
import { SettingsDialog, type SettingsTab } from '@/components/settings/SettingsDialog'
import { useLocale, useT } from '@/i18n'
import { WebContainerPanel } from '@/components/webcontainer/WebContainerPanel'
import { useWebContainerStore } from '@/store/webcontainer.store'
import { getWorkspaceManager } from '@/opfs'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { getRuntimeHandlesForProject } from '@/native-fs/directory-handle-manager'

interface WorkspaceLayoutProps {
  onBackToProjects?: () => void
  projectName?: string
  conversationName?: string
  /** @deprecated use conversationName */
  workspaceName?: string
  /** Switch to a different project */
  onSwitchProject?: (projectId: string) => Promise<void>
  /** Open create-project dialog */
  onCreateProject?: () => void
  /** Navigate to project list */
  onManageProjects?: () => void
  /** Navigate to a workspace within the current project (updates URL) */
  onSelectWorkspace?: (workspaceId: string) => void
  /**
   * Replace the URL after a draft conversation is materialized (first message
   * sent from WelcomeScreen / bare project URL). Use router.replace so the
   * draft → conversation transition doesn't add a history entry.
   */
  onDraftConversationCreated?: (workspaceId: string) => void
  /** Enter draft state (bare project URL) without creating a conversation. */
  onNewDraft?: () => void
}

export function WorkspaceLayout({
  onBackToProjects,
  projectName,
  conversationName,
  workspaceName,
  onSwitchProject,
  onCreateProject,
  onManageProjects,
  onSelectWorkspace,
  onDraftConversationCreated,
  onNewDraft,
}: WorkspaceLayoutProps) {
  const waitForWorkspaceReady = useCallback(async (workspaceId: string, timeoutMs = 30000) => {
    const manager = await getWorkspaceManager()
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const workspace = await manager.getWorkspace(workspaceId)
      if (workspace) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }, [])

  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  // Only select what we need from conversations — avoids re-renders when
  // agent streaming updates change the conversations array reference.
  const hasActiveConversation = useConversationStore(
    (s) => !!s.activeConversationId && s.conversations.some((c) => c.id === s.activeConversationId),
  )
  const createNew = useConversationStore((s) => s.createNew)
  const setActive = useConversationStore((s) => s.setActive)
  const loaded = useConversationStore((s) => s.loaded)
  const loadFromDB = useConversationStore((s) => s.loadFromDB)
  const directoryHandle = useAgentStore((s) => s.directoryHandle)
  const roots = useFolderAccessStore((s) => s.roots)
  const activeProjectId = useProjectStore((s) => s.activeProjectId || null)
  const projectIsLoading = useProjectStore((s) => s.isLoading)
  // Snapshot workspace-store flags so we can gate on workspace readiness.
  // projectStore.setActiveProject briefly clears the workspace store
  // (PENDING_RESET_PATCH: workspaces=[], initialized=false) before
  // refreshWorkspaces repopulates it. Reading workspaceStore during that
  // window — as loadFromDB does when picking a fallback activeConversationId —
  // yields an empty workspaces array and would set activeConversationId=null,
  // briefly flashing WelcomeScreen on the conversation page. `workspaceReady`
  // mirrors the project-switch settled state: !projectIsLoading covers the
  // surrounding setActiveProject call, workspaceInitialized covers the inner
  // refreshWorkspaces. Both must hold before we trust workspaceStore for
  // either rendering or loading.
  const workspaceInitialized = useConversationContextStore((s) => s.initialized)
  // See note above on the workspace-store transient during project switches.
  // We deliberately don't require activeWorkspaceId/workspaces.length here:
  // an empty project (no workspaces yet) is a stable end-state, not a
  // transient — gating on it would leave such users stuck on the spinner.
  const workspaceReady = !projectIsLoading && workspaceInitialized

  // Stable key derived from active project + roots + manual scan trigger.
  // Prevents redundant scans on reference-only updates while still scanning
  // on project switch and explicit manual refresh.
  const prevScanKeyRef = useRef<string>('')
  const rootsKey = roots
    .map((r) => `${r.name}:${r.status}:${r.handle ? 'y' : 'n'}`)
    .join('|')
  const skillsScanVersion = useSkillsStore((s) => s.skillsScanVersion)
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const syncModelForWorkspace = useSettingsStore((s) => s.syncModelForWorkspace)
  const saveModelOverrideForWorkspace = useSettingsStore((s) => s.saveModelOverrideForWorkspace)
  // `showPreview` is a boolean state field controlling the sync preview drawer.
  // `showPreviewPanel` is the action that toggles it (used elsewhere).
  // Earlier the boolean was aliased to `showPreview`, which clashed with the
  // action name and caused a `TypeError: showPreview is not a function`.
  const isPreviewOpen = useConversationContextStore((state) => state.showPreview)
  const hidePreviewPanel = useConversationContextStore((state) => state.hidePreviewPanel)
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [selectedFileHandle, setSelectedFileHandle] = useState<FileSystemFileHandle | null>(null)
  const [selectedFileBlob, setSelectedFileBlob] = useState<Blob | null>(null)
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false)

  // Skills management state
  const [skillsManagerOpen, setSkillsManagerOpen] = useState(false)
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false)
  const [quickActionsOpen, setQuickActionsOpen] = useState(false)
  const skillsLoaded = useSkillsStore((s) => s.loaded) // Reactive state
  const loadSkills = useSkillsStore((s) => s.loadSkills)

  // Phase 4: Workspace preferences state (use selectors)
  const panelState = useWorkspacePreferencesStore((s) => s.panelState)
  const setSidebarCollapsed = useWorkspacePreferencesStore((s) => s.setSidebarCollapsed)
  const setActiveResourceTab = useWorkspacePreferencesStore((s) => s.setActiveResourceTab)
  const panelSizes = useWorkspacePreferencesStore((s) => s.panelSizes)
  const filePreviewMode = useWorkspacePreferencesStore((s) => s.filePreviewMode)
  const wordWrapEnabled = useWorkspacePreferencesStore((s) => s.display.wordWrap)
  const setWordWrap = useWorkspacePreferencesStore((s) => s.setWordWrap)

  // Phase 4: Dialog states
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('workspace-layout')
  const [showRecentFiles, setShowRecentFiles] = useState(false)
  const [showMcpSettings, setShowMcpSettings] = useState(false)
  const [showGoToFile, setShowGoToFile] = useState(false)
  // React to "open in preview" requests from sidebar/list rows
  // (e.g. PendingSyncPanel's preview button). `openInFilePreview()` in the
  // workspace store bumps `filePreviewRequestSeq` and writes the path to
  // `filePreviewRequestPath`. The seq counter guarantees this effect re-fires
  // even when the same path is requested twice in a row. Setting
  // `selectedFilePath` is enough to open the FilePreview drawer — its `open`
  // prop / split-mode `aside` both derive from it (see lines 924 & 959).
  const filePreviewRequestSeq = useConversationContextStore((s) => s.filePreviewRequestSeq)
  const filePreviewRequestPath = useConversationContextStore((s) => s.filePreviewRequestPath)
  useEffect(() => {
    if (filePreviewRequestSeq === 0) return
    if (!filePreviewRequestPath) return
    setSelectedFilePath(filePreviewRequestPath)
    setSelectedFileHandle(null)
    setSelectedFileBlob(null)
  }, [filePreviewRequestSeq, filePreviewRequestPath])
  /** Target file path (with rootName prefix) to reveal in file tree */
  const [revealTargetPath, setRevealTargetPath] = useState<string | null>(null)
  const isWebContainerPanelOpen = useWebContainerStore((s) => s.isPanelOpen)
  const closeWebContainerPanel = useWebContainerStore((s) => s.closePanel)
  const [locale] = useLocale()
  const t = useT()

  // Export panel state
  const {
    isExportPanelOpen: isExportOpen,
    exportData,
    exportFilename,
    closeExport: closeExportPanel,
  } = useExport()

  // Mobile sidebar state
  const isMobile = useMobile()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const activeConversationName = conversationName ?? workspaceName

  // Guard against accidental page close when there are unsaved changes or running agent loops
  useUnloadGuard()

  const handleStartConversation = useCallback(
    (text: string) => {
      const conv = createNew(text.slice(0, 30))
      setActive(conv.id)
      setPendingMessage(text)
      // Draft → real conversation: replace bare URL with canonical one
      onDraftConversationCreated?.(conv.id)
    },
    [createNew, setActive, onDraftConversationCreated]
  )

  const handleInitialMessageConsumed = useCallback(() => {
    setPendingMessage(null)
  }, [])

  // Skills management handlers
  const handleSkillsManagerOpen = useCallback(() => {
    setSkillsManagerOpen(true)
  }, [])

  // Phase 4: Initialize theme system on mount
  useEffect(() => {
    const cleanup = initializeTheme()
    return cleanup
  }, [])

  // Phase 4: Load conversations on mount (independent of Sidebar rendering).
  // Also re-run when `loadError` flips (null→error or error→null): a failed
  // load keeps `loaded=false`, which would otherwise never wake this effect
  // back up. Tying it to loadError lets a later store change (e.g. project
  // switch completing) reattempt the load instead of locking in an empty
  // sidebar. The `inflightLoadFromDB` guard inside loadFromDB prevents
  // overlapping calls.
  const loadError = useConversationStore((s) => s.loadError)
  useEffect(() => {
    // Don't load conversations while the workspace store is still settling.
    // syncFromRoute's project switch transiently clears workspaceStore
    // (workspaces=[], initialized=false) before refreshWorkspaces refills
    // it; loading during that window would set activeConversationId=null
    // and briefly render WelcomeScreen before the workspace list returns.
    // Gating on `workspaceReady` also covers the case where the previous
    // loadFromDB ran with an empty workspace list — when the store later
    // settles, this effect re-fires and retries.
    if (!loaded && workspaceReady) loadFromDB()
  }, [loaded, loadError, loadFromDB, workspaceReady])

  // Pre-initialize Pyodide runtime in the background so first Python execution is fast
  useEffect(() => {
    const trigger = () => {
      import('@/python/api').then(({ pythonExecutor }) => {
        pythonExecutor.warmup()
      }).catch(() => {
        // Warmup failure is non-fatal, ignore
      })
    }

    if ('requestIdleCallback' in window) {
      requestIdleCallback(trigger, { timeout: 10000 })
    } else {
      setTimeout(trigger, 5000)
    }
  }, [])

  // Sync workspace-specific model selection when switching workspace
  useEffect(() => {
    syncModelForWorkspace(activeConversationId ?? null)
  }, [activeConversationId, syncModelForWorkspace])

  // Persist current model selection for active workspace
  useEffect(() => {
    if (!activeConversationId) return
    saveModelOverrideForWorkspace(activeConversationId)
  }, [
    activeConversationId,
    providerType,
    modelName,
    saveModelOverrideForWorkspace,
  ])

  // Phase 4: Enhanced command palette commands
  const commands: Command[] = buildEnhancedCommands({
    // Conversations
    onNewConversation: () => {
      // Deferred creation: enter draft state (bare project URL). The
      // conversation is created only when the first message is sent
      // (handleStartConversation). If no draft callback was provided
      // (non-router usage), fall back to creating directly.
      if (onNewDraft) {
        onNewDraft()
      } else {
        const newConv = createNew('New conversation')
        onSelectWorkspace?.(newConv.id)
      }
    },
    onContinueLast: () => {
      const { conversations } = useConversationStore.getState()
      if (conversations.length === 0) return
      const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      const target = sorted.find((conv) => conv.id !== activeConversationId) || sorted[0]
      void setActive(target.id)
    },
    // Files
    onOpenFile: () => {
      setShowGoToFile(true)
    },
    onShowRecentFiles: () => setShowRecentFiles(true),

    // View
    onToggleSidebar: () => setSidebarCollapsed(!panelState.sidebarCollapsed),
    onToggleTheme: () => {
      const { mode, setTheme } = useThemeStore.getState()
      setTheme(mode === 'dark' ? 'light' : 'dark')
    },
    // Tools
    onOpenSkills: handleSkillsManagerOpen,
    onOpenTools: () => setToolsPanelOpen(true),
    onOpenMCP: () => {
      setShowMcpSettings(true)
    },
    // Settings & Help
    onOpenSettings: () => setShowWorkspaceSettings(true),
    onShowShortcuts: () => setShowShortcutsHelp(true),
  }, {
    t,
    enableLocalization: locale === 'zh-CN' || locale === 'en-US',
  })

  // Initialize skills on mount
  useEffect(() => {
    if (!skillsLoaded) {
      void loadSkills()
    }
  }, [skillsLoaded, loadSkills])

  // Scan project skills when roots change
  // Must wait for skillsLoaded to be true, otherwise cannot properly filter loaded skills
  useEffect(() => {
    // Read current project ID from store directly to avoid stale closure value.
    // The `activeProjectId` from the useProjectStore() selector is captured when
    // this effect is SCHEDULED (not when it runs), so it can be stale if roots
    // update asynchronously after setActiveProject().
    const currentProjectId = useProjectStore.getState().activeProjectId || null

    // Skip if the project has already switched away — this guards against the
    // race where roots change (e.g. async permission grant) after setActiveProject
    // but before the component re-renders with the new project ID.
    if (currentProjectId !== activeProjectId) {
      return
    }

    const manager = getSkillManager()

    // Collect handles from all roots that belong to the current project.
    // We filter by the runtime handle registry to avoid scanning roots from a
    // previous project that might still be in the store's `roots` array while
    // loadRoots() is asynchronously updating it after a project switch.
    const handlesToScan: Array<{ handle: FileSystemDirectoryHandle; rootName: string }> = []
    if (currentProjectId) {
      const projectHandles = getRuntimeHandlesForProject(currentProjectId)
      for (const root of roots) {
        if (root.handle && projectHandles.has(root.name)) {
          handlesToScan.push({ handle: root.handle, rootName: root.name })
        }
      }
    }

    if (handlesToScan.length === 0) {
      manager.clearProjectSkills()
      void loadSkills()
      return
    }
    if (!skillsLoaded) return

    const scanKey = `${currentProjectId ?? 'null'}::${rootsKey}::${skillsScanVersion}`
    // Skip scan when project+roots+manual-trigger key is unchanged
    if (prevScanKeyRef.current === scanKey) {
      return
    }
    prevScanKeyRef.current = scanKey

    const scanForSkills = async () => {
      try {
        // Prevent stale cross-project visibility while switching projects.
        manager.clearProjectSkills()
        await loadSkills()

        console.log(`[WorkspaceLayout] Scanning project skills across ${handlesToScan.length} root(s)...`)

        let allSkills: Skill[] = []
        let allResources: SkillResource[] = []
        let allErrors: string[] = []

        for (const { handle, rootName } of handlesToScan) {
          const result = await scanProjectSkills(handle)
          // Prefix skill IDs with root name for disambiguation, and keep
          // resources in sync with remapped skill IDs.
          const skillIdMap = new Map<string, string>()
          for (const skill of result.skills) {
            const oldId = skill.id
            const newId = `project:${rootName}:${oldId.replace('project:', '')}`
            skill.id = newId
            skillIdMap.set(oldId, newId)
          }

          const remappedResources = result.resources.map((resource) => {
            const mappedSkillId = skillIdMap.get(resource.skillId) ?? resource.skillId
            return {
              ...resource,
              skillId: mappedSkillId,
              id: `${mappedSkillId}:${resource.resourcePath}`,
            }
          })

          allSkills = allSkills.concat(result.skills)
          allResources = allResources.concat(remappedResources)
          allErrors = allErrors.concat(result.errors)
        }

        console.log(`[WorkspaceLayout] Scan result: ${allSkills.length} skills found`)
        if (allErrors.length > 0) {
          console.warn('[WorkspaceLayout] Scan errors:', allErrors)
        }

        if (allSkills.length > 0) {
          manager.setProjectSkills(allSkills, allResources, activeProjectId)
          await loadSkills()
        } else {
          manager.clearProjectSkills()
          await loadSkills()
          console.log(
            '[WorkspaceLayout] No project skills found (checked .claude/skills/ and .skills/)'
          )
        }

        // Sync skill resources to OPFS so Pyodide can access them at /mnt/.skills/
        await syncResourcesToOPFS({ skills: allSkills, resources: allResources, errors: allErrors })
        // Also sync .skills/ directories from all roots directly to OPFS
        if (activeConversationId) {
          const ready = await waitForWorkspaceReady(activeConversationId)
          if (ready) {
            for (const { handle, rootName } of handlesToScan) {
              await syncProjectSkillsToActiveWorkspace(handle, activeConversationId, rootName)
            }
          } else {
            console.warn(
              `[WorkspaceLayout] Workspace not ready for skill sync after timeout: ${activeConversationId}`
            )
          }
        }
      } catch (error) {
        console.error('Failed to scan project skills:', error)
      }
    }

    void scanForSkills()
  }, [roots, skillsLoaded, loadSkills, activeProjectId, activeConversationId, waitForWorkspaceReady, rootsKey, skillsScanVersion])

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K to open Command Palette (replaces Quick Actions)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowCommandPalette(true)
        return
      }

      // Cmd/Ctrl + P to toggle project switcher
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.shiftKey) {
        e.preventDefault()
        setProjectSwitcherOpen((prev) => !prev)
        return
      }

      // Cmd/Ctrl + G to open Go To File dialog
      if ((e.metaKey || e.ctrlKey) && e.key === 'g') {
        e.preventDefault()
        setShowGoToFile(true)
        return
      }

      // Cmd/Ctrl + B to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setSidebarCollapsed(!panelState.sidebarCollapsed)
        return
      }

      // Cmd/Ctrl + , to open workspace settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowWorkspaceSettings(true)
        return
      }

      // Cmd/Ctrl + / to toggle keyboard shortcuts help
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setShowShortcutsHelp((prev) => !prev)
        return
      }

      // Alt + Z to toggle word wrap. Match on e.code (physical key) so it
      // works on macOS too, where Alt+Z produces 'Ω' as e.key.
      if (e.altKey && e.code === 'KeyZ' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setWordWrap(!wordWrapEnabled)
        return
      }

      // ESC to close panels
      if (e.key === 'Escape') {
        if (showCommandPalette) {
          setShowCommandPalette(false)
        } else if (showGoToFile) {
          setShowGoToFile(false)
        } else if (showShortcutsHelp) {
          setShowShortcutsHelp(false)
        } else if (showWorkspaceSettings) {
          setShowWorkspaceSettings(false)
        } else if (showRecentFiles) {
          setShowRecentFiles(false)
        } else if (quickActionsOpen) {
          setQuickActionsOpen(false)
        } else if (toolsPanelOpen) {
          setToolsPanelOpen(false)
        } else if (skillsManagerOpen) {
          setSkillsManagerOpen(false)
        } else if (isWebContainerPanelOpen) {
          closeWebContainerPanel()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [
    showCommandPalette,
    showGoToFile,
    showShortcutsHelp,
    showWorkspaceSettings,
    showRecentFiles,
    quickActionsOpen,
    toolsPanelOpen,
    skillsManagerOpen,
    isWebContainerPanelOpen,
    selectedFilePath,
    panelState.sidebarCollapsed,
    setSidebarCollapsed,
    setActiveResourceTab,
    closeWebContainerPanel,
    wordWrapEnabled,
    setWordWrap,
  ])

  // hasActiveConversation is computed via store selector above (avoids re-renders)

  // Close preview panel (hide without clearing changes)
  const handleClosePreview = useCallback(() => {
    hidePreviewPanel()
  }, [hidePreviewPanel])

  // Handle file click - set selected file for drawer preview
  const handleSidebarFileSelect = useCallback((path: string, handle: FileSystemFileHandle | null) => {
    setSelectedFilePath(path)
    setSelectedFileHandle(handle)
    setSelectedFileBlob(null) // sidebar files are read via OPFS/disk
    if (isMobile) {
      setIsSidebarOpen(false)
    }
  }, [isMobile])

  // Handle element inspector from sidebar - open in new tab
  const handleElementInspect = useCallback(async (path: string, handle: FileSystemFileHandle | null) => {
    try {
      let content: string
      if (handle) {
        // Read from disk file handle
        const file = await handle.getFile()
        content = await file.text()
      } else {
        // Read from OPFS for pending create files
        const opfs = (await import('@/store/opfs.store')).useOPFSStore.getState()
        const result = await opfs.readFile(path)
        if (typeof result.content === 'string') {
          content = result.content
        } else if (result.content instanceof Blob) {
          content = await result.content.text()
        } else {
          const decoder = new TextDecoder()
          content = decoder.decode(result.content as ArrayBuffer)
        }
      }
      // Save to localStorage
      localStorage.setItem('preview-content-' + path, content)
      // Open in new tab
      window.open(`/preview?path=${encodeURIComponent(path)}`, '_blank')
    } catch (err) {
      console.error('[WorkspaceLayout] Failed to open inspector:', err)
    }
  }, [])

  // Close file preview drawer
  const handleCloseFilePreview = useCallback(() => {
    setSelectedFilePath(null)
    setSelectedFileHandle(null)
    setSelectedFileBlob(null)
  }, [])

  // Handle asset preview from AssetsPopover — opens the FilePreview drawer with a pre-loaded blob
  const handleAssetPreview = useCallback((fileName: string, blob: Blob) => {
    setSelectedFilePath(fileName)
    setSelectedFileHandle(null)
    setSelectedFileBlob(blob)
  }, [])

  // ── Resizable file preview pane (split mode) ───────────────────────────
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const setPreviewRatio = useWorkspacePreferencesStore((s) => s.setPreviewRatio)
  // Holds the cleanup function for an in-progress drag, so that unmount
  // mid-drag can still remove the global listeners and restore body styles.
  const dragCleanupRef = useRef<(() => void) | null>(null)

  // Live preview width during drag (visual feedback before committing to store).
  // Also serves as the "is dragging" signal: non-null = dragging.
  const [dragPreviewWidth, setDragPreviewWidth] = useState<number | null>(null)
  // Mirror of `dragPreviewWidth` so the drag cleanup can read the final value
  // synchronously without abusing the setState updater as a side-effect carrier.
  // Reading via the ref avoids React invoking an updater with side effects
  // during the render phase (which would trigger a "setState during render"
  // error in any sibling store consumer like Sidebar).
  const dragPreviewWidthRef = useRef<number | null>(null)

  const startPreviewResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const container = splitContainerRef.current
      if (!container) return

      const onMove = (ev: MouseEvent) => {
        if (!container) return
        const rect = container.getBoundingClientRect()
        if (rect.width === 0) return
        const previewWidth = rect.right - ev.clientX
        const percent = (previewWidth / rect.width) * 100
        // Clamp locally during drag for smooth visual feedback
        const clamped = Math.max(30, Math.min(80, percent))
        dragPreviewWidthRef.current = clamped
        setDragPreviewWidth(clamped)
      }
      const cleanup = () => {
        // Commit final ratio to store BEFORE clearing local drag state.
        // The ref lets us read the value synchronously and call the Zustand
        // action directly, instead of nesting it inside a setState updater
        // (which React invokes during render and would schedule a Sidebar
        // re-render while WorkspaceLayout is still rendering).
        const finalPercent = dragPreviewWidthRef.current
        if (finalPercent != null) setPreviewRatio(finalPercent)
        dragPreviewWidthRef.current = null
        setDragPreviewWidth(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        dragCleanupRef.current = null
      }
      const onUp = cleanup
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      dragCleanupRef.current = cleanup
    },
    [setPreviewRatio]
  )

  // Clean up global drag listeners on unmount
  useEffect(() => {
    return () => {
      if (dragCleanupRef.current) dragCleanupRef.current()
    }
  }, [])

  // Handle "go to file" selection from GoToFileDialog
  const handleGoToFileSelect = useCallback(
    (fullPath: string) => {
      // Determine which root this file belongs to
      // fullPath format: "rootName/relative/path/to/file.ts" or just "path/to/file.ts"
      let relativePath: string | null = null

      for (const root of roots) {
        if (fullPath.startsWith(`${root.name}/`)) {
          relativePath = fullPath.slice(root.name.length + 1)
          break
        }
      }

      // If no root matched, skip — the path doesn't belong to any known root
      if (relativePath === null) {
        console.warn('[WorkspaceLayout] GoToFile: path does not match any root:', fullPath)
        return
      }

      // Ensure sidebar is open and files tab is active
      setSidebarCollapsed(false)
      setActiveResourceTab('files')

      // Set reveal target for the file tree (relative path without root prefix)
      setRevealTargetPath(relativePath)

      // Also set the selected file path for preview
      setSelectedFilePath(fullPath)
      setSelectedFileHandle(null) // Will be resolved by the tree reveal
    },
    [roots, setSidebarCollapsed, setActiveResourceTab]
  )

  // Handle reveal complete callback from FileTreePanel
  const handleRevealComplete = useCallback(() => {
    setRevealTargetPath(null)
  }, [])

  return (
    <div className="flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-white dark:bg-neutral-950">
      {/* Header */}
      <TopBar
        onSkillsManagerOpen={handleSkillsManagerOpen}
        onToolsPanelOpen={() => setToolsPanelOpen(true)}
        onCommandPaletteOpen={() => setShowCommandPalette(true)}
        onBackToProjects={onBackToProjects}
        activeProjectName={projectName}
        activeConversationName={activeConversationName}
        onMenuOpen={() => setIsSidebarOpen((prev) => !prev)}
        isMobile={isMobile}
        onSwitchProject={onSwitchProject}
        onCreateProject={onCreateProject}
        onManageProjects={onManageProjects}
        projectSwitcherOpen={projectSwitcherOpen}
        onProjectSwitcherOpenChange={setProjectSwitcherOpen}
        onSelectWorkspace={onSelectWorkspace}
        onWorkflowOpen={() => useFlowStore.getState().setPanelOpen(true)}
        onNewConversation={() => {
          const newConv = createNew('New conversation')
          onSelectWorkspace?.(newConv.id)
        }}
      />

      {/* Extension install banner — opens guide dialog via store */}
      <ExtensionBanner onInstallClick={() => useExtensionStore.getState().openInstallGuide()} />

      {/* Extension outdated banner — shown when installed version is behind latest */}
      <ExtensionOutdatedBanner />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Mobile sidebar overlay */}
        {isMobile && isSidebarOpen && (
          <div
            className="absolute inset-0 z-40 bg-black/45"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* Sidebar - desktop inline, mobile drawer */}
        {!isMobile && (
          <Sidebar
            onFileSelect={handleSidebarFileSelect}
            onInspect={handleElementInspect}
            selectedFilePath={selectedFilePath}
            revealTargetPath={revealTargetPath}
            onRevealComplete={handleRevealComplete}
            onSelectWorkspace={onSelectWorkspace}
            onNewDraft={onNewDraft}
          />
        )}
        {isMobile && isSidebarOpen && (
          <div className="absolute inset-y-0 left-0 z-50 w-[min(80vw,300px)] border-r border-border bg-background shadow-2xl dark:bg-card">
            <Sidebar
              isMobile
              onRequestClose={() => setIsSidebarOpen(false)}
              onFileSelect={handleSidebarFileSelect}
              onInspect={handleElementInspect}
              selectedFilePath={selectedFilePath}
              revealTargetPath={revealTargetPath}
              onRevealComplete={handleRevealComplete}
              onSelectWorkspace={onSelectWorkspace}
              onNewDraft={onNewDraft}
            />
          </div>
        )}

        {/* Main area: conversation + optional sync preview panel */}
        <div ref={splitContainerRef} className="flex min-w-0 flex-1 overflow-hidden">
          {/* Conversation / Welcome */}
          <main id="main-content" className="min-w-0 flex-1 overflow-hidden">
            {!loaded || !workspaceReady ? (
              // Do not mount WelcomeScreen until BOTH persisted conversations
              // have loaded AND the workspace store has settled. Without the
              // second condition, syncFromRoute's project switch can clear
              // workspaceStore.workspaces=[] (before refreshWorkspaces refills
              // it), causing loadFromDB to read an empty list and set
              // activeConversationId=null — which would briefly flash
              // WelcomeScreen on a conversation page that should land directly
              // on ConversationView.
              <div
                role="status"
                aria-live="polite"
                aria-label={t('common.loading')}
                className="flex h-full min-h-0 w-full items-center justify-center bg-background dark:bg-neutral-950"
              >
                <div
                  className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-primary-600 dark:border-neutral-700 dark:border-t-primary-500"
                />
                <span className="sr-only">{t('common.loading')}</span>
              </div>
            ) : hasActiveConversation ? (
              <ConversationView
                initialMessage={pendingMessage}
                onInitialMessageConsumed={handleInitialMessageConsumed}
                onPreviewAsset={handleAssetPreview}
              />
            ) : (
              <div className="relative h-full min-h-0 w-full overflow-hidden">
                <WelcomeScreen
                  onStartConversation={handleStartConversation}
                  onOpenSettings={(tab) => {
                    if (tab) setSettingsInitialTab(tab)
                    setShowWorkspaceSettings(true)
                  }}
                />
              </div>
            )}
          </main>

          {/* File preview — split (side-by-side) or overlay (drawer) mode */}
          {filePreviewMode === 'split' && !isMobile && selectedFilePath ? (
            <>
              {/* Draggable resize handle */}
              <div
                onMouseDown={startPreviewResize}
                className="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors"
                title=""
              >
                {/* Wider hit area */}
                <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
                {/* Visible divider line on hover/drag */}
                <div
                  className={`absolute inset-y-0 left-0 w-px transition-colors ${
                    dragPreviewWidth !== null ? 'bg-blue-500' : 'bg-neutral-200 group-hover:bg-blue-400 dark:bg-neutral-700'
                  }`}
                />
              </div>
              <aside
                className="h-full shrink-0 overflow-hidden"
                style={{
                  width: `${dragPreviewWidth ?? panelSizes.previewRatio}%`,
                  minWidth: 280,
                  maxWidth: '80%',
                }}
              >
                <FilePreview
                  filePath={selectedFilePath}
                  fileHandle={selectedFileHandle}
                  onClose={handleCloseFilePreview}
                  blob={selectedFileBlob}
                />
              </aside>
            </>
          ) : (
            <Drawer
              open={!!selectedFilePath}
              onClose={handleCloseFilePreview}
              width={isMobile ? '100vw' : `${panelSizes.previewRatio}vw`}
            >
              <FilePreview
                filePath={selectedFilePath}
                fileHandle={selectedFileHandle}
                onClose={handleCloseFilePreview}
                blob={selectedFileBlob}
              />
            </Drawer>
          )}

          {/* Sync preview as Drawer (overlay, no squeeze) */}
          <Drawer
            open={isPreviewOpen}
            onClose={handleClosePreview}
            title={t('settings.syncPanel.syncPreview.emptyStateTitle')}
            width={isMobile ? '100vw' : '85vw'}
          >
            <SyncPreviewPanel onCancel={handleClosePreview} />
          </Drawer>

          {/* Shared sync dialogs (approval + conflict) — rendered ONCE here.
              Both PendingSyncPanel (sidebar) and SyncPreviewPanel (drawer)
              trigger the flow via the shared sync-dialog store. */}
          <SharedSyncDialogs />
        </div>
      </div>

      {/* Skills Manager Dialog */}
      <SkillsManager
        open={skillsManagerOpen}
        onClose={() => setSkillsManagerOpen(false)}
        directoryHandle={directoryHandle}
        roots={roots
          .filter((r) => r.handle)
          .map((r) => ({ name: r.name, handle: r.handle! }))}
      />

      {/* Tools Panel */}
      <ToolsPanel isOpen={toolsPanelOpen} onClose={() => setToolsPanelOpen(false)} />

      {/* Quick Actions Panel */}
      <QuickActionsPanel
        isOpen={quickActionsOpen}
        onClose={() => setQuickActionsOpen(false)}
        onStartConversation={handleStartConversation}
      />

      {/* Phase 4: Command Palette */}
      <CommandPalette
        open={showCommandPalette}
        onOpenChange={setShowCommandPalette}
        commands={commands}
      />

      {/* Go To File Dialog */}
      <GoToFileDialog
        open={showGoToFile}
        onClose={() => setShowGoToFile(false)}
        onSelectFile={handleGoToFileSelect}
      />

      {/* Phase 4: Keyboard Shortcuts Help */}
      <KeyboardShortcutsHelp
        open={showShortcutsHelp}
        onOpenChange={() => setShowShortcutsHelp(false)}
      />

      {/* Unified Settings Dialog — replaces the old WorkspaceSettingsDialog.
          Workspace settings (layout/editor/shortcuts/data) are now tabs inside. */}
      <SettingsDialog
        open={showWorkspaceSettings}
        onOpenChange={() => setShowWorkspaceSettings(false)}
        initialTab={settingsInitialTab}
      />

      {/* Phase 4: Recent Files Panel */}
      {showRecentFiles && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowRecentFiles(false)}
        >
          <div className="h-[60vh] w-[400px]" onClick={(e) => e.stopPropagation()}>
            <RecentFilesPanel
              onFileSelect={(path) => {
                setShowRecentFiles(false)
                // Find and select file — CSS.escape prevents injection via path
                const file = document.querySelector(`[data-file-path="${CSS.escape(path)}"]`) as HTMLElement
                file?.click()
              }}
            />
          </div>
        </div>
      )}

      {/* Export Panel */}
      {isExportOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={closeExportPanel}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ExportPanel
              data={exportData}
              defaultFilename={exportFilename}
              onExportComplete={(result) => {
                console.log('[WorkspaceLayout] Export completed:', result)
                closeExportPanel()
              }}
              onClose={closeExportPanel}
            />
          </div>
        </div>
      )}

      <MCPSettingsDialog open={showMcpSettings} onOpenChange={setShowMcpSettings} />
      <WebContainerPanel isOpen={isWebContainerPanelOpen} onClose={closeWebContainerPanel} />
    </div>
  )
}

export default WorkspaceLayout
