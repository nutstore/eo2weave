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

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  FolderOpen,
  Plus,
  Lock,
  X,
  RefreshCw,
  Loader2,
  Cable,
} from 'lucide-react'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import { bindRuntimeDirectoryHandle } from '@/native-fs'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { useT } from '@/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'
import { useNativeHostPing } from '@/hooks/useNativeHostPing'
import { cn } from '@/lib/utils'
import type { RootInfo } from '@/types/folder-access'

/** Stable tooltip wrapper — module level so it is not recreated per render.
 *  Wraps content in its own TooltipProvider because FolderSelector also
 *  renders outside TopBar's provider (e.g. mobile "more" panel). */
function IconTooltip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom" className="whitespace-pre-line">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function FolderSelector() {
  const t = useT()
  const containerRef = useRef<HTMLDivElement>(null)

  // Multi-root state
  const { roots, activeProjectId, addRoot, adoptPickedRoot, addNativeHostRoot, removeRoot, loadRoots, toggleReadOnly } =
    useFolderAccessStore()

  // UI state
  const [activeChip, setActiveChip] = useState<string | null>(null) // root.id of open dropdown
  const [isAdding, setIsAdding] = useState(false)
  const [isAddingNativeHost, setIsAddingNativeHost] = useState(false)

  const runtimeCapability = getRuntimeCapability()
  const canPickDirectory = runtimeCapability.canPickDirectory
  // Full-chain ping (page → extension → Rust host) instead of a shallow
  // bridge-existence probe: hides the "Local connection" button when the
  // Rust app is not installed. Re-probes on window focus.
  const nativeHostAvailable = useNativeHostPing() === 'available'

  // Click outside to close dropdown
  useEffect(() => {
    if (!activeChip) return
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setActiveChip(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [activeChip])

  // Load roots on mount/project change
  useEffect(() => {
    loadRoots()
  }, [activeProjectId, loadRoots])

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
      const data = event.data as { type?: string; name?: string } | null
      if (data?.type !== 'folder-picked' || !data.name) return
      void adoptPickedRoot(data.name)
    }
    return () => {
      channel?.close()
    }
  }, [isSidePanel, adoptPickedRoot])

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
      setActiveChip(null)
    },
    [removeRoot, t]
  )

  const handleRestorePermission = useCallback(
    async (root: RootInfo) => {
      if (!activeProjectId || !root.persistedHandle) return
      try {
        const permission = await root.persistedHandle.requestPermission({ mode: 'readwrite' })
        if (permission) {
          bindRuntimeDirectoryHandle(activeProjectId, root.name, root.persistedHandle)
          await loadRoots()

          // Sync to agent.store
          const { useAgentStore } = await import('@/store/agent.store')
          useAgentStore.setState({
            directoryHandle: root.persistedHandle,
            directoryName: root.name,
          })

          toast.success(t('projectRoots.permissionRestored'))
          setActiveChip(null)
        } else {
          toast.error(t('projectRoots.permissionDenied'))
        }
      } catch (error) {
        console.error('[FolderSelector] Failed to restore permission:', error)
        toast.error(t('projectRoots.permissionFailed'))
      }
    },
    [activeProjectId, loadRoots, t]
  )

  const handleToggleReadOnly = useCallback(
    async (rootId: string) => {
      await toggleReadOnly(rootId)
      setActiveChip(null)
    },
    [toggleReadOnly]
  )

  const nativeHostButton = nativeHostAvailable && (
    <IconTooltip
      label={`${t('folderSelector.localConnection')}\n${t('folderSelector.localConnectionDescription')}`}
    >
      <button
        type="button"
        onClick={handleAddNativeHostRoot}
        disabled={isAddingNativeHost}
        aria-label={t('folderSelector.localConnection')}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md border border-border bg-white',
          'text-secondary transition-colors hover:border-primary-100 hover:bg-primary-50 hover:text-primary-600 focus:outline-none',
          'dark:border-border dark:bg-card dark:hover:border-primary-600 dark:hover:bg-muted',
          isAddingNativeHost && 'cursor-wait opacity-70'
        )}
      >
        {isAddingNativeHost ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-600" />
        ) : (
          <Cable className="h-3.5 w-3.5" />
        )}
      </button>
    </IconTooltip>
  )

  // No roots: show the two explicit authorization paths.
  if (roots.length === 0) {
    return (
      <div className="relative flex items-center gap-2" ref={containerRef}>
        <IconTooltip
          label={
            !canPickDirectory
              ? t('folderSelector.sandboxMode')
              : `${t('folderSelector.browserAccess')}\n${t('folderSelector.browserAccessDescription')}`
          }
        >
          <button
            type="button"
            onClick={handleAddRoot}
            disabled={!canPickDirectory || isAdding}
            aria-label={
              !canPickDirectory
                ? t('folderSelector.sandboxMode')
                : t('folderSelector.browserAccess')
            }
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border border-border bg-white',
              'text-secondary transition-colors hover:border-primary-100 hover:bg-primary-50 hover:text-primary-600 focus:outline-none',
              'dark:border-border dark:bg-card dark:hover:border-primary-600 dark:hover:bg-muted',
              isAdding && 'cursor-wait opacity-70',
              !canPickDirectory && 'cursor-not-allowed opacity-70'
            )}
          >
            {isAdding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-600" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
          </button>
        </IconTooltip>
        {nativeHostButton}
      </div>
    )
  }

  // Has roots: show chips + [+] button
  return (
    <div className="relative flex items-center gap-1.5" ref={containerRef}>
      {roots.map((root) => (
        <RootChip
          key={root.id}
          root={root}
          isOpen={activeChip === root.id}
          onToggle={() => setActiveChip(activeChip === root.id ? null : root.id)}
          onRemove={() => handleRemoveRoot(root)}
          onRestorePermission={() => handleRestorePermission(root)}
          onToggleReadOnly={() => handleToggleReadOnly(root.id)}
          t={t}
        />
      ))}

      {/* Add button */}
      {canPickDirectory && (
        <IconTooltip label={t('projectRoots.addFolder')}>
          <button
            type="button"
            onClick={handleAddRoot}
            disabled={isAdding}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-border',
              'text-secondary transition-colors hover:border-primary-100 hover:bg-primary-50 hover:text-primary-600',
              'dark:border-border dark:hover:border-primary-600 dark:hover:bg-muted',
              isAdding && 'cursor-wait opacity-70'
            )}
          >
            {isAdding ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        </IconTooltip>
      )}
      {nativeHostButton}
    </div>
  )
}

