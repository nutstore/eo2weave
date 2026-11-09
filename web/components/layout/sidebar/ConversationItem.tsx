import { memo } from 'react'
import Link from 'next/link'
import {
  Plus,
  Trash2,
  Pencil,
  Clock,
  Pin,
  PinOff,
  Download,
  Archive,
  ArchiveRestore,
  Sparkles,
} from 'lucide-react'
import {
  BrandButton,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@creatorweave/ui'

export interface ConversationItemData {
  id: string
  title: string
  isRunning: boolean
  isActive: boolean
  pendingReviewCount: number
  isEditing: boolean
  isArchived: boolean
  isPinned: boolean
  hasSchedule: boolean
  kind?: 'project' | 'direct'
}

export interface ConversationItemProps extends ConversationItemData {
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
export const NewWorkspaceButton = memo(function NewWorkspaceButton({
  onClick,
  label,
  isActive = false,
}: {
  onClick: () => void
  label: string
  /** Highlighted while the new-conversation view is active */
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
export const ConversationItem = memo(function ConversationItem({
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
    prev.kind === next.kind &&
    prev.isArchived === next.isArchived &&
    prev.editingTitle === next.editingTitle &&
    prev.composing === next.composing &&
    prev.workspaceLabel === next.workspaceLabel
    // Note: callback refs are stable (useCallback), so we skip comparing them
  )
})
