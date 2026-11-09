/**
 * Sidebar - unified sidebar with conversation list + resource tabs.
 *
 * Design Specifications (Brand System):
 * - Colors: Uses brand semantic colors (primary, secondary, tertiary, etc.)
 * - Borders: border-subtle instead of border-neutral-200
 * - Buttons: BrandButton component with appropriate variants
 * - Spacing: Consistent with brand design tokens
 *
 * Top: Conversation list (always visible)
 * Bottom: Resource tabs (Files/Plugins/Changes) - visible when a folder is selected
 * Draggable divider between them for height adjustment.
 *
 * File preview is handled by WorkspaceLayout (push-squeeze panel in main area).
 */

import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useRouter } from 'next/navigation'
import { BrushCleaningIcon } from '@/components/icons/BrushCleaningIcon'
import { PanelLeftClose, PanelLeft, Download, ChevronDown } from 'lucide-react'
import {
  BrandButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@creatorweave/ui'
import { useConversationStore } from '@/store/conversation.store'
import { useScheduleStore } from '@/store/schedule.store'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useWorkspaceStore } from '@/store/workspace.store'
import { useProjectStore } from '@/store/project.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { useT } from '@/i18n'
import { ExportConversationDialog } from '@/components/conversation/ExportConversationDialog'
import { BatchExportDialog } from '@/components/conversation/BatchExportDialog'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { ResourceTabPanel, type ResourceTab } from './sidebar/ResourceTabPanel'
import { ConversationList } from './sidebar/ConversationList'
import { SidebarDialogs } from './sidebar/SidebarDialogs'
import { useConversationActions } from './sidebar/useConversationActions'
import { useFileActions } from './sidebar/useFileActions'

const MIN_CONVERSATION_RATIO = 20 // minimum percentage
const MAX_CONVERSATION_RATIO = 80 // maximum percentage

interface SidebarProps {
  /** Called when user clicks a file in the tree */
  onFileSelect?: (path: string, handle: FileSystemFileHandle | null) => void
  /** Called when user clicks element inspector on a file */
  onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
  /** Currently selected file path (for highlight in tree) */
  selectedFilePath?: string | null
  /** Whether sidebar is rendered in mobile mode */
  isMobile?: boolean
  /** Direct conversations have no folder semantics — hide the file/pending/snapshot tabs */
  hideProjectResources?: boolean
  /** Request parent to close mobile sidebar */
  onRequestClose?: () => void
  /** Target file path to reveal in tree (relative path without root prefix) */
  revealTargetPath?: string | null
  /** Called when reveal has been processed */
  onRevealComplete?: () => void
  /** Called when user selects a workspace from the sidebar. Should navigate URL. */
  onSelectWorkspace?: (workspaceId: string) => void
  /** Create a new conversation immediately (persisted) and navigate to it. */
  onCreateConversation?: () => void
}

