/**
 * Effective iteration limit ("turns") for one agent run.
 *
 * `0` means unlimited — the settings UI's ∞ switch — and it must survive this
 * resolver untouched: `process-loop-events` decides "a limit exists" by
 * `maxIterations > 0`, so any other value is a finite cap. Finite values are
 * clamped into the same 1..100 window the UI exposes, and a non-finite value
 * falls back to the historical default, so a corrupted setting can never
 * silently become an unbounded run.
 *
 * Shared by the main conversation loop, subagents (which inherit the setting)
 * and scheduled runs: one setting must mean one thing everywhere. AgentLoop
 * keeps its own `MAX_ITERATIONS` as the last-resort default for callers that
 * pass nothing at all.
 */
export const DEFAULT_ITERATION_LIMIT = 20
export const MAX_ITERATION_LIMIT = 100

export function resolveIterationLimit(configured: number): number {
  if (configured === 0) return 0
  if (!Number.isFinite(configured)) return DEFAULT_ITERATION_LIMIT
  return Math.max(1, Math.min(MAX_ITERATION_LIMIT, Math.floor(configured)))
}
