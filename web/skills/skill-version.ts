/**
 * Skill version comparison + update-vs-skip decision (issue #154).
 *
 * Pure module — no OPFS, no store imports — so the version semantics can be
 * unit-tested directly and reused by any install entry point.
 */

/**
 * Compare two semver-ish version strings ("1.2.3"). Returns -1 if a < b,
 * 0 if equal, 1 if a > b. Missing numeric segments count as 0; non-numeric
 * segments fall back to string comparison so pre-release tags ("1.2.0-beta")
 * still order deterministically.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0'
    const sb = pb[i] ?? '0'
    const na = Number(sa)
    const nb = Number(sb)
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na < nb) return -1
      if (na > nb) return 1
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
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
 * Decide the action for re-installing a skill the user already has.
 *
 * @param storeVersion     Version declared by the store ZIP's SKILL.md.
 * @param installedVersion Version declared by the installed SKILL.md.
 */
export function decideSkillUpdateAction(
  storeVersion: string,
  installedVersion: string,
): SkillUpdateAction {
  const cmp = compareVersions(storeVersion, installedVersion)
  if (cmp > 0) return 'update'
  if (cmp < 0) return 'installed-newer'
  return 'current'
}

/**
 * Extract the `version:` frontmatter value from SKILL.md text. Returns
 * null when the text has no parseable version — callers treat null as
 * "unknown version" and keep the old (non-updating) behavior.
 */
export function parseSkillMdVersion(skillMdText: string): string | null {
  if (!skillMdText.startsWith('---')) return null
  const end = skillMdText.indexOf('---', 3)
  if (end === -1) return null
  const block = skillMdText.slice(3, end)
  const m = block.match(/^\s*version:\s*"?([^"\n]+)"?\s*$/m)
  return m ? m[1]!.trim() : null
}
