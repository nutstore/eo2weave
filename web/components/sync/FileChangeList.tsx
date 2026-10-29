/**
 * FileChangeList Component
 *
 * Displays list of file changes detected after Python execution.
 * Shows add/modify/delete operations with file metadata.
 *
 * Part of Phase 3: Sync Preview UI
 */

import React from 'react'
import { type ChangeDetectionResult, type FileChange, type ChangeType } from '@/opfs/types/opfs-types'
import { useT } from '@/i18n'
import { formatBytes } from '@/lib/utils'

interface FileChangeListProps {
  /** Change detection result from workspace store */
  changes: ChangeDetectionResult | null
  /** Callback when user selects a file */
  onSelectFile?: (file: FileChange) => void
  /** Currently selected file path */
  selectedPath?: string
}

/**
 * Get icon and color for change type
 */
function getChangeTypeStyle(type: ChangeType, t: (key: string) => string): { icon: string; color: string; label: string } {
  switch (type) {
    case 'add':
      return { icon: '+', color: 'text-green-600', label: t('settings.syncPanel.fileChangeList.added') }
    case 'modify':
      return { icon: '~', color: 'text-blue-600', label: t('settings.syncPanel.fileChangeList.modified') }
    case 'delete':
      return { icon: '×', color: 'text-red-600', label: t('settings.syncPanel.fileChangeList.deleted') }
  }
}

/**
 * Format file size for display, preserving the legacy '-' fallback
 * for missing values that the canonical formatter does not provide.
 */
function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  return formatBytes(bytes)
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp?: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const FileChangeList: React.FC<FileChangeListProps> = ({
  changes,
  onSelectFile,
  selectedPath,
}) => {
  const t = useT()

  if (!changes || changes.changes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div className="w-16 h-16 rounded-full bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center mb-4">
          <svg
            className="w-8 h-8 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h2l3 3H7a2 2 0 01-2 2z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">{t('settings.syncPanel.fileChangeList.noFileChanges')}</h3>
        <p className="text-sm text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400 max-w-sm">
          {t('settings.syncPanel.fileChangeList.noChangesDescription')}
        </p>
      </div>
    )
  }

  const totalChanges = changes.changes.length
  const summaryText =
    changes.added > 0 || changes.modified > 0 || changes.deleted > 0
      ? t('settings.syncPanel.fileChangeList.fileChangesCount', { count: `${changes.added} ${t('settings.syncPanel.syncPreview.added')}, ${changes.modified} ${t('settings.syncPanel.syncPreview.modified')}, ${changes.deleted} ${t('settings.syncPanel.syncPreview.deleted')}` })
      : t('settings.syncPanel.fileChangeList.fileChangesCount', { count: totalChanges })

  return (
    <div className="flex flex-col h-full">
      {/* Summary Header */}
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t('settings.pendingSyncPanel.title')}</h3>
            <p className="text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400 mt-1">{summaryText}</p>
          </div>
          <div className="text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
            {t('settings.syncPanel.fileChangeList.totalCount', { count: totalChanges })}
          </div>
        </div>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {changes.changes.map((change, index) => {
            const style = getChangeTypeStyle(change.type, t)
            const isSelected = change.path === selectedPath

            return (
              <button
                key={`${change.path}-${index}`}
                onClick={() => onSelectFile?.(change)}
                className={`w-full px-4 py-3 flex items-start gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${
                  isSelected ? 'bg-primary-50 dark:bg-primary-50/20 border-l-4 border-primary-500' : ''
                }`}
                aria-label={t('settings.syncPanel.fileChangeList.viewChange', { path: change.path })}
              >
                {/* Type Icon */}
                <div
                  className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${style.color} bg-opacity-10`}
                  style={{ backgroundColor: `${style.color}15` }}
                >
                  {style.icon}
                </div>

                {/* File Info */}
                <div className="flex-1 min-w-0 text-left">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-sm font-medium ${style.color}`}
                    >
                      {style.label}
                    </span>
                    <span className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">•</span>
                    <span className="text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400" title={change.path}>
                      {change.path.length > 50
                        ? `...${change.path.slice(-47)}`
                        : change.path}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                    <span>{t('settings.syncPanel.fileChangeList.size', { size: formatFileSize(change.size) })}</span>
                    {change.mtime && (
                      <>
                        <span>•</span>
                        <span>{t('settings.syncPanel.fileChangeList.time', { time: formatTime(change.mtime) })}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Selection Indicator */}
                {isSelected && (
                  <div className="flex-shrink-0">
                    <svg
                      className="w-5 h-5 text-blue-500"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-8-8 0 8 8 8 0 00016 0 8-8a8 8 0 000-8 8zm3.707-9.293a1 1 0 00-1.414 1.414L9 10.586 7 7H4a1 1 0 000-2 0v4a1 1 0 002 2h5l7.293 7.293z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
