import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import schema from '../sqlite-schema.sql?raw'
import { BASE_SCHEMA_VERSION, LATEST_SCHEMA_VERSION, initializeSchema } from './index'

let sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>
let db: InstanceType<typeof sqlite.oo1.DB>

beforeAll(async () => {
  sqlite = await sqlite3InitModule()
})

afterEach(() => {
  db?.close()
})

describe('sqlite-wasm schema initialization', () => {
  it.each([0, BASE_SCHEMA_VERSION])(
    'upgrades v%i through v23 and preserves the version on reload',
    async (version) => {
      db = new sqlite.oo1.DB(':memory:')
      if (version > 0) db.exec(schema)

      const progress = vi.fn()
      await initializeSchema(db, progress)

      expect(db.exec({ sql: 'PRAGMA user_version', returnValue: 'resultRows' })).toEqual([
        [LATEST_SCHEMA_VERSION],
      ])
      expect(progress.mock.calls.map(([event]) => event.details)).toContain(
        'Running migration v23: add_workflow_script_tables'
      )
      expect(() =>
        db.exec('SELECT prompt, options_key FROM workflow_agent_steps LIMIT 0')
      ).not.toThrow()

      progress.mockClear()
      await initializeSchema(db, progress)

      expect(db.exec({ sql: 'PRAGMA user_version', returnValue: 'resultRows' })).toEqual([
        [LATEST_SCHEMA_VERSION],
      ])
      expect(progress.mock.calls.map(([event]) => event.step)).not.toContain('migration')
    }
  )

  it('strips stored envelopes without tripping over a message row that is not JSON', async () => {
    db = new sqlite.oo1.DB(':memory:')
    db.exec(schema)
    db.exec('PRAGMA user_version = 24')
    db.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv', 'history', 1, 1)")
    db.exec(`
      INSERT INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at) VALUES
        ('with-envelope', 'conv', 'user', '"hi"', '{"contextCommit":{"envelope":"payload","digest":"d1"}}', 1, 1, 1),
        ('empty-meta', 'conv', 'user', '"hi"', '', 2, 2, 2),
        ('plain-text', 'conv', 'user', '"hi"', 'not json', 3, 3, 3)
    `)

    await initializeSchema(db)

    expect(db.exec({ sql: 'PRAGMA user_version', returnValue: 'resultRows' })).toEqual([
      [LATEST_SCHEMA_VERSION],
    ])
    // json_remove/json_extract throw `malformed JSON` on '' — the guard keeps the
    // migration from aborting startup on a row this codebase already tolerates.
    const rows = db.exec({
      sql: 'SELECT id, meta_json FROM messages ORDER BY seq',
      returnValue: 'resultRows',
      rowMode: 'object',
    })
    expect(rows).toEqual([
      { id: 'with-envelope', meta_json: '{"contextCommit":{"digest":"d1"}}' },
      { id: 'empty-meta', meta_json: '' },
      { id: 'plain-text', meta_json: 'not json' },
    ])
  })
})
