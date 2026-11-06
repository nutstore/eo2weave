import { GitBranch as GitBranchIcon } from 'lucide-react'
import type { GitBranchInfo } from '@/lib/git-branch'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'

/**
 * Muted `⎇ main` badge shown next to a folder name. Renders nothing when the
 * folder is not a work tree (or the read failed).
 */
export function GitBranchBadge({
  info,
  className,
}: {
  info: GitBranchInfo | null
  className?: string
}) {
  const t = useT()
  if (!info) return null

  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 font-mono text-[10px] font-normal normal-case text-tertiary',
        className
      )}
      title={info.kind === 'detached' ? t('fileTree.detachedHead') : t('fileTree.gitBranch')}
    >
      <GitBranchIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{info.kind === 'branch' ? info.name : info.sha}</span>
    </span>
  )
}
