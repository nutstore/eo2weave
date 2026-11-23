import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../tools/tool-types'

const resolveVfsTargetMock = vi.hoisted(() => vi.fn())
vi.mock('../../tools/vfs-resolver', () => ({ resolveVfsTarget: resolveVfsTargetMock }))

import {
  appendTeamLedger,
  assignTeamTask,
  buildTeamTaskSection,
  listTeamSlotFiles,
  readTeamBrief,
  readTeamManifest,
  readTeamTaskView,
  recordTeamTaskOutcome,
  teamBoardQueuePolicy,
  teamManifestPath,
  writeTeamManifest,
} from '../team-board'
import { parseTeamManifest, serializeTeamManifest, emptyTeamManifest } from '../team-manifest'

const RUN_KEY = 'conv-1-run-1'

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceId: 'ws-1', projectId: 'proj-1', teamRunKey: RUN_KEY, ...overrides } as ToolContext
}

/**
 * Path-aware board fixture: the manifest and the ledger are two files, so a
 * single-store fake silently appends ledger JSON onto the manifest and turns a
 * passing test into an invalid-JSON crash.
 */
function boardStore(initial?: string) {
  const store: { content?: string; ledger?: string } = { content: initial }
  resolveVfsTargetMock.mockImplementation(async (rawPath: string) => {
    const isLedger = rawPath.endsWith('_ledger.jsonl')
    return {
      kind: 'team' as const,
      path: isLedger ? '_ledger.jsonl' : 'manifest.json',
      backend: {
        readFile: async () => {
          const value = isLedger ? store.ledger : store.content
          if (value === undefined) throw new Error('NotFoundError')
          return { content: value, size: value.length, mimeType: 'text/plain' }
        },
        writeFile: async (target: string, content: string) => {
          if (target === '_ledger.jsonl') store.ledger = content
          else store.content = content
        },
      },
    }
  })
  return store
}

/** Read-only board fake: no state, just a resolved target for parse/read tests. */
function backendWith(store: { content?: string }) {
  return {
    kind: 'team' as const,
    path: 'manifest.json',
    backend: {
      writeFile: vi.fn(async () => undefined),
      readFile: vi.fn(async () => {
        if (store.content === undefined) throw new Error('NotFoundError')
        return { content: store.content, size: store.content.length, mimeType: 'application/json' }
      }),
    },
  }
}

describe('team board paths', () => {
  it('keeps the manifest inside the run directory', () => {
    expect(teamManifestPath(RUN_KEY)).toBe(`vfs://team/${RUN_KEY}/manifest.json`)
  })
})

describe('team board reads', () => {
  beforeEach(() => { resolveVfsTargetMock.mockReset() })

  it('returns null when the context has no run key (board disabled)', async () => {
    expect(await readTeamManifest(context({ teamRunKey: undefined }))).toBeNull()
    expect(resolveVfsTargetMock).not.toHaveBeenCalled()
  })

  it('returns null when the manifest does not exist yet', async () => {
    // First spawn of a run: no file, no board, and that is not an error.
    resolveVfsTargetMock.mockResolvedValue(backendWith({}))
    expect(await readTeamManifest(context())).toBeNull()
  })

  it('parses an existing manifest', async () => {
    const store = { content: serializeTeamManifest({ ...emptyTeamManifest('Ship it'), tasks: [{ id: 't1', goal: 'x', status: 'pending' as const }] }) }
    resolveVfsTargetMock.mockResolvedValue(backendWith(store))
    const manifest = await readTeamManifest(context())
    expect(manifest?.goal).toBe('Ship it')
    expect(manifest?.tasks[0].id).toBe('t1')
  })

  it('asks the resolver for read access, never resolves paths itself', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({}))
    await readTeamManifest(context())
    expect(resolveVfsTargetMock).toHaveBeenCalledWith(`vfs://team/${RUN_KEY}/manifest.json`, expect.anything(), 'read')
  })

  it('throws on a corrupt manifest instead of reporting an empty board', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({ content: '{ broken' }))
    await expect(readTeamManifest(context())).rejects.toThrow(/invalid JSON/)
  })

  it('reads the run goal from 00-brief.md', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({ content: 'Ship the board.\nTwo lines.' }))
    expect(await readTeamBrief(context())).toBe('Ship the board.\nTwo lines.')
  })

  it('returns null for a missing or empty brief', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({}))
    expect(await readTeamBrief(context())).toBeNull()
    resolveVfsTargetMock.mockResolvedValue(backendWith({ content: '   \n  ' }))
    expect(await readTeamBrief(context())).toBeNull()
  })

  it('bounds a runaway brief so it cannot crowd out the task', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({ content: 'x'.repeat(2000) }))
    const goal = await readTeamBrief(context())
    expect(goal?.length).toBe(801)
    expect(goal?.endsWith('…')).toBe(true)
  })
})

