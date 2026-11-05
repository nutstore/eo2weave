import { describe, expect, it } from 'vitest'
import { isGitIgnored, parseGitIgnore } from '../gitignore-policy'

describe('gitignore policy', () => {
  it('treats a trailing slash as a directory-only rule', () => {
    const rules = parseGitIgnore('output/\n')
    expect(isGitIgnored('output', rules, 'file')).toBe(false)
    expect(isGitIgnored('output', rules, 'directory')).toBe(true)
    expect(isGitIgnored('output/result.txt', rules, 'file')).toBe(true)
  })
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

  it('does not classify the directory itself as ignored under a trailing-/** rule', () => {
    // git check-ignore: `dist/**` does NOT ignore the directory `dist` itself
    // (it covers contents only). The previous candidate set let micromatch's
    // `a/**` match the bare `a`, so deleteDirPending treated an ignored tree's
    // root as ignored and deleted it immediately without pending review.
    expect(isGitIgnored('dist', parseGitIgnore('dist/**\n'), 'directory')).toBe(false)
    // Contents beneath the directory stay ignored.
    expect(isGitIgnored('dist/a', parseGitIgnore('dist/**\n'), 'directory')).toBe(true)
    expect(isGitIgnored('dist/a.js', parseGitIgnore('dist/**\n'), 'file')).toBe(true)
    // Glob-qualified variant: the base matched through `**` is equally exempt.
    expect(isGitIgnored('a/dist', parseGitIgnore('**/dist/**\n'), 'directory')).toBe(false)
    expect(isGitIgnored('a/dist/x', parseGitIgnore('**/dist/**\n'), 'directory')).toBe(true)
  })

  it('keeps a negated file ignored under a glob-qualified trailing-/** rule (#184)', () => {
    // git check-ignore: with `**/dist/**` + `!dist/generated/keep.json`,
    // keep.json stays IGNORED — an exclusion qualified with `**` blocks
    // re-inclusion beneath it. The old ancestor check compared the literal
    // prefix `**/dist/` with startsWith and never recognized `dist` or
    // `dist/generated` as excluded, so the negation won and the file missed
    // immediate deletion.
    const rules = parseGitIgnore('**/dist/**\n!dist/generated/keep.json\n')
    expect(isGitIgnored('dist/generated/keep.json', rules, 'file')).toBe(true)
    expect(isGitIgnored('dist/generated/app.js', rules, 'file')).toBe(true)
    // Unqualified `dir/**` behaves the same (excluded dir cannot be
    // re-included beneath): `!dist/a/keep.txt` does NOT rescue the file.
    const unqualified = parseGitIgnore('dist/**\n!dist/a/keep.txt\n')
    expect(isGitIgnored('dist/a/keep.txt', unqualified, 'file')).toBe(true)
  })
})
