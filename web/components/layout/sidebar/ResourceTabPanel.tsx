import { useState, useCallback, useMemo, memo } from 'react'
import {
  FolderTree,
  Clock,
  History,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { BrandButton } from '@creatorweave/ui'
import { useOPFSStore } from '@/store/opfs.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { useSkillsStore } from '@/store/skills.store'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import { FileTreePanel } from '@/components/file-viewer/FileTreePanel'
import { GitBranchBadge } from '@/components/file-viewer/GitBranchBadge'
import { useGitBranch } from '@/hooks/useGitBranch'
import { PendingSyncPanel } from '@/components/sync/PendingSyncPanel'
import { SnapshotList } from '@/components/sync/SnapshotList'
import { useT } from '@/i18n'
import { NativeHostExecutor } from '@/opfs/native-disk/executor-native-host'

export type ResourceTab = 'files' | 'plugins' | 'pending' | 'snapshots'

/** Shared read-only executor used by Native Host-backed file trees. */
const nativeHostTreeExecutor = new NativeHostExecutor()

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
  // Multi-root mode hides the tree's own header, so the branch badge has to
  // live in this heading — the hook also covers Native Host roots, which have
  // no directory handle and read through the executor instead.
  const nativeHostBacked = root.backend === 'native-host'
  const gitBranch = useGitBranch({
    handle: root.handle,
    executor: nativeHostBacked ? nativeHostTreeExecutor : null,
    rootId: nativeHostBacked ? root.scopeId : null,
  })
  // Per-root external refresh signal: the tree's built-in header (with its
  // refresh button) is hidden in multi-root mode, so expose refresh here.
  const [refreshSignal, setRefreshSignal] = useState(0)
  // The panel's own refresh used to bump this; the root row is the only
  // refresh affordance now, so it must rescan project skills too (issue #234).
  const bumpSkillsScanVersion = useSkillsStore((s) => s.bumpSkillsScanVersion)
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
      {/* ONE root row shape for every case: a single mounted root used to
          render a different header (uppercase title + branch + refresh), so
          the panel changed appearance purely because a second root was
          mounted. The list now always renders root rows. */}
      <div className="flex w-full items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-secondary hover:bg-hover"
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
        {/* The folder name keeps its space; the branch label takes only the
            remainder and is what truncates (same priority as the old header). */}
        <GitBranchBadge info={gitBranch} className="mr-1 min-w-0 flex-1 justify-end overflow-hidden" />
        <button
          type="button"
          className="mr-1 shrink-0 rounded-md p-1 text-tertiary transition-colors hover:bg-hover hover:text-secondary"
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
          onClick={() => {
            // The tree panel's own refresh used to rescan project skills; the
            // root row is now the only refresh affordance (issue #234 review).
            setRefreshSignal((s) => s + 1)
            bumpSkillsScanVersion()
          }}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div hidden={collapsed && !shouldReveal}>
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
          showHeader={false}
          gitBranch={gitBranch}
          refreshSignal={refreshSignal}
        />
      </div>
    </div>
  )
})

/**
 * ResourceTabPanel — isolated from conversation state to avoid re-rendering
 * during agent streaming. Only re-renders when its own props change.
 */
export const ResourceTabPanel = memo(function ResourceTabPanel({
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
  activeProjectId,
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
  activeProjectId: string | null
  t: (key: string, params?: Record<string, string | number>) => string
}) {
  // Root collapse state for multi-root file tree
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(new Set())

  // OPFS-only draft content: when no folder is mounted, files written by the
  // LLM land in the virtual __opfs__ root. The empty state must only show
  // while that root is actually empty — otherwise generated files become
  // invisible (regression from #46's unconditional empty-state branch).
  const opfsPendingChanges = useOPFSStore((s) => s.pendingChanges)
  const opfsCachedCount = useOPFSStore((s) => s.cachedPaths.length)
  // The tree only renders pending creates/modifies + cached paths — pure
  // deletion records produce no nodes, so they must not count as content.
  const opfsDisplayableCount =
    opfsPendingChanges.filter((c) => c.type !== 'delete').length + opfsCachedCount

  // "Choose local folder" empty-state button (#82): same entry as the topbar
  // FolderSelector's addFolder. In a side panel the in-panel
  // showDirectoryPicker is unreliable (crbug 40240444 family), so this
  // handler mirrors FolderSelector and hands off to the full-tab
  // /folder-pick page instead of calling addRoot() directly.
  const canPickDirectory = getRuntimeCapability().canPickDirectory
  const isSidePanel = isSidePanelMode()
  const addRoot = useFolderAccessStore((s) => s.addRoot)
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const handleChooseLocalFolder = useCallback(async () => {
    if (!canPickDirectory || isAddingFolder) return
    setIsAddingFolder(true)
    try {
      if (isSidePanel) {
        const url = new URL(window.location.href)
        url.hash = ''
        url.search = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''
        url.pathname = '/folder-pick'
        window.open(url.toString(), '_blank', 'noopener')
        return
      }
      await addRoot()
    } catch (error) {
      console.error('[Sidebar] Failed to open folder:', error)
    } finally {
      setIsAddingFolder(false)
    }
  }, [addRoot, canPickDirectory, isAddingFolder, isSidePanel, activeProjectId])

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
          roots.length === 1 && roots[0]?.id === '__opfs__' && opfsDisplayableCount === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="max-w-sm text-sm leading-7 text-muted-foreground">
                {/* text-balance: the title is long enough to wrap in a narrow
                    sidebar; without balancing, the last character can end up
                    alone on the second line (an orphan). Balance keeps the
                    two lines even. */}
                <h3 className="mb-4 text-center text-base font-semibold leading-6 text-balance text-secondary dark:text-secondary-foreground">
                  {t('sidebar.localFilesEmpty.title', { brand: t('projectHome.brand') })}
                </h3>
                <ul className="list-disc space-y-2 pl-5">
                  <li>{t('sidebar.localFilesEmpty.authorizedHint')}</li>
                  <li>{t('sidebar.localFilesEmpty.unlinkedHint')}</li>
                </ul>
                {/* Real mount entry (#82): same directory picker as the topbar
                    FolderSelector's addFolder. Hidden when the runtime has no
                    directory picker (side-panel handoff/mobile) — the text
                    hints above stay as the guidance there. */}
                {canPickDirectory && (
                  <div className="mt-5 flex justify-center">
                    <BrandButton
                      variant="outline"
                      className="h-9 gap-2 px-4 text-sm"
                      onClick={() => void handleChooseLocalFolder()}
                      disabled={isAddingFolder}
                    >
                      {isAddingFolder
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <FolderOpen className="h-4 w-4" />}
                      {t('projectRoots.chooseLocalFolder')}
                    </BrandButton>
                  </div>
                )}
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