describe('team board re-read on resume', () => {
  beforeEach(() => { resolveVfsTargetMock.mockReset() })

  it("renders a member's own task and the run goal", async () => {
    const manifest = serializeTeamManifest({
      ...emptyTeamManifest('Ship it'),
      tasks: [{ id: 't1', goal: 'Inspect the diff', status: 'running' as const }],
    })
    resolveVfsTargetMock.mockImplementation(async (rawPath: string) => {
      const isBrief = rawPath.endsWith('00-brief.md')
      return {
        kind: 'team' as const,
        path: isBrief ? '00-brief.md' : 'manifest.json',
        backend: {
          writeFile: vi.fn(async () => undefined),
          readFile: vi.fn(async () => ({
            content: isBrief ? 'Ship the board.' : manifest,
            size: 1,
            mimeType: 'text/plain',
          })),
        },
      }
    })

    const view = await readTeamTaskView(context(), 't1')
    expect(view.brief).toContain('Inspect the diff')
    expect(view.runGoal).toBe('Ship the board.')
    expect(view.error).toBeUndefined()
  })

  it('reports an unreadable board instead of claiming the task was never recorded', async () => {
    resolveVfsTargetMock.mockResolvedValue(backendWith({ content: '{ broken' }))
    const view = await readTeamTaskView(context(), 't1')
    expect(view.brief).toBeNull()
    expect(view.error).toMatch(/invalid JSON/)
  })
})