export const Sidebar = memo(function Sidebar({
  onFileSelect,
  onInspect,
  selectedFilePath,
  isMobile = false,
  hideProjectResources = false,
  onRequestClose,
  revealTargetPath,
  onRevealComplete,
  onSelectWorkspace,
  onCreateConversation,
}: SidebarProps) {
  const t = useT()
  const router = useRouter()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Use selectors to avoid re-rendering on every streaming delta.
  // Sidebar only needs id/title for the list — not streamingContent/toolCalls/etc.
  // NOTE: intentionally exclude updatedAt — cancelAgent writes updatedAt which would
  // cause unnecessary re-renders of the entire Sidebar (including buttons).
  // useShallow ensures stable references when the extracted values haven't changed.
  const conversationListItems = useConversationStore(
    useShallow((s) =>
      s.conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind }))
    )
  )

  // Subscribe to runtime store for running status — this ensures Sidebar
  // re-renders when agent status changes (idle → pending → streaming → idle),
  // without subscribing to high-frequency streaming deltas.
  const runningConversationIds = useConversationRuntimeStore(
    useShallow((s) => {
      const running: string[] = []
      s.runtimes.forEach((rt, id) => {
        if (rt.status !== 'idle' && rt.status !== 'error') {
          running.push(id)
        }
      })
      return running
    })
  )
  const runningSet = useMemo(() => new Set(runningConversationIds), [runningConversationIds])

  // Multi-root: get all roots from folder-access store
  const roots = useFolderAccessStore((state) => state.roots)
  // Pure-OPFS mode: when no native directory is mounted, render a virtual
  // "OPFS drafts" root so the file panel is always visible (with an empty
  // state if no files have been written yet). Files written by the LLM land
  // here directly, bypassing the pending/approval workflow.
  // NOTE: we intentionally do NOT consult `hasDirectoryHandle` here — that
  // boolean can be stale (set true by a previous grant, never cleared after
  // the user removes the root). `roots.length` from folder-access.store is
  // the authoritative source of truth for "is a native dir mounted right now".
  const displayRoots = useMemo(() => {
    if (roots.length > 0) return roots
    return [
      { id: '__opfs__', name: t('fileTree.opfsDraftRoot'), handle: null as FileSystemDirectoryHandle | null },
    ]
  }, [roots, t])
  const workspaceStats = useConversationContextStore((state) => state.workspaces)
  // Extract lastAccessedAt as a stable map — avoids re-sorting when other workspace fields
  // (e.g. pendingCount) change frequently during parallel streaming.
  const lastAccessedAtMap = useConversationContextStore(
    useShallow((s) => {
      const map = new Map<string, number>()
      for (const w of s.workspaces) {
        if (w.lastAccessedAt) map.set(w.id, w.lastAccessedAt)
      }
      return map
    })
  )
  const activeWorkspaceId = useConversationContextStore((state) => state.activeWorkspaceId)
  const workspaceIds = workspaceStats.map((w) => w.id)
  const currentPendingCount = useConversationContextStore((state) => state.currentPendingCount)
  const scopedWorkspaceIdSet = useMemo(() => new Set(workspaceIds), [workspaceIds])
  // The shared sidebar always renders PROJECT conversation rows (its links
  // are projectWorkspacePath-based). Standalone (kind='direct') chats live in
  // the /chats space and are rejected by that route sync, so they never
  // appear here regardless of which workspace hosts them.
  const scopedConversations = useMemo(
    () => conversationListItems.filter(
      (conv) => conv.kind !== 'direct' && (scopedWorkspaceIdSet.has(conv.id) || conv.id === activeWorkspaceId)
    ),
    [conversationListItems, scopedWorkspaceIdSet, activeWorkspaceId]
  )
  const pendingCountByConversationId = useMemo(() => {
    const map = new Map<string, number>()
    for (const ws of workspaceStats) {
      map.set(ws.id, ws.pendingCount || 0)
    }
    return map
  }, [workspaceStats])
  const workspaceStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const ws of workspaceStats) {
      map.set(ws.id, ws.status || 'active')
    }
    return map
  }, [workspaceStats])

  // Sidebar state — read layout preferences from store (use selectors)
  const panelSizes = useWorkspacePreferencesStore((s) => s.panelSizes)
  const storePanelState = useWorkspacePreferencesStore((s) => s.panelState)
  const setSidebarWidth = useWorkspacePreferencesStore((s) => s.setSidebarWidth)
  const setConversationRatio = useWorkspacePreferencesStore((s) => s.setConversationRatio)
  const setSidebarCollapsed = useWorkspacePreferencesStore((s) => s.setSidebarCollapsed)

  const [collapsed, setCollapsed] = useState(storePanelState.sidebarCollapsed)
  const width = panelSizes.sidebarWidth
  const [resourceTab, setResourceTab] = useState<ResourceTab>('files')
  const [workspaceTab, setWorkspaceTab] = useState<'active' | 'archived'>('active')
  const reduceMotion = useReducedMotion()

  // Pin state from workspace store
  const pinnedIds = useWorkspaceStore((state) => state.pinnedWorkspaceIds)

  const displayedConversations = useMemo(
    () => {
      const filtered = scopedConversations.filter((conv) => {
        const status = workspaceStatusMap.get(conv.id) || 'active'
        return workspaceTab === 'active' ? status !== 'archived' : status === 'archived'
      })
      // Sort: pinned items in pin order, unpinned by lastAccessedAt desc.
      // Pinned order is positional (from pinnedIds), so a lastAccessedAt
      // touch during refresh cannot reorder pinned items.
      const pinnedOrder = new Map<string, number>()
      pinnedIds.forEach((id, index) => pinnedOrder.set(id, index))
      const pinnedSet = new Set(pinnedIds)
      return [...filtered].sort((a, b) => {
        const aPinned = pinnedSet.has(a.id)
        const bPinned = pinnedSet.has(b.id)
        if (aPinned && bPinned) {
          return (pinnedOrder.get(a.id) ?? 0) - (pinnedOrder.get(b.id) ?? 0)
        }
        if (aPinned) return -1
        if (bPinned) return 1
        return (lastAccessedAtMap.get(b.id) ?? 0) - (lastAccessedAtMap.get(a.id) ?? 0)
      })
    },
    [scopedConversations, workspaceTab, workspaceStatusMap, pinnedIds, lastAccessedAtMap]
  )
  const archivedCount = useMemo(
    () => scopedConversations.filter((conv) => workspaceStatusMap.get(conv.id) === 'archived').length,
    [scopedConversations, workspaceStatusMap]
  )
  const activeCount = useMemo(
    () => scopedConversations.length - archivedCount,
    [scopedConversations.length, archivedCount]
  )

  // Schedule badges: subscribe to workspaceScheduleCount map (only re-renders when counts change)
  const workspaceScheduleCount = useScheduleStore((s) => s.workspaceScheduleCount)
  const scopedConversationIds = useMemo(() => scopedConversations.map((conv) => conv.id), [scopedConversations])
  const conversationRatio = panelSizes.conversationRatio

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      onRequestClose?.()
    }
  }, [isMobile, onRequestClose])

  // Conversation row state machine (rename / pin / export / archive / delete /
  // generate-title) and the conversation dialogs' state.
  const conversationActions = useConversationActions({
    t,
    router,
    activeProjectId,
    scopedConversations,
    scopedConversationIds,
    closeMobileSidebar,
    onSelectWorkspace,
  })
  // File-tree delete confirmation state machine.
  const fileActions = useFileActions({ t, activeProjectId })

  const {
    setClearConversationsDialogOpen,
    clearingConversations,
    exportConvId,
    setExportConvId,
    batchExportOpen,
    setBatchExportOpen,
  } = conversationActions

  // Drag sidebar width (horizontal)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // Drag conversation ratio (vertical)
  const verticalDragRef = useRef<{
    startY: number
    startRatio: number
    containerHeight: number
  } | null>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isMobile && collapsed) {
      setCollapsed(false)
    }
  }, [isMobile, collapsed])

  // Refresh pending changes when switching to pending tab
  const refreshPending = useCallback(async () => {
    const { refreshPendingChanges } = useConversationContextStore.getState()
    await refreshPendingChanges()
  }, [])

  const handleFileSelect = useCallback(
    (path: string, handle: FileSystemFileHandle | null) => {
      onFileSelect?.(path, handle)
      closeMobileSidebar()
    },
    [onFileSelect, closeMobileSidebar]
  )

  // Horizontal drag (sidebar width)
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startWidth = width
      dragRef.current = { startX: e.clientX, startWidth }

      const handleMove = (me: MouseEvent) => {
        if (!dragRef.current) return
        const delta = me.clientX - dragRef.current.startX
        const newWidth = Math.max(200, Math.min(400, dragRef.current.startWidth + delta))
        setSidebarWidth(newWidth)
      }

      const handleUp = () => {
        dragRef.current = null
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [width, setSidebarWidth]
  )

  // Vertical drag (conversation/resource split)
  const handleVerticalDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const containerHeight = sidebarRef.current?.offsetHeight || 0
      if (containerHeight === 0) return

      verticalDragRef.current = {
        startY: e.clientY,
        startRatio: conversationRatio,
        containerHeight,
      }

      const handleMove = (me: MouseEvent) => {
        if (!verticalDragRef.current) return
        const delta = me.clientY - verticalDragRef.current.startY
        const deltaPercent = (delta / verticalDragRef.current.containerHeight) * 100
        let newRatio = verticalDragRef.current.startRatio + deltaPercent

        // Constrain to min/max values
        newRatio = Math.max(MIN_CONVERSATION_RATIO, Math.min(MAX_CONVERSATION_RATIO, newRatio))
        setConversationRatio(newRatio)
      }

      const handleUp = () => {
        verticalDragRef.current = null
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    },
    [conversationRatio, setConversationRatio]
  )

  // The route owner owns navigation (URL params are the source of truth,
  // notably during project switches); the sidebar only closes itself.
  const handleCreateNewWorkspace = useCallback(() => {
    onCreateConversation?.()
    closeMobileSidebar()
  }, [onCreateConversation, closeMobileSidebar])

  // Collapsed state — sync local state with store
  useEffect(() => {
    setCollapsed(storePanelState.sidebarCollapsed)
  }, [storePanelState.sidebarCollapsed])

  const handleSetCollapsed = useCallback((value: boolean) => {
    setCollapsed(value)
    setSidebarCollapsed(value)
  }, [setSidebarCollapsed])

  // collapsed sidebar view — single container with animated width
  return (
    <>
      <motion.div
        ref={sidebarRef}
        animate={{ width: isMobile ? undefined : (collapsed ? 40 : (panelSizes.sidebarWidth || 280)) }}
        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
        className={`border-subtle bg-background flex shrink-0 flex-col overflow-hidden border-r dark:bg-card ${
          isMobile ? 'h-full max-w-full' : ''
        }`}
      >
        {/* Collapsed: expand button only */}
        {collapsed && (
          <div className="flex items-center justify-center py-1">
            <BrandButton
              iconButton
              variant="ghost"
              onClick={() => handleSetCollapsed(false)}
              title={t('sidebar.expandSidebar')}
            >
              <PanelLeft className="h-4 w-4" />
            </BrandButton>
          </div>
        )}

        {!collapsed && <>
        {/* Collapse button */}
        <div className="border-subtle flex h-10 items-center justify-between border-b bg-white px-2 dark:bg-card">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-semibold text-secondary outline-none transition-colors hover:bg-transparent focus-visible:ring-0"
                aria-label={`${t('sidebar.workspace')} (${workspaceTab === 'active' ? activeCount : archivedCount})`}
              >
                <span>
                  {t('sidebar.workspace')}
                  <span className="ml-1 font-normal text-muted-foreground">
                    {workspaceTab === 'active' ? activeCount : archivedCount}
                  </span>
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-tertiary" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44 rounded-xl p-2">
              <DropdownMenuItem
                onSelect={() => setWorkspaceTab('active')}
                className={workspaceTab === 'active' ? 'bg-muted font-medium text-secondary' : ''}
              >
                {t('sidebar.activeTab')}
                <span className="ml-auto text-tertiary">{activeCount}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setWorkspaceTab('archived')}
                className={workspaceTab === 'archived' ? 'bg-muted font-medium text-secondary' : ''}
              >
                {t('sidebar.archivedTab')}
                <span className="ml-auto text-tertiary">{archivedCount}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex items-center gap-1">
            <BrandButton
              iconButton
              variant="ghost"
              className="h-6 w-6"
              onClick={() => setBatchExportOpen(true)}
              title={t('conversation.batchExport.title')}
            >
              <Download className="h-3 w-3" />
            </BrandButton>
            <BrandButton
              iconButton
              variant="ghost"
              className="h-6 w-6"
              disabled={scopedConversationIds.length === 0 || clearingConversations}
              onClick={() => setClearConversationsDialogOpen(true)}
              title={t('sidebar.clearWorkspace')}
            >
              <BrushCleaningIcon className="h-3 w-3" />
            </BrandButton>
            <BrandButton
              iconButton
              variant="ghost"
              className="h-6 w-6"
              onClick={() => {
                if (isMobile) {
                  onRequestClose?.()
                  return
                }
                handleSetCollapsed(true)
              }}
              title={isMobile ? t('sidebar.closeSidebar') : t('sidebar.collapseSidebar')}
            >
              <PanelLeftClose className="h-3 w-3" />
            </BrandButton>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Conversation list */}
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/25"
            style={hideProjectResources ? undefined : { height: `${conversationRatio}%` }}
          >
          <ConversationList
            conversations={displayedConversations}
            showNewWorkspace={workspaceTab === 'active'}
            onCreateNewWorkspace={handleCreateNewWorkspace}
            activeProjectId={activeProjectId}
            activeWorkspaceId={activeWorkspaceId}
            runningSet={runningSet}
            pendingCountByConversationId={pendingCountByConversationId}
            workspaceStatusMap={workspaceStatusMap}
            pinnedIds={pinnedIds}
            workspaceScheduleCount={workspaceScheduleCount}
            reduceMotion={reduceMotion}
            actions={conversationActions}
            t={t}
          />
          </div>

          {/* Vertical drag divider */}
          {!isMobile && (
            <div
              className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-neutral-50/50 transition-colors hover:bg-neutral-100/80 dark:bg-muted dark:hover:bg-muted"
              onMouseDown={handleVerticalDragStart}
              title={t('sidebar.dragToResizeHeight')}
            >
              {/* center dot */}
              <div className="group-hover:bg-primary-500 h-1 w-1 rounded-full bg-neutral-300 transition-colors" />
            </div>
          )}

          {/* Resource tabs — memoized to avoid re-render during streaming.
              Direct conversations have no folder semantics: the file tree,
              pending-changes and snapshot panels are hidden entirely. */}
          {!hideProjectResources && (
          <div className="min-h-0 overflow-hidden" style={{ height: `${100 - conversationRatio}%` }}>
            <ResourceTabPanel
              resourceTab={resourceTab}
              onTabChange={setResourceTab}
              roots={displayRoots}
              selectedFilePath={selectedFilePath}
              revealTargetPath={revealTargetPath}
              rootsLength={displayRoots.length}
              onFileSelect={handleFileSelect}
              onInspect={onInspect}
              onFileDelete={fileActions.handleFileDelete}
              onRevealComplete={onRevealComplete}
              currentPendingCount={currentPendingCount}
              refreshPending={refreshPending}
              activeProjectId={activeProjectId}
              t={t}
            />
          </div>
          )}
        </div>
        </>}
      </motion.div>

      <SidebarDialogs
        conversationActions={conversationActions}
        fileActions={fileActions}
        scopedConversationIds={scopedConversationIds}
        confirmDeleteTitle={displayedConversations.find((c) => c.id === conversationActions.confirmDeleteId)?.title || ''}
        t={t}
      />

      {/* Horizontal drag divider (sidebar width) */}
      {!isMobile && (
        <div
          className="group relative flex w-2 shrink-0 cursor-col-resize flex-col items-center justify-center bg-neutral-50/50 transition-colors hover:bg-neutral-100/80 dark:bg-muted dark:hover:bg-muted"
          onMouseDown={handleDragStart}
          title={t('sidebar.dragToResizeWidth')}
        >
          {/* center dot */}
          <div className="group-hover:bg-primary-500 h-1 w-1 rounded-full bg-neutral-300 transition-colors" />
        </div>
      )}

      {/* Export conversation dialog */}
      {exportConvId && (
        <ExportConversationDialog
          open={!!exportConvId}
          onOpenChange={(open) => {
            if (!open) setExportConvId(null)
          }}
          conversationId={exportConvId}
        />
      )}

      {/* Batch export dialog (search + export conversations) */}
      <BatchExportDialog
        open={batchExportOpen}
        onOpenChange={setBatchExportOpen}
      />
    </>
  )
})

export { ResourceTabPanel }
