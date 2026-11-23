import { type FsProvider } from '@creatorweave/fs-provider'
import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'
import { getWorkspaceManager } from '@/opfs'
import { parseTeamManifest } from './team-manifest'
import { TEAM_MANIFEST_FILE, isValidTeamRunKey } from './team-paths'

/**
 * Team board retention.
 *
 * Every team run mints its own board directory and nothing deletes one per run:
 * the board is the record of what the team did, and it lives in the
 * conversation's own workspace (`workspaces/{id}/team/{runKey}`), so deleting
 * the conversation removes all of them at once. That is the right lifetime for
 * the result — but a long-running chat would still carry one directory per team
 * run, so this pass bounds it.
 *
 * Retention follows the shape already used for fs-op snapshots
 * (`pruneProjectSnapshots`): keep the newest N, and drop anything that has been
 * idle longer than M. Three things are never pruned, because deleting them would
 * destroy live work rather than reclaim dead weight:
 *
 *   - the board of the run doing the pruning (`activeRunKey`),
 *   - a board whose manifest still holds a `running` task (and is recent — a
 *     crashed run leaves `running` behind forever),
 *   - a board touched within `minAgeMs` (covers a run that has just created its
 *     directory but has not written its manifest yet).
 *
 * A board we cannot date is kept: this runs before an answer, so "not sure"
 * must mean "leave it alone".
 */

export interface TeamBoardPrunePolicy {
  /** Number of newest boards kept regardless of age. */
  keep: number
  /**
   * Boards idle longer than this go, even when they are among the newest.
   * `Infinity` disables the age rule (keep by count only).
   */
  maxAgeMs: number
  /** Boards younger than this are never considered (protects runs in flight). */
  minAgeMs: number
}

/** Defaults: a week of review window, and a hard stop on unbounded counts. */
export const TEAM_BOARD_RETENTION: TeamBoardPrunePolicy = {
  keep: 20,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  minAgeMs: 60 * 60 * 1000,
}

/**
 * How long a `running` task still counts as "a team is working on this".
 *
 * Without a ceiling, a run that crashed (closed tab, killed browser) leaves its
 * task at `running` forever and the board becomes immortal — the retention pass
 * would be unable to tell it apart from live work. A day is far longer than any
 * single member runs and far shorter than an accumulation problem.
 */
export const TEAM_BOARD_STALE_RUN_MS = 24 * 60 * 60 * 1000

export interface TeamBoardInfo {
  runKey: string
  /** Run start, from the run key's embedded timestamp. `null` when unknown. */
  startedAt: number | null
  /** Last known activity: the manifest's `updatedAt`, else the run start. */
  lastActivity: number
  /** A task on the board is still `running`. */
  inFlight: boolean
  /** Manifest missing or unparseable; the board may still hold files. */
  damaged?: boolean
}

export interface TeamBoardKeep {
  board: TeamBoardInfo
  reason: string
}

export interface TeamBoardPrunePlan {
  remove: TeamBoardInfo[]
  keep: TeamBoardKeep[]
}

/**
 * Run start timestamp embedded in a run key (`{conversation}-{Date.now()}-{rand}`).
 *
 * Read from the name so listing a project's boards costs no file reads; the
 * manifest's `updatedAt` is preferred whenever it is available.
 */
