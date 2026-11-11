import { describe, expect, it, vi } from 'vitest'
import { CredentialRegistry, type CredentialVerdict } from '@/agent/providers/credential-state'

const KEY = 'openai'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('CredentialRegistry (#281)', () => {
  it('starts unknown and never guesses', () => {
    const registry = new CredentialRegistry()
    expect(registry.getState(KEY).kind).toBe('unknown')
  })

  it('commits a verdict, bumps the epoch and notifies subscribers', () => {
    const registry = new CredentialRegistry()
    const seen: string[] = []
    registry.subscribe(KEY, (state) => seen.push(state.kind))
    const before = registry.getState(KEY).epoch

    const committed = registry.commit(KEY, { kind: 'valid' })

    expect(committed.kind).toBe('valid')
    expect(committed.epoch).toBeGreaterThan(before)
    expect(seen).toEqual(['valid'])
  })

  it('makes a cached verdict visibly stale after any commit', () => {
    const registry = new CredentialRegistry()
    const cached = registry.commit(KEY, { kind: 'valid' })
    expect(registry.isCurrent(cached.epoch)).toBe(true)

    registry.commit(KEY, { kind: 'expired' })

    expect(registry.isCurrent(cached.epoch)).toBe(false)
    expect(registry.getState(KEY).kind).toBe('expired')
  })

  it('resolves single-flight: concurrent callers share one resolver call', async () => {
    const registry = new CredentialRegistry()
    const gate = deferred<CredentialVerdict>()
    const resolver = vi.fn(() => gate.promise)
    registry.registerResolver(KEY, resolver)

    const first = registry.resolve(KEY)
    const second = registry.resolve(KEY)
    gate.resolve({ kind: 'valid' })

    await expect(first).resolves.toMatchObject({ kind: 'valid' })
    await expect(second).resolves.toMatchObject({ kind: 'valid' })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  // #286 review P1: a resolve that started before a logout must not resurrect it.
  it('discards a resolver result that lands after a newer commit', async () => {
    const registry = new CredentialRegistry()
    const gate = deferred<CredentialVerdict>()
    registry.registerResolver(KEY, () => gate.promise)

    const resolving = registry.resolve(KEY)
    registry.commit(KEY, { kind: 'missing' })
    gate.resolve({ kind: 'valid' })

    await expect(resolving).resolves.toMatchObject({ kind: 'missing' })
    expect(registry.getState(KEY).kind).toBe('missing')
  })

  it('discards a resolver failure that lands after a newer commit', async () => {
    const registry = new CredentialRegistry()
    const gate = deferred<CredentialVerdict>()
    registry.registerResolver(KEY, () => gate.promise)

    const resolving = registry.resolve(KEY)
    registry.commit(KEY, { kind: 'valid' })
    gate.reject(new Error('late failure'))

    await expect(resolving).resolves.toMatchObject({ kind: 'valid' })
    expect(registry.getState(KEY).kind).toBe('valid')
  })

  // #286 review P1: the caller's deadline must not free the single-flight slot.
  it('does not start a second resolver after the caller timed out', async () => {
    const registry = new CredentialRegistry(10)
    const gate = deferred<CredentialVerdict>()
    const resolver = vi.fn(() => gate.promise)
    registry.registerResolver(KEY, resolver)

    await registry.resolve(KEY)
    await registry.resolve(KEY)
    expect(resolver).toHaveBeenCalledTimes(1)

    gate.resolve({ kind: 'valid' })
  })

  // #286 review P2: a forced refresh must not be satisfied by a plain attempt.
  it('runs a refreshing attempt after the plain one when refresh is requested', async () => {
    const registry = new CredentialRegistry()
    const first = deferred<CredentialVerdict>()
    const calls: boolean[] = []
    registry.registerResolver(KEY, async ({ refresh }) => {
      calls.push(refresh)
      return refresh ? { kind: 'valid' } : first.promise
    })

    const plain = registry.resolve(KEY)
    const forced = registry.resolve(KEY, { refresh: true })
    first.resolve({ kind: 'expired' })

    await expect(plain).resolves.toMatchObject({ kind: 'expired' })
    await expect(forced).resolves.toMatchObject({ kind: 'valid' })
    expect(calls).toEqual([false, true])
  })

  it('joins an in-flight refreshing attempt instead of starting another', async () => {
    const registry = new CredentialRegistry()
    const gate = deferred<CredentialVerdict>()
    const calls: boolean[] = []
    registry.registerResolver(KEY, async ({ refresh }) => {
      calls.push(refresh)
      return gate.promise
    })

    const first = registry.resolve(KEY, { refresh: true })
    const second = registry.resolve(KEY, { refresh: true })
    gate.resolve({ kind: 'valid' })

    await expect(first).resolves.toMatchObject({ kind: 'valid' })
    await expect(second).resolves.toMatchObject({ kind: 'valid' })
    expect(calls).toEqual([true])
  })

  it('turns a resolver failure into a temporary verdict', async () => {
    const registry = new CredentialRegistry()
    const error = new Error('store unavailable')
    registry.registerResolver(KEY, async () => {
      throw error
    })

    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'temporary', error })
    expect(registry.getState(KEY).kind).toBe('temporary')
  })

  // #286 review P2: a synchronous throw must not poison the slot.
  it('retries after a resolver that throws synchronously', async () => {
    const registry = new CredentialRegistry()
    const resolver = vi
      .fn<() => Promise<CredentialVerdict>>()
      .mockImplementationOnce(() => {
        throw new Error('sync boom')
      })
      .mockResolvedValueOnce({ kind: 'valid' })
    registry.registerResolver(KEY, resolver)

    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'temporary' })
    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'valid' })
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('publishes the timeout to subscribers as a stale verdict', async () => {
    const registry = new CredentialRegistry(10)
    registry.commit(KEY, { kind: 'valid' })
    registry.registerResolver(KEY, () => new Promise<CredentialVerdict>(() => {}))
    const seen: Array<{ kind: string; stale?: boolean }> = []
    registry.subscribe(KEY, (state) => seen.push({ kind: state.kind, stale: state.stale }))

    const state = await registry.resolve(KEY)

    expect(state.kind).toBe('valid')
    expect(state.stale).toBe(true)
    // The registry itself learns about it, not just the caller: a subscribed UI
    // must be able to show "checking again" instead of a confident stale answer.
    expect(registry.getState(KEY).stale).toBe(true)
    expect(seen.at(-1)).toEqual({ kind: 'valid', stale: true })
  })

  it('answers a timeout with temporary when nothing was ever known', async () => {
    const registry = new CredentialRegistry(10)
    registry.registerResolver(KEY, () => new Promise<CredentialVerdict>(() => {}))

    const state = await registry.resolve(KEY)

    expect(state.kind).toBe('temporary')
    expect(registry.getState(KEY).kind).toBe('temporary')
  })

  it('does not invent a verdict when no resolver is registered', async () => {
    const registry = new CredentialRegistry()
    await expect(registry.resolve('nobody')).resolves.toMatchObject({ kind: 'unknown' })
    expect(registry.hasResolver('nobody')).toBe(false)
  })

  it('leaves the answer to the owner when a resolver is registered later', async () => {
    const registry = new CredentialRegistry()
    expect(registry.getState(KEY).kind).toBe('unknown')
    registry.registerResolver(KEY, async () => ({ kind: 'valid' }))
    // Registration alone does not resolve; the provider calls resolve() after
    // registering, which is the only place that knows a credential may exist.
    expect(registry.getState(KEY).kind).toBe('unknown')
    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'valid' })
  })

  it('keeps one broken listener from blocking the others', () => {
    const registry = new CredentialRegistry()
    const good = vi.fn()
    registry.subscribe(KEY, () => {
      throw new Error('boom')
    })
    registry.subscribe(KEY, good)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registry.commit(KEY, { kind: 'missing' })

    expect(good).toHaveBeenCalledWith(expect.objectContaining({ kind: 'missing' }))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('stops notifying after unsubscribe', () => {
    const registry = new CredentialRegistry()
    const listener = vi.fn()
    const off = registry.subscribe(KEY, listener)
    off()
    registry.commit(KEY, { kind: 'valid' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('CredentialRegistry — bounded waits and recovery (#286 review round 2)', () => {
  // P1: a forced refresh must not queue forever behind an attempt that never settles.
  it('bounds the wait for a plain attempt when a refresh is requested', async () => {
    const registry = new CredentialRegistry(10, 60_000)
    const hung = deferred<CredentialVerdict>()
    const calls: boolean[] = []
    registry.registerResolver(KEY, async ({ refresh }) => {
      calls.push(refresh)
      return hung.promise
    })

    const plain = registry.resolve(KEY)
    const forced = registry.resolve(KEY, { refresh: true })

    await expect(forced).resolves.toMatchObject({ kind: 'temporary' })
    expect(calls).toEqual([false])
    hung.resolve({ kind: 'valid' })
    await plain
  })

  // P1: a resolver that never settles must not block every later call forever.
  it('abandons an attempt that outlives the abandon horizon and retries', async () => {
    const registry = new CredentialRegistry(10, 20)
    const hung = deferred<CredentialVerdict>()
    const resolver = vi
      .fn<() => Promise<CredentialVerdict>>()
      .mockReturnValueOnce(hung.promise)
      .mockResolvedValueOnce({ kind: 'valid' })
    registry.registerResolver(KEY, resolver)

    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'temporary' })
    await new Promise((resolve) => setTimeout(resolve, 30))

    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'valid' })
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  // P2: a fresh read must not look stale because ANOTHER key committed.
  it('reports a fresh read as current even after another provider commits', () => {
    const registry = new CredentialRegistry()
    const state = registry.commit(KEY, { kind: 'valid' })
    expect(registry.isCurrent(state.epoch)).toBe(true)

    registry.commit('anthropic', { kind: 'valid' })
    expect(registry.isCurrent(state.epoch)).toBe(false)

    // Re-reading must recover: the epoch it carries is the registry's current one.
    const reread = registry.getState(KEY)
    expect(registry.isCurrent(reread.epoch)).toBe(true)
  })

  // P2: an old timeout must not stamp a newer login as stale.
  it('does not mark a verdict stale when a newer commit landed during the wait', async () => {
    const registry = new CredentialRegistry(10)
    const hung = deferred<CredentialVerdict>()
    registry.registerResolver(KEY, () => hung.promise)

    const resolving = registry.resolve(KEY)
    registry.commit(KEY, { kind: 'valid' })

    const state = await resolving
    expect(state.kind).toBe('valid')
    expect(state.stale).toBeUndefined()
  })
})
