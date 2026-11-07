import { describe, expect, it } from 'vitest'
import { BASE_SCHEMA_VERSION, initializeSchema } from './index'

class SchemaDatabase {
  statements: string[] = []
  /** When true, simulated ALTER TABLE repairs never register the column. */
  blockFsOpsRepair = false
  /** When true, simulated kind ALTER TABLE never registers the column. */
  blockKindRepair = false
  private missingConversationColumns: Set<string>
  private missingProjectRootColumns: Set<string>
  private missingFsOpsColumns: Set<string>
  private missingKindColumn: boolean

  constructor(
    public userVersion = 0,
    missingConversationColumns: string[] = [],
    missingProjectRootColumns: string[] = [],
    missingFsOpsColumns: string[] = [],
    missingKindColumn = false,
  ) {
    this.missingConversationColumns = new Set(missingConversationColumns)
    this.missingProjectRootColumns = new Set(missingProjectRootColumns)
    this.missingFsOpsColumns = new Set(missingFsOpsColumns)
    this.missingKindColumn = missingKindColumn
  }

  exec(sql: string): Array<{ values: number[][] }> {
    if (sql.trim() === 'PRAGMA user_version') {
      return [{ values: [[this.userVersion]] }]
    }

    const selectedColumns = [...sql.matchAll(/compressed_context_\w+/g)].map((match) => match[0])
    const missingSelectedColumn = selectedColumns.find((column) =>
      this.missingConversationColumns.has(column)
    )
    if (sql.includes('FROM conversations LIMIT 0') && missingSelectedColumn) {
      throw new Error(`no such column: ${missingSelectedColumn}`)
    }

    const selectedProjectRootColumns = [...sql.matchAll(/\b(?:backend|scope_id)\b/g)]
      .map((match) => match[0])
    const missingProjectRootColumn = selectedProjectRootColumns.find((column) =>
      this.missingProjectRootColumns.has(column)
    )
    if (sql.includes('FROM project_roots LIMIT 0') && missingProjectRootColumn) {
      throw new Error(`no such column: ${missingProjectRootColumn}`)
    }

    const selectedFsOpsColumns = [...sql.matchAll(/\bdelete_mode\b/g)].map((match) => match[0])
    const missingFsOpsColumn = selectedFsOpsColumns.find((column) =>
      this.missingFsOpsColumns.has(column)
    )
    if (sql.includes('FROM fs_ops LIMIT 0') && missingFsOpsColumn) {
      throw new Error(`no such column: ${missingFsOpsColumn}`)
    }

    if (sql.includes('SELECT kind FROM conversations LIMIT 0') && this.missingKindColumn) {
      throw new Error('no such column: kind')
    }
    if (sql.includes('kind FROM conversations') && sql.includes('LIMIT 0') && !sql.includes('SELECT kind')) {
      // multi-column probes (verify) — treat any kind reference as a check
    }

    const addedColumn = sql.match(/ALTER TABLE conversations ADD COLUMN (compressed_context_\w+)/)
    if (addedColumn) {
      this.missingConversationColumns.delete(addedColumn[1])
    }
    if (/ALTER TABLE conversations ADD COLUMN kind/.test(sql) && !this.blockKindRepair) {
      this.missingKindColumn = false
    }
    const addedProjectRootColumn = sql.match(/ALTER TABLE project_roots\s+ADD COLUMN (backend|scope_id)/)
    if (addedProjectRootColumn) {
      this.missingProjectRootColumns.delete(addedProjectRootColumn[1])
    }
    const addedFsOpsColumn = sql.match(/ALTER TABLE fs_ops\s+ADD COLUMN (\w+)/)
    if (addedFsOpsColumn && !this.blockFsOpsRepair) {
      this.missingFsOpsColumns.delete(addedFsOpsColumn[1])
    }

    this.statements.push(sql)
    const versions = [...sql.matchAll(/PRAGMA user_version = (\d+)/g)]
    const latestVersion = versions.at(-1)?.[1]
    if (latestVersion) this.userVersion = Number(latestVersion)
    return []
  }
}

