import { describe, expect, it } from 'vitest'
import { collectContextSources, foldContext, reconcileContext, type ContextObservation } from '@/agent/context/journal'
import type { Message } from '@/agent/message-types'

const skills = (count: number): ContextObservation[] => [{
  sourceId: 'skills', entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [`skill-${i}`, `Description ${i}`])),
}]
const commit = (history: Message[], observations = skills(12), reset = false) => {
  const message = reconcileContext(history, observations, 'envelope', reset)
  if (message) history.push(message)
  return message
}

describe('context journal', () => {
  it('sends only additions and removals for the 12 → 100 → 12 published sequence', () => {
    const history: Message[] = []
    const baseline = commit(history)!
    const original = JSON.stringify(baseline)
    const added = commit(history, skills(100))!
    expect(Object.keys(added.contextCommit!.changes[0].added)).toHaveLength(88)
    expect(added.contextCommit!.changes[0].snapshot).toBeUndefined()
    const removed = commit(history)!
    expect(removed.contextCommit!.changes[0].removed).toHaveLength(88)
    expect(removed.content).not.toContain('Description')
    expect(JSON.stringify(baseline)).toBe(original)
    expect(foldContext(history).get('skills')!.entries).toEqual(skills(12)[0].entries)
  })

  it('does not publish an unobserved intermediate state or repeat the original catalog', () => {
    const history: Message[] = []
    commit(history)
    // Environment changes are collected only at admission: 100 was never committed.
    expect(commit(history, skills(12))).toBeUndefined()
    expect(history).toHaveLength(1)
  })

  it('ignores collection order and changes only modified entries', () => {
    const history: Message[] = []
    commit(history)
    const reversed = Object.fromEntries(Object.entries(skills(12)[0].entries).reverse())
    expect(commit(history, [{ sourceId: 'skills', entries: reversed }])).toBeUndefined()
    reversed['skill-4'] = 'New description'
    const changed = commit(history, [{ sourceId: 'skills', entries: reversed }])!
    expect(changed.contextCommit!.changes[0].updated).toEqual({ 'skill-4': 'New description' })
    expect(changed.contextCommit!.changes[0].added).toEqual({})
  })

  it('distinguishes authoritative empty state from unavailable sources', async () => {
    const history: Message[] = []
    commit(history)
    const unavailable = await collectContextSources([{ id: 'skills', collect: () => undefined }])
    expect(commit(history, unavailable)).toBeUndefined()
    const cleared = commit(history, [{ sourceId: 'skills', entries: {} }])!
    expect(cleared.contextCommit!.changes[0].removed).toHaveLength(12)
    expect(commit(history, [{ sourceId: 'skills', entries: {} }])).toBeUndefined()
  })

  it('restores a serialized journal and compares against the most recent committed state', () => {
    const history: Message[] = []
    commit(history)
    commit(history, skills(100))
    const restored = JSON.parse(JSON.stringify(history)) as Message[]
    expect(commit(restored, skills(100))).toBeUndefined()
    expect(commit(restored)!.contextCommit!.changes[0].removed).toHaveLength(88)
  })

  it('rebases every known source after compaction, even when collection is unavailable', () => {
    const history: Message[] = []
    commit(history)
    commit(history, [{ sourceId: 'workspace', entries: { root: '/project' } }])
    const baseline = commit(history, [], true)!
    expect(baseline.contextCommit!.epoch).not.toBe(history[0].contextCommit!.epoch)
    expect(baseline.contextCommit!.changes.every(change => change.snapshot !== undefined)).toBe(true)
    expect(foldContext([baseline])).toEqual(foldContext(history))
    expect(commit(history)).toBeUndefined()
  })

  it('updates independent scalar and collection sources without repeating the others', () => {
    const history: Message[] = []
    commit(history, [...skills(12), { sourceId: 'date', entries: { value: '2026-10-13' } }])
    const next = commit(history, [...skills(12), { sourceId: 'date', entries: { value: '2026-10-14' } }])!
    expect(next.contextCommit!.changes.map(change => change.sourceId)).toEqual(['date'])
  })

  it('rejects broken patches rather than silently inventing a baseline', () => {
    const history: Message[] = []
    commit(history)
    const patch = commit(history, skills(100))!
    expect(() => foldContext([patch])).toThrow('Broken context baseline')
  })

  it('recovers with a new epoch when the baseline turn was deleted', () => {
    const history: Message[] = []
    commit(history)
    const patch = commit(history, skills(100))!
    const trimmed = [patch]
    const next = reconcileContext(trimmed, skills(100), 'envelope')!
    expect(next.contextCommit!.changes[0].snapshot).toBeDefined()
    expect(reconcileContext([...trimmed, next], skills(100), 'envelope')).toBeUndefined()
  })

  it('starts a new epoch for a changed request envelope', () => {
    const history: Message[] = []
    commit(history)
    const next = reconcileContext(history, skills(12), 'different tools')!
    expect(next.contextCommit!.epoch).not.toBe(history[0].contextCommit!.epoch)
    expect(next.contextCommit!.changes[0].snapshot).toEqual(skills(12)[0].entries)
  })

  it('rejects duplicate source registration', async () => {
    await expect(collectContextSources([
      { id: 'same', collect: () => ({}) }, { id: 'same', collect: () => ({}) },
    ])).rejects.toThrow('Duplicate context source')
  })
})
