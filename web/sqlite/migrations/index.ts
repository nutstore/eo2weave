/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite Migration System
 *
 * Manages incremental database schema migrations using version tracking.
 *
 * Migration file format:
 * - Named with version prefix: 002_add_feature.sql
 * - Each migration must be idempotent (safe to run multiple times)
 * - After execution, PRAGMA user_version is updated
 *
 * Version is defined in sqlite-schema.sql via PRAGMA user_version.
 * Incremental migrations start from the next schema version.
 */

import schemaSQL from '../sqlite-schema.sql?raw'

// Progress callback type
export type MigrationProgressCallback = (progress: {
  step: string
  details: string
  current: number
  total: number
}) => void

export interface Migration {
  version: number
  name: string
  up: string | ((db: any) => void | Promise<void>)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Treat known idempotent DDL conflicts as recoverable.
 * Example: column already exists because a previous run partially applied DDL
 * before user_version was updated.
 */
function canRecoverMigrationError(migration: Migration, error: unknown): boolean {
  if (typeof migration.up !== 'string') return false
  const msg = getErrorMessage(error).toLowerCase()
  if (msg.includes('duplicate column name')) return true
  // Keep this scoped to schema-upgrade style migrations only.
  return migration.up.toLowerCase().includes('add column') && msg.includes('already exists')
}

function conversationColumnExists(db: any, column: string): boolean {
  try {
    db.exec(`SELECT ${column} FROM conversations LIMIT 0`)
    return true
  } catch {
    return false
  }
}

function repairConversationCompressionColumns(db: any): void {
  const requiredColumns = [
    ['compressed_context_summary', 'TEXT'],
    ['compressed_context_cutoff_ts', 'INTEGER'],
  ] as const

  for (const [column, type] of requiredColumns) {
    if (!conversationColumnExists(db, column)) {
      db.exec(`ALTER TABLE conversations ADD COLUMN ${column} ${type}`)
    }
  }

  bumpUserVersionFloor(db, 15)
}

/**
 * Synchronous read of PRAGMA user_version (the async getCurrentVersion helper
 * is unavailable inside the synchronous repair functions).
 */
function readUserVersion(db: any): number {
  try {
    const result = db.exec('PRAGMA user_version')
    const versionFromValues = result?.[0]?.values?.[0]?.[0]
    if (typeof versionFromValues === 'number') return versionFromValues

    const versionFromArray = result?.[0]?.[0]
    if (typeof versionFromArray === 'number') return versionFromArray
  } catch {
    // Treat unreadable version as 0 so repair functions still raise the floor.
  }
  return 0
}

/**
 * Raise PRAGMA user_version to `version` without ever downgrading it.
 *
 * Repair helpers run on every startup — including fresh databases whose base
 * schema already carries a higher version. An unconditional write would
 * regress those databases (e.g. 18 → 17), causing the next launch to re-run a
 * migration whose DDL is already present and log a recoverable
 * "duplicate column name" conflict on every startup.
 */
function bumpUserVersionFloor(db: any, version: number): void {
  if (readUserVersion(db) < version) {
    db.exec(`PRAGMA user_version = ${version}`)
  }
}

/**
 * Guard against databases whose user_version claims an upgrade completed while
 * required conversation columns are absent. This has happened when a base
 * schema version was raised without mirroring an earlier ALTER TABLE.
 */
function verifyConversationSchema(db: any): void {
  try {
    db.exec(
      'SELECT compressed_context_summary, compressed_context_cutoff_ts FROM conversations LIMIT 0'
    )
  } catch (error) {
    throw new Error(
      `SCHEMA_INCOMPATIBLE: conversations is missing required compression columns. ${getErrorMessage(error)}`
    )
  }
}

function projectRootColumnExists(db: any, column: string): boolean {
  try {
    db.exec(`SELECT ${column} FROM project_roots LIMIT 0`)
    return true
  } catch {
    return false
  }
}

/** Repair v16 roots if a database recorded the version before its DDL landed. */
function repairProjectRootBackendColumns(db: any): void {
  if (!projectRootColumnExists(db, 'backend')) {
    db.exec("ALTER TABLE project_roots ADD COLUMN backend TEXT NOT NULL DEFAULT 'fsaccess'")
  }
  if (!projectRootColumnExists(db, 'scope_id')) {
    db.exec('ALTER TABLE project_roots ADD COLUMN scope_id TEXT')
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_roots_project_scope
      ON project_roots(project_id, scope_id) WHERE scope_id IS NOT NULL`
  )
  bumpUserVersionFloor(db, 17)
}

function verifyProjectRootSchema(db: any): void {
  try {
    db.exec('SELECT backend, scope_id FROM project_roots LIMIT 0')
  } catch (error) {
    throw new Error(
      `SCHEMA_INCOMPATIBLE: project_roots is missing backend identity columns. ${getErrorMessage(error)}`
    )
  }
}


function fsOpsColumnExists(db: any, column: string): boolean {
  try {
    db.exec(`SELECT ${column} FROM fs_ops LIMIT 0`)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the physical fs_ops.delete_mode column exists.
 *
 * Runs unconditionally after pending migrations (and inside the v18 migration)
 * so a database whose user_version raced ahead of its DDL gets the column
 * created regardless of which version it reports.
 */
function repairFsOpsDeleteModeColumn(db: any): void {
  if (!fsOpsColumnExists(db, 'delete_mode')) {
    db.exec('ALTER TABLE fs_ops ADD COLUMN delete_mode TEXT')
  }
  bumpUserVersionFloor(db, 18)
}

function verifyFsOpsDeleteModeSchema(db: any): void {
  try {
    db.exec('SELECT delete_mode FROM fs_ops LIMIT 0')
  } catch (error) {
    throw new Error(
      `SCHEMA_INCOMPATIBLE: fs_ops is missing the delete_mode column. ${getErrorMessage(error)}`
    )
  }
}

function conversationKindColumnExists(db: any, column: string): boolean {
  try {
    db.exec(`SELECT ${column} FROM conversations LIMIT 0`)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the physical conversations.kind column exists.
 *
 * Runs unconditionally after pending migrations (and inside the v19 migration)
 * so a database whose user_version raced ahead of its DDL gets the column
 * created regardless of which version it reports. Existing rows default to
 * 'project' — the NOT NULL DEFAULT carries that with zero data migration.
 */
function repairConversationKindColumn(db: any): void {
  if (!conversationKindColumnExists(db, 'kind')) {
    db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'project'")
  }
  bumpUserVersionFloor(db, 19)
}

function verifyConversationKindSchema(db: any): void {
  try {
    db.exec('SELECT kind FROM conversations LIMIT 0')
  } catch (error) {
    throw new Error(
      `SCHEMA_INCOMPATIBLE: conversations is missing the kind column. ${getErrorMessage(error)}`
    )
  }
}

// Base schema version
export const BASE_SCHEMA_VERSION = 19

// ============================================================================
// Migration Registry
// ============================================================================
// Add new migrations here. Each migration should:
// 1. Be idempotent (use IF NOT EXISTS, OR IGNORE, etc.)
// 2. Include PRAGMA user_version = X at the end
// 3. Be atomic (can be rolled back on error)
// ============================================================================

export const migrations: Migration[] = [
  {
    version: 4,
    name: 'add_custom_workflows_table',
    up: `
      CREATE TABLE IF NOT EXISTS custom_workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          domain TEXT NOT NULL DEFAULT 'custom',
          entry_node_id TEXT,
          nodes_json TEXT NOT NULL DEFAULT '[]',
          edges_json TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL DEFAULT 'user-created',
          version INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_custom_workflows_domain ON custom_workflows(domain);
      CREATE INDEX IF NOT EXISTS idx_custom_workflows_source ON custom_workflows(source);
      CREATE INDEX IF NOT EXISTS idx_custom_workflows_enabled ON custom_workflows(enabled);
      CREATE INDEX IF NOT EXISTS idx_custom_workflows_updated_at ON custom_workflows(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_custom_workflows_name_lower ON custom_workflows(lower(name));

      PRAGMA user_version = 4;
    `,
  },
  {
    version: 5,
    name: 'extract_messages_to_independent_table',
    up: `
      CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content_json TEXT NOT NULL DEFAULT 'null',
          meta_json TEXT,
          timestamp INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);

      PRAGMA user_version = 5;
    `,
  },
  {
    version: 6,
    name: 'add_project_roots_table',
    up: `
      CREATE TABLE IF NOT EXISTS project_roots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0,
          read_only INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
          UNIQUE(project_id, name),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_project_roots_project_id ON project_roots(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_roots_project_default ON project_roots(project_id, is_default);

      PRAGMA user_version = 6;
    `,
  },
  {
    version: 7,
    name: 'add_project_active_workspace_table',
    up: `
      CREATE TABLE IF NOT EXISTS project_active_workspace (
          project_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          last_modified INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );

      PRAGMA user_version = 7;
    `,
  },
  {
    version: 8,
    name: 'add_compression_baseline_to_conversations',
    up: `
      ALTER TABLE conversations ADD COLUMN compressed_context_summary TEXT;
      ALTER TABLE conversations ADD COLUMN compressed_context_cutoff_ts INTEGER;

      PRAGMA user_version = 8;
    `,
  },
  {
    version: 9,
    name: 'drop_active_singleton_tables',
    up: `
      -- PR-B: active project/workspace must be derived from the URL route,
      -- never persisted in a shared singleton table. Drop the legacy tables,
      -- triggers, and view that previously stored this global pointer.
      -- (A shared OPFS SQLite file is visible to ALL browser tabs, so a
      -- singleton "active" row caused cross-tab pollution on refresh.)
      DROP VIEW IF EXISTS v_active_workspace;
      DROP TRIGGER IF EXISTS active_workspace_singleton;
      DROP TRIGGER IF EXISTS active_project_singleton;
      DROP TABLE IF EXISTS project_active_workspace;
      DROP TABLE IF EXISTS active_workspace;
      DROP TABLE IF EXISTS active_project;

      PRAGMA user_version = 9;
    `,
  },
  {
    version: 10,
    name: 'add_subagent_type_to_subagent_tasks',
    up: `
      ALTER TABLE subagent_tasks
        ADD COLUMN subagent_type TEXT NOT NULL DEFAULT 'general-purpose';

      PRAGMA user_version = 10;
    `,
  },
  {
    version: 11,
    name: 'add_parent_tool_call_id_to_subagent_tasks',
    up: `
      ALTER TABLE subagent_tasks
        ADD COLUMN parent_tool_call_id TEXT;

      PRAGMA user_version = 11;
    `,
  },
  {
    version: 12,
    name: 'create_app_settings_table',
    up: `
      -- Generic key/value store for scalar app-level settings not tied to a
      -- specific project or workspace (e.g. snapshot.high_watermark).
      -- Values are JSON-encoded strings.
      CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
      );

      PRAGMA user_version = 12;
    `,
  },
  {
    version: 13,
    name: 'drop_custom_workflows_table',
    up: `
      -- Drop the legacy custom_workflows table.
      -- The old workflow system (LLM role-based pipelines) has been removed
      -- and will be replaced by a new visual canvas workflow system.
      DROP TABLE IF EXISTS custom_workflows;

      PRAGMA user_version = 13;
    `,
  },
  {
    version: 14,
    name: 'release_flow_and_snapshot_schema',
    up: `
      -- All schema additions introduced by the v14 production release are
      -- grouped here because production's latest released schema is v13.
      CREATE TABLE IF NOT EXISTS flow_templates (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          nodes_json TEXT NOT NULL DEFAULT '[]',
          edges_json TEXT NOT NULL DEFAULT '[]',
          entry_node_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 's') * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_flow_templates_project ON flow_templates(project_id);
      CREATE INDEX IF NOT EXISTS idx_flow_templates_updated ON flow_templates(updated_at DESC);

      ALTER TABLE fs_changesets ADD COLUMN run_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_fs_changesets_workspace_run
        ON fs_changesets(workspace_id, run_id);

      ALTER TABLE conversations ADD COLUMN flow_instance_json TEXT;
      PRAGMA user_version = 14;
    `,
  },
  {
    version: 15,
    name: 'repair_conversation_compression_columns',
    up: repairConversationCompressionColumns,
  },
  {
    version: 16,
    name: 'add_project_root_backend_identity',
    up: `
      ALTER TABLE project_roots
        ADD COLUMN backend TEXT NOT NULL DEFAULT 'fsaccess';
      ALTER TABLE project_roots
        ADD COLUMN scope_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_roots_project_scope
        ON project_roots(project_id, scope_id)
        WHERE scope_id IS NOT NULL;

      PRAGMA user_version = 16;
    `,
  },
  {
    version: 17,
    name: 'repair_project_root_backend_identity',
    up: repairProjectRootBackendColumns,
  },
  {
    version: 18,
    name: 'add_fs_ops_delete_mode',
    up: repairFsOpsDeleteModeColumn,
  },
  {
    version: 19,
    name: 'add_conversations_kind',
    up: repairConversationKindColumn,
  },
]

// ============================================================================
// Migration Executor
// ============================================================================

/**
 * Get current database version from PRAGMA user_version
 */
export async function getCurrentVersion(db: any): Promise<number> {
  try {
    const result = db.exec('PRAGMA user_version')
    // sqlite-wasm result shape may vary by build:
    // - [{ columns, values }]
    // - [[version]]
    const versionFromValues = result?.[0]?.values?.[0]?.[0]
    if (typeof versionFromValues === 'number') return versionFromValues

    const versionFromArray = result?.[0]?.[0]
    if (typeof versionFromArray === 'number') return versionFromArray

    // Fallback: use prepared statement API.
    const stmt = db.prepare('PRAGMA user_version')
    try {
      if (stmt.step()) {
        const row = stmt.get({}) as { user_version?: number }
        if (typeof row?.user_version === 'number') return row.user_version
      }
    } finally {
      stmt.finalize()
    }

    return 0
  } catch {
    return 0
  }
}

/**
 * Execute pending migrations with progress reporting
 * Returns the number of migrations executed
 */
export async function runPendingMigrations(
  db: any,
  onProgress?: MigrationProgressCallback
): Promise<{ executed: number; finalVersion: number }> {
  const currentVersion = await getCurrentVersion(db)

  // Filter migrations that need to run
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion)

  if (pendingMigrations.length === 0) {
    return { executed: 0, finalVersion: currentVersion }
  }

  console.log(
    `[SQLite Migration] Current version: ${currentVersion}, Pending migrations: ${pendingMigrations.length}`
  )

  // Report initial progress
  onProgress?.({
    step: 'migration',
    details: `Database upgrade (${currentVersion} → ${pendingMigrations[pendingMigrations.length - 1].version})`,
    current: 0,
    total: pendingMigrations.length,
  })

  let executed = 0
  for (const migration of pendingMigrations) {
    try {
      console.log(`[SQLite Migration] Running v${migration.version}: ${migration.name}`)

      // Report progress for each migration
      onProgress?.({
        step: 'migration',
        details: `Running migration v${migration.version}: ${migration.name}`,
        current: executed + 1,
        total: pendingMigrations.length,
      })

      if (typeof migration.up === 'function') {
        await migration.up(db)
      } else {
        await db.exec(migration.up)
      }
      executed++

      // Verify version was updated
      const newVersion = await getCurrentVersion(db)
      if (newVersion !== migration.version) {
        throw new Error(
          `Migration v${migration.version} did not update user_version correctly (got ${newVersion})`
        )
      }
      console.log(`[SQLite Migration] Completed v${migration.version}`)
    } catch (error) {
      if (canRecoverMigrationError(migration, error)) {
        console.warn(
          `[SQLite Migration] Recoverable migration conflict in v${migration.version}, forcing version update:`,
          error
        )
        await db.exec(`PRAGMA user_version = ${migration.version}`)
        executed++
        continue
      }
      console.error(`[SQLite Migration] Failed v${migration.version}:`, error)
      onProgress?.({
        step: 'error',
        details: `Migration failed: v${migration.version} - ${error}`,
        current: executed,
        total: pendingMigrations.length,
      })
      throw new Error(`Migration v${migration.version} failed: ${error}`)
    }
  }

  const finalVersion = await getCurrentVersion(db)

  // Report completion
  onProgress?.({
    step: 'migration',
    details: `Database upgrade complete (v${finalVersion})`,
    current: pendingMigrations.length,
    total: pendingMigrations.length,
  })

  console.log(`[SQLite Migration] All migrations complete. Final version: ${finalVersion}`)

  return { executed, finalVersion }
}

/**
 * Initialize database with base schema and run migrations
 * This is called during database initialization
 */
export async function initializeSchema(
  db: any,
  onProgress?: MigrationProgressCallback
): Promise<void> {
  const existingVersion = await getCurrentVersion(db)

  // Report schema initialization start
  onProgress?.({
    step: 'init',
    details: 'Initializing database schema...',
    current: 0,
    total: 1,
  })

  // Execute base schema (CREATE TABLE IF NOT EXISTS)
  // This is safe to run on existing databases
  db.exec(schemaSQL)

  // The base schema's PRAGMA describes fresh databases. On an existing
  // database, restore its prior version so missing incremental DDL still runs.
  // CREATE TABLE IF NOT EXISTS cannot add columns to that existing table.
  if (existingVersion > 0) {
    db.exec(`PRAGMA user_version = ${existingVersion}`)
  }

  // Run any pending migrations
  await runPendingMigrations(db, onProgress)

  // A database can report v17 if a prior build wrote user_version before the
  // v16/v17 DDL completed. Repair physical root columns after pending migration
  // scheduling so this remains safe even when there is no newer version to run.
  repairProjectRootBackendColumns(db)

  // Same guard for the v18 fs_ops.delete_mode column: a database can report a
  // version >= 18 while the physical column is absent (DDL raced user_version),
  // so repair it on every startup before verifying.
  repairFsOpsDeleteModeColumn(db)

  // Same guard for the v19 conversations.kind column.
  repairConversationKindColumn(db)

  // Version numbers alone are not enough: validate the physical columns after
  // migration so the app fails safely with an exportable database instead of
  // later rendering an empty conversation list.
  verifyConversationSchema(db)
  verifyProjectRootSchema(db)
  verifyFsOpsDeleteModeSchema(db)
  verifyConversationKindSchema(db)

  // Report completion
  onProgress?.({
    step: 'complete',
    details: 'Database ready',
    current: 1,
    total: 1,
  })
}
