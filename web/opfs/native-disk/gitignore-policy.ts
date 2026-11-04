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
 */
export function isGitIgnored(path: string, rules: readonly GitIgnoreRule[], kind?: 'file' | 'directory'): boolean {
  const normalizedPath = normalizePath(path)
  let ignored = false

  for (const rule of rules) {
    if (matchesRule(normalizedPath, rule, kind)) {
      ignored = !rule.negated
    }
  }

  return ignored
}

function matchesRule(path: string, rule: GitIgnoreRule, kind?: 'file' | 'directory'): boolean {
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
