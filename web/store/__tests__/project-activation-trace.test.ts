import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectActivationTrace,
  getActiveActivationProjectId,
  getPendingActivationStep,
  resetActiveActivationTraceForTests,
} from '@/store/project-activation-trace'

/**
 * Pins the activation trace contract (issue #316): each awaited step logs its
 * own duration, a step that never settles still identifies itself, and the
 * trace never changes behaviour — errors keep propagating unchanged.
 */
describe('project activation trace', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  const logCalls = (message: string) => logSpy.mock.calls.filter((call: unknown[]) => call[0] === message)
  const warnCalls = (message: string) => warnSpy.mock.calls.filter((call: unknown[]) => call[0] === message)

  beforeEach(() => {
    resetActiveActivationTraceForTests()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetActiveActivationTraceForTests()
  })

  it('logs a start and a completed line per step, in order, with durations', async () => {
    const trace = createProjectActivationTrace('proj-1', { stallLogIntervalMs: 0 })
    const ran: string[] = []

    await trace.step('repo.findById', async () => {
      // The pending step is readable while the await is outstanding, which is
      // what lets the route-sync guard name the blocked operation.
      expect(trace.pendingStep()).toBe('repo.findById')
      ran.push('repo.findById')
      return { id: 'proj-1' }
    })
    expect(trace.pendingStep()).toBeNull()

    await trace.step('bootstrapProjectOpfs', () => {
      ran.push('bootstrapProjectOpfs')
    })
    trace.finish('ok')

    expect(ran).toEqual(['repo.findById', 'bootstrapProjectOpfs'])

    const starts = logCalls('[ProjectActivation] step start').map((call: unknown[]) => call[1])
    expect(starts.map((payload) => (payload as { step: string }).step)).toEqual([
      'repo.findById',
      'bootstrapProjectOpfs',
    ])
    expect(starts.every((payload) => typeof (payload as { atMs: number }).atMs === 'number')).toBe(true)

    const dones = logCalls('[ProjectActivation] step done').map((call: unknown[]) => call[1]) as {
      step: string
      stepMs: number
    }[]
    expect(dones.map((payload) => payload.step)).toEqual(['repo.findById', 'bootstrapProjectOpfs'])
    expect(dones.every((payload) => Number.isFinite(payload.stepMs) && payload.stepMs >= 0)).toBe(true)

    const finished = logCalls('[ProjectActivation] finished')
    expect(finished).toHaveLength(1)
    expect(finished[0][1]).toMatchObject({ projectId: 'proj-1', outcome: 'ok' })
  })

  it('propagates a step failure unchanged and records it', async () => {
    const trace = createProjectActivationTrace('proj-2', { stallLogIntervalMs: 0 })
    const boom = new Error('OPFS directory handle blocked')

    await expect(
      trace.step('bootstrapProjectOpfs', async () => {
        throw boom
      })
    ).rejects.toBe(boom)

    expect(trace.pendingStep()).toBeNull()
    const failures = warnCalls('[ProjectActivation] step failed')
    expect(failures).toHaveLength(1)
    expect(failures[0][1]).toMatchObject({
      projectId: 'proj-2',
      step: 'bootstrapProjectOpfs',
      error: 'OPFS directory handle blocked',
    })
    expect(logCalls('[ProjectActivation] step done')).toHaveLength(0)
  })

  it('names the still-pending step when the chain stops progressing', async () => {
    vi.useFakeTimers()
    const trace = createProjectActivationTrace('proj-stall', { stallLogIntervalMs: 5000 })
    let release: () => void = () => {}
    const stuck = trace.step(
      'agentStore.setActiveProject',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    await vi.advanceTimersByTimeAsync(5000)

    const stalls = warnCalls('[ProjectActivation] still pending')
    expect(stalls.length).toBeGreaterThanOrEqual(1)
    expect(stalls[0][1]).toMatchObject({
      projectId: 'proj-stall',
      step: 'agentStore.setActiveProject',
    })

    release()
    await stuck
    trace.finish('ok')

    // Once the activation finishes the watchdog stops re-announcing it.
    const warningsAfterFinish = warnSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(warnSpy.mock.calls.length).toBe(warningsAfterFinish)
  })

  it('does not re-announce between steps', async () => {
    vi.useFakeTimers()
    const trace = createProjectActivationTrace('proj-idle', { stallLogIntervalMs: 5000 })
    await trace.step('repo.findById', () => Promise.resolve(null))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(warnCalls('[ProjectActivation] still pending')).toHaveLength(0)
    trace.finish('ok')
  })

  it('reports the in-flight activation to the route-sync guard', async () => {
    const trace = createProjectActivationTrace('proj-3', { stallLogIntervalMs: 0 })
    expect(getActiveActivationProjectId()).toBe('proj-3')
    expect(getPendingActivationStep()).toBeNull()

    let release: () => void = () => {}
    const stuck = trace.step(
      'refreshWorkspaces',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    expect(getPendingActivationStep()).toBe('refreshWorkspaces')

    release()
    await stuck
    trace.finish('ok')

    expect(getPendingActivationStep()).toBeNull()
    expect(getActiveActivationProjectId()).toBeNull()
  })

  it('finishes once and stops the watchdog even for a failed outcome', () => {
    const trace = createProjectActivationTrace('proj-4', { stallLogIntervalMs: 0 })
    trace.finish('failed')
    trace.finish('ok')

    expect(warnCalls('[ProjectActivation] finished')).toHaveLength(1)
    expect(logCalls('[ProjectActivation] finished')).toHaveLength(0)
    expect(getActiveActivationProjectId()).toBeNull()
  })
})
