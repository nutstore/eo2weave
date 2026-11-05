/**
 * FileTreePanel - File tree component using brand design system
 *
 * Design Specifications:
 * - Font: text-xs (12px) for tree items
 * - Spacing: py-1.5 (6px vertical padding), px-3 (12px horizontal padding)
 * - Border radius: rounded-md (6px)
 * - Colors: Uses brand semantic colors (primary, secondary, danger, etc.)
 * - Hover state: bg-hover (hsl(var(--bg-hover)))
 * - Selected state: bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700
 *
 * Phase 3 Integration:
 * - Shows file modification status from OPFS pending changes
 * - Displays pending indicators (create/modify/delete) next to files
 *
 * Context Menu:
 * - Right-click on any node shows context menu
 * - "Copy Path" action copies file/directory path to clipboard
 */

import { useState, useCallback, useEffect, useMemo, useRef, memo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw, Copy, MousePointer2, Cloud, Trash2 } from 'lucide-react'
import { BrandButton, BrandBadge } from '@creatorweave/ui'
import { formatBytes } from '@/lib/utils'
import { FileIcon } from '@/lib/file-icons'
import { useOPFSStore } from '@/store/opfs.store'
import { useWorkspaceStore } from '@/store/workspace.store'
import { useSkillsStore } from '@/store/skills.store'
import { SidebarPanelHeader } from '@/components/layout/SidebarPanelHeader'
import { useT } from '@/i18n'
import {
  isTreeEntryIgnored,
  parseTreeIgnoreRules,
  treeIgnoreRulesFor,
  withDirectoryIgnoreRules,
  type GitIgnoreRule,
  type TreeIgnoreRules,
} from '@/components/file-viewer/file-tree-ignore'
import { readDirectoryIgnoreRules } from '@/vfs/gitignore-discovery'
import type { PendingChange } from '@/opfs/types/opfs-types'
import type { DiskExecutor } from '@/opfs/native-disk/executor'

const HIDDEN_PATTERNS = [
  /^\.DS_Store$/, // macOS .DS_Store
  /^\.AppleDouble$/, // macOS .AppleDouble
  /^\.LSOverride$/, // macOS .LSOverride
  /^\._/, // macOS resource fork files (._filename)
  /^\.git$/, // .git directory
  /^\.svn$/, // .svn directory
  /^\.hg$/, // .hg directory
  /^node_modules$/, // node_modules directory
]

/** File tree node */
interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  children?: TreeNode[]
  loaded?: boolean
  /** File handle - null indicates OPFS-only file (not on disk) */
  handle: FileSystemDirectoryHandle | FileSystemFileHandle | null
}

interface FileTreePanelBaseProps {
  directoryHandle: FileSystemDirectoryHandle | null
  /**
   * Persistent disk root ID for a non-FS-Access root (currently a Native Host
   * scope). When set, disk entries are loaded through diskExecutor instead of
   * a FileSystemDirectoryHandle.
   */
  diskRootId?: string | null
  diskExecutor?: (Pick<DiskExecutor, 'listDir'> & Partial<Pick<DiskExecutor, 'read'>>) | null
  rootName?: string | null
  /** Prefix for OPFS path matching in multi-root mode (e.g., "my-app"). Pending/cached paths in OPFS store use "{prefix}/path" format. */
  pathPrefix?: string | null
  selectedPath?: string | null
  showHeader?: boolean
  /**
   * Increment to trigger a tree refresh from outside (used in multi-root mode
   * where showHeader=false hides the built-in refresh button).
   */
  refreshSignal?: number
  /**
   * When set, the tree will programmatically expand all ancestor directories
   * to make this file visible, select it, and scroll it into view.
   * The value is a relative path within this root (no rootName prefix).
   * Set to null to clear.
   */
  revealTarget?: string | null
  /** Called when revealTarget has been processed (tree expanded & file selected) */
  onRevealComplete?: () => void
  /** Called when user requests to delete a file/directory from context menu */
  onDelete?: (path: string, node: TreeNode, pos: { x: number; y: number }) => void
}

type FileTreePanelProps =
  | (FileTreePanelBaseProps & {
      mode?: 'all'
      onFileSelect: (path: string, handle: FileSystemFileHandle | null) => void
      onDirectorySelect?: (path: string, handle: FileSystemDirectoryHandle) => void
      onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
    })
  | (FileTreePanelBaseProps & {
      mode: 'directories'
      onFileSelect?: (path: string, handle: FileSystemFileHandle | null) => void
      onDirectorySelect?: (path: string, handle: FileSystemDirectoryHandle) => void
      onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
    })

