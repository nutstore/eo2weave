import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind CSS classes
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Human-readable byte units, smallest first.
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Format file size (alias for formatBytes for compatibility)
 */
export function formatSize(bytes: number): string {
  return formatBytes(bytes)
}

/**
 * Format bytes to human-readable format.
 *
 * One decimal place (always shown above the byte unit) matches the per-module
 * formatters this canonical implementation replaced, so deduplicating them
 * does not change any displayed size: byte counts stay whole ("512 B") and
 * larger units render as "1.0 KB" / "1.5 MB". The few pre-PR two-decimal
 * branches (the skill-download progress and the storage diagnostics labels)
 * read better with one decimal and are the only displayed sizes that change.
 *
 * Invalid input is handled here rather than at each call site: a non-finite
 * count falls back to "0 B", and a negative count keeps the plain signed byte
 * label its callers used to show ("-2048 B") instead of deriving an invalid
 * unit from a negative logarithm.
 *
 * Units run up to TB. A few replaced formatters stopped at MB or GB (and two
 * of them rendered "undefined" past their cap); escalating the unit is the
 * same behavior the pre-existing callers of this formatter already had.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0 B'
  if (bytes < 0) return `-${Math.abs(bytes)} B`
  if (bytes === 0) return '0 B'

  const unitIndex = Math.min(
    Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0),
    BYTE_UNITS.length - 1
  )
  const value = bytes / 1024 ** unitIndex

  return unitIndex === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`
}

/**
 * Format date
 */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Format number with thousand separators
 */
export function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format duration in milliseconds to human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }

  const seconds = ms / 1000
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) {
    const remainingMinutes = minutes % 60
    const remainingSeconds = Math.floor(seconds % 60)
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`
  }

  if (minutes > 0) {
    const remainingSeconds = Math.floor(seconds % 60)
    return `${minutes}m ${remainingSeconds}s`
  }

  return `${seconds.toFixed(1)}s`
}
