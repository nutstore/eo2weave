/**
 * Tests for the SkillManager user-skill cache reconciliation (#197).
 *
 * Two scan shapes must not be treated as authoritative:
 *  - a scan that resolves with per-skill errors (unreadable SKILL.md) dropped
 *    that skill from the cache/UI/agent context;
 *  - a scan that fails after a completed delete kept the deleted skill.
 */

import { describe, expect, it } from 'vitest'
import {
  USER_SKILL_ID_PREFIX,
  dirNameFromScanError,
  reconcileUserSkillScan,
  removeUserSkill,
  userSkillId,
} from '@/skills/user-skill-cache'
import type { Skill } from '@/skills/skill-types'

const makeSkill = (dirName: string): Skill =>
  ({
    id: `${USER_SKILL_ID_PREFIX}${dirName}`,
    name: dirName,
    source: 'user',
    enabled: true,
  }) as unknown as Skill

describe('userSkillId / dirNameFromScanError', () => {
  it('builds the manager id for a directory', () => {
    expect(userSkillId('alpha')).toBe('user:alpha')
  })

  it('reads the directory from both scan error formats', () => {
    // SKILL.md read/parse failure.
    expect(dirNameFromScanError('user/alpha/SKILL.md: could not read')).toBe('alpha')
    // Resource failure (skillId is `user:<dirName>`).
    expect(dirNameFromScanError('user:beta/reference.md: file too large')).toBe('beta')
  })

  it('returns null for errors that do not name a user skill', () => {
    expect(dirNameFromScanError('builtin/x/SKILL.md: parse error')).toBeNull()
    expect(dirNameFromScanError('something else entirely')).toBeNull()
  })
})

describe('reconcileUserSkillScan (#197)', () => {
  it('keeps a skill whose directory errored during this scan', () => {
    const previous = [makeSkill('alpha'), makeSkill('broken')]
    const next = reconcileUserSkillScan(previous, {
      skills: [makeSkill('alpha')],
      resources: [],
      errors: ['user/broken/SKILL.md: permission denied'],
    })
    expect(next.map((s) => s.id)).toEqual(['user:alpha', 'user:broken'])
  })

  it('still drops skills that genuinely disappeared from disk', () => {
    const previous = [makeSkill('alpha'), makeSkill('deleted')]
    const next = reconcileUserSkillScan(previous, {
      skills: [makeSkill('alpha')],
      resources: [],
      errors: [],
    })
    expect(next.map((s) => s.id)).toEqual(['user:alpha'])
  })

  it('prefers the freshly scanned entry over the cached one', () => {
    const cached = { ...makeSkill('alpha'), name: 'stale name' } as Skill
    const fresh = { ...makeSkill('alpha'), name: 'fresh name' } as Skill
    const next = reconcileUserSkillScan([cached], {
      skills: [fresh],
      resources: [],
      errors: ['user:alpha/reference.md: file too large'],
    })
    expect(next).toEqual([fresh])
  })
})

describe('removeUserSkill (#197)', () => {
  it('removes only the deleted directory', () => {
    const next = removeUserSkill([makeSkill('alpha'), makeSkill('beta')], 'alpha')
    expect(next.map((s) => s.id)).toEqual(['user:beta'])
  })

  it('is a no-op for an unknown directory', () => {
    const previous = [makeSkill('alpha')]
    expect(removeUserSkill(previous, 'missing')).toEqual(previous)
  })
})