describe('team board writes', () => {
  beforeEach(() => { resolveVfsTargetMock.mockReset() })

  it('refuses to overwrite a board it could not parse', async () => {
    // One malformed manifest must fail the spawn: degrading to an empty board
    // would drop every task, handoff and artifact already on it.
    const store = boardStore('{ broken')
    const { error } = await assignTeamTask(context(), { taskId: 't1', goal: 'x' })
    expect(error).toMatch(/invalid JSON/)
    expect(store.content).toBe('{ broken')
  })

  it('refuses to write without a run key', async () => {
    await expect(writeTeamManifest(context({ teamRunKey: undefined }), emptyTeamManifest())).rejects.toThrow(/run key/)
  })

  it('rejects a write path that the member could never use', async () => {
    // Anonymous member => its slot is by/t1/, so by/probe-a/out.md is unreachable.
    const { error, fatal } = await assignTeamTask(context(), {
      taskId: 't1',
      goal: 'x',
      handoff: { writes: ['by/probe-a/out.md'] },
    })
    expect(fatal).toBe(true)
    expect(error).toMatch(/must stay inside by\/t1\//)
    expect(resolveVfsTargetMock).not.toHaveBeenCalled()
  })

  it('accepts a write path inside the anonymous slot, and inside the actor slot', async () => {
    boardStore()
    const anon = await assignTeamTask(context(), { taskId: 't1', goal: 'x', handoff: { writes: ['by/t1/out.md'] } })
    expect(anon.error).toBeUndefined()
    // A named actor keeps its own directory, whatever the task id is.
    const named = await assignTeamTask(context(), {
      taskId: 't2',
      goal: 'y',
      assignee: 'gatekeeper',
      handoff: { writes: ['by/gatekeeper/audit.md'] },
    })
    expect(named.error).toBeUndefined()
  })

  it('refuses a task id that cannot become a directory name', async () => {
    const { error, fatal } = await assignTeamTask(context(), { taskId: 'has spaces/../etc', goal: 'x' })
    expect(fatal).toBe(true)
    expect(error).toMatch(/cannot derive a write area/)
  })

  it('records a new task as running with its handoff', async () => {
    const store = boardStore()
    const { result, error } = await assignTeamTask(context(), {
      taskId: 't1',
      goal: 'Audit the resolver',
      assignee: 'gatekeeper',
      handoff: { expects: 'file:line list', reads: ['00-brief.md'] },
    })
    expect(error).toBeUndefined()
    expect(result?.task).toMatchObject({ id: 't1', status: 'running', assignee: 'gatekeeper' })
    const written = parseTeamManifest(store.content ?? '')
    expect(written.tasks).toHaveLength(1)
    expect(written.tasks[0].handoff?.reads).toEqual(['00-brief.md'])
    expect(result?.brief).toContain('Audit the resolver')
  })

  it('preserves both tasks and ledger entries when assigning in parallel', async () => {
    const store = boardStore()
    const outcomes = await Promise.all([
      assignTeamTask(context(), { taskId: 't1', goal: 'First task' }),
      assignTeamTask(context({ workspaceId: 'ws-2' }), { taskId: 't2', goal: 'Second task' }),
    ])

    expect(outcomes.map(outcome => outcome.error)).toEqual([undefined, undefined])
    expect(parseTeamManifest(store.content ?? '').tasks.map(task => task.id)).toEqual(['t1', 't2'])
    const entries = (store.ledger ?? '').trim().split('\n').map(line => JSON.parse(line))
    expect(entries.map(entry => entry.taskId)).toEqual(['t1', 't2'])
  })

  it('fails loudly instead of hanging when a board write never settles', async () => {
    const previousTimeout = teamBoardQueuePolicy.waitTimeoutMs
    teamBoardQueuePolicy.waitTimeoutMs = 20
    // A wedged backend write: the queue must surface it, not swallow the run.
    resolveVfsTargetMock.mockImplementation(async () => ({
      kind: 'team' as const,
      path: 'manifest.json',
      backend: { readFile: () => new Promise(() => {}), writeFile: async () => {} },
    }))
    try {
      const stuck = assignTeamTask(context(), { taskId: 't1', goal: 'stuck' })
      void stuck.catch(() => {})
      const queued = await assignTeamTask(context({ workspaceId: 'ws-2' }), { taskId: 't2', goal: 'queued' })
      expect(queued.error).toMatch(/write queue is stuck/)
    } finally {
      teamBoardQueuePolicy.waitTimeoutMs = previousTimeout
    }
  })

  it('keeps the goal the lead already wrote and appends new handoff fields', async () => {
    boardStore(serializeTeamManifest({ ...emptyTeamManifest('Run goal'), tasks: [{ id: 't1', goal: 'Original goal', status: 'pending' as const, handoff: { expects: 'a list' } }] }))
    const { result } = await assignTeamTask(context(), { taskId: 't1', goal: 'Different wording', handoff: { writes: ['by/t1/out.md'] } })
    expect(result?.task.goal).toBe('Original goal')
    expect(result?.task.handoff).toEqual({ expects: 'a list', writes: ['by/t1/out.md'] })
    expect(result?.task.status).toBe('running')
  })

  it('preserves artifacts recorded by an earlier attempt', async () => {
    boardStore(serializeTeamManifest({ ...emptyTeamManifest('g'), tasks: [{ id: 't1', goal: 'x', status: 'done' as const, artifacts: ['by/x/out.md'] }] }))
    const { result } = await assignTeamTask(context(), { taskId: 't1' })
    expect(result?.task.artifacts).toEqual(['by/x/out.md'])
  })

  it('reports a board write failure instead of throwing into the spawn', async () => {
    // A board that cannot be written degrades the prompt; it must not kill the run.
    // The failure is simulated on the backend on purpose: a `vi.fn()` whose
    // implementation throws is reported by vitest as a test error even when the
    // caller catches it, which would test the harness instead of the code.
    resolveVfsTargetMock.mockResolvedValue({
      kind: 'team' as const,
      path: 'manifest.json',
      backend: {
        readFile: async () => {
          throw new Error('NotFoundError')
        },
        writeFile: async () => {
          throw new Error('QuotaExceededError: board unwritable')
        },
      },
    })
    const { result, error } = await assignTeamTask(context(), { taskId: 't1', goal: 'x' })
    expect(result).toBeUndefined()
    expect(error).toMatch(/QuotaExceededError/)
  })

  it('reports a missing run key as an error', async () => {
    const { error } = await assignTeamTask(context({ teamRunKey: undefined }), { taskId: 't1' })
    expect(error).toMatch(/run key/)
  })
})

describe('team board terminal states', () => {
  beforeEach(() => { resolveVfsTargetMock.mockReset() })


  const running = serializeTeamManifest({
    ...emptyTeamManifest('g'),
    tasks: [{ id: 't1', goal: 'x', status: 'running' as const }],
  })

  it('flips a task to done and records what it left behind', async () => {
    const store = boardStore(running)
    await recordTeamTaskOutcome(context(), { taskId: 't1', status: 'done', artifacts: ['by/t1/out.md'] })
    const written = parseTeamManifest(store.content ?? '')
    expect(written.tasks[0]).toMatchObject({ status: 'done', artifacts: ['by/t1/out.md'] })
  })

  it('flips a task to blocked so the board stops claiming it is in flight', async () => {
    const store = boardStore(running)
    await recordTeamTaskOutcome(context(), { taskId: 't1', status: 'blocked', error: 'boom' })
    expect(parseTeamManifest(store.content ?? '').tasks[0].status).toBe('blocked')
  })

  it('preserves both terminal states when tasks finish in parallel', async () => {
    const store = boardStore(serializeTeamManifest({
      ...emptyTeamManifest('g'),
      tasks: [
        { id: 't1', goal: 'First task', status: 'running' },
        { id: 't2', goal: 'Second task', status: 'running' },
      ],
    }))

    await Promise.all([
      recordTeamTaskOutcome(context(), { taskId: 't1', status: 'done', artifacts: ['by/t1/out.md'] }),
      recordTeamTaskOutcome(context(), { taskId: 't2', status: 'blocked', error: 'boom' }),
    ])

    expect(parseTeamManifest(store.content ?? '').tasks).toMatchObject([
      { id: 't1', status: 'done', artifacts: ['by/t1/out.md'] },
      { id: 't2', status: 'blocked' },
    ])
  })

  it('refuses to finish a task that is not on the board', async () => {
    boardStore(running)
    await expect(recordTeamTaskOutcome(context(), { taskId: 'ghost', status: 'done' })).rejects.toThrow(/no task "ghost"/)
  })

  it('creates the ledger on the first event and appends after that', async () => {
    const store = boardStore(running)
    await appendTeamLedger(context(), { at: 1, taskId: 't1', event: 'spawned', status: 'running' })
    await appendTeamLedger(context(), { at: 2, taskId: 't1', event: 'done', status: 'done' })
    const lines = (store.ledger ?? '').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ event: 'spawned', status: 'running' })
    expect(lines[1]).toMatchObject({ event: 'done', status: 'done' })
  })

  it('keeps existing ledger lines when appending', async () => {
    const store = boardStore(running)
    store.ledger = '{"event":"spawned"}\n'
    await appendTeamLedger(context(), { at: 3, taskId: 't1', event: 'blocked', status: 'blocked' })
    expect(store.ledger?.startsWith('{"event":"spawned"}\n')).toBe(true)
    expect(store.ledger?.endsWith('\n')).toBe(true)
  })

  it('preserves both ledger entries when appending in parallel', async () => {
    const store = boardStore(running)
    await Promise.all([
      appendTeamLedger(context(), { at: 1, taskId: 't1', event: 'done', status: 'done' }),
      appendTeamLedger(context(), { at: 2, taskId: 't2', event: 'blocked', status: 'blocked' }),
    ])

    const entries = (store.ledger ?? '').trim().split('\n').map(line => JSON.parse(line))
    expect(entries.map(entry => entry.taskId)).toEqual(['t1', 't2'])
  })

  it('lists only files in the member slot, as board-relative paths', async () => {
    resolveVfsTargetMock.mockResolvedValue({
      kind: 'team' as const,
      path: 'by/t1',
      backend: {
        listDir: async () => [
          { name: 'out.md', path: 'by/t1/out.md', kind: 'file' },
          { name: 'nested', path: 'by/t1/nested', kind: 'directory' },
        ],
      },
    })
    expect(await listTeamSlotFiles(context(), 'by/t1')).toEqual(['by/t1/out.md'])
  })

  it('returns an empty artifact list when the slot does not exist yet', async () => {
    resolveVfsTargetMock.mockResolvedValue({
      kind: 'team' as const,
      path: 'by/t1',
      backend: {
        listDir: async () => {
          throw new Error('NotFoundError')
        },
      },
    })
    expect(await listTeamSlotFiles(context(), 'by/t1')).toEqual([])
  })
})

