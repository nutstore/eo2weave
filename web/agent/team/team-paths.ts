/**
 * Team board paths — the `vfs://team/` namespace.
 *
 * Physical location: `{projectDir}/workspaces/{conversationId}/team/{runKey}/`.
 *
 * The board belongs to the conversation that minted the run key: one
 * conversation = one workspace, so deleting the conversation deletes its boards,
 * and a board never outlives the chat that produced it. It is a sibling of
 * `files/` and `assets/` inside the workspace — outside `files/` so it never
 * enters git or the sync-to-disk review queue, outside `assets/` because those
 * are user uploads (mounted at /mnt_assets).
 *
 * Layout inside one run:
 *
 *   team/{runKey}/
 *     00-brief.md        lead only — what the team is trying to achieve
 *     manifest.json      lead only — the task entity (single writer)
 *     _ledger.jsonl      lead only — append-only decision log
 *     by/{actorId}/...   that member's own scratch + handoff files
 *
 * This module is pure path/ACL logic on purpose: no OPFS, no handles. The
 * resolver decides *how* to reach a path; this decides *whether it may*.
 */

export const TEAM_BRIEF_FILE = '00-brief.md'
export const TEAM_MANIFEST_FILE = 'manifest.json'
export const TEAM_LEDGER_FILE = '_ledger.jsonl'
export const TEAM_MEMBERS_DIR = 'by'

/** Files only the lead may write, because a second writer would mean two truths. */
export type TeamAccess = { allowed: true } | { allowed: false; reason: string }

const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidTeamRunKey(runKey: string): boolean {
  return RUN_KEY_PATTERN.test(runKey) && !runKey.includes('..')
}

export function isValidTeamActorId(actorId: string): boolean {
  return ACTOR_ID_PATTERN.test(actorId) && !actorId.includes('..')
}

/**
 * The one directory a member may write to.
 *
 * A named actor gets `by/{actorId}/`; an anonymous member gets `by/{taskId}/`,
 * because two anonymous members would otherwise share a directory and their
 * files would become unattributable. `null` means "no write area at all" — the
 * caller must fail closed rather than invent a name (an invented fallback is how
 * the prompt ended up promising `by/anonymous/` while the ACL granted
 * `by/default/`).
 */
export function teamMemberSlot(input: { actorId?: string | null; taskId?: string | null }): string | null {
  const actorId = input.actorId?.trim()
  if (actorId && isValidTeamActorId(actorId)) return `${TEAM_MEMBERS_DIR}/${actorId}`
  const taskId = input.taskId?.trim()
  if (taskId && isValidTeamActorId(taskId)) return `${TEAM_MEMBERS_DIR}/${taskId}`
  return null
}

export interface TeamAccessContext {
  op: 'read' | 'write' | 'delete'
  /** Run key taken from the path. */
  runKey: string
  relativePath: string
  /** Identity of the execution asking. `null` = anonymous. */
  actorId: string | null
  /** Board task this execution fulfils; the fallback write slot when anonymous. */
  taskId?: string | null
  /** Run key of the execution asking; cross-run access is not allowed. */
  currentRunKey: string
  /** True when the asking execution is the lead (owner) of the run. */
  isLead: boolean
}

/**
 * Decide whether an execution may touch a team path.
 *
 * Default deny: unknown run keys, unknown layouts and anonymous members are
 * refused rather than auto-created. A member that quietly materialised a
 * directory would make "who wrote this" unanswerable later.
 */
export function authorizeTeamAccess(context: TeamAccessContext): TeamAccess {
  const { op, runKey, relativePath, actorId, currentRunKey, isLead } = context

  if (!isValidTeamRunKey(runKey)) return { allowed: false, reason: `invalid team run key "${runKey}"` }
  if (!isValidTeamRunKey(currentRunKey)) {
    return { allowed: false, reason: 'no active team run for this execution' }
  }

  if (op === 'read') {
    // Within a run everything is readable — that is the point of a board.
    // An empty path means "the run root", which is only meaningful for listing.
    if (runKey === currentRunKey) return { allowed: true }
    return isLead
      ? { allowed: true }
      : { allowed: false, reason: `run "${runKey}" is outside this execution's team board` }
  }

  if (!relativePath || relativePath.endsWith('/')) {
    return { allowed: false, reason: 'team path must point at a file' }
  }

  if (runKey !== currentRunKey) {
    return { allowed: false, reason: `cannot ${op} run "${runKey}" from run "${currentRunKey}"` }
  }

  if (isLead) return { allowed: true }

  const slot = teamMemberSlot({ actorId, taskId: context.taskId })
  if (!slot) {
    return { allowed: false, reason: 'this execution has no write area on the team board (no actor and no task id)' }
  }
  if (relativePath === slot || !relativePath.startsWith(`${slot}/`)) {
    return {
      allowed: false,
      reason: `members may only ${op} under ${slot}/ (requested "${relativePath}")`,
    }
  }
  return { allowed: true }
}

/**
 * Run key for one orchestration run: one user message, one lead loop, N members.
 *
 * Deliberately takes the turn/message id rather than a date: a date-keyed board
 * would be shared by two runs of the same conversation on the same day, which is
 * exactly the "two writers, one manifest" situation the board layout exists to
 * prevent. The parameter is required for the same reason — a default invites
 * callers to treat it as unimportant.
 */
export function createTeamRunKey(conversationId: string, turnId: string): string {
  const safeConversation = conversationId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)
  const safeTurn = turnId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32)
  if (!safeConversation || !safeTurn) {
    throw new Error('createTeamRunKey requires both a conversation id and a turn id')
  }
  const key = `${safeConversation}-${safeTurn}`
  // Sanitizing can still yield something unusable (e.g. "///" becomes "---"),
  // and an invalid run key would silently produce an unreachable board.
  if (!isValidTeamRunKey(key)) {
    throw new Error(`createTeamRunKey produced an invalid run key: "${key}"`)
  }
  return key
}
