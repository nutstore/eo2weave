import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryProvider } from '@creatorweave/fs-provider/memory'
import type { FsProvider } from '@creatorweave/fs-provider'
import {
  TEAM_BOARD_RETENTION,
  planTeamBoardPrune,
  pruneTeamBoards,
  pruneTeamBoardsOn,
  readTeamBoards,
  resolveTeamBoardPrunePolicy,
  teamRunStartedAt,
  type TeamBoardInfo,
} from '../team-prune'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

function board(runKey: string, overrides: Partial<TeamBoardInfo> = {}): TeamBoardInfo {
  return {
    runKey,
    startedAt: NOW - 2 * DAY,
    lastActivity: NOW - 2 * DAY,
    inFlight: false,
    ...overrides,
  }
}

describe('team board prune planning', () => {
  it('never removes the board of the run that is pruning', () => {
    const plan = planTeamBoardPrune({
      boards: [board('active-1', { lastActivity: NOW - 400 * DAY })],
      activeRunKey: 'active-1',
      now: NOW,
      policy: { keep: 0, maxAgeMs: 0, minAgeMs: 0 },
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toContain('pruning')
  })

  it('never removes a board that still has a running task', () => {
    const plan = planTeamBoardPrune({
      boards: [board('run-a', { lastActivity: NOW - 400 * DAY, inFlight: true })],
      now: NOW,
      policy: { keep: 0, maxAgeMs: 0, minAgeMs: 0 },
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toContain('still running')
  })

  it('never removes a board younger than minAgeMs', () => {
    const plan = planTeamBoardPrune({
      boards: [board('run-a', { lastActivity: NOW - HOUR / 2 })],
      now: NOW,
      policy: { keep: 0, maxAgeMs: 0, minAgeMs: HOUR },
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toContain('younger than')
  })

  it('keeps the newest `keep` boards', () => {
    const plan = planTeamBoardPrune({
      boards: [
        board('run-old', { lastActivity: NOW - 3 * HOUR }),
        board('run-new', { lastActivity: NOW - 2 * HOUR }),
      ],
      now: NOW,
      policy: { keep: 2 },
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep.every(entry => entry.reason === 'within retention')).toBe(true)
  })

  it('removes boards beyond the count quota once they are past minAgeMs', () => {
    const plan = planTeamBoardPrune({
      boards: [
        board('run-newest', { lastActivity: NOW - 2 * HOUR }),
        board('run-middle', { lastActivity: NOW - 3 * HOUR }),
        board('run-oldest', { lastActivity: NOW - 4 * HOUR }),
      ],
      now: NOW,
      policy: { keep: 1 },
    })
    expect(plan.remove.map(entry => entry.runKey).sort()).toEqual(['run-middle', 'run-oldest'])
    expect(plan.keep.map(entry => entry.board.runKey)).toEqual(['run-newest'])
  })

  it('removes idle boards past maxAgeMs even when they fit inside `keep`', () => {
    const plan = planTeamBoardPrune({
      boards: [
        board('run-recent', { lastActivity: NOW - 2 * HOUR }),
        board('run-idle', { lastActivity: NOW - 30 * DAY }),
      ],
      now: NOW,
      policy: { keep: 10, maxAgeMs: 7 * DAY },
    })
    expect(plan.remove.map(entry => entry.runKey)).toEqual(['run-idle'])
  })

  it('treats maxAgeMs: Infinity as "keep by count only"', () => {
    const plan = planTeamBoardPrune({
      boards: [board('run-ancient', { lastActivity: NOW - 900 * DAY })],
      now: NOW,
      policy: { keep: 5, maxAgeMs: Infinity },
    })
    expect(plan.remove).toEqual([])
  })

  it('spares a damaged board from the count quota but not from the age rule', () => {
    const plan = planTeamBoardPrune({
      boards: [
        board('run-fresh', { lastActivity: NOW - 2 * HOUR }),
        board('run-damaged-newish', { lastActivity: NOW - 2 * DAY, damaged: true }),
        board('run-damaged-ancient', { lastActivity: NOW - 60 * DAY, damaged: true }),
      ],
      now: NOW,
      policy: { keep: 1, maxAgeMs: 7 * DAY },
    })
    expect(plan.remove.map(entry => entry.runKey)).toEqual(['run-damaged-ancient'])
  })

  it('never removes a board whose age is unknown', () => {
    const plan = planTeamBoardPrune({
      boards: [board('run-undatable', { startedAt: null, lastActivity: 0, damaged: true })],
      now: NOW,
      policy: { keep: 0, maxAgeMs: 0, minAgeMs: 0 },
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep[0]?.reason).toBe('age unknown')
  })

  it('keep: 0 removes every eligible board', () => {
    const plan = planTeamBoardPrune({
      boards: [
        board('run-a', { lastActivity: NOW - 2 * HOUR }),
        board('run-b', { lastActivity: NOW - 3 * HOUR }),
      ],
      now: NOW,
      policy: { keep: 0, maxAgeMs: 0, minAgeMs: 0 },
    })
    expect(plan.remove.map(entry => entry.runKey).sort()).toEqual(['run-a', 'run-b'])
  })

  it('clamps nonsense policy values instead of trusting their sign', () => {
    expect(resolveTeamBoardPrunePolicy({ keep: -5 }).keep).toBe(0)
    expect(resolveTeamBoardPrunePolicy({ maxAgeMs: -1 }).maxAgeMs).toBe(TEAM_BOARD_RETENTION.maxAgeMs)
    expect(resolveTeamBoardPrunePolicy({ minAgeMs: -1 }).minAgeMs).toBe(TEAM_BOARD_RETENTION.minAgeMs)
    expect(resolveTeamBoardPrunePolicy({ keep: 2.7 }).keep).toBe(2)
    expect(resolveTeamBoardPrunePolicy().keep).toBe(TEAM_BOARD_RETENTION.keep)
  })

  it('reads the run start from the run key', () => {
    expect(teamRunStartedAt('conv-1795420393389-a1b2c3')).toBe(1795420393389)
    expect(teamRunStartedAt('conv-1795420393389-1795420814195-8nfronz6')).toBe(1795420814195)
    expect(teamRunStartedAt('conv-no-timestamp')).toBeNull()
  })
})

function manifest(options: { updatedAt?: number; statuses?: Array<'pending' | 'running' | 'done' | 'blocked'> }): string {
  const statuses = options.statuses ?? ['done']
  return `${JSON.stringify({
    version: 1,
    goal: 'ship it',
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
    tasks: statuses.map((status, index) => ({ id: `t${index}`, goal: `task ${index}`, status })),
  }, null, 2)}\n`
}

async function writeFile(provider: FsProvider, path: string, content: string): Promise<void> {
  await provider.writeFile(path, new TextEncoder().encode(content))
}

describe('team board prune IO', () => {
  let provider: FsProvider

  beforeEach(() => {
    provider = memoryProvider()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('describes boards from their manifest and directory name', async () => {
    await writeFile(provider, 'conv-1795420393389-aaaaaaaa/manifest.json',
      manifest({ updatedAt: NOW - 3 * HOUR, statuses: ['running'] }))
    await writeFile(provider, 'conv-1795420393389-bbbbbbbb/by/t1/notes.md', 'scratch')
    // A board that only ever wrote a brief: no manifest at all.
    await writeFile(provider, 'conv-1795420393389-cccccccc/00-brief.md', 'goal')

    const boards = await readTeamBoards(provider, NOW)
    const byKey = new Map(boards.map(entry => [entry.runKey, entry]))

    expect(byKey.get('conv-1795420393389-aaaaaaaa')).toMatchObject({
      startedAt: 1795420393389,
      lastActivity: NOW - 3 * HOUR,
      inFlight: true,
    })
    expect(byKey.get('conv-1795420393389-bbbbbbbb')).toMatchObject({
      lastActivity: 1795420393389,
      inFlight: false,
      damaged: true,
    })
    // Bare files at the team root are not boards.
    expect(boards).toHaveLength(3)
  })

  it('keeps the manifest timestamp when it is newer than the run key', async () => {
    const runKey = 'conv-1795420393389-dddddddd'
    await writeFile(provider, `${runKey}/manifest.json`, manifest({ updatedAt: NOW }))
    const [entry] = await readTeamBoards(provider)
    expect(entry.lastActivity).toBe(NOW)
  })

  it('removes pruned boards recursively and reports what it kept', async () => {
    await writeFile(provider, 'conv-1795420393389-old/manifest.json', manifest({ updatedAt: NOW - 30 * DAY }))
    await writeFile(provider, 'conv-1795420393389-old/by/t1/notes.md', 'member scratch')
    await writeFile(provider, 'conv-1795420393389-new/manifest.json', manifest({ updatedAt: NOW }))

    const report = await pruneTeamBoardsOn(provider, { keep: 5, maxAgeMs: 7 * DAY, minAgeMs: 0, now: NOW })

    expect(report.scanned).toBe(2)
    expect(report.removed).toEqual(['conv-1795420393389-old'])
    expect(report.failures).toEqual([])
    await expect(provider.stat('conv-1795420393389-old')).rejects.toThrow()
    // The recursive delete took the member's scratch directory with it.
    await expect(provider.stat('conv-1795420393389-old/by/t1/notes.md')).rejects.toThrow()
    expect(report.kept).toEqual([{ runKey: 'conv-1795420393389-new', reason: 'within retention' }])
  })

  it('prunes a board whose running task went stale, and keeps a live one', async () => {
    const zombie = 'conv-1795420393389-eeeeeeee'
    await writeFile(provider, `${zombie}/manifest.json`, manifest({ updatedAt: NOW - 30 * DAY, statuses: ['running'] }))
    const live = 'conv-1795420393389-ffffffff'
    await writeFile(provider, `${live}/manifest.json`, manifest({ updatedAt: NOW - 5 * 60 * 1000, statuses: ['running'] }))

    const report = await pruneTeamBoardsOn(provider, { keep: 0, maxAgeMs: 7 * DAY, minAgeMs: 0, now: NOW })

    // A crashed run leaves `running` behind forever; that must not make the
    // board immortal. A member that is genuinely working still protects it.
    expect(report.removed).toEqual([zombie])
    expect(report.kept).toEqual([{ runKey: live, reason: 'a task on it is still running' }])
  })

  it('reports a failed removal instead of throwing', async () => {
    await writeFile(provider, 'conv-1795420393389-old/manifest.json', manifest({ updatedAt: NOW - 30 * DAY }))
    const failing: FsProvider = {
      ...provider,
      remove: async () => {
        throw new Error('EBUSY: locked')
      },
    }

    const report = await pruneTeamBoardsOn(failing, { keep: 0, maxAgeMs: 0, minAgeMs: 0, now: NOW })

    expect(report.removed).toEqual([])
    expect(report.failures).toEqual([{ runKey: 'conv-1795420393389-old', error: 'EBUSY: locked' }])
  })

  it('returns an empty report when there is no team directory to read', async () => {
    const report = await pruneTeamBoardsOn(memoryProvider())
    expect(report).toEqual({ scanned: 0, removed: [], kept: [], failures: [] })
  })
})

describe('pruneTeamBoards conversation entry', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@/opfs')
  })

  it('does nothing for a blank conversation id', async () => {
    const report = await pruneTeamBoards('   ')
    expect(report).toEqual({ scanned: 0, removed: [], kept: [], failures: [] })
  })

  it('returns an empty report when the conversation never created a team directory', async () => {
    vi.resetModules()
    vi.doMock('@/opfs', () => ({
      getWorkspaceManager: async () => ({
        getWorkspace: async () => ({
          getTeamDir: async () => {
            throw new DOMException('missing', 'NotFoundError')
          },
        }),
      }),
      ProjectManager: { create: async () => ({ getWorkspacesDir: async () => null }) },
    }))
    const { pruneTeamBoards: fresh } = await import('../team-prune')
    const report = await fresh('conv-1')
    expect(report).toEqual({ scanned: 0, removed: [], kept: [], failures: [] })
  })

})