/**
 * Individual root chip with dropdown menu
 */
function RootChip({
  root,
  isOpen,
  onToggle,
  onRemove,
  onRestorePermission,
  onToggleReadOnly,
  t,
}: {
  root: RootInfo
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
  onRestorePermission: () => void
  onToggleReadOnly: () => void
  t: (key: string, params?: Record<string, string>) => string
}) {
  const isReady = root.status === 'ready'
  const needsActivation = root.status === 'needs_user_activation'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={cn(
          'flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-normal',
          'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
          needsActivation
            ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/30'
            : isReady
              ? 'border-border bg-white text-secondary hover:bg-primary-50 dark:border-border dark:bg-card dark:hover:bg-muted'
              : 'border-border bg-card text-muted-foreground hover:bg-muted'
        )}
      >
        {/* Status dot */}
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full flex-shrink-0',
            isReady ? 'bg-success' : needsActivation ? 'bg-amber-400' : 'bg-gray-300'
          )}
        />
        <span className="max-w-[100px] truncate">{root.name}</span>
        {root.readOnly && <Lock className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {/* Native-host backend badge - shown only when the root is backed by
            the native host (not the File System Access API). The cable icon
            makes native-host roots visually distinct from browser-API roots,
            which matters during testing and operation. */}
        {(root.backend ?? 'fsaccess') === 'native-host' && (
          <span
            className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm bg-primary/10 text-primary-600 dark:text-primary-400"
            title={t('projectRoots.nativeHostBadge')}
            aria-label={t('projectRoots.nativeHostBadge')}
          >
            <Cable className="h-2.5 w-2.5" />
          </span>
        )}
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          role="menu"
          aria-label={t('projectRoots.menuLabel')}
          className="absolute left-0 top-full z-50 mt-1 min-w-[160px] whitespace-nowrap rounded-lg border border-border bg-card py-1 shadow-lg dark:border-border dark:bg-card"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Restore permission */}
          {needsActivation && (
            <button
              type="button"
              role="menuitem"
              onClick={onRestorePermission}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20 focus-visible:outline-none focus-visible:bg-amber-100 dark:focus-visible:bg-amber-900/30"
            >
              <RefreshCw className="h-4 w-4" />
              <span>{t('projectRoots.restorePermission')}</span>
            </button>
          )}

          {/* Toggle read-only */}
          <button
            type="button"
            role="menuitem"
            onClick={onToggleReadOnly}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-secondary hover:bg-muted dark:hover:bg-muted focus-visible:outline-none focus-visible:bg-muted"
          >
            <Lock className="h-4 w-4" />
            <span>{root.readOnly ? t('projectRoots.enableWrite') : t('projectRoots.makeReadOnly')}</span>
          </button>

          {/* Remove */}
          <button
            type="button"
            role="menuitem"
            onClick={onRemove}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger/5 focus-visible:outline-none focus-visible:bg-danger/10"
          >
            <X className="h-4 w-4" />
            <span>{t('projectRoots.removeRoot')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
