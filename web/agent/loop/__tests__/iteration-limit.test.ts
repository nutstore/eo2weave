import { describe, expect, it } from 'vitest'
import { DEFAULT_ITERATION_LIMIT, MAX_ITERATION_LIMIT, resolveIterationLimit } from '@/agent/loop/iteration-limit'

describe('resolveIterationLimit', () => {
  it('keeps 0 as unlimited', () => {
    expect(resolveIterationLimit(0)).toBe(0)
  })

  it('passes finite values through inside the UI window', () => {
    expect(resolveIterationLimit(1)).toBe(1)
    expect(resolveIterationLimit(20)).toBe(20)
    expect(resolveIterationLimit(MAX_ITERATION_LIMIT)).toBe(MAX_ITERATION_LIMIT)
  })

  it('floors fractions and clamps to 1..100', () => {
    expect(resolveIterationLimit(37.9)).toBe(37)
    expect(resolveIterationLimit(1000)).toBe(MAX_ITERATION_LIMIT)
    expect(resolveIterationLimit(-5)).toBe(1)
    expect(resolveIterationLimit(0.4)).toBe(1)
  })

  it('falls back to the default for non-finite input instead of running unbounded', () => {
    expect(resolveIterationLimit(Number.NaN)).toBe(DEFAULT_ITERATION_LIMIT)
    expect(resolveIterationLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ITERATION_LIMIT)
    expect(resolveIterationLimit(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_ITERATION_LIMIT)
  })
})