/** Pending status badge using brand badge component */
function PendingIndicator({ type }: { type: PendingChange['type'] | null }) {
  const t = useT()
  if (!type) return null

  const variantMap = {
    create: 'success' as const,
    modify: 'warning' as const,
    delete: 'error' as const,
  }

  const labelMap = {
    create: 'A',
    modify: 'M',
    delete: 'D',
  }

  const titleKeyMap = {
    create: 'fileTree.pending.create',
    modify: 'fileTree.pending.modify',
    delete: 'fileTree.pending.delete',
  }

  return (
    <BrandBadge
      type="badge"
      variant={variantMap[type]}
      shape="pill"
      className="h-4 min-w-4 px-1 text-[10px] font-mono"
      title={t(titleKeyMap[type])}
    >
      {labelMap[type]}
    </BrandBadge>
  )
}

/** Approved but not synced to disk indicator */
function ApprovedNotSyncedIndicator() {
  const t = useT()
  return (
    <BrandBadge
      type="badge"
      variant="neutral"
      shape="pill"
      className="h-4 min-w-4 px-1 text-[10px] font-mono"
      title={t('fileTree.approvedNotSynced')}
    >
      <Cloud className="h-2.5 w-2.5" />
    </BrandBadge>
  )
}

/** Global context menu close event name */
const CONTEXT_MENU_CLOSE_EVENT = 'file-tree-close-context-menu'

/** Emit event to close all context menus */
function closeAllContextMenus() {
  document.dispatchEvent(new CustomEvent(CONTEXT_MENU_CLOSE_EVENT))
}

