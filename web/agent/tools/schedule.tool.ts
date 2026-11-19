/**
 * Schedule Management Tool — allows the LLM to create, edit, delete, list,
 * and trigger scheduled tasks bound to the current conversation.
 *
 * Actions:
 * - create: Create a new schedule with a cron expression and prompt
 * - edit:   Modify an existing schedule's fields
 * - delete: Remove a schedule
 * - list:   List all schedules for the current conversation
 * - get:    Get details of a specific schedule
 * - run_now: Trigger an immediate test run
 *
 * Classification: 'write' (only available in Act mode)
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { isValidCron, describeCron, getNextRunTime } from '@/utils/cron-utils'
import {
  createSchedule,
  saveSchedule,
  deleteSchedule,
  loadSchedule,
  getSchedulesForWorkspace,
  type Schedule,
} from '@/services/schedule-storage'
import { triggerSchedule } from '@/services/schedule-heartbeat'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(msg: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, error: msg, ...extra })
}

function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data })
}

/** Serialize a Schedule for tool output (omit large/internal fields) */
function serializeSchedule(s: Schedule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id,
    name: s.name,
    cron: s.schedule.expression,
    cron_description: describeCron(s.schedule.expression),
    prompt: s.prompt.length > 200 ? s.prompt.slice(0, 200) + '...' : s.prompt,
    enabled: s.enabled,
    last_run_at: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
    last_run_number: s.lastRunNumber,
    next_run: (() => {
      const next = getNextRunTime(s.schedule.expression, s.lastRunAt ?? s.createdAt)
      return next ? new Date(next).toISOString() : null
    })(),
    notification: s.notification,
    created_at: new Date(s.createdAt).toISOString(),
    updated_at: new Date(s.updatedAt).toISOString(),
  }
  // Only surface the schedule's own error when it is set. Emitting
  // `error: null` would make the tool card render a failure badge, because
  // the UI treats any payload carrying an `error` key as a failed call.
  if (s.error) out.error = s.error
  return out
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleCreate(
  args: Record<string, unknown>,
  context: { workspaceId?: string | null },
): Promise<string> {
  const workspaceId = context.workspaceId
  if (!workspaceId) {
    return err('No active conversation. Schedules must be bound to a conversation.')
  }

  const name = asString(args.name)?.trim()
  const cronExpression = asString(args.cron)?.trim()
  const prompt = asString(args.prompt)?.trim()

  if (!name) return err('name is required')
  if (!cronExpression) return err('cron is required (5-field cron expression, e.g. "0 9 * * *")')
  if (!prompt) return err('prompt is required (the task prompt to execute on schedule)')

  // Validate cron
  if (!isValidCron(cronExpression)) {
    return err(`Invalid cron expression: "${cronExpression}". Use 5-field format: minute hour day-of-month month day-of-week.`, {
      hint: 'Examples: "0 9 * * *" (daily 9AM), "0 9 * * 1" (weekly Monday 9AM), "0 9 1 * *" (monthly 1st 9AM), "0 * * * *" (hourly), "*/30 * * * *" (every 30 min)',
    })
  }

  // Resolve projectId from workspace
  let projectId = ''
  try {
    const { getWorkspaceRepository } = await import('@/sqlite/repositories/workspace.repository')
    const wsRepo = await getWorkspaceRepository()
    const ws = await wsRepo.findWorkspaceById(workspaceId)
    if (ws) projectId = ws.projectId ?? ''
  } catch {
    // Fallback: empty projectId
  }

  const onSuccess = asBool(args.notify_on_success, true)
  const onFailure = asBool(args.notify_on_failure, true)
  const enabled = asBool(args.enabled, true)

  const schedule = await createSchedule({
    projectId,
    workspaceId,
    name,
    prompt,
    schedule: { type: 'cron', expression: cronExpression },
    notification: { onSuccess, onFailure },
    enabled,
  })

  // Refresh sidebar badges
  try {
    const { useScheduleStore } = await import('@/store/schedule.store')
    await useScheduleStore.getState().refresh()
  } catch { /* non-fatal */ }

  return ok({
    schedule: serializeSchedule(schedule),
    message: `Schedule "${name}" created. It will run ${describeCron(cronExpression)}.`,
  })
}

async function handleEdit(
  args: Record<string, unknown>,
): Promise<string> {
  const scheduleId = asString(args.schedule_id)
  if (!scheduleId) return err('schedule_id is required')

  const schedule = await loadSchedule(scheduleId)
  if (!schedule) return err(`Schedule not found: ${scheduleId}`)

  let changed = false
  const updates: Partial<Schedule> = { updatedAt: Date.now() }

  const name = asString(args.name)?.trim()
  if (name !== undefined && name !== schedule.name) {
    updates.name = name
    changed = true
  }

  const cronExpression = asString(args.cron)?.trim()
  if (cronExpression !== undefined && cronExpression !== schedule.schedule.expression) {
    if (!isValidCron(cronExpression)) {
      return err(`Invalid cron expression: "${cronExpression}"`)
    }
    updates.schedule = { type: 'cron', expression: cronExpression }
    changed = true
  }

  const prompt = asString(args.prompt)?.trim()
  if (prompt !== undefined && prompt !== schedule.prompt) {
    updates.prompt = prompt
    changed = true
  }

  if (typeof args.enabled === 'boolean' && args.enabled !== schedule.enabled) {
    updates.enabled = args.enabled
    changed = true
  }

  if (typeof args.notify_on_success === 'boolean' || typeof args.notify_on_failure === 'boolean') {
    const onSuccess = asBool(args.notify_on_success, schedule.notification?.onSuccess ?? true)
    const onFailure = asBool(args.notify_on_failure, schedule.notification?.onFailure ?? true)
    updates.notification = { onSuccess, onFailure }
    changed = true
  }

  if (!changed) {
    return ok({ schedule: serializeSchedule(schedule), message: 'No changes to apply.' })
  }

  const updated = { ...schedule, ...updates }
  await saveSchedule(updated)

  // Refresh sidebar badges
  try {
    const { useScheduleStore } = await import('@/store/schedule.store')
    await useScheduleStore.getState().refresh()
  } catch { /* non-fatal */ }

  return ok({
    schedule: serializeSchedule(updated),
    message: `Schedule "${updated.name}" updated.`,
  })
}

