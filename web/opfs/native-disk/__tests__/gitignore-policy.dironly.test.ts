import { describe, expect, it } from 'vitest'
import { isGitIgnored, parseGitIgnore } from '@/opfs/native-disk/gitignore-policy'

describe('gitignore policy directory-only rules', () => {
  const rules = parseGitIgnore('build/\n')

  it('applies trailing-slash rules to directories only', () => {
    expect(isGitIgnored('build', rules, 'directory')).toBe(true)
    expect(isGitIgnored('build', rules, 'file')).toBe(false)
    expect(isGitIgnored('build/output.js', rules, 'file')).toBe(true)
  })
})

describe('gitignore policy excluded-parent pruning', () => {
  it('does not re-include files under an excluded directory', () => {
    // Git: "It is not possible to re-include a file if a parent directory of
    // that file is excluded." Rules must be built via parseGitIgnore so the
    // negation actually matches (a manually crafted `{ pattern:
    // '!build/keep.txt', negated: true }` rule never matches anything and
    // makes this test vacuous).
    const rules = parseGitIgnore('build/\n!build/keep.txt\n')
    expect(isGitIgnored('build/keep.txt', rules, 'file')).toBe(true)
  })

  it('does not re-include nested descendants of an excluded directory', () => {
    const rules = parseGitIgnore('dist/\n!dist/generated/keep.json\n')
    expect(isGitIgnored('dist', rules, 'directory')).toBe(true)
    expect(isGitIgnored('dist/generated', rules, 'directory')).toBe(true)
    expect(isGitIgnored('dist/generated/keep.json', rules, 'file')).toBe(true)
  })

  it('still re-includes files when their parent directories are not excluded', () => {
    // `build/**` matches descendants (and, under this walker's micromatch
    // semantics, the `build` directory itself), but it is not a directory-only
    // exclusion, so the negation on the file itself must still win.
    const rules = parseGitIgnore('build/**\n!build/keep.txt\n')
    expect(isGitIgnored('build/generated/app.js', rules)).toBe(true)
    expect(isGitIgnored('build/keep.txt', rules)).toBe(false)
  })

  it('lets a negated directory rule re-include a directory before exclusion is reached', () => {
    // Git idiom: exclude everything directly under logs/, then re-include the
    // keep/ directory itself (git check-ignore: audit.txt not ignored).
    const rules = parseGitIgnore('logs/*\n!logs/keep/\n')
    expect(isGitIgnored('logs/keep', rules, 'directory')).toBe(false)
    expect(isGitIgnored('logs/keep/audit.txt', rules)).toBe(false)
    expect(isGitIgnored('logs/other.txt', rules)).toBe(true)
  })
})
