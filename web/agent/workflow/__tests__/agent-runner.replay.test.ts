import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@creatorweave/quickjs-runtime'
import { createAgentRunner, type AgentStepRecord, type AgentStepStore } from '../agent-runner'
import type { SubagentRuntime } from '@/agent/tools/tool-types'

/** The runner's optionsKey for default options: name, type, mode, timeout, as, role, capabilities, task, handoff. */
const DEFAULT_KEY = JSON.stringify([null, null, null, null, null, null, null, null, null])

function completedRow(stepIndex: number, prompt: string, result: string): AgentStepRecord {
  return {
    stepIndex,
    promptHash: 'h',
    prompt,
    optionsKey: DEFAULT_KEY,
    status: 'completed',
    agentId: `cached-${stepIndex}`,
    result,
  }
}

/**
 * In-memory store. Plain async functions, not `vi.fn()`: a mock whose
 * implementation throws is reported by vitest as a test error even when the
 * caller catches it, so anything that must fail belongs on a plain method.
 */
function fakeStore(rows: AgentStepRecord[] = []) {
  const saved = rows.map(row => ({ ...row }))
  const store: AgentStepStore = {
    listSteps: async () => saved.map(row => ({ ...row })),
    saveStep: async input => {
      const existing = saved.findIndex(row => row.stepIndex === input.stepIndex)
      const row: AgentStepRecord = {
        stepIndex: input.stepIndex,
        promptHash: input.promptHash,
        prompt: input.prompt,
        optionsKey: input.optionsKey,
        status: input.status,
        agentId: input.agentId,
        name: input.name,
        result: input.result,
      }
      if (existing >= 0) saved[existing] = row
      else saved.push(row)
    },
  }
  return { store, saved }
}

/** Every spawn is a fresh child that echoes its prompt. */
function fakeRuntime() {
  let spawned = 0
  const spawn = vi.fn(async (input: { prompt: string }) => {
    spawned += 1
    return { content: `fresh:${input.prompt}`, agentId: `agent-${spawned}`, usage: null }
  })
  return { runtime: { spawn } as unknown as Pick<SubagentRuntime, 'spawn'>, spawn }
}

describe('agent runner replay', () => {
  it('serves every step from cache when nothing changed', async () => {
    const { store } = fakeStore([completedRow(0, 'a', 'A'), completedRow(1, 'b', 'B')])
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime, store, runId: 'run-1' })

    expect(await runner.runAgent('a')).toMatchObject({ content: 'A', cached: true })
    expect(await runner.runAgent('b')).toMatchObject({ content: 'B', cached: true })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('re-runs from the first changed step onward', async () => {
    // Prefix replay: editing step 1 also invalidates step 2, whose prompt is
    // untouched. That is exactly what a targeted retry has to opt out of.
    const { store } = fakeStore([completedRow(0, 'a', 'A'), completedRow(1, 'b', 'B')])
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime, store, runId: 'run-1' })

    await runner.runAgent('a')
    const changed = await runner.runAgent('b changed')

    expect(changed.cached).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('re-executes only the retried step and keeps the later ones cached', async () => {
    const { store, saved } = fakeStore([completedRow(0, 'a', 'A'), completedRow(1, 'b', 'B')])
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime, store, runId: 'run-1' })

    await runner.runAgent('a')
    const retried = await runner.runAgent('b', { retry: true })

    expect(retried).toMatchObject({ content: 'fresh:b', cached: false })
    expect(spawn).toHaveBeenCalledTimes(1)
    // The retried row is overwritten in place, not appended.
    expect(saved.filter(row => row.stepIndex === 1)).toHaveLength(1)
    expect(saved.find(row => row.stepIndex === 1)?.result).toBe('fresh:b')
  })

  it('does not let a retried row answer a later step with the same prompt', async () => {
    // Both steps ask the same question, so the "any unconsumed prior step"
    // fallback could otherwise hand step 1 the row that step 0 just skipped.
    const { store } = fakeStore([completedRow(0, 'same', 'OLD'), completedRow(1, 'same', 'OLD')])
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime, store, runId: 'run-1' })

    const retried = await runner.runAgent('same', { retry: true })
    const next = await runner.runAgent('same')

    expect(retried).toMatchObject({ content: 'fresh:same', cached: false })
    expect(next).toMatchObject({ content: 'OLD', cached: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps running fresh after a retry when a later step misses on its own', async () => {
    const { store } = fakeStore([completedRow(0, 'a', 'A'), completedRow(1, 'b', 'B')])
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime, store, runId: 'run-1' })

    await runner.runAgent('a', { retry: true })
    const changed = await runner.runAgent('edited')

    expect(changed.cached).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('treats retry as a cache hint only, never as part of the step identity', async () => {
    // If `retry` leaked into optionsKey, the row written by a retry could never
    // be matched by a plain run again, so every later rerun would miss.
    const { store, saved } = fakeStore()
    const first = fakeRuntime()
    await createAgentRunner({ runtime: first.runtime, store, runId: 'run-1' }).runAgent('a')

    const second = fakeRuntime()
    await createAgentRunner({ runtime: second.runtime, store, runId: 'run-1' }).runAgent('a', { retry: true })
    expect(second.spawn).toHaveBeenCalledTimes(1)

    const third = fakeRuntime()
    const hit = await createAgentRunner({ runtime: third.runtime, store, runId: 'run-1' }).runAgent('a')

    expect(hit.cached).toBe(true)
    expect(third.spawn).not.toHaveBeenCalled()
    expect(saved).toHaveLength(1)
    expect(saved[0].optionsKey).toBe(DEFAULT_KEY)
  })

  it('ignores retry when the run has no store', async () => {
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime })

    const result = await runner.runAgent('a', { retry: true } as JsonValue)

    expect(result.cached).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('agent runner team binding', () => {
  it('forwards task_id and handoff, and names the step after the task', async () => {
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime })

    await runner.runAgent('a', {
      task_id: 't1',
      handoff: { expects: 'file:line list', reads: ['00-brief.md'], writes: ['by/t1/out.md'] },
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][0]).toMatchObject({
      name: 't1',
      description: 't1',
      task_id: 't1',
      handoff: { expects: 'file:line list', reads: ['00-brief.md'], writes: ['by/t1/out.md'] },
    })
  })

  it('drops a malformed handoff instead of handing it to the board', async () => {
    const { runtime, spawn } = fakeRuntime()
    const runner = createAgentRunner({ runtime })

    await runner.runAgent('a', { task_id: 't1', handoff: { expects: 42, reads: 'nope' } })

    expect(spawn.mock.calls[0][0]).toMatchObject({ task_id: 't1', handoff: undefined })
  })

  it('treats the task binding as part of the step identity', async () => {
    // The task section is injected into the child's prompt, so binding a step to
    // a different task must not be served the previous task's answer.
    const { store } = fakeStore()
    const first = fakeRuntime()
    await createAgentRunner({ runtime: first.runtime, store, runId: 'run-1' })
      .runAgent('a', { task_id: 't1' })

    const second = fakeRuntime()
    const rebound = await createAgentRunner({ runtime: second.runtime, store, runId: 'run-1' })
      .runAgent('a', { task_id: 't2' })

    expect(rebound.cached).toBe(false)
    expect(second.spawn).toHaveBeenCalledTimes(1)
  })
})
