import { describe, expect, it } from 'vitest'
import { isGitIgnored } from '@/opfs/native-disk/gitignore-policy'

describe('gitignore policy directory-only rules', () => {
  const rules = [
    { baseDir: '', pattern: 'build/', negated: false },
    { baseDir: '', pattern: '!build/keep.txt', negated: true },
  ]

  it('applies trailing-slash rules to directories only', () => {
    expect(isGitIgnored('build', rules, 'directory')).toBe(true)
    expect(isGitIgnored('build', rules, 'file')).toBe(false)
    expect(isGitIgnored('build/output.js', rules, 'file')).toBe(true)
  })

  it('does not re-include files under an excluded directory', () => {
    expect(isGitIgnored('build/keep.txt', rules, 'file')).toBe(true)
  })
})