export function teamRunStartedAt(runKey: string): number | null {
  const match = /(\d{13})-[A-Za-z0-9]{1,12}$/.exec(runKey)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

export interface TeamBoardPruneInput {
  boards: readonly TeamBoardInfo[]
  /** Run key performing the prune; never removed. */
  activeRunKey?: string | null
  now: number
  policy?: Partial<TeamBoardPrunePolicy>
}

/**
 * Decide what to remove. Pure on purpose: the expensive, failure-prone part is
 * the IO, and retention rules are the thing that needs to be read carefully.
 */
export function planTeamBoardPrune(input: TeamBoardPruneInput): TeamBoardPrunePlan {
  const policy = resolveTeamBoardPrunePolicy(input.policy)
  const keep: TeamBoardKeep[] = []
  const candidates: TeamBoardInfo[] = []

  for (const board of input.boards) {
    if (input.activeRunKey && board.runKey === input.activeRunKey) {
      keep.push({ board, reason: 'this is the run doing the pruning' })
      continue
    }
    if (board.inFlight) {
      keep.push({ board, reason: 'a task on it is still running' })
      continue
    }
    if (!(board.lastActivity > 0)) {
      // No name timestamp and no readable manifest: deleting it would be a
      // guess about age, and the only thing a guess can destroy is live work.
      keep.push({ board, reason: 'age unknown' })
      continue
    }
    if (input.now - board.lastActivity < policy.minAgeMs) {
      keep.push({ board, reason: `younger than ${policy.minAgeMs}ms` })
      continue
    }
    candidates.push(board)
  }

  // Newest first, so "the newest `keep` boards" is a slice, not a search.
  candidates.sort((a, b) => b.lastActivity - a.lastActivity)

  const remove: TeamBoardInfo[] = []
  candidates.forEach((board, index) => {
    const age = input.now - board.lastActivity
    const beyondCount = index >= policy.keep
    const beyondAge = age > policy.maxAgeMs
    if (!beyondCount && !beyondAge) {
      keep.push({ board, reason: 'within retention' })
      return
    }
    if (board.damaged && !beyondAge) {
      // Keep the newest `keep` boards even when their manifest is unreadable —
      // out of the count quota is not evidence the board is worthless.
      keep.push({ board, reason: 'unreadable manifest: pruned by age only' })
      return
    }
    remove.push(board)
  })

  return { remove, keep }
}

export function resolveTeamBoardPrunePolicy(
  policy?: Partial<TeamBoardPrunePolicy>,
): TeamBoardPrunePolicy {
  const merged = { ...TEAM_BOARD_RETENTION, ...policy }
  return {
    // A negative quota would mean "delete everything including the newest";
    // `keep: 0` is how a caller says that, so clamp instead of trusting signs.
    keep: Number.isFinite(merged.keep) ? Math.max(0, Math.floor(merged.keep)) : TEAM_BOARD_RETENTION.keep,
    maxAgeMs: merged.maxAgeMs >= 0 ? merged.maxAgeMs : TEAM_BOARD_RETENTION.maxAgeMs,
    minAgeMs: merged.minAgeMs >= 0 ? merged.minAgeMs : TEAM_BOARD_RETENTION.minAgeMs,
  }
}

/** One board's metadata, read from inside its own directory. */
async function describeTeamBoard(provider: FsProvider, runKey: string, now: number): Promise<TeamBoardInfo> {
  const startedAt = teamRunStartedAt(runKey)
  try {
    const raw = await provider.readFile(`${runKey}/${TEAM_MANIFEST_FILE}`)
    const manifest = parseTeamManifest(new TextDecoder().decode(raw))
    const lastActivity = Math.max(startedAt ?? 0, manifest.updatedAt ?? 0)
    return {
      runKey,
      startedAt,
      lastActivity,
      // A `running` task only protects the board while it could still be alive.
      // Stale `running` is what a crashed run leaves behind, not a reason to
      // keep its scratch files forever.
      inFlight: manifest.tasks.some(task => task.status === 'running')
        && now - lastActivity < TEAM_BOARD_STALE_RUN_MS,
    }
  } catch {
    // A board with no manifest (a run that only wrote a brief) or a manifest
    // that does not parse is still reclaimable — but by age only, never in a
    // race against a live run's half-written file.
    return {
      runKey,
      startedAt,
      lastActivity: startedAt ?? 0,
      inFlight: false,
      damaged: true,
    }
  }
}

/** List every run board in a project, without pruning anything. */
export async function readTeamBoards(provider: FsProvider, now = Date.now()): Promise<TeamBoardInfo[]> {
  const entries = await provider.readdir('')
  const boards: TeamBoardInfo[] = []
  for (const entry of entries) {
    // Boards are directories named after their run key. Files and foreign names
    // are somebody else's business: pruning what we cannot address is how a
    // cleanup turns into data loss.
    if (entry.kind !== 'directory') continue
    if (!isValidTeamRunKey(entry.name)) continue
    boards.push(await describeTeamBoard(provider, entry.name, now))
  }
  return boards
}

export interface PruneTeamBoardsOptions extends Partial<TeamBoardPrunePolicy> {
  /** Run key performing the prune; never removed. */
  activeRunKey?: string | null
  /** Clock override, so retention can be asserted without waiting for time. */
  now?: number
}

export interface TeamBoardPruneReport {
  /** Boards found on this project. */
  scanned: number
  /** Run keys removed, in the order they were deleted. */
  removed: string[]
  /** Boards left in place, with the rule that saved them. */
  kept: Array<{ runKey: string; reason: string }>
  /**
   * Removals that threw. A failed delete is reported, never retried silently:
   * a board that survives every prune is a bug worth seeing.
   */
  failures: Array<{ runKey: string; error: string }>
}

/**
 * Prune the boards under an already-resolved team directory.
 *
 * Split from `pruneTeamBoards` so retention can be exercised against a plain
 * `FsProvider` (the memory provider in tests) with no OPFS or store mocks.
 */
export async function pruneTeamBoardsOn(
  provider: FsProvider,
  options: PruneTeamBoardsOptions = {},
): Promise<TeamBoardPruneReport> {
  const now = options.now ?? Date.now()
  const boards = await readTeamBoards(provider, now)
  const plan = planTeamBoardPrune({
    boards,
    activeRunKey: options.activeRunKey ?? null,
    now,
    policy: options,
  })

  const removed: string[] = []
  const failures: TeamBoardPruneReport['failures'] = []
  for (const board of plan.remove) {
    try {
      await provider.remove(board.runKey, { recursive: true })
      removed.push(board.runKey)
    } catch (error) {
      failures.push({
        runKey: board.runKey,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    scanned: boards.length,
    removed,
    kept: plan.keep.map(({ board, reason }) => ({ runKey: board.runKey, reason })),
    failures,
  }
}

/**
 * Prune a conversation's team boards.
 *
 * Boards live in the conversation's own workspace (`workspaces/{id}/team/`), so
 * this is a per-conversation sweep — the conversation delete already removes
 * them all, and this only keeps a long-running chat from carrying one directory
 * per team run. Never creates the directory, never throws for a missing one.
 */
export async function pruneTeamBoards(
  conversationId: string,
  options: PruneTeamBoardsOptions = {},
): Promise<TeamBoardPruneReport> {
  const trimmed = conversationId?.trim()
  const empty: TeamBoardPruneReport = { scanned: 0, removed: [], kept: [], failures: [] }
  if (!trimmed) return empty

  try {
    const workspace = await (await getWorkspaceManager()).getWorkspace(trimmed)
    if (!workspace) return empty
    const teamDir = await workspace.getTeamDir()
    return await pruneTeamBoardsOn(fromFileSystemHandle(teamDir), options)
  } catch {
    // No team directory (a conversation that never ran a team) is not an error.
    return empty
  }
}
