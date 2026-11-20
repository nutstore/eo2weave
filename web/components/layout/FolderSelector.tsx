/**
 * FolderSelector - Multi-root folder management component
 *
 * Features:
 * - No roots: show "Open Folder" button → addRoot
 * - Has roots: show root chips + [+] add button
 * - Each chip: root name, lock icon if read-only
 * - Chip dropdown: restore permission, toggle read-only, remove
 * - Handles permission restoration
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  FolderOpen,
  Plus,
  Lock,
  X,
  RefreshCw,
  Loader2,
  HardDrive,
  Globe2,
  MoreHorizontal,
} from 'lucide-react'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { useT } from '@/i18n'
import { restoreRootPermission } from '@/lib/folder-permission'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@creatorweave/ui'
import { useNativeHostPing } from '@/hooks/useNativeHostPing'
import { cn } from '@/lib/utils'
import type { RootInfo } from '@/types/folder-access'

export function FolderSelector() {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)

  // Multi-root state
  const { roots, activeProjectId, addRoot, adoptPickedRoot, addNativeHostRoot, removeRoot, loadRoots, toggleReadOnly } =
    useFolderAccessStore()

  // UI state
  const [isRootsOpen, setIsRootsOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [isAddingNativeHost, setIsAddingNativeHost] = useState(false)

  const runtimeCapability = getRuntimeCapability()
  const canPickDirectory = runtimeCapability.canPickDirectory
  // Full-chain ping (page → extension → Rust host) instead of a shallow
  // bridge-existence probe: hides the "Local connection" button when the
  // Rust app is not installed. Re-probes on window focus.
  const nativeHostAvailable = useNativeHostPing() === 'available'

  // Load roots on mount/project change
  useEffect(() => {
    loadRoots()
  }, [activeProjectId, loadRoots])

  // Close the folder list when authorization changes the trigger shape.
  useEffect(() => {
    setIsRootsOpen(false)
  }, [roots.length])

  // Folder-pick handoff (side panel → full tab) ────────────────────────
  // Chromium's showDirectoryPicker is unreliable inside the side panel
  // (crbug 40240444 family): it can reject with AbortError even after a
  // successful selection — indistinguishable from a real cancel. When
  // running in that window shape, the add-folder entry hands off to a
  // dedicated full-tab picker (/folder-pick) instead; this listener adopts
  // the picked handle when the tab reports back over BroadcastChannel.
  const isSidePanel = isSidePanelMode()
  useEffect(() => {
    if (!isSidePanel) return
    let channel: BroadcastChannel | null = null
    try {
      channel = new BroadcastChannel('creatorweave-folder-pick')
    } catch {
      return
    }
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; name?: string; pickId?: string; projectId?: string | null } | null
      if (data?.type !== 'folder-picked' || !data.name || !data.pickId) return
      if (data.projectId !== null && data.projectId !== activeProjectId) return
      void adoptPickedRoot(data.name, data.pickId, data.projectId ?? null)
    }
    return () => {
      channel?.close()
    }
  }, [isSidePanel, activeProjectId, adoptPickedRoot])

  const handleAddRoot = useCallback(async () => {
    if (!canPickDirectory || isAdding) return
    // Side panel: hand off to the reliable full-tab picker instead of
    // calling the broken in-panel native picker.
    if (isSidePanel) {
      setIsAdding(true)
      try {
        const url = new URL(window.location.href)
        url.hash = ''
        url.search = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''
        url.pathname = '/folder-pick'
        window.open(url.toString(), '_blank', 'noopener')
      } finally {
        setIsAdding(false)
      }
      return
    }
    setIsAdding(true)
    try {
      await addRoot()
    } finally {
      setIsAdding(false)
    }
  }, [addRoot, canPickDirectory, isAdding, isSidePanel, activeProjectId])

  const handleAddNativeHostRoot = useCallback(async () => {
    if (!nativeHostAvailable || isAddingNativeHost) return
    setIsAddingNativeHost(true)
    try {
      await addNativeHostRoot()
    } finally {
      setIsAddingNativeHost(false)
    }
  }, [addNativeHostRoot, isAddingNativeHost, nativeHostAvailable])

  const handleRemoveRoot = useCallback(
    async (root: RootInfo) => {
      const confirmed = window.confirm(
        t('projectRoots.confirmRemove', { name: root.name })
      )
      if (!confirmed) return
      await removeRoot(root.id)
    },
    [removeRoot, t]
  )

  const handleRestorePermission = useCallback(
    async (root: RootInfo) => {
      if (!activeProjectId) return
      await restoreRootPermission({
        projectId: activeProjectId,
        root,
        sidePanel: isSidePanel,
        strings: {
          restored: t('projectRoots.permissionRestored'),
          denied: t('projectRoots.permissionDenied'),
          failed: t('projectRoots.permissionFailed'),
          timedOut: t('projectRoots.permissionTimedOut'),
        },
        loadRoots,
      })
    },
    [activeProjectId, isSidePanel, loadRoots, t]
  )

  const handleToggleReadOnly = useCallback(
    async (rootId: string) => {
      await toggleReadOnly(rootId)
    },
    [toggleReadOnly]
  )

  const addFolderMenu = (canPickDirectory || nativeHostAvailable) && (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={isAdding || isAddingNativeHost}
          aria-label={t('projectRoots.chooseLocalFolder')}
          className={cn(
            roots.length === 0
              ? 'flex h-7 items-center justify-center gap-1.5 rounded-md border border-border px-2 text-xs font-normal'
              : 'flex h-7 w-8 items-center justify-center rounded-none border-0 border-l border-gray-200 dark:border-neutral-700',
            'text-secondary transition-colors hover:bg-primary-50 hover:text-primary-600',
            'dark:border-border dark:hover:bg-muted',
            (isAdding || isAddingNativeHost) && 'cursor-wait opacity-70'
          )}
        >
          {isAdding || isAddingNativeHost ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : roots.length === 0 ? (
            <>
              <FolderOpen className="h-3.5 w-3.5" />
              <span>{t('projectRoots.chooseLocalFolder')}</span>
            </>
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]">
        {canPickDirectory && (
          <DropdownMenuItem onSelect={() => void handleAddRoot()}>
            <FolderOpen className="h-4 w-4" />
            <span>{t('projectRoots.openLocalFolder')}</span>
          </DropdownMenuItem>
        )}
        {canPickDirectory && nativeHostAvailable && <DropdownMenuSeparator />}
        {nativeHostAvailable && (
          <DropdownMenuItem onSelect={() => void handleAddNativeHostRoot()}>
            <HardDrive className="h-4 w-4" />
            <span>{t('projectRoots.openViaNativeHost')}</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // No roots: keep both authorization methods behind the same add control.
  if (roots.length === 0) {
    return (
      <div className="relative flex items-center gap-2" ref={containerRef}>
        {addFolderMenu ? (
          <div title={t('folderSelector.browserAccessDescription')}>{addFolderMenu}</div>
        ) : (
          <button
            type="button"
            disabled
            title={t('folderSelector.sandboxMode')}
            aria-label={t('folderSelector.sandboxMode')}
            className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-border bg-white px-2 text-xs font-normal text-secondary opacity-70 dark:border-border dark:bg-card"
          >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>{t('projectRoots.chooseLocalFolder')}</span>
            </button>
        )}
      </div>
    )
  }

  // Has roots: show one compact management trigger, a separate add button,
  // and the native-host entry point.
  return (
    <div
        className="relative flex h-7 items-center overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-neutral-700 dark:bg-card"
        ref={containerRef}
      >
      <Popover
        modal={false}
        open={isRootsOpen}
        onOpenChange={(open) => {
          setIsRootsOpen(open)
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('projectRoots.title')}
            aria-expanded={isRootsOpen}
            className={cn(
              'flex h-7 min-w-0 items-center gap-1.5 rounded-none border-0 bg-transparent px-2.5 text-sm font-normal text-secondary',
              'transition-colors hover:bg-primary-50 hover:text-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
              'dark:bg-transparent dark:hover:bg-muted'
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span>{roots.length === 1 ? roots[0]?.name : t('projectRoots.authorizedCount', { count: String(roots.length) })}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
          <div className="max-h-72 overflow-y-auto p-1.5">
            {roots.map((root) => (
              <RootRow
                key={root.id}
                root={root}
                onRemove={() => handleRemoveRoot(root)}
                onRestorePermission={() => handleRestorePermission(root)}
                onToggleReadOnly={() => handleToggleReadOnly(root.id)}
                t={t}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {addFolderMenu}
    </div>
  )
}

/**
 * One authorized folder row. The row is informational; only the actions
 * button is interactive so the list never implies folder switching.
 */
