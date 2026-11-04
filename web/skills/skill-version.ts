/**
 * Skill version comparison + update-vs-skip decision (issue #154).
 *
 * Pure module — no OPFS, no store imports — so the version semantics can be
 * unit-tested directly and reused by any install entry point.
 */

/** A version split into the parts SemVer precedence compares. */
interface ParsedVersion {
  /** Numeric core segments (major, minor, patch — missing ones count as 0). */
  core: number[]
  /** Dot-separated prerelease identifiers (empty for a stable release). */
  prerelease: string[]
}

/**
 * Parse a semver-ish version string ("1.2.3", "1.2.3-beta.1", "2.0").
 *
 * Build metadata (`+build`) is dropped — SemVer says it must not affect
 * precedence. Returns null when the string carries no numeric core, i.e. it
 * is not a version at all.
 */
function parseVersion(raw: string): ParsedVersion | null {
  const s = raw.trim().replace(/^v/i, '')
  const m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  return {
    core: m[1]!.split('.').map((n) => Number(n)),
    prerelease: m[2] ? m[2]!.split('.') : [],
  }
}

/** Compare the numeric core segments (missing segments count as 0). */
function compareCore(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const na = a[i] ?? 0
    const nb = b[i] ?? 0
    if (na !== nb) return na < nb ? -1 : 1
  }
  return 0
}

/**
 * Compare prerelease identifiers per SemVer: numeric identifiers compare
 * numerically and rank below alphanumeric ones, alphanumeric identifiers
 * compare lexically, and a longer prerelease outranks a shorter one when all
 * shared identifiers are equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
  // A release outranks any prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const x = a[i]!
    const y = b[i]!
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const nx = Number(x)
      const ny = Number(y)
      if (nx !== ny) return nx < ny ? -1 : 1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (xNum !== yNum) return xNum ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Compare two semver-ish version strings ("1.2.3"). Returns -1 if a < b,
 * 0 if equal, 1 if a > b.
 *
 * SemVer precedence: missing numeric segments count as 0, a prerelease ranks
 * BELOW the matching stable release, prerelease identifiers compare
 * numerically/lexically per SemVer, and build metadata is ignored. A version
 * that is not a version at all ranks below any parseable one — an unknown
 * version can never justify overwriting a real install.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) {
    // Neither side is a version — order them deterministically so the
    // decision stays stable instead of flipping between runs.
    const sa = a.trim()
    const sb = b.trim()
    if (sa === sb) return 0
    return sa < sb ? -1 : 1
  }
  if (!pa) return -1
  if (!pb) return 1

  const core = compareCore(pa.core, pb.core)
  if (core !== 0) return core
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/** What a re-install of a store skill should do with an existing install. */
export type SkillUpdateAction =
  /** Store is newer — overwrite the installed copy in place. */
  | 'update'
  /** Versions match — keep the installed copy ("Already installed"). */
  | 'current'
  /** Installed copy is newer than the store — skip, never downgrade. */
  | 'installed-newer'

/**
 * Whether a re-install of an ALREADY-INSTALLED skill with this update action
 * requires an explicit user confirmation before anything is written (#154,
 * round 2). Only `update` replaces installed content: a fresh install keeps
 * its existing opt-in, and `current` / `installed-newer` touch nothing.
 *
 * The agent's `install_skill` tool is policy-level `auto`, so the update
 * consent gate is enforced in code (not just prompt instructions) by checking
 * this decision before the install flow runs.
 */
export function skillUpdateNeedsConsent(action: SkillUpdateAction): boolean {
  return action === 'update'
}

/** True when the string is a parseable semver-ish version, not junk text. */
export function isKnownVersion(raw: string): boolean {
  return parseVersion(raw) !== null
}

/**
 * Decide the action for re-installing a skill the user already has.
 *
 * @param storeVersion     Version declared by the store ZIP's SKILL.md.
 * @param installedVersion Version declared by the installed SKILL.md.
 */
export function decideSkillUpdateAction(
  storeVersion: string,
  installedVersion: string,
): SkillUpdateAction {
  // An unparseable version on either side is UNKNOWN, never "lower than
  // everything": lexical fallback would rank junk below a real version and
  // let a store release overwrite a locally modified install of unknown
  // provenance (#154 round 2). The conservative keep (never overwrite,
  // never downgrade) is the backstop for callers that reach us with junk.
  if (!isKnownVersion(storeVersion) || !isKnownVersion(installedVersion)) {
    return 'installed-newer'
  }
  const cmp = compareVersions(storeVersion, installedVersion)
  if (cmp > 0) return 'update'
  if (cmp < 0) return 'installed-newer'
  return 'current'
}

/**
 * Read a YAML scalar: strip surrounding quotes and drop an inline comment.
 * Returns '' when the value is empty or is not a plain scalar (a flow or
 * block collection has no scalar value).
 */
function readYamlScalar(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  const quote = s[0]
  if (quote === '"' || quote === "'") {
    // Quoted scalar: the value ends at the matching quote, everything after
    // it is an inline comment.
    const end = s.indexOf(quote, 1)
    if (end === -1) return '' // unterminated quote — not a scalar
    return s.slice(1, end).trim()
  }
  // Bare scalar: YAML only starts a comment at a "#" preceded by a space.
  const commentAt = s.search(/\s#/)
  const bare = commentAt === -1 ? s : s.slice(0, commentAt).trim()
  if (!bare) return ''
  // Flow/block collections are not scalars — the version stays unknown.
  if (/^[[{|>]/.test(bare)) return ''
  return bare
}

/**
 * Extract the `version:` frontmatter value from SKILL.md text. Returns
 * null when the text has no parseable version — callers treat null as
 * "unknown version" and keep the old (non-updating) behavior.
 *
 * The value is read as a YAML scalar: quotes are stripped, an inline comment
 * is dropped, and an empty value yields null (the next frontmatter field is
 * never consumed).
 */
export function parseSkillMdVersion(skillMdText: string): string | null {
  if (!skillMdText.startsWith('---')) return null
  const end = skillMdText.indexOf('---', 3)
  if (end === -1) return null
  const block = skillMdText.slice(3, end)
  for (const line of block.split('\n')) {
    // Top-level frontmatter key only — a nested `version:` is not the
    // skill's own version.
    const m = /^version\s*:(.*)$/.exec(line)
    if (!m) continue
    return readYamlScalar(m[1]!) || null
  }
  return null
}
