import { describe, expect, it } from 'vitest'
import {
  COMPRESSION_TRIGGER_RATIO,
  DEFAULT_COMPRESSION_ABSOLUTE_CAP,
  resolveCompressionTriggerTokens,
} from '../loop/context-compression'

describe('resolveCompressionTriggerTokens', () => {
  it('falls back to the ratio when the cap is disabled', () => {
    expect(
      resolveCompressionTriggerTokens({ maxContextTokens: 200_000, absoluteCapEnabled: false, absoluteCap: 50_000 })
    ).toBe(170_000)
  })

  it('keeps the ratio when the cap sits above it', () => {
    expect(
      resolveCompressionTriggerTokens({ maxContextTokens: 200_000, absoluteCapEnabled: true, absoluteCap: 200_000 })
    ).toBe(170_000)
  })

  it('caps a large window at the absolute limit', () => {
    expect(
      resolveCompressionTriggerTokens({ maxContextTokens: 1_000_000, absoluteCapEnabled: true, absoluteCap: 200_000 })
    ).toBe(200_000)
  })

  it('uses the default cap when enabled without a value', () => {
    const trigger = resolveCompressionTriggerTokens({ maxContextTokens: 1_000_000, absoluteCapEnabled: true })
    expect(trigger).toBe(DEFAULT_COMPRESSION_ABSOLUTE_CAP)
  })

  it('ignores a non-positive cap instead of compressing immediately', () => {
    expect(
      resolveCompressionTriggerTokens({ maxContextTokens: 200_000, absoluteCapEnabled: true, absoluteCap: 0 })
    ).toBe(170_000)
  })

  it('floors the ratio so the threshold is an integer', () => {
    const trigger = resolveCompressionTriggerTokens({ maxContextTokens: 1001 })
    expect(trigger).toBe(Math.floor(1001 * COMPRESSION_TRIGGER_RATIO))
    expect(Number.isInteger(trigger)).toBe(true)
  })
})