async function handleDelete(
  args: Record<string, unknown>,
): Promise<string> {
  const scheduleId = asString(args.schedule_id)
  if (!scheduleId) return err('schedule_id is required')

  const schedule = await loadSchedule(scheduleId)
  if (!schedule) return err(`Schedule not found: ${scheduleId}`)

  await deleteSchedule(scheduleId)

  // Refresh sidebar badges
  try {
    const { useScheduleStore } = await import('@/store/schedule.store')
    await useScheduleStore.getState().refresh()
  } catch { /* non-fatal */ }

  return ok({ deleted: true, schedule_id: scheduleId, name: schedule.name })
}

async function handleList(
  _args: Record<string, unknown>,
  context: { workspaceId?: string | null },
): Promise<string> {
  const workspaceId = context.workspaceId
  if (!workspaceId) {
    return err('No active conversation.')
  }

  const schedules = await getSchedulesForWorkspace(workspaceId)
  return ok({
    count: schedules.length,
    schedules: schedules.map(serializeSchedule),
  })
}

async function handleGet(
  args: Record<string, unknown>,
): Promise<string> {
  const scheduleId = asString(args.schedule_id)
  if (!scheduleId) return err('schedule_id is required')

  const schedule = await loadSchedule(scheduleId)
  if (!schedule) return err(`Schedule not found: ${scheduleId}`)

  // Return full prompt for get (not truncated)
  const data = serializeSchedule(schedule)
  data.prompt = schedule.prompt
  return ok({ schedule: data })
}

async function handleRunNow(
  args: Record<string, unknown>,
): Promise<string> {
  const scheduleId = asString(args.schedule_id)
  if (!scheduleId) return err('schedule_id is required')

  const schedule = await loadSchedule(scheduleId)
  if (!schedule) return err(`Schedule not found: ${scheduleId}`)

  // Fire and forget — the run happens asynchronously
  triggerSchedule(scheduleId, { force: true }).catch((e) => {
    console.error('[manage_schedule] run_now failed:', e)
  })

  return ok({
    schedule_id: scheduleId,
    name: schedule.name,
    message: `Triggered immediate run for "${schedule.name}". The result will appear in this conversation shortly.`,
  })
}

// ---------------------------------------------------------------------------
// Tool definition & executor
// ---------------------------------------------------------------------------

export const manageScheduleDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'manage_schedule',
    description: [
      'Create, edit, delete, list, or trigger scheduled tasks (定时任务) bound to the current conversation.',
      'Schedules run automatically on a cron schedule, executing a fixed prompt independently (no conversation history).',
      '',
      'Actions:',
      '- create: Create a new schedule. Requires name, cron (5-field), prompt.',
      '- edit: Update fields of an existing schedule. Requires schedule_id.',
      '- delete: Remove a schedule. Requires schedule_id.',
      '- list: List all schedules for the current conversation.',
      '- get: Get full details of a schedule including the complete prompt.',
      '- run_now: Trigger an immediate run (test). Requires schedule_id.',
      '',
      'IMPORTANT: Before creating a schedule, always confirm the details with the user via ask_user_question.',
      'The prompt should be self-contained — it will be executed without conversation context.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'edit', 'delete', 'list', 'get', 'run_now'],
          description: 'The action to perform.',
        },
        schedule_id: {
          type: 'string',
          description: 'Schedule ID (required for edit, delete, get, run_now).',
        },
        name: {
          type: 'string',
          description: 'Display name for the schedule (create/edit).',
        },
        cron: {
          type: 'string',
          description: '5-field cron expression, e.g. "0 9 * * *" (daily 9AM), "0 9 * * 1" (weekly Mon), "*/30 * * * *" (every 30 min). Supports @daily, @weekly, @monthly, @hourly aliases.',
        },
        prompt: {
          type: 'string',
          description: 'The task prompt to execute on schedule. Must be self-contained — it runs without conversation history. Example: "Read last week\'s git log, summarize progress, and save a weekly report to reports/week-{date}.md"',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the schedule is active (default true for create). Use false to pause.',
        },
        notify_on_success: {
          type: 'boolean',
          description: 'Send a desktop notification on successful run (default true).',
        },
        notify_on_failure: {
          type: 'boolean',
          description: 'Send a desktop notification on failed run (default true).',
        },
      },
      required: ['action'],
    },
  },
}

export const manageScheduleExecutor: ToolExecutor = async (args, context) => {
  const action = asString(args.action)

  switch (action) {
    case 'create':
      return handleCreate(args, context)
    case 'edit':
      return handleEdit(args)
    case 'delete':
      return handleDelete(args)
    case 'list':
      return handleList(args, context)
    case 'get':
      return handleGet(args)
    case 'run_now':
      return handleRunNow(args)
    default:
      return err(`Unknown action: "${action}". Valid actions: create, edit, delete, list, get, run_now`)
  }
}

export const schedulePromptDoc: ToolPromptDoc = {
  category: 'meta',
  section: '### Schedule Management',
  lines: [
    '- `manage_schedule(action, ...)` - Create, edit, delete, list, or trigger scheduled tasks (定时任务). Actions: create, edit, delete, list, get, run_now. Always confirm with user before create.',
  ],
}
