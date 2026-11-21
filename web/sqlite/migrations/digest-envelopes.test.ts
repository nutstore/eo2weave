import { describe, expect, it } from 'vitest'
import { digestContextCommitEnvelopes } from './index'
import { envelopeDigest } from '@/agent/context/envelope-digest'

/** Minimal stand-in for the sqlite-wasm handle used inside the worker. */
function fakeDb(rows: Array<[string, string]>) {
  const updated: Array<{ id: string; meta: string }> = []
  const statements: string[] = []
  return {
    updated,
    statements,
    exec(sql: string) {
      statements.push(sql)
      if (sql.trim().startsWith('SELECT')) return [{ values: rows }]
      return undefined
    },
    prepare(sql: string) {
      statements.push(sql)
      let bound: unknown[] = []
      return {
        bind: (params: unknown[]) => { bound = params },
        step: () => { updated.push({ meta: String(bound[0]), id: String(bound[1]) }); return true },
        reset: () => { bound = [] },
        finalize: () => {},
      }
    },
  }
}

describe('digest_context_commit_envelopes', () => {
  it('replaces a stored envelope with its digest and keeps everything else', () => {
    const meta = {
      kind: 'context_update',
      contextCommit: { version: 1, epoch: 'e1', sequence: 7, envelope: 'the whole prompt', changes: [{ sourceId: 'skills' }] },
    }
    const db = fakeDb([['m1', JSON.stringify(meta)]])

    digestContextCommitEnvelopes(db)

    expect(db.updated).toHaveLength(1)
    const next = JSON.parse(db.updated[0].meta)
    expect(next.kind).toBe('context_update')
    expect(next.contextCommit.envelope).toBeUndefined()
    expect(next.contextCommit.envelopeDigest).toBe(envelopeDigest('the whole prompt'))
    // A digest recorded here must match what the runtime computes for the same
    // envelope, or the next turn would rebase for no reason.
    expect(next.contextCommit.epoch).toBe('e1')
    expect(next.contextCommit.sequence).toBe(7)
    expect(next.contextCommit.changes).toEqual([{ sourceId: 'skills' }])
  })

  it('leaves rows alone when the payload is unreadable or already digested', () => {
    const already = { contextCommit: { version: 1, epoch: 'e2', sequence: 1, envelopeDigest: 'abc', changes: [] } }
    const db = fakeDb([
      ['broken', '{not json'],
      ['done', JSON.stringify(already)],
    ])

    digestContextCommitEnvelopes(db)

    expect(db.updated).toHaveLength(0)
  })

  it('raises the version floor even when there is nothing to compact', () => {
    const db = fakeDb([])

    digestContextCommitEnvelopes(db)

    expect(db.updated).toHaveLength(0)
    expect(db.statements).toContainEqual('PRAGMA user_version = 25')
  })
})
