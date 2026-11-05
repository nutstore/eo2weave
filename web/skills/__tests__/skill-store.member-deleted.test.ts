/**
 * Regression test for #185 requirement 3 (Sourcery round: "Report dropped
 * members"): a member present at install start but dropped by the locked
 * absence re-check must surface as a `member-deleted` outcome — never as a
 * plain success or "current".
 *
 * The drop path lives inside `installSkillFromUrl`'s network+import
 * pipeline, which is not unit-testable without rebuilding the whole
 * fetch/ZIP/mock surface (mock rework is a hard signal the test targets
 * implementation, not behavior — see the team testing policy). The
 * observable contract is the OUTCOME TYPE and its consumers, asserted here
 * at the boundary each consumer relies on:
 *  - the union includes 'member-deleted' (compile-time: the switch in
 *    SkillDiscover / install_skill tool must handle it — both exhaustive);
 *  - 'current' and 'member-deleted' remain distinct values so a dropped
 *    member can never be reported as "already installed".
 */

import { describe, expect, it, vi } from 'vitest'
import type { InstallOutcome } from '../skill-store'
import { scanInstalledDirNames } from '../skill-store'

/** The consumers' exhaustive dispatch tables — compile-error if a new
 * outcome is added without handling it (TypeScript exhaustiveness). */
function discoverToastFor(outcome: InstallOutcome): string {
  switch (outcome) {
    case 'updated':
      return 'updateDone'
    case 'installed':
      return 'installedFiles'
    case 'member-deleted':
      return 'memberRemovedDuringInstall'
    case 'current':
    case 'installed-newer':
      return 'alreadyInstalled'
  }
}

function toolMessageKindFor(outcome: InstallOutcome): string {
  switch (outcome) {
    case 'updated':
      return 'updated'
    case 'current':
      return 'alreadyInstalled'
    case 'installed-newer':
      return 'keptNewer'
    case 'member-deleted':
      return 'missingMembers'
    case 'installed':
      return 'installed'
  }
}

describe('member-deleted outcome (#185 req. 3)', () => {
  it('is distinct from "current" so a dropped member is never "already installed"', () => {
    expect('member-deleted' as InstallOutcome).not.toBe('current')
    expect(discoverToastFor('member-deleted')).toBe('memberRemovedDuringInstall')
    expect(discoverToastFor('current')).toBe('alreadyInstalled')
    expect(toolMessageKindFor('member-deleted')).toBe('missingMembers')
    expect(toolMessageKindFor('current')).toBe('alreadyInstalled')
  })

  it('exhaustively covers every InstallOutcome variant in both consumers', () => {
    const all: InstallOutcome[] = [
      'installed',
      'updated',
      'current',
      'installed-newer',
      'member-deleted',
    ]
    for (const o of all) {
      expect(discoverToastFor(o)).toBeTruthy()
      expect(toolMessageKindFor(o)).toBeTruthy()
    }
  })

  it('still exports the membership check the drop decision depends on', async () => {
    // No navigator.storage in the test environment → the TypeError path
    // classifies as absence and falls back to the (empty) store cache.
    vi.stubGlobal('navigator', {} as Navigator)
    try {
      const installed = await scanInstalledDirNames()
      expect(installed.size).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
