import type { ToolContext } from '../tools/tool-types'
import { resolveVfsTarget } from '../tools/vfs-resolver'
import { TEAM_BRIEF_FILE, TEAM_LEDGER_FILE, TEAM_MANIFEST_FILE, teamMemberSlot } from './team-paths'
import {
  emptyTeamManifest,
  findTeamTask,
  parseTeamManifest,
  renderTeamTask,
  serializeTeamManifest,
  setTeamTaskStatus,
  upsertTeamTask,
  type TeamManifest,
  type TeamTask,
  type TeamTaskHandoff,
  type TeamTaskStatus,
} from './team-manifest'

/**
 * The only module that touches OPFS for the manifest.
 *
 * Everything above it (team-manifest.ts) is pure string/object work; everything
 * below it (vfs-resolver + TeamBackend) decides where a write is allowed. This
 * layer exists so `subagent/runtime.ts` never has to know either of those.
 */

export function teamManifestPath(runKey: string): string {
  return `vfs://team/${runKey}/${TEAM_MANIFEST_FILE}`
}

function runKeyOf(context: ToolContext): string | undefined {
  const runKey = context.teamRunKey
  return typeof runKey === 'string' && runKey.trim() ? runKey.trim() : undefined
}

/** Read a run's manifest. `null` means "no board / no manifest" (not an error). */
export async function readTeamManifest(context: ToolContext): Promise<TeamManifest | null> {
  const runKey = runKeyOf(context)
  if (!runKey) return null
  try {
    const target = await resolveVfsTarget(teamManifestPath(runKey), context, 'read')
    if (target.kind !== 'team') return null
    const result = await target.backend.readFile(target.path, { encoding: 'text' })
    const raw = typeof result.content === 'string' ? result.content : ''
    if (!raw.trim()) return emptyTeamManifest()
    return parseTeamManifest(raw)
  } catch {
    // A missing file is the normal case on the first spawn of a run.
    return null
  }
}

export async function writeTeamManifest(context: ToolContext, manifest: TeamManifest): Promise<void> {
  const runKey = runKeyOf(context)
  if (!runKey) throw new Error('cannot write a team manifest without a run key')
  const target = await resolveVfsTarget(teamManifestPath(runKey), context, 'write')
  if (target.kind !== 'team') throw new Error('team manifest path did not resolve to the team backend')
  await target.backend.writeFile(target.path, serializeTeamManifest(manifest))
}

/**
 * The run's goal, from `00-brief.md`.
 *
 * One source on purpose: the manifest holds state (what is in flight), the brief
 * holds the shared statement of intent. Copying the goal into the manifest would
 * give two answers that can drift, and the members would read whichever one the
 * code happened to wire up.
 */
export async function readTeamBrief(context: ToolContext): Promise<string | null> {
  const runKey = runKeyOf(context)
  if (!runKey) return null
  try {
    const target = await resolveVfsTarget(`vfs://team/${runKey}/${TEAM_BRIEF_FILE}`, context, 'read')
    if (target.kind !== 'team') return null
    const result = await target.backend.readFile(target.path, { encoding: 'text' })
    const raw = typeof result.content === 'string' ? result.content.trim() : ''
    if (!raw) return null
    // Bounded: a runaway brief must not crowd out the task itself.
    return raw.length > TEAM_BRIEF_PROMPT_LIMIT ? `${raw.slice(0, TEAM_BRIEF_PROMPT_LIMIT)}…` : raw
  } catch {
    return null
  }
}

const TEAM_BRIEF_PROMPT_LIMIT = 800

export interface AssignTeamTaskInput {
  taskId: string
  /** Short summary of the work — the `description` of the spawn, not the prompt. */
  goal?: string
  assignee?: string | null
  handoff?: TeamTaskHandoff
}

export interface AssignTeamTaskResult {
  task: TeamTask
  manifest: TeamManifest
  /** Prompt-ready view of this member's own task. */
  brief: string | null
  /** The run's shared goal, read from `00-brief.md` (null when unwritten). */
  runGoal: string | null
}

export interface AssignTeamTaskOutcome {
  result?: AssignTeamTaskResult
  error?: string
  /**
   * The caller's arguments are wrong (a write path outside the member's slot).
   * Fatal on purpose: the spawn would hand out a contract that cannot be
   * fulfilled, and the member would discover it halfway through its work.
   */
  fatal?: boolean
}