describe('member prompt section', () => {
  it('names the actor slot when the member runs as an agent', () => {
    const section = buildTeamTaskSection({
      runKey: RUN_KEY,
      brief: '- [running] t1: do it',
      actorId: 'gatekeeper',
      taskId: 't1',
    })
    expect(section).toContain('## Your task on the team board')
    expect(section).toContain('- [running] t1: do it')
    expect(section).toContain(`vfs://team/${RUN_KEY}/`)
    expect(section).toContain('write only under by/gatekeeper/')
  })

  it('falls back to the task id for an anonymous member (never a made-up name)', () => {
    const section = buildTeamTaskSection({ runKey: RUN_KEY, brief: null, actorId: null, taskId: 't1' })
    expect(section).toContain('write only under by/t1/')
    expect(section).not.toContain('anonymous')
  })

  it('says the member has no write area instead of inventing one', () => {
    const section = buildTeamTaskSection({ runKey: RUN_KEY, brief: null, actorId: null, taskId: null })
    expect(section).toContain('no write area')
  })

  it('says the lead recorded no task instead of printing an empty heading', () => {
    const section = buildTeamTaskSection({ runKey: RUN_KEY, brief: null, actorId: 'gatekeeper', taskId: 't1' })
    expect(section).toContain('did not record a task')
  })

  it('surfaces a board write failure to the member', () => {
    const section = buildTeamTaskSection({
      runKey: RUN_KEY,
      brief: '- [running] t1: do it',
      actorId: 'gatekeeper',
      taskId: 't1',
      boardError: 'PERMISSION_DENIED',
    })
    expect(section).toContain('could not be updated (PERMISSION_DENIED)')
  })

  it('puts the run goal from the brief above the task', () => {
    const section = buildTeamTaskSection({
      runKey: RUN_KEY,
      goal: 'Consolidate the four duplicate date parsers.',
      brief: '- [running] t1: do it',
      actorId: null,
      taskId: 't1',
    })
    const goalIndex = section.indexOf('Run goal (from 00-brief.md)'.slice(0, 20))
    expect(goalIndex).toBeGreaterThan(-1)
    expect(section.indexOf('[running] t1')).toBeGreaterThan(goalIndex)
  })

  it('omits the goal line entirely when no brief was written', () => {
    const section = buildTeamTaskSection({ runKey: RUN_KEY, brief: '- [x] t1: do it', actorId: null, taskId: 't1' })
    expect(section).not.toContain('Run goal')
  })
})
