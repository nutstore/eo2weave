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
})
