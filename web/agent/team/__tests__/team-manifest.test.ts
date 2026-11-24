import { describe, expect, it } from 'vitest'
import {
  emptyTeamManifest,
  findTeamTask,
  parseTeamManifest,
  renderTeamManifest,
  renderTeamTask,
  serializeTeamManifest,
  setTeamTaskStatus,
  tasksForActor,
  upsertTeamTask,
  TeamManifestError,
  type TeamManifest,
} from '../team-manifest'

const sample: TeamManifest = {
  version: 1,
  goal: 'Ship the board',
  tasks: [
    {
      id: 't1',
      goal: 'Audit the resolver',
      assignee: 'gatekeeper',
      status: 'running',
      handoff: { expects: 'file:line list', reads: ['00-brief.md'], writes: ['by/gatekeeper/audit.md'] },
    },
    { id: 't2', goal: 'Write the tests', status: 'pending' },
  ],
}

describe('team manifest parsing', () => {
  it('round-trips a manifest through serialize/parse', () => {
    const parsed = parseTeamManifest(serializeTeamManifest(sample))
    expect(parsed.goal).toBe('Ship the board')
    expect(parsed.tasks.map(task => task.id)).toEqual(['t1', 't2'])
    expect(parsed.tasks[0].handoff).toEqual(sample.tasks[0].handoff)
    expect(parsed.issues).toBeUndefined()
  })

  it('rejects invalid JSON instead of returning an empty board', () => {
    // An empty task list looks exactly like "nothing to do" — silence is worse
    // than a loud parse error here.
    expect(() => parseTeamManifest('{')).toThrow(TeamManifestError)
  })

  it('requires an id and a goal per task', () => {
    expect(() => parseTeamManifest('{"tasks":[{"goal":"x"}]}')).toThrow(/id/)
    expect(() => parseTeamManifest('{"tasks":[{"id":"t1"}]}')).toThrow(/goal/)
  })

  it('rejects duplicate ids', () => {
    expect(() => parseTeamManifest('{"tasks":[{"id":"t1","goal":"a"},{"id":"t1","goal":"b"}]}')).toThrow(/duplicate/)
  })

  it('treats an unknown status as pending and reports it', () => {
    const parsed = parseTeamManifest('{"tasks":[{"id":"t1","goal":"a","status":"finished"}]}')
    expect(parsed.tasks[0].status).toBe('pending')
    expect(parsed.issues?.[0]).toMatch(/unknown status/)
  })

  it('treats a missing status as pending without inventing a complaint', () => {
    const parsed = parseTeamManifest('{"tasks":[{"id":"t1","goal":"a"}]}')
    expect(parsed.tasks[0].status).toBe('pending')
    expect(parsed.issues?.[0]).toMatch(/unknown status/)
  })

  it('drops non-string artifact entries but keeps the string ones', () => {
    const parsed = parseTeamManifest('{"tasks":[{"id":"t1","goal":"a","artifacts":["ok.md",3]}]}')
    expect(parsed.tasks[0].artifacts).toEqual(['ok.md'])
    expect(parsed.issues?.some(issue => /non-string/.test(issue))).toBe(true)
  })

  it('flags a manifest written by a newer build', () => {
    const parsed = parseTeamManifest('{"version":99,"goal":"g","tasks":[]}')
    expect(parsed.issues?.[0]).toMatch(/newer than this build/)
  })

  it('defaults a missing version to the current one', () => {
    expect(parseTeamManifest('{"goal":"g","tasks":[]}').version).toBe(1)
  })
})

describe('team manifest editing', () => {
  it('inserts a new task and replaces an existing one in place', () => {
    const withNew = upsertTeamTask(sample, { id: 't3', goal: 'Third', status: 'pending' })
    expect(withNew.tasks.map(task => task.id)).toEqual(['t1', 't2', 't3'])
    const replaced = upsertTeamTask(sample, { id: 't2', goal: 'Renamed', status: 'blocked' })
    expect(replaced.tasks[1]).toMatchObject({ id: 't2', goal: 'Renamed', status: 'blocked' })
    expect(replaced.tasks).toHaveLength(2)
    // Immutability: the source manifest must not be mutated.
    expect(sample.tasks[1]).toMatchObject({ goal: 'Write the tests', status: 'pending' })
  })

  it('refuses to set a status on an unknown task', () => {
    expect(() => setTeamTaskStatus(sample, 'nope', 'done')).toThrow(/no task "nope"/)
  })

  it('applies a status patch and keeps the other fields', () => {
    const done = setTeamTaskStatus(sample, 't1', 'done', { artifacts: ['by/gatekeeper/audit.md'] })
    expect(findTeamTask(done, 't1')).toMatchObject({
      status: 'done',
      assignee: 'gatekeeper',
      artifacts: ['by/gatekeeper/audit.md'],
    })
  })
})

describe('team manifest views', () => {
  it('scopes tasks to an actor', () => {
    expect(tasksForActor(sample, 'gatekeeper').map(task => task.id)).toEqual(['t1'])
    expect(tasksForActor(sample, 'someone-else')).toEqual([])
    // Unassigned tasks belong to nobody in particular.
    expect(tasksForActor(sample, null).map(task => task.id)).toEqual(['t2'])
  })

  it('renders the lead view with every task and the handoff contract', () => {
    const text = renderTeamManifest(sample)
    expect(text).toContain('Goal: Ship the board')
    expect(text).toContain('[running] t1: Audit the resolver @gatekeeper')
    expect(text).toContain('expects: file:line list')
    expect(text).toContain('writes: by/gatekeeper/audit.md')
    expect(text).toContain('[pending] t2')
  })

  it('renders the member view without other members\' tasks', () => {
    const text = renderTeamManifest(sample, { actorId: 'gatekeeper' })
    expect(text).toContain('t1')
    expect(text).not.toContain('t2')
  })

  it('renders one task by id for the member prompt', () => {
    // Id, not assignee: two anonymous members share `assignee: null`.
    const text = renderTeamTask(sample, 't1')
    expect(text).toContain('[running] t1: Audit the resolver @gatekeeper')
    expect(text).toContain('reads: 00-brief.md')
    expect(text).not.toContain('t2')
    // The run goal is not part of the task: it comes from 00-brief.md.
    expect(text).not.toContain('Run goal')
    expect(renderTeamTask(sample, 'gone')).toBeNull()
  })

  it('says so when nothing is assigned instead of showing an empty section', () => {
    expect(renderTeamManifest(sample, { actorId: 'nobody' })).toContain('No task is assigned to you')
    expect(renderTeamManifest(emptyTeamManifest('g'))).toContain('No tasks yet.')
  })

  it('surfaces parse issues to whoever reads the board', () => {
    const parsed = parseTeamManifest('{"goal":"g","tasks":[{"id":"t1","goal":"a","status":"weird"}]}')
    expect(renderTeamManifest(parsed)).toContain('Manifest issues')
  })
})
