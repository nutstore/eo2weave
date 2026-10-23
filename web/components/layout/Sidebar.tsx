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
import { usePathname, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { projectWorkspacePath } from '@/lib/route-paths'
import { createPortal } from 'react-dom'
import { BrushCleaningIcon } from '@/components/icons/BrushCleaningIcon'
import { Plus, Trash2, PanelLeftClose, PanelLeft, FolderTree, Clock, History, Pencil, Archive, ArchiveRestore, Download, Pin, PinOff, ChevronRight, ChevronDown, Sparkles, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
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
import { useOPFSStore } from '@/store/opfs.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { FileTreePanel } from '@/components/file-viewer/FileTreePanel'
import { PendingSyncPanel } from '@/components/sync/PendingSyncPanel'
import { SnapshotList } from '@/components/sync/SnapshotList'
import { useT } from '@/i18n'
import { ExportConversationDialog } from '@/components/conversation/ExportConversationDialog'
import { BatchExportDialog } from '@/components/conversation/BatchExportDialog'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { NativeHostExecutor } from '@/opfs/native-disk/executor-native-host'

type ResourceTab = 'files' | 'plugins' | 'pending' | 'snapshots'

const MIN_CONVERSATION_RATIO = 20 // minimum percentage
const MAX_CONVERSATION_RATIO = 80 // maximum percentage

/** Tracks conversations currently generating a title, to prevent duplicate clicks. */
const generatingTitleIds = new Set<string>()

interface ConversationItemData {
  id: string
  title: string
  isRunning: boolean
  isActive: boolean
  pendingReviewCount: number
  isEditing: boolean
  isArchived: boolean
  isPinned: boolean
  hasSchedule: boolean
}

interface ConversationItemProps extends ConversationItemData {
  /** Canonical workspace URL — rendered as a next/link for prefetch + middle-click. */
  href: string
  onSelect: (id: string) => void
  onStartRename: (id: string, title: string) => void
  onDeleteClick: (id: string, x: number, y: number) => void
  onTogglePin: (id: string) => void
  onExport: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
  onGenerateTitle: (id: string) => void
  editingTitle: string
  onEditingTitleChange: (title: string) => void
  onConfirmRename: () => void
  onCancelRename: () => void
  onRenameBlur: () => void
  composing: boolean
  onComposingChange: (composing: boolean) => void
  renameInputRef: React.RefObject<HTMLInputElement | null>
  workspaceLabel: string
  t: (key: string, params?: Record<string, string | number>) => string
}

/** Memoized "New Workspace" button — isolated from conversation list re-renders. */
const NewWorkspaceButton = memo(function NewWorkspaceButton({
  onClick,
  label,
  isActive = false,
}: {
  onClick: () => void
  label: string
  /** Highlighted when in draft state (?new=1) — the draft "is" the new conversation */
  isActive?: boolean
}) {
  return (
    // Top padding keeps the button off the header's bottom border — without
    // it the "new conversation" row sits flush against the list container.
    <div className="px-2 pb-1 pt-2">
      <BrandButton
        variant="ghost"
        aria-current={isActive ? 'true' : undefined}
        className={`h-7 w-full justify-start gap-1.5 px-2 text-xs ${
          isActive
            ? 'bg-primary-50 font-semibold text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
            : 'bg-muted'
        }`}
        onClick={onClick}
      >
        <Plus className="h-3 w-3" />
        {label}
      </BrandButton>
    </div>
  )
})

/**
 * Memoized conversation item — prevents all 30+ ContextMenu instances from
 * re-rendering when only one item's state changes.
 *
 * The row is rendered as a next/link so the target workspace page is
 * prefetched on hover/viewport and middle/right-click "open in new tab"
 * works. `onSelect` keeps only the non-navigation side effects (touch
 * last-accessed timestamp, close the mobile sidebar, in-place fallback when
 * no onSelectWorkspace prop was provided).
 */
const ConversationItem = memo(function ConversationItem({
  id,
  title,
  isRunning,
  isActive,
  pendingReviewCount,
  isEditing,
  isArchived,
  isPinned,
  hasSchedule,
  href,
  onSelect,
  onStartRename,
  onDeleteClick: _onDeleteClick,
  onTogglePin,
  onExport,
  onArchive,
  onDelete,
  onGenerateTitle,
  editingTitle,
  onEditingTitleChange,
  onConfirmRename,
  onCancelRename,
  onRenameBlur,
  composing,
  onComposingChange,
  renameInputRef,
  workspaceLabel,
  t,
}: ConversationItemProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Link
          href={href}
          role="listitem"
          aria-current={isActive ? 'page' : undefined}
          aria-label={workspaceLabel}
          className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 ${
            isActive
              ? 'bg-primary-50 font-semibold text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
              : 'hover:bg-hover text-secondary'
          }`}
          onClick={(e) => {
            if (isEditing) {
              e.preventDefault()
              return
            }
            onSelect(id)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onStartRename(id, title)
          }}
        >
          {/* Pin indicator icon */}
          {isPinned && (
            <Pin className="h-3 w-3 shrink-0 text-primary-500" />
          )}

          {/* Running status indicator */}
          {isRunning && (
            <span role="status" aria-label={t('sidebar.running')} className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warning" />
          )}

          {/* Action buttons - visible on hover */}
          {!isEditing && (
            <div className={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center rounded-md border border-border bg-muted p-0.5 shadow-sm transition-opacity ${
                              isActive
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                            }`}>
              <button
                type="button"
                className="rounded p-1 text-secondary transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:text-primary-700"
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onStartRename(id, title)
                }}
                title={t('sidebar.renameWorkspace')}
                aria-label={t('sidebar.renameWorkspace')}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <div className="mx-0.5 h-3 w-px bg-border" />
              <button
                type="button"
                className="rounded p-1 text-secondary transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:hover:bg-danger/20"
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onDelete(id)
                }}
                title={t('sidebar.deleteWorkspace')}
                aria-label={t('sidebar.deleteWorkspace')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Schedule indicator — BEFORE the title so hover action buttons
              (absolute, right-aligned) can never cover it */}
          {hasSchedule && !isEditing && (
            <Clock
              className="h-3 w-3 shrink-0 text-primary-400"
              aria-label={t('sidebar.scheduleIndicator')}
            />
          )}
          {isEditing ? (
            <input
              ref={renameInputRef as React.LegacyRef<HTMLInputElement>}
              type="text"
              value={editingTitle}
              onChange={(e) => onEditingTitleChange(e.target.value)}
              onCompositionStart={() => onComposingChange(true)}
              onCompositionEnd={() => onComposingChange(false)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && !composing) {
                  onConfirmRename()
                } else if (e.key === 'Escape') {
                  onCancelRename()
                }
              }}
              onBlur={onRenameBlur}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-primary-100 bg-card px-1.5 py-0.5 text-xs text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-primary-600 dark:bg-card dark:text-primary"
              maxLength={100}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate" title={title}>{title}</span>
          )}
          {pendingReviewCount > 0 && !isEditing && (
            <span
              className="shrink-0 rounded-full bg-warning/20 px-1.5 py-0.5 text-xs font-semibold leading-none text-warning"
              title={t('sidebar.pendingReviewCount', { count: pendingReviewCount })}
            >
              {pendingReviewCount}
            </span>
          )}
        </Link>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem
          onClick={() => onTogglePin(id)}
        >
          {isPinned
            ? <PinOff className="mr-2 h-3.5 w-3.5" />
            : <Pin className="mr-2 h-3.5 w-3.5" />
          }
          {isPinned ? t('sidebar.unpinWorkspace') : t('sidebar.pinWorkspace')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onExport(id)}
        >
          <Download className="mr-2 h-3.5 w-3.5" />
          {t('sidebar.exportWorkspace') || 'Export'}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onGenerateTitle(id)}
        >
          <Sparkles className="mr-2 h-3.5 w-3.5" />
          {t('sidebar.generateTitle')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => onArchive(id, isArchived)}
        >
          {isArchived
            ? <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
            : <Archive className="mr-2 h-3.5 w-3.5" />
          }
          {isArchived ? t('sidebar.unarchiveWorkspace') : t('sidebar.archiveWorkspace')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}, (prev, next) => {
  // Custom comparison — only re-render when meaningful data changes
  return (
    prev.id === next.id &&
    prev.href === next.href &&
    prev.title === next.title &&
    prev.isRunning === next.isRunning &&
    prev.isActive === next.isActive &&
    prev.pendingReviewCount === next.pendingReviewCount &&
    prev.isEditing === next.isEditing &&
    prev.isPinned === next.isPinned &&
    prev.hasSchedule === next.hasSchedule &&
    prev.isArchived === next.isArchived &&
    prev.editingTitle === next.editingTitle &&
    prev.composing === next.composing &&
    prev.workspaceLabel === next.workspaceLabel
    // Note: callback refs are stable (useCallback), so we skip comparing them
  )
})

