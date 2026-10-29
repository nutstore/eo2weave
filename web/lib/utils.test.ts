import { describe, it, expect } from 'vitest'
import { formatBytes, formatSize, formatNumber, formatDuration } from './utils'

describe('formatBytes', () => {
  it('should format 0 bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('should format bytes correctly', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('should format kilobytes correctly', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('should format megabytes correctly', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('should format gigabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('should format terabytes correctly', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB')
  })

  it('should round to a single decimal place', () => {
    // The per-module formatters this canonical one replaced all rounded to
    // one decimal, so the dedupe must not change displayed sizes.
    expect(formatBytes(1280)).toBe('1.3 KB')
    expect(formatBytes(1234)).toBe('1.2 KB')
    expect(formatBytes(1234567)).toBe('1.2 MB')
  })

  it('should keep the unit boundary on the larger side', () => {
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('should reject negative byte counts without producing an invalid unit', () => {
    expect(formatBytes(-1)).toBe('-1 B')
    expect(formatBytes(-2048)).toBe('-2048 B')
    expect(formatBytes(-1024)).toBe('-1024 B')
  })

  it('should fall back to 0 B for non-finite byte counts', () => {
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
    expect(formatBytes(-Infinity)).toBe('0 B')
  })

  it('should cap at the largest supported unit', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB')
  })
})

describe('formatSize', () => {
  it('should match formatBytes', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(-1)).toBe('-1 B')
    expect(formatSize(NaN)).toBe('0 B')
  })
})

describe('formatNumber', () => {
  it('should format small numbers without commas', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(123)).toBe('123')
  })

  it('should format thousands with commas', () => {
    expect(formatNumber(1000)).toBe('1,000')
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(9999)).toBe('9,999')
  })

  it('should format millions with commas', () => {
    expect(formatNumber(1000000)).toBe('1,000,000')
    expect(formatNumber(1234567)).toBe('1,234,567')
  })

  it('should format billions with commas', () => {
    expect(formatNumber(1000000000)).toBe('1,000,000,000')
    expect(formatNumber(1234567890)).toBe('1,234,567,890')
  })

  it('should handle negative numbers', () => {
    expect(formatNumber(-1234)).toBe('-1,234')
  })
})

describe('formatDuration', () => {
  it('should format milliseconds correctly', () => {
    expect(formatDuration(100)).toBe('100ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('should format seconds correctly', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(5432)).toBe('5.4s')
  })

  it('should format minutes correctly', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
    expect(formatDuration(65000)).toBe('1m 5s')
    expect(formatDuration(125000)).toBe('2m 5s')
  })

  it('should format hours correctly', () => {
    expect(formatDuration(3600000)).toBe('1h 0m 0s')
    expect(formatDuration(3661000)).toBe('1h 1m 1s')
  })

  it('should handle zero duration', () => {
    expect(formatDuration(0)).toBe('0ms')
  })
})
