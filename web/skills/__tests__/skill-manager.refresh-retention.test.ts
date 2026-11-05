/**
 * Tests for refreshUserSkills cache retention and reconciliation (#185, #197).
 *
 * Contract: a failed user-skills scan must NOT clear already-loaded skills —
 * the stale cache is the best available state until the next successful
 * refresh. But a scan that RESOLVED with per-skill errors must not drop the
 * skill that errored, and a skill whose OPFS delete COMPLETED must not survive
 * through the retained cache.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { scanUserSkillsMock } = vi.hoisted(() => ({
  scanUserSkillsMock: vi.fn(),
}))

vi.mock('@/skills/user-skills-scanner', () => ({
  scanUserSkills: scanUserSkillsMock,
}))

import { SkillManager } from '@/skills/skill-manager'
import type { Skill, SkillResource } from '@/skills/skill-types'

const makeSkill = (dirName: string): Skill =>
  ({
    id: `user:${dirName}`,
    name: dirName,
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

const ids = (manager: SkillManager): string[] =>
  manager.getSkillMetadata().map((skill) => skill.id)

describe('SkillManager.refreshUserSkills cache retention (#185 review, #197)', () => {
  let manager: SkillManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new SkillManager()
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha')],
      resources: [makeResource('user:alpha')],
      errors: [],
    })
  })

  it('keeps the previously loaded skills and resources when a later scan fails', async () => {
    await manager.refreshUserSkills()
    expect(ids(manager)).toContain('user:alpha')

    scanUserSkillsMock.mockRejectedValue(new Error('DataError: OPFS unavailable'))
    await manager.refreshUserSkills()

    // Stale cache retained, not wiped.
    expect(ids(manager)).toContain('user:alpha')
  })

  it('drops a deleted skill even when the follow-up scan fails (#197)', async () => {
    await manager.refreshUserSkills()
    expect(ids(manager)).toContain('user:alpha')

    // The delete completed; its follow-up rescan fails.
    manager.forgetUserSkill('alpha')
    scanUserSkillsMock.mockRejectedValue(new Error('DataError: OPFS unavailable'))
    await manager.refreshUserSkills()

    // The whole previous cache is kept on failure — but the completed delete
    // must not resurrect the skill through that retained cache.
    expect(ids(manager)).not.toContain('user:alpha')
  })

  it('discards a scan that started before a completed delete (#183 review)', async () => {
    await manager.refreshUserSkills()
    expect(ids(manager)).toContain('user:alpha')

    // A scan is in flight when the delete completes…
    let releaseScan!: (value: unknown) => void
    scanUserSkillsMock.mockReturnValue(
      new Promise((resolve) => {
        releaseScan = resolve
      }),
    )
    const refresh = manager.refreshUserSkills()
    manager.forgetUserSkill('alpha')
    // …and resolves with its pre-delete view, which still lists alpha.
    releaseScan({
      skills: [makeSkill('alpha')],
      resources: [makeResource('user:alpha')],
      errors: [],
    })
    await refresh

    // The stale view must not resurrect the deleted skill.
    expect(ids(manager)).not.toContain('user:alpha')
  })

  it('merges resources for a skill whose resource scan reported errors (#183 review)', async () => {
    const previousResource = {
      ...makeResource('user:alpha'),
      id: 'user:alpha-keep',
      resourcePath: 'references/keep.md',
    } as SkillResource
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha')],
      resources: [previousResource],
      errors: [],
    })
    await manager.refreshUserSkills()

    // Next scan: SKILL.md still parses, but one resource file is unreadable —
    // the scan returns only the OTHER resource.
    const freshResource = {
      ...makeResource('user:alpha'),
      id: 'user:alpha-new',
      resourcePath: 'references/new.md',
    } as SkillResource
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha')],
      resources: [freshResource],
      errors: ['user:alpha/old.md: permission denied'],
    })
    await manager.refreshUserSkills()

    const paths = (await manager.getSkillResources('user:alpha'))
      .map((resource) => resource.resourcePath)
      .sort()
    expect(paths).toEqual(['references/keep.md', 'references/new.md'])
  })

  it('keeps a skill whose SKILL.md errored during an otherwise successful scan (#197)', async () => {
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha'), makeSkill('beta')],
      resources: [makeResource('user:alpha'), makeResource('user:beta')],
      errors: [],
    })
    await manager.refreshUserSkills()
    expect(ids(manager)).toEqual(['user:alpha', 'user:beta'])

    // Beta's directory now fails to parse — the scan reports an error and
    // returns only alpha.
    scanUserSkillsMock.mockResolvedValue({
      skills: [makeSkill('alpha')],
      resources: [makeResource('user:alpha')],
      errors: ['user:beta/SKILL.md: permission denied'],
    })
    await manager.refreshUserSkills()

    expect(ids(manager)).toContain('user:alpha')
    expect(ids(manager)).toContain('user:beta')
  })
})
