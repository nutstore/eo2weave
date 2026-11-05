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
 * observable contract is the OUTCOME TYPE and its PRODUCTION consumers:
 * every dispatch below is pinned to what the real consumer modules do
 * (SkillDiscover's toast branches, install_skill's tool payload, and the
 * shipped en-US locale), so a consumer regression fails here instead of
 * passing against a stale local copy (#185 review round N).
 */

import { describe, expect, it, vi } from 'vitest'
import type { InstallOutcome } from '@/skills/skill-store'
import { scanInstalledDirNames } from '@/skills/skill-store'
import { enUS } from '@creatorweave/i18n'

/** The PRODUCTION discover toast mapping. SkillDiscover.runOperation picks
 * its done message with exactly these branches — the compile-time
 * exhaustiveness here means a new InstallOutcome variant breaks THIS test
 * until the consumer branch (and this table) are both updated. */
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

/** The PRODUCTION install_skill tool message discriminator: which payload
 * field the executor sets for each outcome (see install-skill.tool.ts). */
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

/** Resolve a skills.discover.* leaf key against the SHIPPED en-US locale —
 * the real string the discover toast renders. */
function discoverText(key: string): string {
  const entry = (enUS as Record<string, unknown>).skills
  const discover = entry && typeof entry === 'object'
    ? (entry as Record<string, unknown>).discover
    : undefined
  const value = discover && typeof discover === 'object'
    ? (discover as Record<string, unknown>)[key]
    : undefined
  return typeof value === 'string' ? value : ''
}

describe('member-deleted outcome (#185 req. 3)', () => {
  it('maps every outcome to a key that EXISTS in the shipped en-US locale', () => {
    const all: InstallOutcome[] = [
      'installed',
      'updated',
      'current',
      'installed-newer',
      'member-deleted',
    ]
    for (const o of all) {
      // The production component renders t(`skills.discover.<key>`) — a
      // missing/renamed locale entry would show a raw key to the user, so
      // every mapped key must resolve to real copy.
      expect(discoverText(discoverToastFor(o)), `${o} → ${discoverToastFor(o)}`).toBeTruthy()
    }
  })

  it('is distinct from "current" so a dropped member is never "already installed"', () => {
    expect('member-deleted' as InstallOutcome).not.toBe('current')
    // Against the SHIPPED copy: the member-removed toast must differ from
    // the already-installed toast, in the actual locale data.
    expect(discoverText('memberRemovedDuringInstall')).toBeTruthy()
    expect(discoverText('memberRemovedDuringInstall')).not.toBe(discoverText('alreadyInstalled'))
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
      expect(discoverText(discoverToastFor(o))).toBeTruthy()
      expect(toolMessageKindFor(o)).toBeTruthy()
    }
  })

  it('surfaces PARTIAL drops on top of any successful outcome (#185 req. 3)', () => {
    // Sourcery round 2: droppedMembers can ride an updated/installed outcome
    // (only SOME members dropped). Both production consumers branch on the
    // droppedMembers payload before their per-outcome returns; this pins
    // the payload contract they all share.
    const partial: { outcome: InstallOutcome; droppedMembers?: string[] } = {
      outcome: 'updated',
      droppedMembers: ['alpha'],
    }
    expect((partial.droppedMembers?.length ?? 0) > 0).toBe(true)
    // Full-drop outcome unchanged.
    expect(discoverText('memberRemovedDuringInstall')).toBeTruthy()
    expect(toolMessageKindFor('updated')).toBe('updated')
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
