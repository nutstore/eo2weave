import { useEffect, useState } from 'react'
import {
  isSameGitBranch,
  readGitBranch,
  readGitBranchViaExecutor,
  type GitBranchInfo,
  type GitHeadReader,
} from '@/lib/git-branch'

/** Branch switches happen in external terminals, so there is nothing to
 *  subscribe to: poll the tiny `.git/HEAD` file, and re-read on focus. */
const DEFAULT_INTERVAL_MS = 7000

/** Executor polls are slower: each read is a stat_file + read_file round
 *  trip that spawns a Native Host process, so 2 launches per poll per root
 *  add up at 7s pacing. 30s keeps the same freshness contract at a third of
 *  the process churn. */
const EXECUTOR_INTERVAL_MS = 30000

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
  intervalMs: number = executor ? EXECUTOR_INTERVAL_MS : DEFAULT_INTERVAL_MS
): GitBranchInfo | null {
  const [info, setInfo] = useState<GitBranchInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    // At most one read in flight: Native Host reads are IPC calls and the
    // executor API has no cancellation, so a stalled host must not be able to
    // fan out polling calls. A read skipped because another was pending is
    // remembered and re-run when it settles, and the request id drops a result
    // that a newer read has already superseded.
    let pending = false
    let rerun = false
    let request = 0

    const read = async () => {
      if (pending) {
        rerun = true
        return
      }
      pending = true
      const current = ++request
      try {
        const next = executor
          ? await readGitBranchViaExecutor(executor, rootId)
          : await readGitBranch(handle)
        if (!cancelled && current === request) {
          setInfo((prev) => (isSameGitBranch(prev, next) ? prev : next))
        }
      } finally {
        pending = false
        if (!cancelled && rerun) {
          rerun = false
          void read()
        }
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
