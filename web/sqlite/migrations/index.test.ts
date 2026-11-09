import { describe, expect, it } from 'vitest'
import { BASE_SCHEMA_VERSION, initializeSchema } from './index'

class SchemaDatabase {
  statements: string[] = []
  /** When true, simulated ALTER TABLE repairs never register the column. */
  blockFsOpsRepair = false
  private missingConversationColumns: Set<string>
  private missingProjectRootColumns: Set<string>
  private missingFsOpsColumns: Set<string>

  constructor(
    public userVersion = 0,
    missingConversationColumns: string[] = [],
    missingProjectRootColumns: string[] = [],
    missingFsOpsColumns: string[] = [],
  ) {
    this.missingConversationColumns = new Set(missingConversationColumns)
    this.missingProjectRootColumns = new Set(missingProjectRootColumns)
    this.missingFsOpsColumns = new Set(missingFsOpsColumns)
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

    const addedColumn = sql.match(/ALTER TABLE conversations ADD COLUMN (compressed_context_\w+)/)
    if (addedColumn) {
      this.missingConversationColumns.delete(addedColumn[1])
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

  it('runs the v18 fs_ops migration when upgrading a v17 database', async () => {
    const db = new SchemaDatabase(17, [], [], ['delete_mode'])

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE fs_ops ADD COLUMN delete_mode')
    )
  })

  it('repairs the fs_ops delete_mode column when a v18 database is missing physical DDL', async () => {
    const db = new SchemaDatabase(18, [], [], ['delete_mode'])

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('ALTER TABLE fs_ops ADD COLUMN delete_mode')
    )
  })

  it('rejects a database whose declared schema still lacks the fs_ops delete_mode column', async () => {
    const db = new SchemaDatabase(18, [], [], ['delete_mode'])
    // Simulate an unfixable database: even the repair ALTER cannot add the column.
    db.blockFsOpsRepair = true

    await expect(initializeSchema(db)).rejects.toThrow('SCHEMA_INCOMPATIBLE')
  })

  it('upgrades a v18 database with managed MCP tasks and resets legacy sessions', async () => {
    const db = new SchemaDatabase(18)

    await initializeSchema(db)

    expect(db.userVersion).toBe(BASE_SCHEMA_VERSION)
    expect(db.statements).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS mcp_tasks')
    )
    expect(db.statements).toContainEqual(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS mcp_task_inputs')
    )
    expect(db.statements).toContain("ALTER TABLE mcp_servers ADD COLUMN protocol_mode TEXT NOT NULL DEFAULT 'auto'")
    expect(db.statements).toContain("UPDATE mcp_servers SET transport = 'streamable_http' WHERE transport = 'sse'")
    expect(db.statements).toContain('UPDATE mcp_servers SET session_id = NULL')
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
