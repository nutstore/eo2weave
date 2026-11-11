import { describe, expect, it, vi } from 'vitest'
import { CredentialRegistry, type CredentialVerdict } from '@/agent/providers/credential-state'

const KEY = 'openai'

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
    expect(registry.getState(KEY).kind).toBe('valid')
    expect(committed.epoch).toBeGreaterThan(before)
    expect(seen).toEqual(['valid'])
  })

  it('makes a cached verdict visibly stale after any commit', () => {
    const registry = new CredentialRegistry()
    const cached = registry.commit(KEY, { kind: 'valid' })
    expect(registry.isCurrent(KEY, cached.epoch)).toBe(true)

    registry.commit(KEY, { kind: 'expired' })

    // A consumer that kept `cached` must re-read: the epoch moved.
    expect(registry.isCurrent(KEY, cached.epoch)).toBe(false)
    expect(registry.getState(KEY).kind).toBe('expired')
  })

  it('resolves single-flight: concurrent callers share one resolver call', async () => {
    const registry = new CredentialRegistry()
    let resolveIt!: (verdict: CredentialVerdict) => void
    const resolver = vi.fn(() => new Promise<CredentialVerdict>((resolve) => { resolveIt = resolve }))
    registry.registerResolver(KEY, resolver)

    const first = registry.resolve(KEY)
    const second = registry.resolve(KEY)
    resolveIt({ kind: 'valid' })

    await expect(first).resolves.toMatchObject({ kind: 'valid' })
    await expect(second).resolves.toMatchObject({ kind: 'valid' })
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('turns a resolver failure into a temporary verdict', async () => {
    const registry = new CredentialRegistry()
    const error = new Error('store unavailable')
    registry.registerResolver(KEY, async () => { throw error })

    await expect(registry.resolve(KEY)).resolves.toMatchObject({ kind: 'temporary', error })
    expect(registry.getState(KEY).kind).toBe('temporary')
  })

  it('answers a timeout with the last known verdict, marked stale', async () => {
    const registry = new CredentialRegistry(10)
    registry.commit(KEY, { kind: 'valid' })
    registry.registerResolver(KEY, () => new Promise<CredentialVerdict>(() => {}))

    const state = await registry.resolve(KEY)

    // Neutral must be transient: the caller gets the last real answer, not a
    // promise that outlives the deadline.
    expect(state.kind).toBe('valid')
    expect(state.stale).toBe(true)
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
  })

  it('keeps one broken listener from blocking the others', () => {
    const registry = new CredentialRegistry()
    const good = vi.fn()
    registry.subscribe(KEY, () => { throw new Error('boom') })
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