describe('initializeSchema', () => {
  it('does not rerun a migration already represented in the fresh schema', async () => {
    const db = new SchemaDatabase()

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements.some((sql) => sql.includes('ALTER TABLE subagent_tasks'))).toBe(false)
  })

  it('runs missing DDL when upgrading a v9 database', async () => {
    const db = new SchemaDatabase(9)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN subagent_type')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN parent_tool_call_id')
    )
  })

  it('applies the complete release upgrade in one v14 migration', async () => {
    const db = new SchemaDatabase(13)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS flow_templates')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN run_id')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN flow_instance_json')
    )
  })

  it('repairs missing compression columns when upgrading a v14 database', async () => {
    const db = new SchemaDatabase(14, [
      'compressed_context_summary',
      'compressed_context_cutoff_ts',
    ])

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN compressed_context_summary')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN compressed_context_cutoff_ts')
    )
  })

  it('rejects a database whose declared schema still lacks required conversation columns', async () => {
    const db = new SchemaDatabase(15, ['compressed_context_summary'])

    await expect(initializeSchema(db)).rejects.toThrow('SCHEMA_INCOMPATIBLE')
  })

  it('adds persisted backend identity to project roots when upgrading a v15 database', async () => {
    const db = new SchemaDatabase(15)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining("ADD COLUMN backend TEXT NOT NULL DEFAULT 'fsaccess'")
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ADD COLUMN scope_id TEXT')
    )
  })

  it('repairs project root columns when a v16 database is missing physical DDL', async () => {
    const db = new SchemaDatabase(16, [], ['backend', 'scope_id'])

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining("ALTER TABLE project_roots ADD COLUMN backend TEXT NOT NULL DEFAULT 'fsaccess'")
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE project_roots ADD COLUMN scope_id TEXT')
    )
  })

  it('repairs project root columns even when the database already reports v17', async () => {
    const db = new SchemaDatabase(17, [], ['backend', 'scope_id'])

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining("ALTER TABLE project_roots ADD COLUMN backend TEXT NOT NULL DEFAULT 'fsaccess'")
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE project_roots ADD COLUMN scope_id TEXT')
    )
  })

  it('runs the v18 fs_ops + v19 kind migrations when upgrading a v17 database', async () => {
    // A v17 database also lacks the v19 kind column.
    const db = new SchemaDatabase(17, [], [], ['delete_mode'], true)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE fs_ops ADD COLUMN delete_mode')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'")
    )
  })

  it('repairs the fs_ops delete_mode column when a v18 database is missing physical DDL', async () => {
    const db = new SchemaDatabase(18, [], [], ['delete_mode'])

    await initializeSchema(db)

    // v19 (kind) also runs — the final version is the current base.
    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE fs_ops ADD COLUMN delete_mode')
    )
  })

  it('repairs the conversations kind column when a v19 database is missing physical DDL', async () => {
    // user_version already 19 but the kind DDL never landed: the startup
    // repair (not the migration, which already ran) must add the column.
    const db = new SchemaDatabase(BASE_SCHEMA_VERSION, [], [], [], true)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'")
    )
  })

  it('rejects a database whose declared schema still lacks the conversations kind column', async () => {
    const db = new SchemaDatabase(BASE_SCHEMA_VERSION, [], [], [], true)
    // Simulate an unfixable database: even the repair ALTER cannot add the column.
    db.blockKindRepair = true

    await expect(initializeSchema(db)).rejects.toThrow('SCHEMA_INCOMPATIBLE')
  })

  it('rejects a database whose declared schema still lacks the fs_ops delete_mode column', async () => {
    const db = new SchemaDatabase(18, [], [], ['delete_mode'])
    // Simulate an unfixable database: even the repair ALTER cannot add the column.
    db.blockFsOpsRepair = true

    await expect(initializeSchema(db)).rejects.toThrow('SCHEMA_INCOMPATIBLE')
  })

  it('does not downgrade the version when repair functions run on a fresh database', async () => {
    const db = new SchemaDatabase()

    await initializeSchema(db)

    // Repairs raise the floor but never regress the base schema version.
    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements.filter((sql) => sql === 'PRAGMA user_version = 17')).toHaveLength(0)
    expect(db.statements.filter((sql) => sql === 'PRAGMA user_version = 18')).toHaveLength(0)
  })
})
