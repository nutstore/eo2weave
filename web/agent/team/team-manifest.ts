import { TEAM_MANIFEST_FILE } from './team-paths'

/**
 * The task entity that lives in `manifest.json` on a run's board.
 *
 * There is no `team_tasks` table and will not be one: a board is a directory of
 * files, and the manifest is the single file the lead owns. Every reader parses
 * this module's shape, so a malformed hand edit must degrade into something
 * visible rather than into a silently empty task list.
 */

export const TEAM_MANIFEST_VERSION = 1

export const TEAM_TASK_STATUSES = ['pending', 'running', 'done', 'blocked'] as const
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number]

/** What the lead expects back from a member, and what it must read first. */
export interface TeamTaskHandoff {
  /** One sentence: the shape of the answer. */
  expects?: string
  /** Board-relative paths the member should read before starting. */
  reads?: string[]
  /** Board-relative paths the member is expected to produce. */
  writes?: string[]
}

export interface TeamTask {
  id: string
  goal: string
  /** Agent id (`as:` value) or a free-form role when nobody owns it yet. */
  assignee?: string | null
  status: TeamTaskStatus
  /** Board-relative paths this task produced. */
  artifacts?: string[]
  handoff?: TeamTaskHandoff
  /** Epoch ms; informational only — ordering comes from the array. */
  updatedAt?: number
}

export interface TeamManifest {
  version: number
  goal: string
  tasks: TeamTask[]
  updatedAt?: number
  /**
   * Recoverable parse complaints (unknown status, stray fields). Kept on the
   * parsed value instead of thrown: a member reading a slightly off manifest is
   * better than a member reading nothing.
   */
  issues?: string[]
}

export class TeamManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamManifestError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStatus(value: unknown, issues: string[], where: string): TeamTaskStatus {
  if (typeof value === 'string' && (TEAM_TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TeamTaskStatus
  }
  // Unknown or missing status resolves to `pending`, never to `done`: a typo
  // must not look like completed work.
  issues.push(`${where}: unknown status ${JSON.stringify(value ?? null)}, treated as "pending"`)
  return 'pending'
}

function asStringList(value: unknown, issues: string[], where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    issues.push(`${where}: expected an array, ignored`)
    return undefined
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry.trim())
    else issues.push(`${where}: dropped a non-string entry`)
  }
  return out.length ? out : undefined
}

function parseHandoff(value: unknown, issues: string[], where: string): TeamTaskHandoff | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    issues.push(`${where}.handoff: expected an object, ignored`)
    return undefined
  }
  const handoff: TeamTaskHandoff = {}
  if (typeof value.expects === 'string' && value.expects.trim()) handoff.expects = value.expects.trim()
  const reads = asStringList(value.reads, issues, `${where}.handoff.reads`)
  const writes = asStringList(value.writes, issues, `${where}.handoff.writes`)
  if (reads) handoff.reads = reads
  if (writes) handoff.writes = writes
  return Object.keys(handoff).length ? handoff : undefined
}

function parseTask(value: unknown, index: number, issues: string[]): TeamTask {
  const where = `tasks[${index}]`
  if (!isRecord(value)) throw new TeamManifestError(`${where}: expected an object`)
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!id) throw new TeamManifestError(`${where}: "id" is required`)
  const goal = typeof value.goal === 'string' ? value.goal.trim() : ''
  if (!goal) throw new TeamManifestError(`${where} (${id}): "goal" is required`)
  const task: TeamTask = {
    id,
    goal,
    status: asStatus(value.status, issues, `${where} (${id})`),
  }
  if (typeof value.assignee === 'string') task.assignee = value.assignee.trim() || null
  else if (value.assignee === null) task.assignee = null
  const artifacts = asStringList(value.artifacts, issues, `${where}.artifacts`)
  if (artifacts) task.artifacts = artifacts
  const handoff = parseHandoff(value.handoff, issues, where)
  if (handoff) task.handoff = handoff
  if (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) task.updatedAt = value.updatedAt
  return task
}

/**
 * Parse a manifest written by the lead (or by hand).
 *
 * Throws only on structural damage (bad JSON, a task without an id or goal):
 * those make the board untrustworthy, and a member acting on an untrustworthy
 * board is worse than a member that reports "the manifest is broken".
 */
export function parseTeamManifest(raw: string): TeamManifest {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new TeamManifestError(`${TEAM_MANIFEST_FILE}: invalid JSON (${(error as Error).message})`)
  }
  if (!isRecord(data)) throw new TeamManifestError(`${TEAM_MANIFEST_FILE}: expected an object`)
  const issues: string[] = []
  const rawTasks = data.tasks
  if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
    throw new TeamManifestError(`${TEAM_MANIFEST_FILE}: "tasks" must be an array`)
  }
  const tasks = (rawTasks ?? []).map((task, index) => parseTask(task, index, issues))
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) throw new TeamManifestError(`${TEAM_MANIFEST_FILE}: duplicate task id "${task.id}"`)
    seen.add(task.id)
  }
  const version = typeof data.version === 'number' && Number.isFinite(data.version)
    ? data.version
    : TEAM_MANIFEST_VERSION
  if (version > TEAM_MANIFEST_VERSION) {
    issues.push(`manifest version ${version} is newer than this build supports (${TEAM_MANIFEST_VERSION})`)
  }
  const manifest: TeamManifest = {
    version,
    goal: typeof data.goal === 'string' ? data.goal.trim() : '',
    tasks,
  }
  if (typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt)) manifest.updatedAt = data.updatedAt
  if (issues.length) manifest.issues = issues
  return manifest
}