/** Single tree node row with custom context menu */
const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  expanded,
  selected,
  pendingType,
  approvedNotSynced,
  gitIgnored,
  rootName,
  onClick,
  onInspect,
  onDelete,
}: {
  node: TreeNode
  depth: number
  expanded: boolean
  selected: boolean
  pendingType: PendingChange['type'] | null
  approvedNotSynced: boolean
  gitIgnored: boolean
  rootName?: string | null
  onClick: () => void
  onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
  onDelete?: (path: string, node: TreeNode, pos: { x: number; y: number }) => void
}) {
  const t = useT()
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 })
  const rowRef = useRef<HTMLDivElement>(null)
  const isDir = node.kind === 'directory'
  const indent = depth * 16

  /** Handle right-click to show context menu */
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    // Close all other context menus first
    closeAllContextMenus()
    setContextMenuPos({ x: e.clientX, y: e.clientY })
    setContextMenuOpen(true)
  }

  /** Close context menu */
  const handleCloseMenu = () => {
    setContextMenuOpen(false)
  }

  /** Copy path to clipboard (with rootName prefix for multi-root mode) */
  const handleCopyPath = async () => {
    try {
      const fullPath = rootName ? `${rootName}/${node.path}` : node.path
      await navigator.clipboard.writeText(fullPath)
    } catch (error) {
      console.error('[FileTree] Failed to copy path:', error)
    }
    handleCloseMenu()
  }

  /** Listen for close event from other nodes */
  useEffect(() => {
    const handleCloseEvent = () => {
      setContextMenuOpen(false)
    }
    document.addEventListener(CONTEXT_MENU_CLOSE_EVENT, handleCloseEvent)
    return () => document.removeEventListener(CONTEXT_MENU_CLOSE_EVENT, handleCloseEvent)
  }, [])

  /** Click outside to close menu */
  useEffect(() => {
    if (!contextMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) {
        handleCloseMenu()
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [contextMenuOpen])

  return (
    <>
      <div
        ref={rowRef}
        data-tree-path={node.path}
        data-git-ignored={gitIgnored || undefined}
        className={`group flex cursor-pointer items-center gap-2 rounded-md h-7 pr-3 text-xs transition-colors ${
          selected
            ? 'bg-primary-50 text-primary-700 dark:bg-primary-100/30 dark:text-primary-700'
            : 'hover:bg-hover text-secondary'
        } ${gitIgnored ? 'opacity-50 grayscale' : ''}`}
        style={{ paddingLeft: `${indent + 4}px` }}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        title={gitIgnored ? `${node.path} • Git ignored` : node.path}
      >
        {/* Expand/collapse arrow (directories only) */}
        {isDir && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {expanded ? (
              <ChevronDown className="text-tertiary h-3.5 w-3.5 transition-transform" />
            ) : (
              <ChevronRight className="text-tertiary h-3.5 w-3.5 transition-transform" />
            )}
          </span>
        )}

        {/* Icon */}
        {isDir ? (
          expanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-warning" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-warning" />
          )
        ) : (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <FileIcon filename={node.name} className="h-3.5 w-3.5 shrink-0" />
          </span>
        )}

        {/* Name */}
        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>

        {/* Size for files */}
        {!isDir && node.size !== undefined && node.size > 0 && (
          <span className="text-tertiary shrink-0 text-xs tabular-nums">
            {formatBytes(node.size)}
          </span>
        )}

        {/* Pending status indicator */}
        {!isDir && <PendingIndicator type={pendingType} />}
        {/* Only show cloud icon for approved-but-not-synced files */}
        {!isDir && approvedNotSynced && !pendingType && <ApprovedNotSyncedIndicator />}
      </div>

      {/* Context Menu Portal */}
      {contextMenuOpen &&
        createPortal(
          <div
            className="z-dropdown fixed min-w-[6rem] overflow-hidden rounded border bg-popover py-0.5 shadow-md"
            style={{ left: contextMenuPos.x + 20, top: contextMenuPos.y }}
          >
            <button
              className="flex w-full cursor-default items-center gap-1 px-2 py-1 text-xs outline-none hover:bg-accent"
              onClick={handleCopyPath}
            >
              <Copy className="h-3 w-3" />
              <span>{t('fileTree.copyPath')}</span>
            </button>
            {!isDir && onInspect && node.path.endsWith('.html') && (
              <button
                className="flex w-full cursor-default items-center gap-1 px-2 py-1 text-xs outline-none hover:bg-accent"
                onClick={() => {
                  onInspect(node.path, node.handle as FileSystemFileHandle)
                  handleCloseMenu()
                }}
              >
                <MousePointer2 className="h-3 w-3" />
                <span>{t('fileTree.inspectElement')}</span>
              </button>
            )}
            {onDelete && (
              <>
                <div className="my-0.5 border-t border-border" />
                <button
                  className="flex w-full cursor-default items-center gap-1 px-2 py-1 text-xs outline-none text-danger hover:bg-danger/10"
                  onClick={() => {
                    onDelete(node.path, node, contextMenuPos)
                    handleCloseMenu()
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  <span>{t('fileTree.deleteFile')}</span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </>
  )
})

/** Recursive tree component */
const TreeBranch = memo(function TreeBranch({
  nodes,
  depth,
  expandedPaths,
  selectedPath,
  pendingMap,
  isGitIgnored,
  onToggle,
  onNodeClick,
  onInspect,
  onDelete,
  approvedNotSyncedPaths,
  rootName,
}: {
  nodes: TreeNode[]
  depth: number
  expandedPaths: Set<string>
  selectedPath: string | null
  pendingMap: Map<string, PendingChange['type']>
  isGitIgnored: (node: TreeNode) => boolean
  approvedNotSyncedPaths: Set<string>
  rootName?: string | null
  onToggle: (node: TreeNode) => void
  onNodeClick: (node: TreeNode) => void
  onInspect?: (path: string, handle: FileSystemFileHandle | null) => void
  onDelete?: (path: string, node: TreeNode, pos: { x: number; y: number }) => void
}) {
  // Sort: directories first, then alphabetically
  const sorted = [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {sorted.map((node) => {
        const expanded = expandedPaths.has(node.path)
        const selected = selectedPath === node.path
        const pendingType = pendingMap.get(node.path) || null
        const approvedNotSynced = approvedNotSyncedPaths.has(node.path)
        const gitIgnored = isGitIgnored(node)

        return (
          <div key={node.path}>
            <TreeNodeRow
              node={node}
              depth={depth}
              expanded={expanded}
              selected={selected}
              pendingType={pendingType}
              approvedNotSynced={approvedNotSynced}
              gitIgnored={gitIgnored}
              rootName={rootName}
              onClick={() => onNodeClick(node)}
              onInspect={onInspect ? (path, handle) => onInspect(path, handle) : undefined}
              onDelete={onDelete}
            />
            {expanded && node.children && (
              <TreeBranch
                nodes={node.children}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                selectedPath={selectedPath}
                pendingMap={pendingMap}
                isGitIgnored={isGitIgnored}
                approvedNotSyncedPaths={approvedNotSyncedPaths}
                rootName={rootName}
                onToggle={onToggle}
                onNodeClick={onNodeClick}
                onInspect={onInspect}
                onDelete={onDelete}
              />
            )}
          </div>
        )
      })}
    </>
  )
})

export const FileTreePanel = memo(function FileTreePanel({
  directoryHandle,
  diskRootId = null,
  diskExecutor = null,
  rootName,
  pathPrefix,
  onFileSelect,
  onDirectorySelect,
  onInspect,
  onDelete,
  selectedPath,
  mode = 'all',
  showHeader = true,
  refreshSignal = 0,
  revealTarget,
  onRevealComplete,
}: FileTreePanelProps) {
  const t = useT()
  const [rootNodes, setRootNodes] = useState<TreeNode[]>([])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gitIgnoreRulesByDir, setGitIgnoreRulesByDir] = useState<TreeIgnoreRules>(() => new Map())
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const bumpSkillsScanVersion = useSkillsStore((s) => s.bumpSkillsScanVersion)

  // Get pending changes and cached files from OPFS store
  const pendingChanges = useOPFSStore((state) => state.pendingChanges)
  const approvedNotSyncedPaths = useOPFSStore((state) => state.approvedNotSyncedPaths)
  const cachedPaths = useOPFSStore((state) => state.cachedPaths)

  // Prefix for OPFS path matching: in multi-root mode, OPFS paths include the root name
  const prefix = pathPrefix ? `${pathPrefix}/` : ''

  // Filter approved-not-synced paths to only those belonging to this root
  const rootApprovedNotSyncedPaths = useMemo(() => {
    if (!prefix) return approvedNotSyncedPaths
    const result = new Set<string>()
    for (const p of approvedNotSyncedPaths) {
      if (p.startsWith(prefix)) {
        result.add(p.slice(prefix.length))
      }
    }
    return result
  }, [approvedNotSyncedPaths, prefix])

  // Filter pending changes to only those belonging to this root, stripping the prefix
  const rootPendingChanges = useMemo(() => {
    if (!prefix) return pendingChanges
    return pendingChanges
      .filter((c) => c.path.startsWith(prefix))
      .map((c) => ({ ...c, path: c.path.slice(prefix.length) }))
  }, [pendingChanges, prefix])

  // Filter cached paths to only those belonging to this root, stripping the prefix
  const rootCachedPaths = useMemo(() => {
    if (!prefix) return cachedPaths
    return cachedPaths
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
  }, [cachedPaths, prefix])

  // Build a map of local file paths to pending change types for O(1) lookup
  const pendingMap = useMemo(() => {
    const map = new Map<string, PendingChange['type']>()
    for (const change of rootPendingChanges) {
      map.set(change.path, change.type)
    }
    return map
  }, [rootPendingChanges])

  /** Get pending create changes that belong to a specific parent directory */
  const getPendingCreatesForPath = useCallback(
    (parentPath: string): PendingChange[] => {
      return rootPendingChanges.filter((change) => {
        if (change.type !== 'create') return false
        // Check if the file's parent matches the parentPath
        const parentOfFile = change.path.split('/').slice(0, -1).join('/')
        return parentOfFile === parentPath
      })
    },
    [rootPendingChanges]
  )

  /** Get pending create subdirectory names that don't exist on disk */
  const getPendingCreateSubdirs = useCallback(
    (parentPath: string, diskSubdirs: Set<string>): string[] => {
      const subdirs = new Set<string>()
      for (const change of rootPendingChanges) {
        if (change.type !== 'create') continue
        // Check if the path is under parentPath
        const expectedPrefix = parentPath ? `${parentPath}/` : ''
        if (!change.path.startsWith(expectedPrefix)) continue
        // Get the first subdirectory component
        const relative = change.path.slice(expectedPrefix.length)
        const parts = relative.split('/')
        if (parts.length >= 2) {
          // There's a subdirectory
          const subdir = parts[0]
          // Only add if it doesn't exist on disk
          if (!diskSubdirs.has(subdir)) {
            subdirs.add(subdir)
          }
        }
      }
      return Array.from(subdirs)
    },
    [rootPendingChanges]
  )

  /** Check if a file/directory name should be hidden */
  const isHidden = useCallback(
    (name: string): boolean => HIDDEN_PATTERNS.some((pattern) => pattern.test(name)),
    []
  )

  /**
   * Add cached files at a specific level to children array
   * Only adds files that are directly in the parent directory (not in subdirectories)
   */
  const addCachedFilesAtLevel = useCallback(
    (
      children: TreeNode[],
      cachedPaths: string[],
      parentPath: string,
      existingNames: Set<string>,
      pendingCreates: PendingChange[]
    ): void => {
      const parentPrefix = parentPath ? `${parentPath}/` : ''

      for (const cachedPath of cachedPaths) {
        // Check if this cached file is directly in the parent directory
        if (parentPrefix && !cachedPath.startsWith(parentPrefix)) continue
        if (parentPrefix) {
          const relative = cachedPath.slice(parentPrefix.length)
          const parts = relative.split('/')
          if (parts.length !== 1) continue // Not directly in this directory
        } else {
          // Root level: no subdirectory allowed
          const parts = cachedPath.split('/')
          if (parts.length !== 1) continue
        }

        const fileName = parentPrefix ? cachedPath.slice(parentPrefix.length).split('/')[0] : cachedPath.split('/')[0]
        if (existingNames.has(fileName)) continue
        // Skip if this file has a pending create (handled above)
        if (pendingCreates.some((p) => p.path === cachedPath)) continue

        children.push({
          name: fileName,
          path: cachedPath,
          kind: 'file' as const,
          handle: null, // OPFS-only file
        })

      }
    },
    []
  )

  /**
   * Add cached subdirectories at a specific level to children array.
   * This keeps approved (non-pending) OPFS files navigable in tree mode.
   */
  const addCachedSubdirsAtLevel = useCallback(
    (
      children: TreeNode[],
      cachedPaths: string[],
      parentPath: string,
      existingNames: Set<string>
    ): void => {
      const parentPrefix = parentPath ? `${parentPath}/` : ''

      for (const cachedPath of cachedPaths) {
        if (parentPrefix && !cachedPath.startsWith(parentPrefix)) continue
        const relative = parentPrefix ? cachedPath.slice(parentPrefix.length) : cachedPath
        const parts = relative.split('/').filter(Boolean)
        if (parts.length < 2) continue

        const subdirName = parts[0]
        if (existingNames.has(subdirName)) continue

        const subdirPath = parentPath ? `${parentPath}/${subdirName}` : subdirName
        children.push({
          name: subdirName,
          path: subdirPath,
          kind: 'directory',
          handle: null,
          children: [],
          loaded: false,
        })
        existingNames.add(subdirName)

      }
    },
    []
  )

  /**
   * Read this directory's own .gitignore — its rules govern that directory's
   * entries only. Both load paths behave the same: the disk executor read and
   * the OPFS handle reuse the helpers web/vfs/gitignore-discovery.ts gives the
   * discovery walk, so tree rows dim exactly the entries the delete flow
   * treats as ignored (#189).
   */
  const readDirectoryRules = useCallback(
    async (dirHandle: FileSystemDirectoryHandle | null, dirPath: string): Promise<GitIgnoreRule[]> => {
      if (diskRootId && diskExecutor?.read) {
        try {
          const result = await diskExecutor.read(diskRootId, dirPath ? `${dirPath}/.gitignore` : '.gitignore')
          return typeof result.content === 'string' ? parseTreeIgnoreRules(result.content, dirPath) : []
        } catch {
          return [] // A missing or unreadable .gitignore must not block the tree.
        }
      }
      if (dirHandle) {
        // Own rules only; withDirectoryIgnoreRules below prepends the inherited set.
        return readDirectoryIgnoreRules(dirHandle, dirPath, [])
      }
      return []
    },
    [diskExecutor, diskRootId]
  )

  /** Load children from a browser handle, a routed disk executor, or OPFS. */
  const loadChildren = useCallback(
    async (dirHandle: FileSystemDirectoryHandle | null, parentPath: string): Promise<TreeNode[]> => {
      const children: TreeNode[] = []
      const allEntries: string[] = []

      if (diskRootId && diskExecutor) {
        // The directory may exist only in OPFS (pending creates or
        // approved-but-not-yet-synced cached files) while missing on disk.
        // Native-host list_dir then reports "directory not found" — the same
        // situation search.worker.ts handles with its overlay fallback. If
        // OPFS has anything under this path prefix, keep going with an empty
        // disk listing; the OPFS merges below populate the node.
        const parentPrefix = parentPath ? `${parentPath}/` : ''
        const hasOpfsContent =
          rootPendingChanges.some(
            (c) => c.type === 'create' && c.path.startsWith(parentPrefix)
          ) || rootCachedPaths.some((p) => p.startsWith(parentPrefix))
        try {
          const entries = await diskExecutor.listDir(diskRootId, parentPath)
          for (const entry of entries) {
            const { name } = entry
            allEntries.push(name)
            if (isHidden(name)) continue

            const path = parentPath ? `${parentPath}/${name}` : name
            if (entry.kind === 'file') {
              if (mode === 'directories') continue
              children.push({
                name,
                path,
                kind: 'file',
                size: entry.stat?.size,
                handle: null,
              })
            } else {
              children.push({
                name,
                path,
                kind: 'directory',
                handle: null,
                children: [],
                loaded: false,
              })
            }
          }
        } catch (error) {
          if (!hasOpfsContent) throw error
          console.warn(`[FileTree] Not on disk yet, rendering OPFS-only content: ${parentPath || '/'}`)
        }
      } else if (dirHandle !== null) {
        for await (const entry of dirHandle.entries()) {
          const [name, handle] = entry
          allEntries.push(name)

          // Skip hidden files like .DS_Store
          if (isHidden(name)) {
            continue
          }
          const path = parentPath ? `${parentPath}/${name}` : name

          if (handle.kind === 'file') {
            if (mode === 'directories') continue
            const fileHandle = handle as FileSystemFileHandle
            try {
              const file = await fileHandle.getFile()
              children.push({ name, path, kind: 'file', size: file.size, handle: fileHandle })
            } catch (err) {
              console.warn('[FileTree] Failed to get file details for:', name, err)
              children.push({ name, path, kind: 'file', handle: fileHandle })
            }
          } else {
            children.push({
              name,
              path,
              kind: 'directory',
              handle: handle as FileSystemDirectoryHandle,
              children: [],
              loaded: false,
            })
          }
        }
      }


      // Merge pending create files into children
      const pendingCreates = getPendingCreatesForPath(parentPath)
      for (const pending of pendingCreates) {
        const fileName = pending.path.split('/').pop()!
        // Skip if already exists on disk
        if (children.some((c) => c.name === fileName)) {
          continue
        }
        // Add pending create file (handle is null since it's OPFS-only)
        children.push({
          name: fileName,
          path: pending.path,
          kind: 'file',
          handle: null, // OPFS-only file
        })

      }

      // Add pending create subdirectories that don't exist on disk
      const diskSubdirs = new Set(
        children.filter((c) => c.kind === 'directory').map((c) => c.name)
      )
      const pendingSubdirs = getPendingCreateSubdirs(parentPath, diskSubdirs)
      for (const subdir of pendingSubdirs) {
        const subdirPath = parentPath ? `${parentPath}/${subdir}` : subdir
        children.push({
          name: subdir,
          path: subdirPath,
          kind: 'directory',
          handle: null, // OPFS-only directory
          children: [],
          loaded: false,
        })

      }

      // Add subdirectories inferred from cached OPFS files.
      // Needed when changes are approved (no longer pending) but not yet synced to disk.
      const namesAfterPendingSubdirs = new Set(children.map((c) => c.name))
      addCachedSubdirsAtLevel(children, rootCachedPaths, parentPath, namesAfterPendingSubdirs)

      // Add cached files from OPFS that are not already in children
      // and not pending creates (already handled above)
      // This works for both OPFS-only mode (dirHandle=null) and disk+OPFS mode
      const existingNames = new Set(children.map((c) => c.name))
      addCachedFilesAtLevel(children, rootCachedPaths, parentPath, existingNames, pendingCreates)

      // Keep this directory's .gitignore with the rules inherited above it so
      // entries below it are checked against root + ancestor rules.
      const ownRules = await readDirectoryRules(dirHandle, parentPath)
      setGitIgnoreRulesByDir((prev) => withDirectoryIgnoreRules(prev, parentPath, ownRules))

      return children
    },
    [
      isHidden,
      mode,
      diskRootId,
      diskExecutor,
      getPendingCreatesForPath,
      getPendingCreateSubdirs,
      rootCachedPaths,
      rootPendingChanges,
      addCachedFilesAtLevel,
      addCachedSubdirsAtLevel,
      readDirectoryRules,
    ]
  )

  const isGitIgnored = useCallback(
    (node: TreeNode) =>
      isTreeEntryIgnored({ path: node.path, kind: node.kind }, treeIgnoreRulesFor(node.path, gitIgnoreRulesByDir)),
    [gitIgnoreRulesByDir]
  )

  /**
   * Load root directory and optionally reload expanded paths.
   *
   * loadChildren also re-reads each directory's .gitignore, so the dimmed rows
   * track .gitignore edits on every refresh.
   */
  const loadRoot = useCallback(
    async (preserveExpanded: boolean = false) => {
      setLoading(true)
      try {
        const children = await loadChildren(directoryHandle ?? null, '')
        setRootNodes(children)
        setLoaded(true)
        setLoadError(null)

        // If preserving expanded state, recursively reload all expanded directories
        if (preserveExpanded && expandedPaths.size > 0) {
          const reloadExpanded = async (nodes: TreeNode[]): Promise<void> => {
            for (const node of nodes) {
              if (node.kind === 'directory' && expandedPaths.has(node.path)) {
                try {
                  const childNodes = await loadChildren(
                    node.handle as FileSystemDirectoryHandle,
                    node.path
                  )
                  node.children = childNodes
                  node.loaded = true
                  // Recursively reload nested expanded directories
                  await reloadExpanded(childNodes)
                } catch (error) {
                  console.error(`[FileTree] Failed to reload ${node.path}:`, error)
                }
              }
            }
          }
          await reloadExpanded(children)
          setRootNodes((prev) => [...prev])
        }
      } catch (error) {
        console.error('[FileTree] Failed to load root:', error)
        // Mark as loaded even on error to prevent infinite reload loop.
        // When directoryHandle points to a deleted/inaccessible directory,
        // loadChildren throws (e.g. NotFoundError). Without setLoaded(true),
        // the auto-load effect would keep re-triggering because
        // !loaded && !loading stays true, causing "加载中" to flash forever.
        setRootNodes([])
        setLoaded(true)
        setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        setLoading(false)
      }
    },
    [directoryHandle, loadChildren, expandedPaths]
  )

  const handleRefresh = useCallback(() => {
    void loadRoot(true)
    bumpSkillsScanVersion()
  }, [loadRoot, bumpSkillsScanVersion])

  /** Toggle directory expand/collapse */
  const handleToggle = useCallback(
    async (node: TreeNode) => {
      if (node.kind !== 'directory') return

      const isExpanded = expandedPaths.has(node.path)
      const next = new Set(expandedPaths)

      if (isExpanded) {
        next.delete(node.path)
        setExpandedPaths(next)
        return
      }

      // Load children if not yet loaded
      if (!node.loaded) {
        try {
          // If node.handle is null (OPFS-only directory), pass null to loadChildren
          // which will only load pending creates
          const children = await loadChildren(
            node.handle as FileSystemDirectoryHandle | null,
            node.path
          )
          node.children = children
          node.loaded = true
          // Force re-render by creating new array
          setRootNodes((prev) => [...prev])
        } catch (error) {
          console.error(`[FileTree] Failed to load ${node.path}:`, error)
          return
        }
      }

      next.add(node.path)
      setExpandedPaths(next)
    },
    [expandedPaths, loadChildren]
  )

  /** Handle file click */
  const handleFileSelect = useCallback(
    (node: TreeNode) => {
      if (node.kind === 'directory') {
        onDirectorySelect?.(node.path, node.handle as FileSystemDirectoryHandle)
        void handleToggle(node)
        return
      }
      if (node.kind === 'file') {
        onFileSelect?.(node.path, node.handle as FileSystemFileHandle)
      }
    },
    [onFileSelect, onDirectorySelect, handleToggle]
  )

  /**
   * Generation counter to cancel in-flight revealPath operations when
   * the tree is reset (project switch, directoryHandle change, etc.)
   */
  const revealGenRef = useRef(0)

  /**
   * Programmatically expand the tree to reveal a target file path.
   * Works by iteratively finding each directory segment, loading its children
   * if needed, and expanding it. Finally selects the target file.
   */
  const revealPath = useCallback(
    async (targetPath: string): Promise<void> => {
      if (!targetPath) return

      // Wait for initial load to complete
      if (!loaded || loading) return

      const gen = revealGenRef.current
      const segments = targetPath.split('/')
      const newExpanded = new Set(expandedPaths)
      let currentNodes = rootNodes
      let mutated = false

      // Walk through each directory segment (all except the last = file)
      for (let i = 0; i < segments.length - 1; i++) {
        // Check if tree was reset during async operation
        if (revealGenRef.current !== gen) return

        const dirPath = segments.slice(0, i + 1).join('/')

        // Find the directory node at current level
        const found = currentNodes.find((n) => n.path === dirPath)

        if (!found) {
          console.warn(`[FileTree] revealPath: directory "${dirPath}" not found in tree`)
          break
        }

        if (found.kind !== 'directory') {
          console.warn(`[FileTree] revealPath: "${dirPath}" is not a directory`)
          break
        }

        // Load children if not yet loaded
        if (!found.loaded) {
          try {
            const children = await loadChildren(
              found.handle as FileSystemDirectoryHandle | null,
              found.path
            )
            // Check cancellation after async
            if (revealGenRef.current !== gen) return
            found.children = children
            found.loaded = true
            mutated = true
          } catch (error) {
            console.error(`[FileTree] revealPath: failed to load "${found.path}":`, error)
            return
          }
        }

        // Expand this directory
        if (!newExpanded.has(found.path)) {
          newExpanded.add(found.path)
        }

        // Move into children for next iteration
        currentNodes = found.children || []
      }

      // Final cancellation check before applying state
      if (revealGenRef.current !== gen) return

      // Apply expanded paths
      setExpandedPaths(newExpanded)
      if (mutated) {
        setRootNodes((prev) => [...prev])
      }

      // Find the target file node to select it (trigger onFileSelect)
      const targetFileName = segments[segments.length - 1]
      const targetNode = currentNodes.find(
        (n) => n.name === targetFileName && n.kind === 'file'
      )
      if (targetNode) {
        onFileSelect?.(targetNode.path, targetNode.handle as FileSystemFileHandle)
      }

      // Scroll into view after React renders
      requestAnimationFrame(() => {
        if (revealGenRef.current !== gen) return
        const selectedEl = document.querySelector(
          `[data-tree-path="${CSS.escape(targetPath)}"]`
        )
        if (selectedEl) {
          selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      })
    },
    [loaded, loading, expandedPaths, rootNodes, loadChildren, onFileSelect]
  )

  // React to revealTarget prop changes
  useEffect(() => {
    if (!revealTarget || !loaded) return
    let cancelled = false
    revealPath(revealTarget).then(() => {
      if (!cancelled) onRevealComplete?.()
    })
    return () => { cancelled = true }
  }, [revealTarget, loaded, revealPath, onRevealComplete])

  // Reset states when directoryHandle changes or workspace switches.
  // NOTE: We intentionally do NOT block loading when activeWorkspaceId is null.
  // A brand-new project may have roots (directoryHandle) but no conversations yet,
  // and users should still be able to browse files in the tree before creating one.
  useEffect(() => {
    // Bump generation to cancel any in-flight revealPath
    revealGenRef.current++
    setLoaded(false)
    setLoading(false)
    setLoadError(null)
    setGitIgnoreRulesByDir(new Map())
    setExpandedPaths(new Set())
    setRootNodes([])
  }, [directoryHandle, diskRootId, diskExecutor, activeWorkspaceId])

  // Auto-load root when not loaded and not loading.
  // directoryHandle may be null (OPFS-only mode) — loadChildren handles that.
  useEffect(() => {
    if (!loaded && !loading) {
      loadRoot()
    }
  }, [directoryHandle, loaded, loading, loadRoot, activeWorkspaceId])

  // Stable ref to latest loadRoot — used by effects below to avoid re-triggering
  // when loadRoot rebuilds due to expandedPaths / cachedPaths changes.
  const loadRootRef = useRef(loadRoot)
  loadRootRef.current = loadRoot

  // Re-load tree when pendingChanges or cachedPaths change (e.g. after Python execution)
  // so newly created OPFS files appear in the tree without manual refresh.
  const prevPendingLenRef = useRef(pendingChanges.length)
  const prevCachedLenRef = useRef(cachedPaths.length)
  useEffect(() => {
    if (!loaded || loading) return
    const pendingChanged = prevPendingLenRef.current !== pendingChanges.length
    const cachedChanged = prevCachedLenRef.current !== cachedPaths.length
    prevPendingLenRef.current = pendingChanges.length
    prevCachedLenRef.current = cachedPaths.length
    if (pendingChanged || cachedChanged) {
      loadRootRef.current(true)
    }
  }, [pendingChanges.length, cachedPaths.length, loaded, loading])

  const prevWorkspaceIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeWorkspaceId) {
      prevWorkspaceIdRef.current = null
      return
    }
    if (prevWorkspaceIdRef.current === activeWorkspaceId) return
    prevWorkspaceIdRef.current = activeWorkspaceId
    loadRootRef.current(true)
  }, [activeWorkspaceId])

  // External refresh trigger (multi-root mode: the built-in header refresh
  // button is hidden, so the parent signals refreshes via refreshSignal).
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    if (!loaded && !loading) return
    void loadRootRef.current(true)
  }, [refreshSignal, loaded, loading])

  // Show empty state only if no disk root, pending changes, or cached files exist.
  const hasPendingChanges = pendingChanges.length > 0
  const hasCachedFiles = cachedPaths.length > 0
  if (!directoryHandle && !diskRootId && !hasPendingChanges && !hasCachedFiles) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-tertiary text-center text-xs">
          {t('fileTree.emptyStateHint')}
          <br />
          {t('fileTree.emptyStateDescription')}
        </p>
      </div>
    )
  }

  return (
      <div className="flex h-full flex-col">
      {showHeader && (
        <SidebarPanelHeader
          title={rootName || directoryHandle?.name || t('fileTree.draftFiles')}
          right={
            <BrandButton
              iconButton
              variant="ghost"
              className="h-6 w-6"
              onClick={handleRefresh}
              title={t('common.refresh')}
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </BrandButton>
          }
        />
      )}

      {/* Tree */}
      <div className="custom-scrollbar flex-1 overflow-y-auto">
        <div className="px-1.5 py-1.5">
          {loading && rootNodes.length === 0 ? (
            <div className="text-tertiary p-4 text-center text-xs">{t('common.loading')}</div>
          ) : loadError && rootNodes.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-danger text-xs">{t('fileTree.loadFailed')}</p>
              <p className="text-tertiary mt-1 text-[11px]">{loadError}</p>
              <button
                type="button"
                className="mt-2 text-xs text-primary underline hover:no-underline"
                onClick={handleRefresh}
              >
                {t('common.refresh')}
              </button>
            </div>
          ) : (
            <TreeBranch
              nodes={rootNodes}
              depth={0}
              expandedPaths={expandedPaths}
              selectedPath={selectedPath || null}
              pendingMap={pendingMap}
              isGitIgnored={isGitIgnored}
              approvedNotSyncedPaths={rootApprovedNotSyncedPaths}
              rootName={rootName}
              onToggle={handleToggle}
              onNodeClick={handleFileSelect}
              onInspect={onInspect}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    </div>
  )
})
