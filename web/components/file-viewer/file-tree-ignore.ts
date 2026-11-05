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
 * Accumulated ignore rules keyed by the directory that holds them, using the
 * path relative to the tree root (`''` is the root).
 */
export type TreeIgnoreRules = ReadonlyMap<string, GitIgnoreRule[]>

/**
 * Parse one .gitignore for the file tree, scoped to the directory holding it.
 *
 * The tree reuses the backend parser so both sides agree on which rules are
 * directory-only and which are negated. A nested .gitignore has to pass its
 * own directory, otherwise its rules would read as if they were root rules
 * and leak into sibling subtrees.
 */
export function parseTreeIgnoreRules(content: string, basePath = ''): GitIgnoreRule[] {
  return parseGitIgnore(content, basePath)
}

/**
 * Rules that govern an entry or directory: those inherited by the directory
 * holding it, falling back to the nearest loaded ancestor. A directory's own
 * .gitignore never decides its own row.
 */
export function treeIgnoreRulesFor(path: string, rulesByDirectory: TreeIgnoreRules): GitIgnoreRule[] {
  const ancestors = path.split('/').slice(0, -1)
  for (let depth = ancestors.length; depth >= 0; depth--) {
    const rules = rulesByDirectory.get(ancestors.slice(0, depth).join('/'))
    if (rules) return rules
  }
  return []
}

/**
 * Extend the rules inherited by a directory with the rules of its own
 * .gitignore.
 *
 * This mirrors web/vfs/walk.ts, which appends `parseGitIgnore(content,
 * current.path)` to the rules it carries down the tree: a nested file only
 * applies to its own subtree, and an entry is checked against root plus every
 * ancestor rule.
 */
export function withDirectoryIgnoreRules(
  rulesByDirectory: TreeIgnoreRules,
  directory: string,
  ownRules: readonly GitIgnoreRule[]
): TreeIgnoreRules {
  const next = new Map(rulesByDirectory)
  next.set(directory, [...treeIgnoreRulesFor(directory, rulesByDirectory), ...ownRules])
  return next
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
