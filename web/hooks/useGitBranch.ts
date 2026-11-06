import { useEffect, useState } from 'react'
import {
  readGitBranch,
  readGitBranchViaExecutor,
  type GitBranchInfo,
  type GitHeadReader,
} from '@/lib/git-branch'

/** Branch switches happen in external terminals, so there is nothing to
 *  subscribe to: poll the tiny `.git/HEAD` file, and re-read on focus. */
const DEFAULT_INTERVAL_MS = 7000

export interface GitBranchSource {
  /** File System Access handle, when the root has one. */
  handle?: FileSystemDirectoryHandle | null
  /** Native Host roots read through the disk executor instead. */
  executor?: GitHeadReader | null
  /** Executor root id (Native Host scope id). */
  rootId?: string | null
}

export function useGitBranch(
  { handle, executor, rootId }: GitBranchSource,
  intervalMs: number = DEFAULT_INTERVAL_MS
): GitBranchInfo | null {
  const [info, setInfo] = useState<GitBranchInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    // One read at a time: a focus read must not stack on a slow poll read
    // (Native Host reads are IPC), and serialising also means an older read
    // can never overwrite a newer result.
    let inFlight = false

    const read = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = executor
          ? await readGitBranchViaExecutor(executor, rootId)
          : await readGitBranch(handle)
        if (!cancelled) setInfo(next)
      } finally {
        inFlight = false
      }
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
  }, [handle, executor, rootId, intervalMs])

  return info
}
