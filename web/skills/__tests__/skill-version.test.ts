import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  decideSkillUpdateAction,
  parseSkillMdVersion,
} from '../skill-version'

describe('compareVersions', () => {
  it('orders numeric segments numerically', () => {
    expect(compareVersions('1.1.2', '1.1.3')).toBe(-1)
    expect(compareVersions('1.1.3', '1.1.2')).toBe(1)
    expect(compareVersions('1.1.3', '1.1.3')).toBe(0)
    expect(compareVersions('1.2', '1.1.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })
})

describe('decideSkillUpdateAction (issue #154)', () => {
  it('updates in place when the store version is newer', () => {
    expect(decideSkillUpdateAction('1.1.3', '1.1.2')).toBe('update')
  })

  it('keeps the installed copy when versions are equal', () => {
    expect(decideSkillUpdateAction('1.1.2', '1.1.2')).toBe('current')
  })

  it('skips (no silent downgrade) when the installed copy is newer', () => {
    expect(decideSkillUpdateAction('1.1.2', '1.1.3')).toBe('installed-newer')
  })
})

describe('parseSkillMdVersion', () => {
  it('reads the frontmatter version, quoted or bare', () => {
    expect(parseSkillMdVersion('---\nname: x\nversion: "1.2.3"\n---\n\nbody')).toBe('1.2.3')
    expect(parseSkillMdVersion('---\nversion: 2.0\n---\n')).toBe('2.0')
  })

  it('returns null without frontmatter or a version key', () => {
    expect(parseSkillMdVersion('# no frontmatter')).toBeNull()
    expect(parseSkillMdVersion('---\nname: x\n---\n')).toBeNull()
    expect(parseSkillMdVersion('---\nversion: "1.0"\n')).toBeNull()
  })
})
