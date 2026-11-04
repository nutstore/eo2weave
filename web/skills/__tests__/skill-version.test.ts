import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  decideSkillUpdateAction,
  parseSkillMdVersion,
  skillUpdateNeedsConsent,
} from '@/skills/skill-version'

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

  it('ranks a prerelease BELOW the matching stable release (SemVer)', () => {
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(-1)
    expect(compareVersions('1.2.0', '1.2.0-beta')).toBe(1)
    expect(compareVersions('1.2.0-beta', '1.2.0-alpha')).toBe(1)
    expect(compareVersions('1.2.0-alpha.1', '1.2.0-alpha')).toBe(1)
    expect(compareVersions('1.2.0-alpha.1', '1.2.0-alpha.2')).toBe(-1)
  })

  it('compares prerelease identifiers numerically and lexically per SemVer', () => {
    // Numeric identifiers compare numerically (not lexically).
    expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1)
    // A numeric identifier ranks below an alphanumeric one.
    expect(compareVersions('1.2.0-1', '1.2.0-alpha')).toBe(-1)
    // Alphanumeric identifiers compare lexically (ASCII order).
    expect(compareVersions('1.2.0-alpha', '1.2.0-beta')).toBe(-1)
    expect(compareVersions('1.2.0-rc.1', '1.2.0-rc.2')).toBe(-1)
  })

  it('ignores build metadata for precedence', () => {
    expect(compareVersions('1.2.0+build.1', '1.2.0+build.2')).toBe(0)
    expect(compareVersions('1.2.0+build.1', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0-alpha+build.1', '1.2.0-alpha')).toBe(0)
  })

  it('compares a prerelease against a different core by core first', () => {
    expect(compareVersions('1.2.0-beta', '1.1.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.10.0-beta')).toBe(-1)
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

  it('never overwrites a stable install with a prerelease', () => {
    // The store ships a prerelease of the same core version — it must NOT
    // replace the stable installed copy.
    expect(decideSkillUpdateAction('1.2.0-beta', '1.2.0')).toBe('installed-newer')
    // The other way round: a stable release DOES replace a prerelease.
    expect(decideSkillUpdateAction('1.2.0', '1.2.0-beta')).toBe('update')
  })

  it('treats an unparseable installed version as unknown — never overwrite (#154 round 2)', () => {
    // Junk versions used to rank BELOW any parseable one, so a store
    // release overwrote a locally modified install of unknown provenance.
    // Unknown now keeps the installed copy (conservative, no overwrite).
    expect(decideSkillUpdateAction('2.0.0', 'not-a-version')).toBe('installed-newer')
    expect(decideSkillUpdateAction('2.0.0', '')).toBe('installed-newer')
    expect(decideSkillUpdateAction('2.0.0', 'beta??')).toBe('installed-newer')
    expect(decideSkillUpdateAction('2.0.0', 'latest-draft')).toBe('installed-newer')
  })

  it('treats an unparseable store version as unknown — no update from junk (#154 round 2)', () => {
    expect(decideSkillUpdateAction('not-a-version', '1.0.0')).toBe('installed-newer')
    expect(decideSkillUpdateAction('', '1.0.0')).toBe('installed-newer')
  })

  it('treats identical junk versions on both sides as unknown too (#154 round 2)', () => {
    // Even string-equal junk stays in the unknown lane — the decision never
    // depends on the lexical fallback.
    expect(decideSkillUpdateAction('same', 'same')).toBe('installed-newer')
  })
})

describe('skillUpdateNeedsConsent (issue #154 round 2)', () => {
  it('asks before overwriting an older installed copy', () => {
    expect(skillUpdateNeedsConsent('update')).toBe(true)
  })

  it('does not ask when nothing would be written', () => {
    expect(skillUpdateNeedsConsent('current')).toBe(false)
    expect(skillUpdateNeedsConsent('installed-newer')).toBe(false)
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

  it('reads a single-quoted scalar without the quotes', () => {
    expect(parseSkillMdVersion("---\nversion: '1.2.3'\n---\n")).toBe('1.2.3')
  })

  it('drops an inline comment from the value', () => {
    expect(parseSkillMdVersion('---\nversion: 1.2.3 # released today\n---\n')).toBe('1.2.3')
    expect(parseSkillMdVersion('---\nversion: "1.2.3" # released today\n---\n')).toBe('1.2.3')
    expect(parseSkillMdVersion("---\nversion: '1.2.3' # released today\n---\n")).toBe('1.2.3')
  })

  it('rejects an empty version without consuming the next field', () => {
    // An empty value must not swallow the following field.
    expect(parseSkillMdVersion('---\nversion:\nname: x\n---\n')).toBeNull()
    expect(parseSkillMdVersion('---\nversion:   \nname: x\n---\n')).toBeNull()
    expect(parseSkillMdVersion('---\nversion: ""\nname: x\n---\n')).toBeNull()
    expect(parseSkillMdVersion('---\nversion:\ncategory: general\n---\n')).toBeNull()
  })

  it('ignores a nested version key', () => {
    expect(
      parseSkillMdVersion('---\nname: x\nmetadata:\n  version: 9.9.9\n---\n'),
    ).toBeNull()
  })
})
