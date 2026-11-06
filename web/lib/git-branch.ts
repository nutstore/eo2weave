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
  stat?(rootId: string, relativePath: string): Promise<{ size: number } | null>
  read?(rootId: string, relativePath: string): Promise<{ content: string | ArrayBuffer }>
}

/** Length of the short SHA shown for a detached HEAD. */
const SHORT_SHA_LENGTH = 7

/** Object id: 40 hex chars (SHA-1) or 64 (SHA-256 repositories). */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * A real `.git/HEAD` is one short line, so anything larger than this cannot
 * be a HEAD file (a pathological file would otherwise be read in full on
 * every poll). Oversized reads return null; callers render nothing then.
 */
const MAX_GIT_HEAD_BYTES = 512

/**
 * Git forbids control characters in ref names, so a HEAD containing them was
 * not written by git. Bidi overrides/isolates are also rejected: they are
 * valid UTF-8 text but let a repository reorder the rendered badge.
 */
const UNSAFE_REF_CHARS_RE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

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
    if (!name || UNSAFE_REF_CHARS_RE.test(name)) return null
    return { kind: 'branch', name }
  }

  if (SHA_RE.test(value)) {
    return { kind: 'detached', sha: value.slice(0, SHORT_SHA_LENGTH) }
  }

  return null
}

/** Same branch in both reads? Callers keep their previous object when this is
 *  true, so polling does not hand a fresh object to memoized consumers. */
export function isSameGitBranch(
  a: GitBranchInfo | null,
  b: GitBranchInfo | null
): boolean {
  if (!a || !b) return a === b
  return a.kind === 'branch'
    ? b.kind === 'branch' && a.name === b.name
    : b.kind === 'detached' && a.sha === b.sha
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
    if (file.size > MAX_GIT_HEAD_BYTES) return null
    return parseGitHead(await file.slice(0, MAX_GIT_HEAD_BYTES).text())
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
    // Stat first when the executor can: an oversized file must not be fetched
    // (Native Host assembles the whole file in chunks before returning).
    if (executor.stat) {
      const stat = await executor.stat(rootId, '.git/HEAD')
      if (!stat || stat.size > MAX_GIT_HEAD_BYTES) return null
    }
    const { content } = await executor.read(rootId, '.git/HEAD')
    if (typeof content === 'string') {
      if (content.length > MAX_GIT_HEAD_BYTES) return null
      return parseGitHead(content)
    }
    // Bound the byte count before decoding an oversized payload.
    if (content.byteLength > MAX_GIT_HEAD_BYTES) return null
    return parseGitHead(new TextDecoder().decode(content))
  } catch {
    return null
  }
}
