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
})
