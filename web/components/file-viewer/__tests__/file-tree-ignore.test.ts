import { describe, expect, it } from 'vitest'
import {
  isTreeEntryIgnored,
  parseTreeIgnoreRules,
  treeIgnoreRulesFor,
  withDirectoryIgnoreRules,
  type TreeIgnoreRules,
} from '@/components/file-viewer/file-tree-ignore'

/** Accumulate .gitignore files the way the tree does while it loads directories. */
function loadRules(directories: Array<[string, string]>): TreeIgnoreRules {
  return directories.reduce<TreeIgnoreRules>(
    (rules, [directory, content]) =>
      withDirectoryIgnoreRules(rules, directory, parseTreeIgnoreRules(content, directory)),
    new Map()
  )
}

function ignored(rulesByDirectory: TreeIgnoreRules, path: string, kind: 'file' | 'directory' = 'file'): boolean {
  return isTreeEntryIgnored({ path, kind }, treeIgnoreRulesFor(path, rulesByDirectory))
}

describe('file tree ignore status', () => {
  it('marks a directory-only rule\'s contents ignored and its root not', () => {
    const rules = parseTreeIgnoreRules('dist/\n')

    // The directory itself is ignored (git check-ignore: `dist/`).
    expect(isTreeEntryIgnored({ path: 'dist', kind: 'directory' }, rules)).toBe(true)
    expect(isTreeEntryIgnored({ path: 'dist/assets/app.js', kind: 'file' }, rules)).toBe(true)
    // A regular file with the same name is not covered by a directory-only
    // rule — the backend sends it through pending review.
    expect(isTreeEntryIgnored({ path: 'dist', kind: 'file' }, rules)).toBe(false)
  })

  it('does not mark a trailing-/** rule\'s base directory ignored', () => {
    // git check-ignore: `dist/**` covers the contents, not the directory
    // itself, so the tree must not dim the `dist` row.
    const rules = parseTreeIgnoreRules('dist/**\n')

    expect(isTreeEntryIgnored({ path: 'dist', kind: 'directory' }, rules)).toBe(false)
    expect(isTreeEntryIgnored({ path: 'dist/assets', kind: 'directory' }, rules)).toBe(true)
    expect(isTreeEntryIgnored({ path: 'dist/assets/app.js', kind: 'file' }, rules)).toBe(true)
  })

  it('keeps files beneath an excluded ancestor ignored despite a later negation', () => {
    // Git: "It is not possible to re-include a file if a parent directory of
    // that file is excluded." The tree must keep showing the file as
    // ignored, matching the backend's delete policy.
    const rules = parseTreeIgnoreRules('dist/**\n!dist/assets/keep.json\n')

    expect(isTreeEntryIgnored({ path: 'dist/assets/keep.json', kind: 'file' }, rules)).toBe(true)
    expect(isTreeEntryIgnored({ path: 'dist/assets/app.js', kind: 'file' }, rules)).toBe(true)
  })

  it('un-ignores files beneath a directory re-included by a negated directory rule', () => {
    // git check-ignore: with `logs/*` + `!logs/keep/`, `logs/keep/audit.txt`
    // is NOT ignored. The tree must not dim it — the backend reviews it
    // instead of deleting it outright (#189).
    const rules = parseTreeIgnoreRules('logs/*\n!logs/keep/\n')

    expect(isTreeEntryIgnored({ path: 'logs/keep', kind: 'directory' }, rules)).toBe(false)
    expect(isTreeEntryIgnored({ path: 'logs/keep/audit.txt', kind: 'file' }, rules)).toBe(false)
    // Entries the negation does not cover stay ignored.
    expect(isTreeEntryIgnored({ path: 'logs/other.txt', kind: 'file' }, rules)).toBe(true)
  })

  it('displays the same status the backend delete policy applies', () => {
    // The tree must not carry its own matcher: the displayed status has to
    // be the policy the delete flow applies, so a dimmed row is exactly an
    // entry the backend deletes without pending review.
    const rules = parseTreeIgnoreRules('dist/**\n!dist/assets/keep.json\nlogs/*\n!logs/keep/\n')
    const entries = [
      { path: 'dist', kind: 'directory' as const },
      { path: 'dist/assets', kind: 'directory' as const },
      { path: 'dist/assets/app.js', kind: 'file' as const },
      { path: 'dist/assets/keep.json', kind: 'file' as const },
      { path: 'logs/keep', kind: 'directory' as const },
      { path: 'logs/keep/audit.txt', kind: 'file' as const },
      { path: 'logs/other.txt', kind: 'file' as const },
      { path: 'src/app.ts', kind: 'file' as const },
    ]

    expect(entries.map((entry) => isTreeEntryIgnored(entry, rules))).toEqual([
      false, // dist — trailing-/** covers contents, not the directory
      true, // dist/assets
      true, // dist/assets/app.js
      true, // dist/assets/keep.json — excluded ancestor wins
      false, // logs/keep — re-included directory
      false, // logs/keep/audit.txt — re-included subtree
      true, // logs/other.txt
      false, // src/app.ts
    ])
  })
})

describe('file tree nested ignore rules', () => {
  it('applies a nested .gitignore that the root file does not repeat', () => {
    // git check-ignore in a scratch repo: empty root .gitignore plus
    // sub/.gitignore `build/` reports sub/build/out.js ignored (exit 0).
    const rules = loadRules([
      ['', ''],
      ['sub', 'build/\n'],
    ])

    expect(ignored(rules, 'sub/build', 'directory')).toBe(true)
    expect(ignored(rules, 'sub/build/out.js')).toBe(true)
    // The rule is scoped to sub/, so a sibling build directory stays clean.
    expect(ignored(rules, 'other/build', 'directory')).toBe(false)
    expect(ignored(rules, 'other/build/out.js')).toBe(false)
  })

  it('lets a nested negation re-include a file the root rule ignores', () => {
    // git check-ignore: root `*.log` plus sub/.gitignore `!keep.log` leaves
    // sub/keep.log untracked-but-clean (exit 1), while sub/other.log and
    // other/a.log stay ignored (exit 0).
    const rules = loadRules([
      ['', '*.log\n'],
      ['sub', '!keep.log\n'],
    ])

    expect(ignored(rules, 'sub/keep.log')).toBe(false)
    expect(ignored(rules, 'sub/other.log')).toBe(true)
    expect(ignored(rules, 'other/a.log')).toBe(true)
  })

  it('keeps a nested rule from leaking into sibling subtrees', () => {
    // git check-ignore: sub/.gitignore `*.log` does not ignore other/a.log
    // (exit 1), only sub/other.log (exit 0).
    const rules = loadRules([
      ['', ''],
      ['sub', '*.log\n'],
    ])

    expect(ignored(rules, 'sub/other.log')).toBe(true)
    expect(ignored(rules, 'other/a.log')).toBe(false)
  })

  it('inherits root rules into nested directories', () => {
    // git check-ignore: a root `dist/` rule also covers sub/dist/app.js
    // (unqualified patterns match at any depth), while sub/build/out.js stays
    // clean because no rule names it.
    const rules = loadRules([
      ['', 'dist/\n'],
      ['sub', 'build/\n'],
    ])

    expect(ignored(rules, 'sub/dist/app.js')).toBe(true)
    expect(ignored(rules, 'sub/build/out.js')).toBe(true)
    expect(ignored(rules, 'other/build/out.js')).toBe(false)
  })
})
