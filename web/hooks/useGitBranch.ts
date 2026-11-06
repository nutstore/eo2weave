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

/** A read pending longer than this is treated as lost (Native Host stalled). */
const STALLED_READ_MS = 2000

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
    // (Native Host reads are IPC). A read that has been pending far too long
    // is treated as lost, so a stalled host cannot freeze polling; `rerun`
    // remembers a read skipped while another was in flight, and the request
    // id drops results that a newer read has already superseded.
    let inFlight = false
    let inFlightSince = 0
    let rerun = false
    let request = 0

    const read = async () => {
      if (inFlight && Date.now() - inFlightSince < STALLED_READ_MS) {
        rerun = true
        return
      }
      inFlight = true
      inFlightSince = Date.now()
      const current = ++request
      try {
        const next = executor
          ? await readGitBranchViaExecutor(executor, rootId)
          : await readGitBranch(handle)
        if (!cancelled && current === request) setInfo(next)
      } finally {
        inFlight = false
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