/** Stable serialization: one task per line keeps board diffs readable. */
export function serializeTeamManifest(manifest: TeamManifest): string {
  const payload: Record<string, unknown> = {
    version: manifest.version ?? TEAM_MANIFEST_VERSION,
    goal: manifest.goal,
  }
  if (manifest.updatedAt !== undefined) payload.updatedAt = manifest.updatedAt
  payload.tasks = manifest.tasks.map(task => {
    const out: Record<string, unknown> = { id: task.id, goal: task.goal, status: task.status }
    if (task.assignee !== undefined) out.assignee = task.assignee
    if (task.artifacts?.length) out.artifacts = task.artifacts
    if (task.handoff) out.handoff = task.handoff
    if (task.updatedAt !== undefined) out.updatedAt = task.updatedAt
    return out
  })
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function emptyTeamManifest(goal = ''): TeamManifest {
  return { version: TEAM_MANIFEST_VERSION, goal, tasks: [] }
}

/** Insert or replace a task by id, preserving array order for existing ids. */
export function upsertTeamTask(manifest: TeamManifest, task: TeamTask): TeamManifest {
  const index = manifest.tasks.findIndex(entry => entry.id === task.id)
  const tasks = [...manifest.tasks]
  if (index >= 0) tasks[index] = { ...tasks[index], ...task }
  else tasks.push(task)
  return { ...manifest, tasks }
}

export function setTeamTaskStatus(
  manifest: TeamManifest,
  id: string,
  status: TeamTaskStatus,
  patch: Partial<Omit<TeamTask, 'id' | 'status'>> = {},
): TeamManifest {
  const index = manifest.tasks.findIndex(entry => entry.id === id)
  if (index < 0) throw new TeamManifestError(`no task "${id}" in the manifest`)
  const tasks = [...manifest.tasks]
  tasks[index] = { ...tasks[index], ...patch, status }
  return { ...manifest, tasks }
}

export function findTeamTask(manifest: TeamManifest, id: string): TeamTask | undefined {
  return manifest.tasks.find(entry => entry.id === id)
}

/** Tasks a given actor owns. `null`/undefined id matches unassigned tasks. */
export function tasksForActor(manifest: TeamManifest, actorId?: string | null): TeamTask[] {
  const wanted = actorId?.trim() || null
  return manifest.tasks.filter(task => (task.assignee ?? null) === wanted)
}

function renderTaskLines(task: TeamTask): string[] {
  const owner = task.assignee ? ` @${task.assignee}` : ''
  const lines = [`- [${task.status}] ${task.id}: ${task.goal}${owner}`]
  const handoff = task.handoff
  if (handoff?.expects) lines.push(`  expects: ${handoff.expects}`)
  if (handoff?.reads?.length) lines.push(`  reads: ${handoff.reads.join(', ')}`)
  if (handoff?.writes?.length) lines.push(`  writes: ${handoff.writes.join(', ')}`)
  if (task.artifacts?.length) lines.push(`  artifacts: ${task.artifacts.join(', ')}`)
  return lines
}

/**
 * Compact rendering for prompt injection.
 *
 * Without an `actorId` it is the lead's view (everything). With one it is the
 * member's view: only its own tasks, plus the goal, so a member never has to be
 * told the plan twice by a parent agent.
 */
export function renderTeamManifest(manifest: TeamManifest, options?: { actorId?: string | null }): string {
  const scoped = options && 'actorId' in options
  const tasks = scoped ? tasksForActor(manifest, options.actorId) : manifest.tasks
  const lines: string[] = []
  if (manifest.goal) lines.push(`Goal: ${manifest.goal}`)
  if (!tasks.length) {
    lines.push(scoped ? 'No task is assigned to you; follow your prompt directly.' : 'No tasks yet.')
  } else {
    for (const task of tasks) lines.push(...renderTaskLines(task))
  }
  if (manifest.issues?.length) {
    lines.push('', 'Manifest issues (fix the file before trusting it):')
    for (const issue of manifest.issues) lines.push(`- ${issue}`)
  }
  return lines.join('\n')
}

/**
 * One task, by id — the member's own view.
 *
 * Scoping by id (not by assignee) is deliberate: two anonymous members both have
 * `assignee: null`, so an assignee filter would hand each of them the other's
 * task. Returns `null` when the task is gone from the board.
 */
export function renderTeamTask(manifest: TeamManifest, taskId: string): string | null {
  const task = findTeamTask(manifest, taskId)
  if (!task) return null
  const lines: string[] = []
  if (manifest.goal) lines.push(`Run goal: ${manifest.goal}`)
  lines.push(...renderTaskLines(task))
  return lines.join('\n')
}
