import { describe, expect, it } from 'vitest'
import {
  authorizeTeamAccess,
  createTeamRunKey,
  formatTeamPath,
  isReservedTeamFile,
  isValidTeamActorId,
  isValidTeamRunKey,
  parseTeamPath,
  teamActorDir,
} from '../team-paths'

const RUN = 'conv-1-2026-11-20'
const OTHER_RUN = 'conv-2-2026-11-20'

function access(overrides: Partial<Parameters<typeof authorizeTeamAccess>[0]> = {}) {
  return authorizeTeamAccess({
    op: 'write',
    runKey: RUN,
    relativePath: 'by/worker-a/notes.md',
    actorId: 'worker-a',
    currentRunKey: RUN,
    isLead: false,
    ...overrides,
  })
}

describe('parseTeamPath', () => {
  it('accepts both the vfs form and the bare form', () => {
    const viaVfs = parseTeamPath(`vfs://team/${RUN}/by/worker-a/notes.md`)
    const bare = parseTeamPath(`team/${RUN}/by/worker-a/notes.md`)
    expect(viaVfs).toEqual(bare)
    expect(viaVfs?.runKey).toBe(RUN)
    expect(viaVfs?.relativePath).toBe('by/worker-a/notes.md')
    expect(viaVfs?.segments).toEqual(['by', 'worker-a', 'notes.md'])
  })

  it('rejects traversal, absolute paths, other namespaces and a bare run', () => {
    expect(parseTeamPath(`vfs://team/${RUN}/by/../secrets.md`)).toBeNull()
    expect(parseTeamPath(`vfs://team/${RUN}/./notes.md`)).toBeNull()
    expect(parseTeamPath(`vfs://team/${RUN}/by/a\\b.md`)).toBeNull()
    expect(parseTeamPath(`vfs://workspace/${RUN}/by/a.md`)).toBeNull()
    expect(parseTeamPath(`vfs://team/${RUN}`)).toBeNull()
    expect(parseTeamPath(`vfs://team/../by/a.md`)).toBeNull()
    expect(parseTeamPath('')).toBeNull()
  })

  it('round-trips through formatTeamPath', () => {
    expect(formatTeamPath(RUN, '/by/worker-a/notes.md')).toBe(`vfs://team/${RUN}/by/worker-a/notes.md`)
    expect(parseTeamPath(formatTeamPath(RUN, 'by/worker-a/notes.md'))?.relativePath).toBe('by/worker-a/notes.md')
  })
})

describe('run key and actor id validation', () => {
  it('accepts ids that look like slugs and rejects anything else', () => {
    expect(isValidTeamRunKey(RUN)).toBe(true)
    expect(isValidTeamActorId('worker-a.2')).toBe(true)
    expect(isValidTeamRunKey('..')).toBe(false)
    expect(isValidTeamRunKey('a/b')).toBe(false)
    expect(isValidTeamRunKey('')).toBe(false)
  })

  it('builds a stable, filesystem-safe run key', () => {
    expect(createTeamRunKey('1795151660134-176ib6t', 'msg-42')).toBe('1795151660134-176ib6t-msg-42')
    expect(isValidTeamRunKey(createTeamRunKey('conv/with/slashes', 'msg-42'))).toBe(true)
  })

  it('gives two consecutive runs of the same conversation different keys', () => {
    // Date-keyed boards were the bug this replaces: same conversation, same day,
    // two runs writing one manifest.
    const first = createTeamRunKey('conv-1', 'msg-41')
    const second = createTeamRunKey('conv-1', 'msg-42')
    expect(first).not.toBe(second)
  })

  it('refuses to invent a run key from missing parts', () => {
    expect(() => createTeamRunKey('', 'msg-42')).toThrow()
    expect(() => createTeamRunKey('conv-1', '')).toThrow()
    expect(() => createTeamRunKey('///', '///')).toThrow()
  })
})

describe('authorizeTeamAccess — members', () => {
  it('lets a member write inside its own directory', () => {
    expect(access()).toEqual({ allowed: true })
  })

  it('refuses a member writing another member’s directory or a reserved file', () => {
    expect(access({ relativePath: 'by/worker-b/notes.md' })).toMatchObject({ allowed: false })
    expect(access({ relativePath: 'manifest.json' })).toMatchObject({ allowed: false })
    expect(access({ relativePath: '00-brief.md' })).toMatchObject({ allowed: false })
    expect(access({ relativePath: '_ledger.jsonl' })).toMatchObject({ allowed: false })
  })

  it('refuses the directory itself, which is not a file', () => {
    expect(access({ relativePath: 'by/worker-a' })).toMatchObject({ allowed: false })
  })

  it('refuses an anonymous member that has no task id either', () => {
    expect(access({ actorId: null })).toMatchObject({ allowed: false })
    expect(access({ actorId: null })).toMatchObject({ reason: expect.stringMatching(/no write area/) })
  })

  it('gives an anonymous member the task id as its slot', () => {
    // Two anonymous members must not share one directory: by/<taskId>/ keeps
    // "who wrote this" answerable without inventing an actor name.
    const anon = { actorId: null, taskId: 't1' } as const
    expect(access({ ...anon, relativePath: 'by/t1/out.md' })).toEqual({ allowed: true })
    expect(access({ ...anon, relativePath: 'by/t2/out.md' })).toMatchObject({ allowed: false })
    expect(access({ ...anon, relativePath: 'manifest.json' })).toMatchObject({ allowed: false })
  })

  it('keeps an actor slot when both actor and task id are present', () => {
    expect(access({ relativePath: 'by/worker-a/out.md', taskId: 't9' })).toEqual({ allowed: true })
    expect(access({ relativePath: 'by/t9/out.md', taskId: 't9' })).toMatchObject({ allowed: false })
  })

  it('reads everything inside its own run, including reserved files', () => {
    expect(access({ op: 'read', relativePath: 'manifest.json' })).toEqual({ allowed: true })
    expect(access({ op: 'read', relativePath: 'by/worker-b/notes.md' })).toEqual({ allowed: true })
  })
})

describe('authorizeTeamAccess — lead and isolation', () => {
  it('lets the lead write reserved files', () => {
    expect(access({ isLead: true, actorId: null, relativePath: 'manifest.json' })).toEqual({ allowed: true })
    expect(access({ isLead: true, actorId: null, relativePath: '_ledger.jsonl' })).toEqual({ allowed: true })
  })

  it('never lets any run touch another run', () => {
    expect(access({ runKey: OTHER_RUN })).toMatchObject({ allowed: false })
    expect(access({ runKey: OTHER_RUN, op: 'read' })).toMatchObject({ allowed: false })
    expect(access({ runKey: OTHER_RUN, op: 'read', isLead: true })).toEqual({ allowed: true })
  })

  it('denies everything when the execution has no active run', () => {
    expect(access({ currentRunKey: '' })).toMatchObject({ allowed: false })
  })

  it('treats the reserved-file list as exactly the files the lead owns', () => {
    expect(isReservedTeamFile('manifest.json')).toBe(true)
    expect(isReservedTeamFile('/00-brief.md')).toBe(true)
    expect(isReservedTeamFile('by/worker-a/manifest.json')).toBe(false)
    expect(teamActorDir('worker-a')).toBe('by/worker-a')
  })
})
