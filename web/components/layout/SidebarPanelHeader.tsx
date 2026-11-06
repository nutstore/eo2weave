import type { ReactNode } from 'react'

interface SidebarPanelHeaderProps {
  title: ReactNode
  leftExtra?: ReactNode
  right?: ReactNode
}

/**
 * Shared header for sidebar resource panels.
 * Locks header height to avoid visual jumps between tabs/states.
 */
export function SidebarPanelHeader({ title, leftExtra, right }: SidebarPanelHeaderProps) {
  return (
    <div className="border-subtle flex h-9 items-center justify-between gap-2 border-b bg-elevated px-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wider text-secondary">{title}</span>
        {leftExtra}
      </div>
      {right}
    </div>
  )
}

