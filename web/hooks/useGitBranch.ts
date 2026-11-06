import { useEffect, useState } from 'react'
import { readGitBranch, type GitBranchInfo } from '@/lib/git-branch'

/** Branch switches happen in external terminals, so there is nothing to
 *  subscribe to: poll the tiny `.git/HEAD` file, and re-read on focus. */
const DEFAULT_INTERVAL_MS = 7000

export function useGitBranch(
  handle: FileSystemDirectoryHandle | null | undefined,
  intervalMs: number = DEFAULT_INTERVAL_MS
): GitBranchInfo | null {
  const [info, setInfo] = useState<GitBranchInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    const read = async () => {
      const next = await readGitBranch(handle)
      if (!cancelled) setInfo(next)
    }

    setInfo(null)
    void read()

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read()
    }, intervalMs)
    const onFocus = () => void read()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [handle, intervalMs])

  return info
}
