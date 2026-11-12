/**
 * Schedule Storage — persists Schedule metadata to OPFS.
 *
 * Each schedule is stored as a single JSON file:
 *   OPFS/schedules/{scheduleId}.json
 *
 * Schedule files are NOT part of workspace sync — they are global system data.
 */

import { generateId } from '@/opfs/utils/opfs-utils'
import { getNextRunTime } from '@/utils/cron-utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Schedule {
  /** Unique ID with "sched_" prefix */
  id: string
  /** Derived from conversation.projectId at creation time */
  projectId: string
  /** == conversationId, one-to-one binding */
  workspaceId: string
  /** Display name, defaults to conversation.title */
  name: string
  /** Distilled or manually written prompt, frozen at creation */
  prompt: string
  schedule: {
    type: 'cron'
    expression: string
  }
  /** Optional LLM override; resolve URL, credentials, and model defaults from this provider. */
  llm?: {
    /** Provider ID; an unavailable provider fails the run without falling back to current settings. */
    provider: string
    /** Model to use instead of the provider default. */
    model: string
  }
  /** Optional output directory pattern */
  output?: {
    directory: string
    filenamePattern: string
  }
  /** Notification preferences */
  notification?: {
    onSuccess: boolean
    onFailure: boolean
    message?: string
  }
  enabled: boolean
  /** Error state: null | 'CONV_DELETED' | 'LLM_NOT_AVAILABLE' | string */
  error: string | null
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastRunNumber: number
}

// ---------------------------------------------------------------------------
// OPFS path helpers
// ---------------------------------------------------------------------------

const SCHEDULES_DIR = 'schedules'

async function getSchedulesRootDir(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory()
  return opfsRoot.getDirectoryHandle(SCHEDULES_DIR, { create: true })
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Load all schedules from OPFS.
 */
export async function loadAllSchedules(): Promise<Schedule[]> {
  try {
    const root = await getSchedulesRootDir()
    const schedules: Schedule[] = []

    for await (const entry of root.values()) {
      if (entry.kind !== 'file') continue
      if (!entry.name.endsWith('.json')) continue

      try {
        const file = await entry.getFile()
        const text = await file.text()
        const schedule = JSON.parse(text) as Schedule
        schedules.push(schedule)
      } catch {
        // Skip corrupted files
        console.warn(`[ScheduleStorage] Failed to load ${entry.name}:`, entry)
      }
    }

    return schedules
  } catch (err) {
    console.error('[ScheduleStorage] Failed to load schedules:', err)
    return []
  }
}

/**
 * Load a single schedule by ID.
 */
export async function loadSchedule(id: string): Promise<Schedule | null> {
  try {
    const root = await getSchedulesRootDir()
    const fileName = `${id}.json`
    const fileHandle = await root.getFileHandle(fileName)
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text) as Schedule
  } catch {
    return null
  }
}

/**
 * Save a schedule (create or update).
 */
export async function saveSchedule(schedule: Schedule): Promise<void> {
  const root = await getSchedulesRootDir()
  const fileName = `${schedule.id}.json`
  const fileHandle = await root.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    await writable.write(JSON.stringify(schedule, null, 2))
  } finally {
    await writable.close()
  }

  // Register/unregister alarm in browser extension
  await _syncScheduleAlarm(schedule)
}

/**
 * Create a new schedule with a generated ID.
 */
export async function createSchedule(
  data: Omit<Schedule, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunNumber' | 'error'>
): Promise<Schedule> {
  const now = Date.now()
  const schedule: Schedule = {
    ...data,
    id: generateId('sched'),
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunNumber: 0,
    error: null,
  }
  await saveSchedule(schedule)
  return schedule
}

/**
 * Delete a schedule by ID.
 */
export async function deleteSchedule(id: string): Promise<void> {
  try {
    const root = await getSchedulesRootDir()
    await root.removeEntry(`${id}.json`)
  } catch {
    // Already deleted
  }
  // Clear alarm in browser extension
  await _clearScheduleAlarm(id)
}

/**
 * Get all schedules for a specific workspace (conversation).
 */
export async function getSchedulesForWorkspace(workspaceId: string): Promise<Schedule[]> {
  const all = await loadAllSchedules()
  return all.filter(s => s.workspaceId === workspaceId)
}

/**
 * Get all enabled schedules.
 */
export async function getEnabledSchedules(): Promise<Schedule[]> {
  const all = await loadAllSchedules()
  return all.filter(s => s.enabled && !s.error)
}

// ---------------------------------------------------------------------------
// Browser Extension bridge — sync alarms and send notifications
// ----------------------------------------------------------------------------

declare global {
  interface Window {
    __agentWeb?: {
      scheduleRegisterAlarm?: (scheduleId: string, nextRunTime: number) => Promise<{ ok: boolean; error?: string }>
      scheduleClearAlarm?: (scheduleId: string) => Promise<{ ok: boolean; error?: string }>
      scheduleShowNotification?: (title: string, body: string) => Promise<{ ok: boolean }>
    }
  }
}

/**
 * Sync schedule alarm state to the browser extension.
 * Registers an alarm if the schedule is enabled, clears it otherwise.
 */
async function _syncScheduleAlarm(schedule: Schedule): Promise<void> {
  if (typeof window === 'undefined' || !window.__agentWeb) return

  try {
    if (schedule.enabled && !schedule.error) {
      const lastAt = schedule.lastRunAt ?? schedule.createdAt
      const nextRun = getNextRunTime(schedule.schedule.expression, lastAt)
      if (nextRun !== null) {
        await window.__agentWeb.scheduleRegisterAlarm?.(schedule.id, nextRun)
      }
    } else {
      await window.__agentWeb.scheduleClearAlarm?.(schedule.id)
    }
  } catch {
    // Bridge may not be available — non-fatal
  }
}

/**
 * Clear a schedule's alarm from the browser extension.
 */
async function _clearScheduleAlarm(scheduleId: string): Promise<void> {
  if (typeof window === 'undefined' || !window.__agentWeb) return
  try {
    await window.__agentWeb.scheduleClearAlarm?.(scheduleId)
  } catch {
    // Bridge may not be available — non-fatal
  }
}

/**
 * Show a schedule notification via the browser extension.
 */
export async function showScheduleNotification(title: string, body: string): Promise<void> {
  if (typeof window === 'undefined' || !window.__agentWeb) return
  try {
    await window.__agentWeb.scheduleShowNotification?.(title, body)
  } catch {
    // Bridge may not be available — non-fatal
  }
}
