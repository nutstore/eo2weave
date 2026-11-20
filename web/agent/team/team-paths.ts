/**
 * Team board paths — the `vfs://team/` namespace.
 *
 * Physical location: `{projectDir}/team/{runKey}/`. That is a sibling of
 * `agents/`, deliberately outside every workspace root, so the board never
 * enters git, never enters the sync-to-disk review queue, and never shows up in
 * a project `ls`.
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

export const TEAM_NAMESPACE = 'team'
export const TEAM_BRIEF_FILE = '00-brief.md'
export const TEAM_MANIFEST_FILE = 'manifest.json'
export const TEAM_LEDGER_FILE = '_ledger.jsonl'
export const TEAM_MEMBERS_DIR = 'by'

/** Files only the lead may write, because a second writer would mean two truths. */
export const TEAM_RESERVED_FILES: readonly string[] = [TEAM_BRIEF_FILE, TEAM_MANIFEST_FILE, TEAM_LEDGER_FILE]

export interface TeamPath {
  runKey: string
  relativePath: string
  segments: string[]
}

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
 * Split a team path into run key + relative path.
 *
 * Returns null for anything malformed rather than throwing: a bad path from a
 * model is a normal event, and callers need a clean "unknown path" branch.
 */
export function parseTeamPath(raw: string): TeamPath | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim()
  if (value.startsWith('vfs://')) value = value.slice('vfs://'.length)
  const parts = value.split('/').filter((part, index, all) => !(part === '' && index === all.length - 1))
  if (parts.length < 2) return null
  if (parts[0] !== TEAM_NAMESPACE) return null
  const runKey = parts[1]!
  if (!isValidTeamRunKey(runKey)) return null
  const segments = parts.slice(2)
  if (segments.length === 0) return null
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
    // Backslashes would let a caller smuggle a separator past one layer.
    if (segment.includes('\\')) return null
  }
  return { runKey, relativePath: segments.join('/'), segments }
}

export function formatTeamPath(runKey: string, relativePath: string): string {
  return `vfs://${TEAM_NAMESPACE}/${runKey}/${relativePath.replace(/^\/+/, '')}`
}

export function isReservedTeamFile(relativePath: string): boolean {
  return TEAM_RESERVED_FILES.includes(relativePath.replace(/^\/+/, ''))
}

export function teamActorDir(actorId: string): string {
  return `${TEAM_MEMBERS_DIR}/${actorId}`
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
  if (actorId && isValidTeamActorId(actorId)) return teamActorDir(actorId)
  const taskId = input.taskId?.trim()
  if (taskId && isValidTeamActorId(taskId)) return teamActorDir(taskId)
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