interface SidebarProps {
  /** Called when user clicks a file in the tree */
  onFileSelect?: (path: string, handle: FileSystemFileHandle | null) => void
  /** Called when user clicks element inspector on a file */
  onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
  /** Currently selected file path (for highlight in tree) */
  selectedFilePath?: string | null
  /** Whether sidebar is rendered in mobile mode */
  isMobile?: boolean
  /** Request parent to close mobile sidebar */
  onRequestClose?: () => void
  /** Target file path to reveal in tree (relative path without root prefix) */
  revealTargetPath?: string | null
  /** Called when reveal has been processed */
  onRevealComplete?: () => void
  /** Called when user selects a workspace from the sidebar. Should navigate URL. */
  onSelectWorkspace?: (workspaceId: string) => void
  /** Enter the route owner's draft state without creating a conversation. */
  onNewDraft?: () => void
}

/** Memoized wrapper for FileTreePanel with stable callbacks per root */
const RootFileTreePanel = memo(function RootFileTreePanel({
  root,
  selectedFilePath,
  revealTargetPath,
  rootsLength,
  onFileSelect,
  onInspect,
  onFileDelete,
  onRevealComplete,
  collapsed,
  onToggleCollapse,
}: {
  root: {
    id: string
    name: string
    handle: FileSystemDirectoryHandle | null
    backend?: 'fsaccess' | 'native-host'
    scopeId?: string | null
  }
  selectedFilePath?: string | null
  revealTargetPath?: string | null
  rootsLength: number
  onFileSelect: (fullPath: string, handle: FileSystemFileHandle | null) => void
  onInspect?: ((fullPath: string, handle: FileSystemFileHandle | null) => void) | undefined
  onFileDelete?: (rootName: string, path: string, node: { kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle | null }, pos: { x: number; y: number }) => void
  onRevealComplete?: (() => void) | undefined
  collapsed: boolean
  onToggleCollapse: (rootName: string) => void
}) {
  const t = useT()
  // Per-root external refresh signal: the tree's built-in header (with its
  // refresh button) is hidden in multi-root mode, so expose refresh here.
  const [refreshSignal, setRefreshSignal] = useState(0)
  const handleFileSelect = useCallback(
    (path: string, handle: FileSystemFileHandle | null) => {
      // Virtual OPFS root: paths in cachedPaths are already workspace-relative
      // (no rootName prefix), so pass through unchanged.
      const fullPath = root.id === '__opfs__' ? path : `${root.name}/${path}`
      onFileSelect(fullPath, handle)
    },
    [onFileSelect, root.name, root.id]
  )

  const handleInspect = useCallback<(path: string, handle: FileSystemFileHandle | null) => void>(
    onInspect
      ? (path, handle) => {
          const fullPath = root.id === '__opfs__' ? path : `${root.name}/${path}`
          onInspect(fullPath, handle)
        }
      : () => {},
    [onInspect, root.name, root.id]
  )

  const handleDelete = useCallback(
    (path: string, node: { kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle | null }, pos: { x: number; y: number }) => {
      // Pass '__opfs__' sentinel for virtual root so the delete handler knows
      // not to prepend rootName to the path.
      onFileDelete?.(root.id === '__opfs__' ? '__opfs__' : root.name, path, node, pos)
    },
    [onFileDelete, root.name, root.id]
  )

  const rootRevealTarget = useMemo(() => {
    if (!revealTargetPath) return null
    if (root.id === '__opfs__') return revealTargetPath
    if (selectedFilePath?.startsWith(`${root.name}/`)) return revealTargetPath
    if (rootsLength === 1) return revealTargetPath
    return null
  }, [revealTargetPath, selectedFilePath, root.name, root.id, rootsLength])

  const rootSelectedPath = root.id === '__opfs__'
    ? selectedFilePath ?? null
    : selectedFilePath?.startsWith(`${root.name}/`)
      ? selectedFilePath.slice(root.name.length + 1)
      : null

  // Auto-expand when there's a revealTarget for this root
  const shouldReveal = rootRevealTarget !== null

  return (
    <div className="flex-shrink-0">
      {rootsLength > 1 ? (
        <div className="flex w-full items-center gap-1">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-secondary hover:bg-hover"
            onClick={() => onToggleCollapse(root.name)}
          >
            {collapsed && !shouldReveal ? (
              <ChevronRight className="h-3 w-3 shrink-0 text-tertiary" />
            ) : (
              <ChevronDown className="h-3 w-3 shrink-0 text-tertiary" />
            )}
            <FolderTree className="h-3 w-3 shrink-0 text-warning" />
            <span className="truncate">{root.name}</span>
          </button>
          <button
            type="button"
            className="mr-1 shrink-0 rounded-md p-1 text-tertiary transition-colors hover:bg-hover hover:text-secondary"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
            onClick={() => setRefreshSignal((s) => s + 1)}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {rootsLength <= 1 || !collapsed || shouldReveal ? (
        <FileTreePanel
          directoryHandle={root.handle}
          diskRootId={root.backend === 'native-host' ? root.scopeId : null}
          diskExecutor={root.backend === 'native-host' ? nativeHostTreeExecutor : null}
          rootName={root.name}
          // Virtual OPFS-only root: don't filter cachedPaths by name prefix
          // (files were written without any rootName prefix in pure-OPFS mode).
          pathPrefix={root.id === '__opfs__' ? null : root.name}
          onFileSelect={handleFileSelect}
          selectedPath={rootSelectedPath}
          onInspect={handleInspect}
          onDelete={handleDelete}
          revealTarget={rootRevealTarget}
          onRevealComplete={onRevealComplete}
          showHeader={rootsLength <= 1}
          refreshSignal={refreshSignal}
        />
      ) : null}
    </div>
  )
})

/** Shared read-only executor used by Native Host-backed file trees. */
const nativeHostTreeExecutor = new NativeHostExecutor()

/**
 * ResourceTabPanel — isolated from conversation state to avoid re-rendering
 * during agent streaming. Only re-renders when its own props change.
 */
const ResourceTabPanel = memo(function ResourceTabPanel({
  resourceTab,
  onTabChange,
  roots,
  selectedFilePath,
  revealTargetPath,
  rootsLength,
  onFileSelect,
  onInspect,
  onFileDelete,
  onRevealComplete,
  currentPendingCount,
  refreshPending,
  t,
}: {
  resourceTab: ResourceTab
  onTabChange: (tab: ResourceTab) => void
  roots: { id: string; name: string; handle: FileSystemDirectoryHandle | null }[]
  selectedFilePath?: string | null
  revealTargetPath?: string | null
  rootsLength: number
  onFileSelect: (fullPath: string, handle: FileSystemFileHandle | null) => void
  onInspect?: ((fullPath: string, handle: FileSystemFileHandle | null) => void) | undefined
  onFileDelete?: (rootName: string, path: string, node: { kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle | null }, pos: { x: number; y: number }) => void
  onRevealComplete?: (() => void) | undefined
  currentPendingCount: number
  refreshPending: () => Promise<void>
  t: (key: string, params?: Record<string, string | number>) => string
}) {
  // Root collapse state for multi-root file tree
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set())

  const handleToggleCollapse = useCallback((rootName: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev)
      if (next.has(rootName)) {
        next.delete(rootName)
      } else {
        next.add(rootName)
      }
      return next
    })
  }, [])

  return (
    <div
      className="border-subtle flex h-full flex-col overflow-hidden border-t bg-white dark:bg-card"
    >
      {/* Tab buttons */}
      <div className="border-subtle flex items-center gap-0.5 border-b px-1.5 py-1">
        <BrandButton
          variant="ghost"
          className={`h-7 gap-1 px-2 py-1 text-xs ${
            resourceTab === 'files'
              ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
              : ''
          }`}
          onClick={() => onTabChange('files')}
        >
          <FolderTree className="h-3 w-3" />
          {t('sidebar.files')}
        </BrandButton>
        <BrandButton
          variant="ghost"
          className={`h-7 gap-1 px-2 py-1 text-xs ${
            resourceTab === 'pending'
              ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
              : ''
          }`}
          onClick={async () => {
            onTabChange('pending')
            await refreshPending()
          }}
        >
          <Clock className="h-3 w-3" />
          {t('sidebar.changes')}
          {currentPendingCount > 0 && (
            <span className="min-w-[1.1rem] rounded-full bg-warning/20 px-1.5 py-0.5 text-xs font-semibold leading-none text-warning">
              {currentPendingCount}
            </span>
          )}
        </BrandButton>
        <BrandButton
          variant="ghost"
          className={`h-7 gap-1 px-2 py-1 text-xs ${
            resourceTab === 'snapshots'
              ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
              : ''
          }`}
          onClick={() => onTabChange('snapshots')}
        >
          <History className="h-3 w-3" />
          {t('sidebar.snapshots')}
        </BrandButton>
        {/* Plugins tab hidden for now */}
        {/* <BrandButton
          variant="ghost"
          className={`h-7 gap-1 px-2 py-1 text-xs ${
            resourceTab === 'plugins'
              ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
              : ''
          }`}
          onClick={() => onTabChange('plugins')}
        >
          <Puzzle className="h-3 w-3" />
          {t('sidebar.plugins')}
        </BrandButton> */}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden" data-tour="file-tree">
        {resourceTab === 'files' && (
          roots.length === 1 && roots[0]?.id === '__opfs__' ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-sm text-sm leading-7 text-muted-foreground">
                <h3 className="mb-4 text-center text-base font-semibold leading-6 text-secondary dark:text-secondary-foreground">
                  {t('sidebar.localFilesEmpty.title', { brand: t('projectHome.brand') })}
                </h3>
                <ul className="list-disc space-y-2 pl-5">
                  <li>{t('sidebar.localFilesEmpty.authorizedHint')}</li>
                  <li>{t('sidebar.localFilesEmpty.unlinkedHint')}</li>
                </ul>
              </div>
            </div>
          ) : (
            <div className="custom-scrollbar flex h-full flex-col overflow-y-auto">
              {roots.map((root) => (
                <RootFileTreePanel
                  key={root.id}
                  root={root}
                  selectedFilePath={selectedFilePath}
                  revealTargetPath={revealTargetPath}
                  rootsLength={rootsLength}
                  onFileSelect={onFileSelect}
                  onInspect={onInspect}
                  onFileDelete={onFileDelete}
                  onRevealComplete={onRevealComplete}
                  collapsed={collapsedRoots.has(root.name)}
                  onToggleCollapse={handleToggleCollapse}
                />
              ))}
            </div>
          )
        )}

        {/* Plugins tab content hidden for now */}
        {/* resourceTab === 'plugins' && (
          <div className="flex h-full flex-col">
            <SidebarPanelHeader title={t('sidebar.pluginTitle')} />
            <div className="flex flex-1 items-center justify-center p-4">
              <p className="text-xs text-secondary">
                {t('sidebar.pluginManagerHint')}
              </p>
            </div>
          </div>
        ) */}

        {resourceTab === 'pending' && (
          <div className="h-full overflow-hidden">
            <PendingSyncPanel />
          </div>
        )}

        {resourceTab === 'snapshots' && (
          <div className="h-full overflow-hidden">
            <SnapshotList limit={300} fullHeight />
          </div>
        )}
      </div>
    </div>
  )
})

