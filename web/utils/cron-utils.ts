/**
 * Cron Utilities — parse cron expressions and compute next run time.
 *
 * Supports standard 5-field cron format:
 *   ┌───────────── minute (0-59)
 *   │ ┌───────────── hour (0-23)
 *   │ │ ┌───────────── day of month (1-31)
 *   │ │ │ ┌───────────── month (1-12)
 *   │ │ │ │ ┌───────────── day of week (0-6, 0=Sunday)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Special values:
 *   *        any value
 *   ,        value list separator (e.g. 1,3,5)
 *   -        range (e.g. 1-5)
 *   /        step (e.g. *\/15 = every 15 minutes)
 *   @daily   = 0 0 * * *
 *   @weekly  = 0 0 * * 0
 *   @monthly = 0 0 1 * *
 */

export interface CronFields {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export interface CronParseResult {
  ok: true
  fields: CronFields
  expression: string // normalized form
}

export interface CronParseError {
  ok: false
  error: string
}

export type CronParseOutput = CronParseResult | CronParseError

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SPECIAL_EXPRESSIONS: Record<string, CronFields> = {
  '@daily':  { minute: '0',    hour: '0',    dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  '@weekly': { minute: '0',    hour: '0',    dayOfMonth: '*', month: '*', dayOfWeek: '0' },
  '@monthly':{ minute: '0',    hour: '0',    dayOfMonth: '1', month: '*', dayOfWeek: '*' },
  '@hourly': { minute: '0',    hour: '*',    dayOfMonth: '*', month: '*', dayOfWeek: '*' },
}

/**
 * Parse a cron expression string into normalized fields.
 */
export function parseCron(expression: string): CronParseOutput {
  const trimmed = expression.trim()

  if (SPECIAL_EXPRESSIONS[trimmed]) {
    return {
      ok: true,
      fields: { ...SPECIAL_EXPRESSIONS[trimmed] },
      expression: trimmed,
    }
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length === 4) {
    // Support 4-field format (no day-of-week)
    parts.push('*')
  } else if (parts.length === 6) {
    // Support 6-field format (with seconds)
    parts.shift() // drop seconds
  }

  if (parts.length !== 5) {
    return { ok: false, error: `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}` }
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  const minuteErr = validateField(minute, 0, 59, 'minute')
  if (minuteErr) return { ok: false, error: `minute: ${minuteErr}` }

  const hourErr = validateField(hour, 0, 23, 'hour')
  if (hourErr) return { ok: false, error: `hour: ${hourErr}` }

  const domErr = validateField(dayOfMonth, 1, 31, 'day-of-month')
  if (domErr) return { ok: false, error: `day-of-month: ${domErr}` }

  const monthErr = validateField(month, 1, 12, 'month')
  if (monthErr) return { ok: false, error: `month: ${monthErr}` }

  const dowErr = validateField(dayOfWeek, 0, 6, 'day-of-week')
  if (dowErr) return { ok: false, error: `day-of-week: ${dowErr}` }

  return {
    ok: true,
    fields: { minute, hour, dayOfMonth, month, dayOfWeek },
    expression: `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`,
  }
}

function validateField(value: string, min: number, max: number, name: string): string | null {
  if (value === '*') return null
  const listParts = value.split(',')
  for (const part of listParts) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/')
      if (!/^\d+$/.test(stepStr)) return `${name}: invalid step "${stepStr}"`
      const step = parseInt(stepStr, 10)
      if (step <= 0) return `${name}: step must be positive`
      if (rangeStr !== '*') {
        const rangeErr = validateRange(rangeStr, min, max, name)
        if (rangeErr) return rangeErr
      }
    } else if (part.includes('-')) {
      const rangeErr = validateRange(part, min, max, name)
      if (rangeErr) return rangeErr
    } else {
      if (!/^\d+$/.test(part)) return `${name}: "${part}" is not a number`
      const num = parseInt(part, 10)
      if (num < min || num > max) return `${name}: ${num} out of range [${min}-${max}]`
    }
  }
  return null
}

function validateRange(range: string, min: number, max: number, name: string): string | null {
  if (range === '*') return null
  const parts = range.split('-')
  if (parts.length !== 2) return `${name}: invalid range "${range}"`
  const [fromStr, toStr] = parts
  if (!/^\d+$/.test(fromStr) || !/^\d+$/.test(toStr)) return `${name}: range "${range}" contains non-numbers`
  const from = parseInt(fromStr, 10)
  const to = parseInt(toStr, 10)
  if (from < min || from > max) return `${name}: range start ${from} out of [${min}-${max}]`
  if (to < min || to > max) return `${name}: range end ${to} out of [${min}-${max}]`
  if (from > to) return `${name}: range start > end (${from} > ${to})`
  return null
}

// ---------------------------------------------------------------------------
// Field matching
// ---------------------------------------------------------------------------

function fieldMatches(value: string, unit: number, min: number, max: number): boolean {
  if (value === '*') return true

  const listParts = value.split(',')
  for (const part of listParts) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      let start = min
      let end = max
      if (rangeStr !== '*') {
        const [fromStr, toStr] = rangeStr.split('-')
        start = parseInt(fromStr, 10)
        end = toStr ? parseInt(toStr, 10) : max
      }
      if (unit >= start && unit <= end && (unit - start) % step === 0) return true
    } else if (part.includes('-')) {
      const [fromStr, toStr] = part.split('-')
      const from = parseInt(fromStr, 10)
      const to = parseInt(toStr, 10)
      if (unit >= from && unit <= to) return true
    } else {
      if (parseInt(part, 10) === unit) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Next run time
// ---------------------------------------------------------------------------

/**
 * Compute the next scheduled run time (in ms, Unix epoch) after `after`.
 * Returns null if the cron has no future occurrence (shouldn't happen for valid crons).
 */
export function getNextRunTime(expression: string, after: number = Date.now()): number | null {
  const result = parseCron(expression)
  if (!result.ok) return null

  const { minute, hour, dayOfMonth, month, dayOfWeek } = result.fields

  // Start from the next second after `after`
  let current = new Date(after)
  current.setMilliseconds(0)
  current.setSeconds(0)

  // Advance to next minute
  current.setMinutes(current.getMinutes() + 1)

  // Safety: don't search more than 2 years ahead
  const maxDate = new Date(after)
  maxDate.setFullYear(maxDate.getFullYear() + 2)

  while (current <= maxDate) {
    const dom = current.getDate()
    const monthIdx = current.getMonth() + 1 // 1-based
    const dow = current.getDay() // 0=Sun

    // Month must match
    if (!fieldMatches(month, monthIdx, 1, 12)) {
      // Advance to next month, day 1, midnight
      current = new Date(current.getFullYear(), current.getMonth() + 1, 1, 0, 0, 0)
      continue
    }

    // Day-of-week must match (OR with day-of-month)
    const dowMatch = fieldMatches(dayOfWeek, dow, 0, 6)
    // Day-of-month must match
    const domMatch = fieldMatches(dayOfMonth, dom, 1, 31)

    // Cron day matching logic:
    // - If both day-of-month and day-of-week are '*', day always matches
    // - If only one is specified (not '*'), that one must match
    // - If both are specified, either matching is sufficient (OR)
    const domIsWild = isAllWildcard(dayOfMonth)
    const dowIsWild = isAllWildcard(dayOfWeek)
    const dayMatches = domIsWild && dowIsWild
      ? true
      : (!domIsWild && domMatch) || (!dowIsWild && dowMatch)

    if (!dayMatches) {
      current.setDate(current.getDate() + 1)
      current.setHours(0, 0, 0, 0)
      continue
    }

    // Hour
    if (!fieldMatches(hour, current.getHours(), 0, 23)) {
      // Find next matching hour
      const nextHour = findNextMatch(current.getHours() + 1, 0, 23, hour)
      if (nextHour === null) {
        current.setDate(current.getDate() + 1)
        current.setHours(0, 0, 0, 0)
        continue
      }
      current.setHours(nextHour, 0, 0, 0)
      continue
    }

    // Minute
    if (!fieldMatches(minute, current.getMinutes(), 0, 59)) {
      const nextMinute = findNextMatch(current.getMinutes() + 1, 0, 59, minute)
      if (nextMinute === null) {
        current.setHours(current.getHours() + 1, 0, 0, 0)
        continue
      }
      current.setMinutes(nextMinute, 0, 0)
      continue
    }

    // All fields match — this is the next run time
    return current.getTime()
  }

  return null
}

function isAllWildcard(value: string): boolean {
  return value === '*'
}

function findNextMatch(after: number, min: number, max: number, field: string): number | null {
  for (let v = after; v <= max; v++) {
    if (fieldMatches(field, v, min, max)) return v
  }
  return null
}

// ---------------------------------------------------------------------------
// Human-readable description
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月',
                     '七月', '八月', '九月', '十月', '十一月', '十二月']

/**
 * Return a human-readable Chinese description of the cron expression.
 */
export function describeCron(expression: string): string {
  const result = parseCron(expression)
  if (!result.ok) return `无效表达式: ${result.error}`

  const { minute, hour, dayOfMonth, month, dayOfWeek } = result.fields

  // Daily
  if (isAllWildcard(minute) && isAllWildcard(hour) &&
      isAllWildcard(dayOfMonth) && isAllWildcard(month) && isAllWildcard(dayOfWeek)) {
    return '每天每小时'
  }
  // Weekly
  if (isAllWildcard(minute) && isAllWildcard(hour) &&
      isAllWildcard(dayOfMonth) && isAllWildcard(month) && !isAllWildcard(dayOfWeek)) {
    const days = expandField(dayOfWeek, 0, 6).map(d => WEEKDAY_NAMES[d]).join('、')
    return `每周${days}`
  }
  // Monthly
  if (isAllWildcard(minute) && isAllWildcard(hour) &&
      !isAllWildcard(dayOfMonth) && isAllWildcard(month) && isAllWildcard(dayOfWeek)) {
    const days = expandField(dayOfMonth, 1, 31).map(d => `${d}日`).join('、')
    return `每月${days}`
  }
  // Hourly
  if (isAllWildcard(minute) && !isAllWildcard(hour) &&
      isAllWildcard(dayOfMonth) && isAllWildcard(month) && isAllWildcard(dayOfWeek)) {
    return `每天 ${hour} 点`
  }

  // Generic: just show the cron expression with field names
  const parts: string[] = []
  if (!isAllWildcard(hour)) parts.push(`${hour} 点`)
  if (!isAllWildcard(minute)) {
    if (minute.startsWith('*/')) {
      parts.push(`每 ${minute.slice(2)} 分钟`)
    } else {
      parts.push(`${minute} 分`)
    }
  }

  if (!isAllWildcard(dayOfMonth) && !isAllWildcard(dayOfWeek)) {
    parts.push(`每月${dayOfMonth}日 或 每周${dayOfWeek}`)
  } else if (!isAllWildcard(dayOfMonth)) {
    parts.push(`每月${dayOfMonth}日`)
  } else if (!isAllWildcard(dayOfWeek)) {
    const days = expandField(dayOfWeek, 0, 6).map(d => WEEKDAY_NAMES[d]).join('、')
    parts.push(`每${days}`)
  }

  if (!isAllWildcard(month)) {
    const months = expandField(month, 1, 12).map(m => MONTH_NAMES[m - 1]).join('、')
    parts.push(months)
  }

  return parts.join('，') || '每天每小时'
}

function expandField(value: string, min: number, max: number): number[] {
  if (value === '*') {
    const result: number[] = []
    for (let v = min; v <= max; v++) result.push(v)
    return result
  }

  const result = new Set<number>()
  const listParts = value.split(',')
  for (const part of listParts) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/')
      const step = parseInt(stepStr, 10)
      let start = min
      let end = max
      if (rangeStr !== '*') {
        const [fromStr, toStr] = rangeStr.split('-')
        start = parseInt(fromStr, 10)
        end = toStr ? parseInt(toStr, 10) : max
      }
      for (let v = start; v <= end; v += step) result.add(v)
    } else if (part.includes('-')) {
      const [fromStr, toStr] = part.split('-')
      const from = parseInt(fromStr, 10)
      const to = parseInt(toStr, 10)
      for (let v = from; v <= to; v++) result.add(v)
    } else {
      result.add(parseInt(part, 10))
    }
  }
  return Array.from(result).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a cron expression without computing next run time.
 */
export function isValidCron(expression: string): boolean {
  return parseCron(expression).ok
}