/**
 * Check a handoff's `writes` against the directory the ACL will actually allow.
 *
 * Returns the offending paths, or an empty list when the contract is executable.
 */
export function findOutOfScopeWrites(
  writes: readonly string[] | undefined,
  slot: string | null,
): string[] {
  if (!writes?.length) return []
  if (!slot) return [...writes]
  return writes.filter(path => {
    const normalized = path.replace(/^\/+/, '')
    return !normalized.startsWith(`${slot}/`)
  })
}

/**
 * Record a task as running and return the member's own view of it.
 *
 * The lead is the only writer of the board, so this runs with the lead's tool
 * context (ACL: root files, lead only). A failure here must not abort a spawn —
 * a board that is momentarily unwritable is a degraded experience, not a broken
 * run — but it must not be silent either: the error travels back to the caller
 * so it can be appended to the member's prompt.
 */
export async function assignTeamTask(
  context: ToolContext,
  input: AssignTeamTaskInput,
): Promise<AssignTeamTaskOutcome> {
  const runKey = runKeyOf(context)
  if (!runKey) return { error: 'no team run key in this context' }
  const taskId = input.taskId.trim()
  if (!taskId) return { error: 'task id is required', fatal: true }

  const slot = teamMemberSlot({ actorId: input.assignee, taskId })
  if (!slot) {
    return {
      error: `cannot derive a write area for task "${taskId}": pass \`as\` (an agent id) or use an id that is valid as a directory name`,
      fatal: true,
    }
  }
  const outOfScope = findOutOfScopeWrites(input.handoff?.writes, slot)
  if (outOfScope.length) {
    return {
      error: `handoff.writes must stay inside ${slot}/; not allowed: ${outOfScope.map(path => `"${path}"`).join(', ')}`,
      fatal: true,
    }
  }

  try {
    const manifest = (await readTeamManifest(context)) ?? emptyTeamManifest()
    const existing = findTeamTask(manifest, taskId)
    const handoff = mergeHandoff(existing?.handoff, input.handoff)
    const task: TeamTask = {
      id: taskId,
      // Keep the goal the lead already wrote; the spawn description is only a
      // fallback, so a second spawn of the same task cannot silently reword it.
      goal: existing?.goal || input.goal?.trim() || taskId,
      assignee: input.assignee !== undefined ? input.assignee : (existing?.assignee ?? null),
      status: 'running',
      updatedAt: Date.now(),
    }
    if (handoff) task.handoff = handoff
    if (existing?.artifacts?.length) task.artifacts = existing.artifacts
    const next = upsertTeamTask({ ...manifest, goal: manifest.goal }, task)
    next.updatedAt = task.updatedAt
    await writeTeamManifest(context, next)
    // The ledger is history, not state: if it cannot be written the task is
    // still recorded in the manifest, so this must not fail the spawn.
    try {
      await appendTeamLedger(context, {
        at: task.updatedAt ?? Date.now(),
        taskId,
        event: 'spawned',
        status: 'running',
        actorId: task.assignee ?? null,
      })
    } catch {
      // ignore: the manifest above is the record that matters
    }
    return { result: { task, manifest: next, brief: renderTeamTask(next, taskId), runGoal: await readTeamBrief(context) } }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export interface TeamTaskOutcomeInput {
  taskId: string
  status: Extract<TeamTaskStatus, 'done' | 'blocked'>
  /** Board-relative files the member produced, already scoped to its slot. */
  artifacts?: string[]
  /** Why it ended blocked (execution error / timeout / kill). */
  error?: string
}

/**
 * Write a member's terminal state back to the board.
 *
 * Without this a failed run leaves a task reading `running` forever, which makes
 * the board lie about the one thing it is supposed to answer: what is still in
 * flight. Throws on failure so the caller can record the board problem instead
 * of hiding it.
 */
export async function recordTeamTaskOutcome(
  context: ToolContext,
  input: TeamTaskOutcomeInput,
): Promise<TeamManifest> {
  const manifest = (await readTeamManifest(context)) ?? emptyTeamManifest()
  if (!findTeamTask(manifest, input.taskId)) {
    throw new Error(`no task "${input.taskId}" on the board to finish`)
  }
  const patch: Partial<Omit<TeamTask, 'id' | 'status'>> = { updatedAt: Date.now() }
  if (input.artifacts?.length) patch.artifacts = input.artifacts
  const next = setTeamTaskStatus(manifest, input.taskId, input.status, patch)
  next.updatedAt = patch.updatedAt
  await writeTeamManifest(context, next)
  return next
}

/** One line of the run's append-only history. */
export interface TeamLedgerEntry {
  at: number
  taskId: string
  event: 'spawned' | 'done' | 'blocked'
  status: TeamTaskStatus
  actorId?: string | null
  artifacts?: string[]
  error?: string
}

/**
 * Append one event to `_ledger.jsonl`.
 *
 * Read-modify-write because the backend has no append mode; the run is the only
 * writer and events are small, so a lost-concurrency story here is not worth the
 * complexity. A malformed ledger is preferable to a malformed manifest: readers
 * of the ledger can skip an unparsable line, whereas the manifest is state.
 */
export async function appendTeamLedger(context: ToolContext, entry: TeamLedgerEntry): Promise<void> {
  const runKey = runKeyOf(context)
  if (!runKey) throw new Error('cannot append to a team ledger without a run key')
  const path = `vfs://team/${runKey}/${TEAM_LEDGER_FILE}`
  const target = await resolveVfsTarget(path, context, 'write')
  if (target.kind !== 'team') throw new Error('team ledger path did not resolve to the team backend')
  let existing = ''
  try {
    const current = await resolveVfsTarget(path, context, 'read')
    if (current.kind === 'team') {
      const read = await current.backend.readFile(current.path, { encoding: 'text' })
      existing = typeof read.content === 'string' ? read.content : ''
      if (existing && !existing.endsWith('\n')) existing += '\n'
    }
  } catch {
    // No ledger yet — the first event creates it.
  }
  await target.backend.writeFile(target.path, `${existing}${JSON.stringify(entry)}\n`)
}

/**
 * Files a member left in its own slot, as board-relative paths.
 *
 * Derived from the directory rather than from reported paths: what exists is a
 * fact, what a member says it wrote is a claim.
 */
export async function listTeamSlotFiles(context: ToolContext, slot: string): Promise<string[]> {
  const runKey = runKeyOf(context)
  if (!runKey) return []
  try {
    const target = await resolveVfsTarget(`vfs://team/${runKey}/${slot}`, context, 'list')
    if (target.kind !== 'team') return []
    const entries = await target.backend.listDir(target.path)
    return entries.filter(entry => entry.kind === 'file').map(entry => `${slot}/${entry.name}`)
  } catch {
    return []
  }
}

function mergeHandoff(previous: TeamTaskHandoff | undefined,
  next: TeamTaskHandoff | undefined,
): TeamTaskHandoff | undefined {
  if (!previous && !next) return undefined
  const merged: TeamTaskHandoff = { ...previous, ...next }
  if (previous?.reads && !next?.reads) merged.reads = previous.reads
  if (previous?.writes && !next?.writes) merged.writes = previous.writes
  if (!merged.expects && !merged.reads && !merged.writes) return undefined
  return merged
}

/**
 * Prompt section for a member: its own task plus where it may write.
 *
 * Returns the section text; callers append it to a system prompt only when the
 * spawn actually named a task.
 */
export function buildTeamTaskSection(input: {
  runKey: string
  brief: string | null
  /** The run's goal, from `00-brief.md`. */
  goal?: string | null
  actorId: string | null
  taskId: string | null
  boardError?: string
}): string {
  const slot = teamMemberSlot({ actorId: input.actorId, taskId: input.taskId })
  const lines: string[] = ['## Your task on the team board', '']
  if (input.goal) lines.push(`Run goal (from 00-brief.md): ${input.goal}`, '')
  if (input.brief) lines.push(input.brief, '')
  else lines.push('The lead did not record a task for this spawn; follow the prompt below.', '')
  const scope = slot
    ? `Board: vfs://team/${input.runKey}/ — you may read any file there, and write only under ${slot}/.`
    : `Board: vfs://team/${input.runKey}/ — you may read any file there but have no write area; return your findings in your final message.`
  lines.push(scope)
  if (input.boardError) lines.push('', `The board could not be updated (${input.boardError}); report this to the lead.`)
  return lines.join('\n')
}
