/**
 * Git branch detection for authorized folders.
 *
 * The app talks to real folders through File System Access handles, so reading
 * `.git/HEAD` is the same mechanism used for `.gitignore`. There is no native
 * change event on a directory handle, so callers poll (see useGitBranch).
 */

/** What `.git/HEAD` says: a checkout, or a detached commit. */
export type GitBranchInfo =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }

/** Length of the short SHA shown for a detached HEAD. */
const SHORT_SHA_LENGTH = 7

const SHA_RE = /^[0-9a-f]{40}$/i

/**
 * Parse the contents of `.git/HEAD`.
 *
 * - `ref: refs/heads/<branch>` → branch checkout
 * - a 40-char SHA → detached HEAD
 * - anything else (tag ref, remote ref, garbage) → null
 */
export function parseGitHead(content: string): GitBranchInfo | null {
  const value = content.trim()
  if (!value) return null

  if (value.startsWith('ref:')) {
    const ref = value.slice(4).trim()
    const prefix = 'refs/heads/'
    if (!ref.startsWith(prefix)) return null
    const name = ref.slice(prefix.length)
    return name ? { kind: 'branch', name } : null
  }

  if (SHA_RE.test(value)) {
    return { kind: 'detached', sha: value.slice(0, SHORT_SHA_LENGTH) }
  }

  return null
}

/**
 * Read `.git/HEAD` under a directory handle.
 *
 * Returns null — never throws — when the folder is not a work tree, when
 * `.git` is a file (worktrees/submodules point at another gitdir we cannot
 * resolve through a handle), or when the permission has lapsed.
 */
export async function readGitBranch(
  handle: FileSystemDirectoryHandle | null | undefined
): Promise<GitBranchInfo | null> {
  if (!handle) return null
  try {
    const gitDir = await handle.getDirectoryHandle('.git')
    const headFile = await gitDir.getFileHandle('HEAD')
    const file = await headFile.getFile()
    return parseGitHead(await file.text())
  } catch {
    return null
  }
}
