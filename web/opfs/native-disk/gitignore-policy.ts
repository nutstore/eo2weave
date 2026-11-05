import micromatch from 'micromatch'

/** A parsed rule from a .gitignore file. */
export interface GitIgnoreRule {
  /** Directory containing the .gitignore, relative to its authorized root. */
  baseDir: string
  pattern: string
  negated: boolean
}

/**
 * Parse the meaningful rules from one .gitignore file.
 *
 * Escaped leading `#` and `!` are treated as literal pattern characters. This
 * intentionally covers the Git rule forms used by workspace dependency and
 * build directories while leaving the final match ordering to the caller.
 */
export function parseGitIgnore(content: string, baseDir = ''): GitIgnoreRule[] {
  return content.split(/\r?\n/).flatMap((rawLine) => {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) return []

    let negated = false
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1)
    } else if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }

    if (!line) return []
    return [{ baseDir: normalizePath(baseDir), pattern: line, negated }]
  })
}

/**
 * Apply Git ignore rules in declaration order. Later rules (including `!`
 * negations) override earlier rules, matching Git's last-rule-wins behavior.
 *
 * Like Git, a path beneath an excluded directory cannot be re-included: each
 * ancestor directory is evaluated on its own, and once an ancestor ends up
 * excluded no negation may rescue the path (Git: "It is not possible to
 * re-include a file if a parent directory of that file is excluded"). A
 * negation can still re-include paths inside a non-excluded tree, and a
 * negated directory rule can re-include a directory before exclusion is
 * reached.
 */
export function isGitIgnored(path: string, rules: readonly GitIgnoreRule[], kind?: 'file' | 'directory'): boolean {
  const normalizedPath = normalizePath(path)

  const segments = normalizedPath.split('/')
  for (let i = 1; i < segments.length; i++) {
    const ancestor = segments.slice(0, i).join('/')
    if (isDirectoryExcluded(ancestor, rules)) return true
  }

  let ignored = false

  for (const rule of rules) {
    if (matchesRule(normalizedPath, rule, kind)) {
      ignored = !rule.negated
    }
  }

  return ignored
}

/**
 * Last-rule-wins evaluation of one ancestor directory. A `dir/**` pattern
 * covers the directory's contents but not the directory itself (Git
 * semantics), so it must not mark the directory excluded here.
 */
function isDirectoryExcluded(dirPath: string, rules: readonly GitIgnoreRule[]): boolean {
  let excluded = false

  for (const rule of rules) {
    if (matchesRule(dirPath, rule, 'directory', true)) {
      excluded = !rule.negated
    }
  }

  return excluded
}

function matchesRule(
  path: string,
  rule: GitIgnoreRule,
  kind?: 'file' | 'directory',
  forDirectoryExclusion = false,
): boolean {
  const basePrefix = rule.baseDir ? `${rule.baseDir}/` : ''
  if (rule.baseDir && path !== rule.baseDir && !path.startsWith(basePrefix)) return false

  const relativePath = rule.baseDir
    ? path.slice(basePrefix.length)
    : path
  if (!relativePath) return false

  const directoryPattern = rule.pattern.endsWith('/')
  let pattern = rule.pattern.replace(/\\/g, '/')
  if (directoryPattern) pattern = pattern.slice(0, -1)
  const anchored = pattern.startsWith('/')
  if (anchored) pattern = pattern.slice(1)
  if (!pattern) return false

  const hasSlash = pattern.includes('/')
  const prefixes = anchored || hasSlash ? [''] : ['', '**/']
  if (directoryPattern && kind === 'file') {
    const slash = relativePath.lastIndexOf('/')
    if (slash < 0) return false
    const parent = relativePath.slice(0, slash)
    return micromatch.isMatch(parent, prefixes.flatMap((prefix) => [`${prefix}${pattern}`, `${prefix}${pattern}/**`]), {
      dot: true, nonegate: true, nocase: false,
    })
  }
  const candidates = prefixes.flatMap((prefix) => {
    const target = `${prefix}${pattern}`
    if (forDirectoryExclusion) {
      // Git semantics: a `dir/**` pattern covers the directory's contents but
      // not the directory itself, while micromatch's `a/**` also matches `a`.
      // Reject that self match here or every `dir/**` rule would mark its own
      // base directory excluded and prune the whole tree.
      if (target.endsWith('/**')) {
        return relativePath.startsWith(`${target.slice(0, -3)}/`) ? [target] : []
      }
      return [target]
    }
    return [target, `${target}/**`]
  })

  return micromatch.isMatch(relativePath, candidates, {
    dot: true,
    nonegate: true,
    nocase: false,
  })
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}