export const Sidebar = memo(function Sidebar({
  onFileSelect,
  onInspect,
  selectedFilePath,
  isMobile = false,
  onRequestClose,
  revealTargetPath,
  onRevealComplete,
  onSelectWorkspace,
  onNewDraft,
}: SidebarProps) {
  const t = useT()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Draft mode: URL is /projects/:id?new=1 (user clicked 新对话, conversation
  // not yet created). Used to highlight the 新对话 button.
  const pathname = usePathname()
  const isDraftMode =
    useSearchParams().get('new') === '1' && pathname === `/projects/${activeProjectId}`

  // Use selectors to avoid re-rendering on every streaming delta.
  // Sidebar only needs id/title for the list — not streamingContent/toolCalls/etc.
  // NOTE: intentionally exclude updatedAt — cancelAgent writes updatedAt which would
  // cause unnecessary re-renders of the entire Sidebar (including buttons).
  // useShallow ensures stable references when the extracted values haven't changed.
  const conversationListItems = useConversationStore(
    useShallow((s) =>
      s.conversations.map((c) => ({ id: c.id, title: c.title }))
    )
  )
  const deleteConversation = useConversationStore((s) => s.deleteConversation)
  const deleteConversations = useConversationStore((s) => s.deleteConversations)
  const updateTitle = useConversationStore((s) => s.updateTitle)
  const generateTitle = useConversationStore((s) => s.generateTitle)

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
  const scopedConversations = useMemo(
    () => conversationListItems.filter(
      (conv) => scopedWorkspaceIdSet.has(conv.id) || conv.id === activeWorkspaceId
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
  const togglePin = useWorkspaceStore((state) => state.togglePin)

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
  const [clearConversationsDialogOpen, setClearConversationsDialogOpen] = useState(false)
  const [clearingConversations, setClearingConversations] = useState(false)
  const [deleteFileDialogOpen, setDeleteFileDialogOpen] = useState(false)
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<{
    rootName: string
    path: string
    fileName: string
    handle: FileSystemFileHandle | FileSystemDirectoryHandle | null
  } | null>(null)
  const [deleteFilePos, setDeleteFilePos] = useState<{ x: number; y: number } | null>(null)
  const deleteFileConfirmRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [composing, setComposing] = useState(false)
  const [exportConvId, setExportConvId] = useState<string | null>(null)
  const [batchExportOpen, setBatchExportOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmDeletePos, setConfirmDeletePos] = useState<{ x: number; y: number } | null>(null)
  const deleteConfirmRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Track the target rename ID to prevent click interference
  const pendingRenameIdRef = useRef<string | null>(null)

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      onRequestClose?.()
    }
  }, [isMobile, onRequestClose])

  // Rename handlers
  const startRename = useCallback((convId: string, currentTitle: string) => {
    pendingRenameIdRef.current = convId
    setEditingId(convId)
    setEditingTitle(currentTitle)
    requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }, [])

  const confirmRename = useCallback(() => {
    if (editingId && editingTitle.trim()) {
      const trimmedTitle = editingTitle.trim()
      const conv = scopedConversations.find((c) => c.id === editingId)
      if (conv && conv.title !== trimmedTitle) {
        updateTitle(editingId, trimmedTitle)
      }
    }
    setEditingId(null)
    setEditingTitle('')
    pendingRenameIdRef.current = null
  }, [editingId, editingTitle, updateTitle, scopedConversations])

  const handleRenameBlur = useCallback(() => {
    setTimeout(() => {
      if (document.activeElement !== renameInputRef.current) {
        confirmRename()
      }
    }, 150)
  }, [confirmRename])

  const cancelRename = useCallback(() => {
    setEditingId(null)
    setEditingTitle('')
    setComposing(false)
    pendingRenameIdRef.current = null
  }, [])

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

  // Close delete confirmation when clicking outside
  useEffect(() => {
    if (!confirmDeleteId) return

    const handleClick = (e: MouseEvent) => {
      if (deleteConfirmRef.current && !deleteConfirmRef.current.contains(e.target as Node)) {
        setConfirmDeleteId(null)
        setConfirmDeletePos(null)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setConfirmDeleteId(null)
        setConfirmDeletePos(null)
      }
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [confirmDeleteId])

  // Close file delete confirmation when clicking outside or pressing Escape
  useEffect(() => {
    if (!deleteFileDialogOpen) return

    const handleClick = (e: MouseEvent) => {
      if (deleteFileConfirmRef.current && !deleteFileConfirmRef.current.contains(e.target as Node)) {
        setDeleteFileDialogOpen(false)
        setPendingDeleteTarget(null)
        setDeleteFilePos(null)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDeleteFileDialogOpen(false)
        setPendingDeleteTarget(null)
        setDeleteFilePos(null)
      }
    }

    // Delay to avoid the triggering click that opened the confirm
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClick)
      document.addEventListener('keydown', handleKeyDown)
    })
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [deleteFileDialogOpen])

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

  const handleFileDelete = useCallback(
    (rootName: string, path: string, node: { kind: 'file' | 'directory'; handle: FileSystemFileHandle | FileSystemDirectoryHandle | null }, pos: { x: number; y: number }) => {
      const fileName = path.split('/').pop() || path
      setPendingDeleteTarget({ rootName, path, fileName, handle: node.handle })
      setDeleteFilePos(pos)
      setDeleteFileDialogOpen(true)
    },
    []
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

  // The route owner derives the target from URL params rather than this
  // sidebar's potentially stale project-store state (notably during project
  // switches). A conversation is still materialized only after first send.
  const handleCreateNewWorkspace = useCallback(() => {
    onNewDraft?.()
    closeMobileSidebar()
  }, [onNewDraft, closeMobileSidebar])

  // Stable callback for editing title change
  const handleEditingTitleChange = useCallback((title: string) => setEditingTitle(title), [])

  // Collapsed state — sync local state with store
  useEffect(() => {
    setCollapsed(storePanelState.sidebarCollapsed)
  }, [storePanelState.sidebarCollapsed])

  const handleSetCollapsed = useCallback((value: boolean) => {
    setCollapsed(value)
    setSidebarCollapsed(value)
  }, [setSidebarCollapsed])

  // Stable callbacks for ConversationItem memoization
  // Side effects for clicking a conversation row. Navigation itself is
  // handled by the <Link href> the row renders as; this callback only touches
  // the last-accessed timestamp (so the item sorts to the top) and closes the
  // mobile sidebar. It deliberately does NOT call onSelectWorkspace/
  // switchWorkspace — that would push a second navigation on top of the link.
  const handleItemSelect = useCallback((id: string) => {
    if (pendingRenameIdRef.current === id) return
    // NOTE: clicking a conversation must NOT change its sort position.
    // Ordering only moves to the top when the user sends a new message
    // (a new agent loop), which bumps lastAccessedAt in the store.
    closeMobileSidebar()
  }, [closeMobileSidebar])

  const handleItemDeleteClick = useCallback((id: string, x: number, y: number) => {
    setConfirmDeleteId(id)
    setConfirmDeletePos({ x, y })
  }, [])

  const handleItemTogglePin = useCallback((id: string) => {
    togglePin(id)
  }, [togglePin])

  const handleItemGenerateTitle = useCallback(async (id: string) => {
    if (generatingTitleIds.has(id)) return
    generatingTitleIds.add(id)
    const toastId = toast.loading(t('sidebar.generatingTitle'))
    try {
      const result = await generateTitle(id, true)
      if (result.ok) {
        if (result.changed) {
          toast.success(t('sidebar.titleGenerated'), { id: toastId })
        } else {
          // Model produced a valid title but it happens to equal the current one.
          toast.info(t('sidebar.titleUnchanged'), { id: toastId })
        }
      } else {
        // Map every failure reason to a precise, actionable toast message.
        const messageKey =
          result.reason === 'no_provider' || result.reason === 'no_model'
            ? 'sidebar.titleGenerateNoProvider'
            : result.reason === 'no_api_key'
            ? 'sidebar.titleGenerateNoApiKey'
            : 'sidebar.titleGenerateFailed'
        toast.error(t(messageKey), { id: toastId })
      }
    } catch (error) {
      console.error('[Sidebar] Failed to generate title:', error)
      toast.error(t('sidebar.titleGenerateFailed'), { id: toastId })
    } finally {
      generatingTitleIds.delete(id)
    }
  }, [generateTitle, t])

  const handleItemExport = useCallback((id: string) => {
    setExportConvId(id)
  }, [])

  const handleItemArchive = useCallback(async (id: string, _isArchived: boolean) => {
    const { archiveWorkspace, unarchiveWorkspace } = useConversationContextStore.getState()
    try {
      if (_isArchived) {
        await unarchiveWorkspace(id)
        toast.success(t('sidebar.workspaceUnarchived'))
      } else {
        await archiveWorkspace(id)
        toast.success(t('sidebar.workspaceArchived'))
      }
    } catch (error) {
      console.error('[Sidebar] Failed to toggle archive:', error)
      toast.error(_isArchived ? t('sidebar.unarchiveFailed') : t('sidebar.archiveFailed'))
    }
  }, [t])

  const handleItemDelete = useCallback(async (id: string) => {
    try {
      await deleteConversation(id)
      toast.success(t('sidebar.workspaceDeleted'))
      // After deleting, navigate to the new active workspace (resolved by workspace store)
      // so that syncFromRoute runs the full switchWorkspace flow (OPFS init, file tree, etc.)
      const newActiveId = useConversationContextStore.getState().activeWorkspaceId
      if (newActiveId && onSelectWorkspace) {
        onSelectWorkspace(newActiveId)
      }
    } catch (error) {
      console.error('[Sidebar] Failed to delete conversation:', error)
      toast.error(t('sidebar.deleteWorkspaceFailed'))
    }
  }, [deleteConversation, t, onSelectWorkspace])

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
            className="flex min-h-0 flex-col overflow-hidden bg-muted/25"
            style={{ height: `${conversationRatio}%` }}
          >
          {workspaceTab === 'active' && (
            <NewWorkspaceButton
              onClick={handleCreateNewWorkspace}
              label={t('sidebar.newWorkspace')}
              isActive={isDraftMode}
            />
          )}

          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            {displayedConversations.map((conv) => {
              const isRunning = runningSet.has(conv.id)
              const isActive = conv.id === activeWorkspaceId
              const pendingReviewCount = pendingCountByConversationId.get(conv.id) || 0
              const isEditing = editingId === conv.id
              const isArchived = workspaceStatusMap.get(conv.id) === 'archived'
              const isPinned = pinnedIds.includes(conv.id)

              return (
                <motion.div
                  key={conv.id}
                  layout={reduceMotion ? false : 'position'}
                  transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 35, mass: 0.8 }}
                  className="mb-0.5"
                >
                <ConversationItem
                  id={conv.id}
                  title={conv.title}
                  isRunning={isRunning}
                  isActive={isActive}
                  pendingReviewCount={pendingReviewCount}
                  isEditing={isEditing}
                  isArchived={isArchived}
                  isPinned={isPinned}
                  hasSchedule={(workspaceScheduleCount.get(conv.id) ?? 0) > 0}
                  href={projectWorkspacePath(activeProjectId, conv.id)}
                  onSelect={handleItemSelect}
                  onStartRename={startRename}
                  onDeleteClick={handleItemDeleteClick}
                  onTogglePin={handleItemTogglePin}
                  onExport={handleItemExport}
                  onArchive={handleItemArchive}
                  onDelete={handleItemDelete}
                  onGenerateTitle={handleItemGenerateTitle}
                  editingTitle={editingTitle}
                  onEditingTitleChange={handleEditingTitleChange}
                  onConfirmRename={confirmRename}
                  onCancelRename={cancelRename}
                  onRenameBlur={handleRenameBlur}
                  composing={composing}
                  onComposingChange={setComposing}
                  renameInputRef={renameInputRef}
                  workspaceLabel={t('sidebar.workspaceLabel', { name: conv.title })}
                  t={t}
                />
                </motion.div>
              )
            })}
          </div>
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

          {/* Resource tabs — memoized to avoid re-render during streaming */}
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
              onFileDelete={handleFileDelete}
              onRevealComplete={onRevealComplete}
              currentPendingCount={currentPendingCount}
              refreshPending={refreshPending}
              t={t}
            />
          </div>
        </div>
        </>}
      </motion.div>

      <BrandDialog
        open={clearConversationsDialogOpen}
        onOpenChange={setClearConversationsDialogOpen}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('sidebar.clearWorkspaceTitle')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="text-secondary text-sm">{t('sidebar.confirmClearWorkspace')}</p>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              disabled={clearingConversations}
              onClick={() => setClearConversationsDialogOpen(false)}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={async () => {
                try {
                  setClearingConversations(true)
                  const result = await deleteConversations(scopedConversationIds)
                  if (result.failed.length === 0) {
                    toast.success(t('sidebar.clearedCount', { count: result.successIds.length }))
                    setClearConversationsDialogOpen(false)
                  } else if (result.successIds.length === 0) {
                    toast.error(t('sidebar.clearFailed', { count: result.failed.length }))
                  } else {
                    toast.error(t('sidebar.deletePartial', { success: result.successIds.length, failed: result.failed.length }))
                  }
                } finally {
                  setClearingConversations(false)
                }
              }}
              disabled={scopedConversationIds.length === 0 || clearingConversations}
            >
              {clearingConversations ? t('sidebar.clearing') : t('sidebar.clear')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Delete File Confirmation Portal */}
      {deleteFileDialogOpen && deleteFilePos && pendingDeleteTarget && createPortal(
        <div
          ref={deleteFileConfirmRef}
          className="fixed z-[9999] rounded-lg border border-danger/30 bg-card p-3 shadow-xl"
          style={{
            left: Math.max(8, deleteFilePos.x - 80),
            top: Math.max(8, deleteFilePos.y - 60),
          }}
        >
          <p className="mb-2 text-xs text-secondary">
            {t('fileTree.deleteConfirm', { name: pendingDeleteTarget.fileName })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger hover:bg-danger/20"
              onClick={async () => {
                try {
                  const { rootName, path, handle } = pendingDeleteTarget
                  // Virtual OPFS root sentinel: paths are already workspace-relative.
                  const fullPath = rootName === '__opfs__' ? path : `${rootName}/${path}`
                  const workspaceId = useConversationContextStore.getState().activeWorkspaceId
                  await useOPFSStore.getState().deleteFile(fullPath, handle instanceof FileSystemDirectoryHandle ? handle : null, workspaceId, activeProjectId)
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : t('common.error'))
                }
                setDeleteFileDialogOpen(false)
                setPendingDeleteTarget(null)
                setDeleteFilePos(null)
              }}
            >
              {t('fileTree.deleteFile')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-200 bg-white px-3 py-1 text-xs text-secondary hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              onClick={() => {
                setDeleteFileDialogOpen(false)
                setPendingDeleteTarget(null)
                setDeleteFilePos(null)
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}

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

      {/* Delete confirmation portal - rendered at body level */}
      {confirmDeleteId && confirmDeletePos && createPortal(
        <div
          ref={deleteConfirmRef}
          className="fixed z-[9999] rounded-lg border border-danger/30 bg-card p-3 shadow-xl"
          style={{
            left: Math.max(8, confirmDeletePos.x - 80),
            top: Math.max(8, confirmDeletePos.y - 60),
          }}
        >
          <p className="mb-2 text-xs text-secondary">
            {t('sidebar.confirmDeleteWorkspace', { name: displayedConversations.find(c => c.id === confirmDeleteId)?.title || '' })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-danger/30 bg-danger/10 px-3 py-1 text-xs text-danger hover:bg-danger/20"
              onClick={async () => {
                if (confirmDeleteId) {
                  try {
                    await deleteConversation(confirmDeleteId)
                    toast.success(t('sidebar.workspaceDeleted'))
                    // Navigate to the new active workspace (resolved by workspace store)
                    // so that syncFromRoute runs the full switchWorkspace flow
                    const newActiveId = useConversationContextStore.getState().activeWorkspaceId
                    if (newActiveId && onSelectWorkspace) {
                      onSelectWorkspace(newActiveId)
                    }
                  } catch (error) {
                    console.error('[Sidebar] Failed to delete conversation:', error)
                    toast.error(t('sidebar.deleteWorkspaceFailed'))
                  }
                }
                setConfirmDeleteId(null)
                setConfirmDeletePos(null)
              }}
            >
              {t('common.delete')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-200 bg-white px-3 py-1 text-xs text-secondary hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700"
              onClick={() => {
                setConfirmDeleteId(null)
                setConfirmDeletePos(null)
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  )
})