function RootRow({
  root,
  onRemove,
  onRestorePermission,
  onToggleReadOnly,
  t,
}: {
  root: RootInfo
  onRemove: () => void
  onRestorePermission: () => void
  onToggleReadOnly: () => void
  t: (key: string, params?: Record<string, string>) => string
}) {
  const isReady = root.status === 'ready'
  const needsActivation = root.status === 'needs_user_activation'

  return (
    <div
      className={cn(
        'relative flex min-h-12 items-center gap-2 rounded-lg px-2.5 py-2',
        needsActivation ? 'bg-amber-50 dark:bg-amber-900/20' : 'hover:bg-muted/70'
      )}
    >
      <FolderOpen className={cn(
        'h-5 w-5 flex-shrink-0',
        isReady ? 'text-secondary' : needsActivation ? 'text-amber-600' : 'text-muted-foreground'
      )} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
          <span className="truncate">{root.name}</span>
          {root.readOnly && <Lock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
          {(root.backend ?? 'fsaccess') === 'native-host' ? (
            <span
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm bg-primary/10 text-primary-600 dark:text-primary-400"
              title={t('projectRoots.nativeHostBadge')}
              aria-label={t('projectRoots.nativeHostBadge')}
            >
              <HardDrive className="h-3 w-3" />
            </span>
          ) : (
            <span
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground"
              title={t('projectRoots.browserAccessBadge')}
              aria-label={t('projectRoots.browserAccessBadge')}
            >
              <Globe2 className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            isReady ? 'bg-success' : needsActivation ? 'bg-amber-400' : 'bg-gray-300'
          )} />
          <span>{needsActivation ? t('projectRoots.restorePermission') : root.readOnly ? t('projectRoots.readOnly') : t('projectRoots.title')}</span>
        </div>
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${t('projectRoots.menuLabel')}: ${root.name}`}
            aria-haspopup="menu"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4} className="min-w-[170px]">
          {needsActivation && (
            <DropdownMenuItem
              onSelect={() => void onRestorePermission()}
              className="text-amber-700 focus:bg-amber-50 focus:text-amber-700 dark:text-amber-400 dark:focus:bg-amber-900/20 dark:focus:text-amber-400"
            >
              <RefreshCw className="h-4 w-4" />
              <span>{t('projectRoots.restorePermission')}</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void onToggleReadOnly()}>
            <Lock className="h-4 w-4" />
            <span>{root.readOnly ? t('projectRoots.enableWrite') : t('projectRoots.makeReadOnly')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void onRemove()}
            className="text-danger focus:bg-danger/10 focus:text-danger"
          >
            <X className="h-4 w-4" />
            <span>{t('projectRoots.removeRoot')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
