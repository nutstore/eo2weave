import { describe, expect, it } from 'vitest'
import { migrations } from './index'

/**
 * Envelopes are the one journal field that was stored verbatim and never needed:
 * 321 of 324 commits across a real install carried 41.9 MB of identical text.
 * The migration must stay pure SQL — no prepare/bind round trip per row — and it
 * must reshape the JSON in place rather than dropping the commit.
 */
describe('strip_context_commit_envelopes', () => {
  const migration = migrations.find((entry) => entry.version === 25)

  it('is registered as a SQL migration', () => {
    expect(migration?.name).toBe('strip_context_commit_envelopes')
    expect(typeof migration?.up).toBe('string')
  })

  it('removes only the envelope and raises the version', () => {
    const sql = String(migration?.up)
    expect(sql).toContain("json_remove(meta_json, '$.contextCommit.envelope')")
    expect(sql).toContain('PRAGMA user_version = 25')
    // Nothing else about the commit may change: foldJournal replays `changes`.
    expect(sql).not.toContain('contextCommit.changes')
    expect(sql).not.toContain('DELETE')
  })
})
