/* eslint-disable react-refresh/only-export-components */
/**
 * Change Helpers - Common utility functions for pending file changes
 *
 * Shared between PendingSyncPanel and PendingFileList components
 */

import React from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import type { ChangeType } from '@/opfs/types/opfs-types'
import { formatBytes } from '@/lib/utils'

/**
 * Change type information
 */
export interface ChangeTypeInfo {
  color: string
  bg: string
  label: string
}

/**
 * Get color and label for change type
 * Uses A/M/D labels consistently, matching FileTreePanel
 */
export function getChangeTypeInfo(type: ChangeType): ChangeTypeInfo {
  switch (type) {
    case 'add':
      return { color: 'text-success', bg: 'bg-success/10', label: 'A' }
    case 'modify':
      return { color: 'text-warning', bg: 'bg-warning/10', label: 'M' }
    case 'delete':
      return { color: 'text-danger', bg: 'bg-danger/10', label: 'D' }
  }
}

/**
 * Change type icon component (using lucide-react)
 */
export function ChangeTypeIcon({ type, className = 'w-3.5 h-3.5' }: { type: ChangeType; className?: string }): React.ReactNode {
  switch (type) {
    case 'add':
      return <Plus className={className} />
    case 'modify':
      return <Pencil className={className} />
    case 'delete':
      return <Trash2 className={className} />
  }
}

export { formatBytes } from '@/lib/utils'

/**
 * Format file size, preserving the legacy '-' fallback for missing
 * values that the canonical formatter does not provide.
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return '-'
  return formatBytes(bytes)
}
