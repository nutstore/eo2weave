import {
  isGitIgnored,
  parseGitIgnore,
  type GitIgnoreRule,
} from '@/opfs/native-disk/gitignore-policy'

export type { GitIgnoreRule }

/** A file-tree entry whose ignore status the tree displays. */
export interface TreeIgnoreCandidate {
  /** Path relative to the tree root, e.g. `dist/assets/app.js`. */
  path: string
  kind: 'file' | 'directory'
}

/**
 * Parse the root .gitignore for the file tree.
 *
 * The tree reuses the backend parser so both sides agree on which rules are
 * directory-only and which are negated.
 */
export function parseTreeIgnoreRules(content: string): GitIgnoreRule[] {
  return parseGitIgnore(content)
}

/**
 * Ignore status shown for a file-tree entry.
 *
 * The tree shares the backend ignore policy
 * (web/opfs/native-disk/gitignore-policy.ts) rather than matching rules on
 * its own. The "Git ignored" marking has to agree with the delete flow,
 * which applies that same policy to decide between deleting an entry
 * outright and sending it through pending review — a tree that disagrees
 * either dims entries that are reviewed normally or hides entries that are
 * deleted immediately (#186, #189).
 */
export function isTreeEntryIgnored(
  candidate: TreeIgnoreCandidate,
  rules: readonly GitIgnoreRule[]
): boolean {
  return isGitIgnored(candidate.path, rules, candidate.kind)
}
