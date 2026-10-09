import { describe, expect, it, vi } from 'vitest'
import { action, condition, createExecution, selector, sequence, wait, type Status } from '../src/index'

describe('memory and composition', () => {
  it('resumes a sequence without repeating completed effects', async () => {
    const first = vi.fn(() => 'success' as const)
    let ready = false
    const last = vi.fn(() => 'success' as const)
    const execution = createExecution(sequence(action(first), wait(() => ready), action(last)), {})
    expect(await execution.tick()).toBe('running')
    expect(await execution.tick()).toBe('running')
    expect(first).toHaveBeenCalledTimes(1)
    expect(last).not.toHaveBeenCalled()
    ready = true
    expect(await execution.tick()).toBe('success')
    expect(await execution.tick()).toBe('success')
    expect(last).toHaveBeenCalledTimes(1)
    execution.reset()
    expect(await execution.tick()).toBe('success')
    expect(first).toHaveBeenCalledTimes(2)
  })

  it('keeps a running selector branch and falls back only on failure', async () => {
    const rejected = vi.fn(() => false)
    const active = vi.fn<() => Status>().mockReturnValueOnce('running').mockReturnValue('failure')
    const fallback = vi.fn(() => 'success' as const)
    const execution = createExecution(selector(condition(rejected), action(active), action(fallback)), {})
    expect(await execution.tick()).toBe('running')
    expect(fallback).not.toHaveBeenCalled()
    expect(await execution.tick()).toBe('success')
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('short circuits sequence failure and selector success', async () => {
    const skipped = vi.fn(() => 'success' as const)
    expect(await createExecution(sequence(condition(() => false), action(skipped)), {}).tick()).toBe('failure')
    expect(await createExecution(selector(condition(() => true), action(skipped)), {}).tick()).toBe('success')
    expect(skipped).not.toHaveBeenCalled()
  })

  it('defines empty composites', async () => {
    expect(await createExecution(sequence(), {}).tick()).toBe('success')
    expect(await createExecution(selector(), {}).tick()).toBe('failure')
  })

  it('isolates executions and repeated subtree occurrences', async () => {
    const leaf = action<{ count: number }>(context => { context.count++; return 'success' })
    const tree = sequence(leaf, leaf)
    const a = createExecution(tree, { count: 0 })
    const b = createExecution(tree, { count: 10 })
    await Promise.all([a.tick(), b.tick()])
    expect(a.context.count).toBe(2)
    expect(b.context.count).toBe(12)
  })
})

describe('async execution and errors', () => {
  it('shares an in-flight tick without starting an action twice', async () => {
    let finish!: (value: Status) => void
    const run = vi.fn(() => new Promise<Status>(resolve => { finish = resolve }))
    const execution = createExecution(action(run), {})
    const first = execution.tick()
    expect(execution.tick()).toBe(first)
    await Promise.resolve()
    expect(execution.status).toBe('running')
    expect(() => execution.reset()).toThrow('pending')
    finish('success')
    expect(await first).toBe('success')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('latches exceptions instead of falling back or repeating effects', async () => {
    const error = new Error('transport failed')
    const broken = vi.fn(async (): Promise<Status> => { throw error })
    const fallback = vi.fn(() => 'success' as const)
    const execution = createExecution(selector(action(broken), action(fallback)), {})
    await expect(execution.tick()).rejects.toBe(error)
    await expect(execution.tick()).rejects.toBe(error)
    expect(broken).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
    expect(execution.status).toBeUndefined()
    execution.reset()
    await expect(execution.tick()).rejects.toBe(error)
    expect(broken).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed callback results', async () => {
    await expect(createExecution(action(() => undefined as unknown as Status), {}).tick()).rejects.toThrow('Action')
    await expect(createExecution(condition(() => 'yes' as unknown as boolean), {}).tick()).rejects.toThrow('Inspect')
  })
})

describe('wait', () => {
  it('observes polling intervals and succeeds when ready', async () => {
    let time = 0
    const inspect = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const execution = createExecution(wait(inspect, { intervalMs: 10 }), {}, { now: () => time })
    expect(await execution.tick()).toBe('running')
    time = 9
    expect(await execution.tick()).toBe('running')
    expect(inspect).toHaveBeenCalledTimes(1)
    time = 10
    expect(await execution.tick()).toBe('success')
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('times out even between inspections and enables fallback', async () => {
    let time = 0
    const inspect = vi.fn(() => false)
    const execution = createExecution(selector(wait(inspect, { intervalMs: 100, timeoutMs: 20 }), condition(() => true)), {}, { now: () => time })
    expect(await execution.tick()).toBe('running')
    time = 20
    expect(await execution.tick()).toBe('success')
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('allows one immediate inspection for a zero timeout', async () => {
    expect(await createExecution(wait(() => true, { timeoutMs: 0 }), {}).tick()).toBe('success')
    expect(await createExecution(wait(() => false, { timeoutMs: 0 }), {}).tick()).toBe('failure')
  })

  it('has no implicit timeout', async () => {
    let time = 0
    const execution = createExecution(wait(() => false), {}, { now: () => time })
    await execution.tick()
    time = 1e12
    expect(await execution.tick()).toBe('running')
  })

  it('validates explicit durations', () => {
    for (const duration of [-1, Infinity, NaN]) {
      expect(() => wait(() => true, { timeoutMs: duration })).toThrow(RangeError)
      expect(() => wait(() => true, { intervalMs: duration })).toThrow(RangeError)
    }
  })
})
