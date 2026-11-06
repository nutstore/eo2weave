/**
 * Git branch detection for authorized folders.
 *
 * A folder can be reached two ways: a File System Access handle, or — for
 * Native Host roots — a disk executor. Both can read the tiny `.git/HEAD`
 * file, so the parse step is shared. There is no native change event on
 * either side, so callers poll (see useGitBranch).
 */

/** What `.git/HEAD` says: a checkout, or a detached commit. */
export type GitBranchInfo =
  | { kind: 'branch'; name: string }
  | { kind: 'detached'; sha: string }

/**
 * Minimal slice of the disk executor needed here: Native Host roots read
 * through it, and callers may pass a narrower executor (e.g. a tree that only
 * exposes `listDir` plus an optional `read`).
 */
export type GitHeadReader = {
  read?(rootId: string, relativePath: string): Promise<{ content: string | ArrayBuffer }>
}

/** Length of the short SHA shown for a detached HEAD. */
const SHORT_SHA_LENGTH = 7

/** Object id: 40 hex chars (SHA-1) or 64 (SHA-256 repositories). */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Parse the contents of `.git/HEAD`.
 *
 * - `ref: refs/heads/<branch>` → branch checkout
 * - a 40/64-char SHA → detached HEAD
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

/**
 * Read `.git/HEAD` through a disk executor — Native Host roots carry no
 * directory handle. Same null-on-any-failure contract as `readGitBranch`.
 */
export async function readGitBranchViaExecutor(
  executor: GitHeadReader | null | undefined,
  rootId: string | null | undefined
): Promise<GitBranchInfo | null> {
  if (!executor?.read || !rootId) return null
  try {
    const { content } = await executor.read(rootId, '.git/HEAD')
    return parseGitHead(typeof content === 'string' ? content : new TextDecoder().decode(content))
  } catch {
    return null
  }
}
