/**
 * Pure reconciliation of the SkillManager's user-skill cache (#197).
 *
 * `refreshUserSkills()` replaces the cache with whatever the OPFS scan
 * returned. Two scan shapes must NOT be treated as authoritative:
 *
 *  - a scan that RESOLVED with per-skill `errors` (one unreadable SKILL.md):
 *    that skill is absent from `skills`, so a wholesale replace dropped it
 *    from the UI and from agent context until a later successful scan;
 *  - a scan that REJECTED after a successful delete: the caller keeps the
 *    previous cache, which still lists the deleted skill (see
 *    `removeUserSkill`, applied by the manager on a completed delete).
 *
 * Keeping this logic pure makes both cases unit-testable without OPFS.
 */

import type { Skill } from './skill-types'
import type { UserSkillScanResult } from './user-skills-scanner'

/** Store/manager id prefix for OPFS-backed user skills (`user:<dirName>`). */
export const USER_SKILL_ID_PREFIX = 'user:'

/** Id the manager/store use for a user skill directory. */
export function userSkillId(dirName: string): string {
  return `${USER_SKILL_ID_PREFIX}${dirName}`
}

/**
 * Directory name a scan error refers to.
 *
 * SKILL.md read/parse failures are formatted `user/<dirName>/SKILL.md: …`;
 * resource failures `${skillId}/${path}: …` where `skillId` is
 * `user:<dirName>`. Anything else (e.g. `builtin/…`) yields null.
 */
export function dirNameFromScanError(message: string): string | null {
  const match = /^user[:/]([^/:]+)\//.exec(message.trim())
  return match?.[1] ?? null
}

/**
 * Merge a resolved scan into the previous cache.
 *
 * Scanned skills win; a skill whose directory errored during THIS scan and
 * produced no entry is carried over from the previous cache so a single
 * unreadable file does not make an installed skill vanish. Skills that
 * simply disappeared from disk are dropped as before.
 */
export function reconcileUserSkillScan(
  previous: Skill[],
  scan: UserSkillScanResult,
): Skill[] {
  const failedDirNames = new Set<string>()
  for (const message of scan.errors) {
    const dirName = dirNameFromScanError(message)
    if (dirName) failedDirNames.add(dirName)
  }
  const scannedIds = new Set(scan.skills.map((skill) => skill.id))
  const carried = previous.filter((skill) => {
    if (!skill.id.startsWith(USER_SKILL_ID_PREFIX)) return false
    const dirName = skill.id.slice(USER_SKILL_ID_PREFIX.length)
    return failedDirNames.has(dirName) && !scannedIds.has(skill.id)
  })
  return [...scan.skills, ...carried]
}

/**
 * Drop one user skill from the cache.
 *
 * Applied right after a COMPLETED OPFS delete, so the entry leaves the UI and
 * agent context even when the follow-up scan fails (the failure path keeps the
 * previous cache wholesale).
 */
export function removeUserSkill(previous: Skill[], dirName: string): Skill[] {
  const id = userSkillId(dirName)
  return previous.filter((skill) => skill.id !== id)
}
