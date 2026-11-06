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

  const label = info.kind === 'branch' ? info.name : info.sha

  return (
    <span
      // `cursor-default` keeps the badge from inheriting the harness's text
      // cursor: it is a label, not selectable content.
      className={cn(
        'flex min-w-0 cursor-default select-none items-center gap-1 font-mono text-[10px] font-normal normal-case text-tertiary',
        className
      )}
      // The full ref, not a generic label: when the header is narrow the badge
      // truncates, and this is the only way to read the whole branch.
      title={info.kind === 'detached' ? `${t('fileTree.detachedHead')}: ${info.sha}` : label}
    >
      <GitBranchIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
