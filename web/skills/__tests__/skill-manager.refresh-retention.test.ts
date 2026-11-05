/**
 * Tests for the #185 review round: refreshUserSkills cache retention.
 *
 * Contract: a failed user-skills scan must NOT clear already-loaded skills —
 * the stale cache is the best available state until the next successful
 * refresh. Before the fix the catch wiped cachedUserSkills and
 * userResourcesBySkillId, making loaded skills disappear from the UI and
 * agent context on a transient OPFS error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanUserSkillsMock } = vi.hoisted(() => ({
  scanUserSkillsMock: vi.fn(),
}))

vi.mock('../user-skills-scanner', () => ({
  scanUserSkills: scanUserSkillsMock,
}))

import { SkillManager } from '../skill-manager'
import type { Skill, SkillResource } from '../skill-types'

const makeSkill = (id: string): Skill =>
  ({
    id,
    name: id,
    description: '',
    enabled: true,
    source: 'user',
  }) as unknown as Skill

const makeResource = (skillId: string): SkillResource =>
  ({
    id: `${skillId}-res`,
    skillId,
    name: 'reference.md',
    path: `${skillId}/reference.md`,
  }) as unknown as SkillResource

describe('SkillManager.refreshUserSkills scan-failure cache retention (#185 review)', () => {
  let manager: SkillManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SkillManager()
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha')],
      resources: [makeResource('alpha')],
      errors: [],
    })
  })

  it('keeps the previously loaded skills and resources when a later scan fails', async () => {
    await manager.refreshUserSkills()
    expect(manager.getSkillMetadata().map((s) => s.id)).toContain('alpha')

    scanUserSkillsMock.mockRejectedValue(new Error('DataError: OPFS unavailable'))
    await manager.refreshUserSkills()

    // Stale cache retained, not wiped.
    expect(manager.getSkillMetadata().map((s) => s.id)).toContain('alpha')
  })
})
