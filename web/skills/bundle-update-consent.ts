/**
 * Aggregated consent for sibling bundle updates (#183).
 *
 * Installing ONE skill whose archive is a bundle also rewrites every other
 * bundle member that is installed at an older version — silently, because the
 * consent layer only ever described the selected skill. The owner chose the
 * aggregated-prompt design (option 1): one prompt lists every member that
 * would be updated, each can be declined, declined members are skipped and
 * named in the result summary.
 *
 * This module owns the enumeration/partition decisions so they can be tested
 * without a browser, OPFS or the network.
 */

import { decideSkillUpdateAction } from './skill-version'

/** What an install knows about one archive member before any write. */
export interface BundleMemberUpdateFacts {
  dirName: string
  /** Version declared by the member's SKILL.md in the archive; null if absent. */
  storeVersion: string | null
}

/** A member that would be overwritten by this install and needs consent. */
export interface BundleUpdateCandidate {
  dirName: string
  installedVersion: string
  storeVersion: string
}

/**
 * Members the install would OVERWRITE (installed + archive version newer).
 *
 * `focusDirName` is the skill the caller explicitly asked to install/update:
 * the user already consented to that one (Update button, `install_skill`
 * update gate), so it is not part of the aggregated prompt. Members with an
 * unknown version on either side are never candidates — the install flow only
 * writes those when nothing is installed (`ifAbsent`), which loses no local
 * copy.
 */
export function collectBundleUpdateCandidates(
  members: BundleMemberUpdateFacts[],
  installedVersions: ReadonlyMap<string, string | null>,
  focusDirName?: string,
): BundleUpdateCandidate[] {
  const candidates: BundleUpdateCandidate[] = []
  for (const member of members) {
    if (member.dirName === focusDirName) continue
    const installedVersion = installedVersions.get(member.dirName)
    if (!installedVersion || !member.storeVersion) continue
    if (decideSkillUpdateAction(member.storeVersion, installedVersion) !== 'update') continue
    candidates.push({
      dirName: member.dirName,
      installedVersion,
      storeVersion: member.storeVersion,
    })
  }
  return candidates
}

/**
 * Split the candidates by the user's answer. Anything not explicitly approved
 * is skipped — the prompt's default on close/decline keeps installed copies.
 */
export function resolveBundleUpdateConsent(
  candidates: BundleUpdateCandidate[],
  approved: Iterable<string>,
): { approved: string[]; skipped: string[] } {
  const approvedSet = new Set(approved)
  const approvedDirNames: string[] = []
  const skipped: string[] = []
  for (const candidate of candidates) {
    if (approvedSet.has(candidate.dirName)) approvedDirNames.push(candidate.dirName)
    else skipped.push(candidate.dirName)
  }
  return { approved: approvedDirNames, skipped }
}
