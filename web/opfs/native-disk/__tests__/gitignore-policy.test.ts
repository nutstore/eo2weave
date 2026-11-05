import { describe, expect, it } from 'vitest'
import { isGitIgnored, parseGitIgnore } from '../gitignore-policy'

describe('gitignore policy', () => {
  it('matches ignored dependency directories and their contents', () => {
    const rules = parseGitIgnore('node_modules/\ndist/\n')

    expect(isGitIgnored('node_modules', rules)).toBe(true)
    expect(isGitIgnored('node_modules/react/index.js', rules)).toBe(true)
    expect(isGitIgnored('dist/assets/app.js', rules)).toBe(true)
    expect(isGitIgnored('src/app.ts', rules)).toBe(false)
  })

  it('honors later negated rules', () => {
    const rules = parseGitIgnore('build/**\n!build/keep.txt\n')

    expect(isGitIgnored('build/generated/app.js', rules)).toBe(true)
    expect(isGitIgnored('build/keep.txt', rules)).toBe(false)
  })

  it('applies nested .gitignore rules only beneath their directory', () => {
    const rules = [
      ...parseGitIgnore('*.log\n'),
      ...parseGitIgnore('cache/\n', 'packages/app'),
    ]

    expect(isGitIgnored('server.log', rules)).toBe(true)
    expect(isGitIgnored('packages/app/cache/index.json', rules)).toBe(true)
    expect(isGitIgnored('packages/other/cache/index.json', rules)).toBe(false)
  })

  it('does not match a same-named regular file under a directory-only rule (#186)', () => {
    const rules = parseGitIgnore('build/\n')

    // A REGULAR file named `build` must not be classified as ignored by the
    // directory-only `build/` rule — otherwise deleteFile bypasses pending
    // review and silently removes it from disk.
    expect(isGitIgnored('build', rules, 'file')).toBe(false)
    // The directory itself and anything beneath it stay ignored.
    expect(isGitIgnored('build', rules, 'directory')).toBe(true)
    expect(isGitIgnored('build/generated/app.js', rules, 'file')).toBe(true)
    // Same for glob-qualified directory-only patterns.
    expect(isGitIgnored('build', parseGitIgnore('**/build/\n'), 'file')).toBe(false)
    expect(isGitIgnored('packages/x/build', parseGitIgnore('**/build/\n'), 'file')).toBe(false)
    expect(isGitIgnored('packages/x/build', parseGitIgnore('**/build/\n'), 'directory')).toBe(true)
    // Git: `dir/**` covers a directory's contents but not the directory
    // itself — a same-named REGULAR file must not match it either.
    expect(isGitIgnored('dist', parseGitIgnore('dist/**\n'), 'file')).toBe(false)
    expect(isGitIgnored('dist/a.js', parseGitIgnore('dist/**\n'), 'file')).toBe(true)
    expect(isGitIgnored('a/dist', parseGitIgnore('**/dist/**\n'), 'file')).toBe(false)
    expect(isGitIgnored('a/dist/a.js', parseGitIgnore('**/dist/**\n'), 'file')).toBe(true)
  })
})
