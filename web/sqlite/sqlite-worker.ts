/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite Worker - Runs SQLite in a worker thread with OPFS-backed SQLite
 *
 * opfs-sahpool advantages over opfs VFS:
 * - Memory-mapped storage for faster reads/writes (2-5x faster)
 * - Better recovery from stale handles after tab sleep
 * - No file-level xLock issues
 * - Multiple reader support
 *
 * Requires Atomics.wait() which is only available in workers.
 *
 * Note: SAH pool is currently disabled because it can cause cross-tab
 * visibility issues where tabs observe divergent project lists.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type { OpfsDatabase } from '@sqlite.org/sqlite-wasm'
import { initializeSchema } from '@/sqlite/migrations/index'
import { serializeMessageMetadata } from '@/sqlite/message-meta'

const DB_NAME = '/bfosa-unified.sqlite'
const SAHPOOL_NAME = 'bfosa-pool'
const ENABLE_OPFS_SAHPOOL = false

// Pool configuration: 1GB max, 4KB pages (same as SQLite default)
const POOL_CONFIG = {
  name: SAHPOOL_NAME,
  szPage: 4096,
  mxPages: 256 * 1024, // 1GB pool size
}

// SQL Logging - controlled via window.__enableSQLiteSQLLogging()
let enableSQLLogging = false

// Diagnostic tracking
let initCount = 0
let poolInitCount = 0

// Track if we've seen data before (to detect data loss)
let hasSeenData = false

// Worker message types
export type WorkerRequest =
  | { type: 'init'; schemaSQL?: string; id?: string; reportProgress?: boolean }
  | { type: 'queryAll'; sql: string; params: unknown[]; id: string }
  | { type: 'queryFirst'; sql: string; params: unknown[]; id: string }
  | { type: 'execute'; sql: string; params: unknown[]; id: string }
  | { type: 'beginTransaction'; id: string }
  | { type: 'commit'; id: string }
  | { type: 'rollback'; id: string }
  | { type: 'close'; id: string }
  | { type: 'getMode'; id: string }
  | { type: 'recover'; id: string }
  | { type: 'setSQLLogging'; enabled: boolean; id?: string }

// Worker response types (used for type safety in message handling)
export type WorkerResponse =
  | { type: 'init'; id: string; success: boolean; mode: 'opfs' | 'memory'; error?: string }
  | { type: 'queryAll'; id: string; rows: unknown[]; error?: string }
  | { type: 'queryFirst'; id: string; row: unknown | null; error?: string }
  | { type: 'execute'; id: string; error?: string }
  | { type: 'beginTransaction'; id: string; error?: string }
  | { type: 'commit'; id: string; error?: string }
  | { type: 'rollback'; id: string; error?: string }
  | { type: 'close'; id: string; error?: string }
  | { type: 'getMode'; id: string; mode: 'opfs' | 'memory'; error?: string }
  | { type: 'recover'; id: string; success: boolean; error?: string }
  | { type: 'setSQLLogging'; id: string; enabled: boolean; error?: string }
  | { type: 'migrationProgress'; step: string; details: string; current: number; total: number }

let sqlite3: any = null
let db: any = null
let dbMode: 'opfs' | 'memory' = 'memory'
let poolUtil: any = null // Store poolUtil for opfs-sahpool VFS

const EMPTY_DB_IGNORED_TABLES = new Set(['migrations', 'idb_migration_state'])

function quoteSQLiteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function getUserTableNames(dbHandle: any): string[] {
  const rows = dbHandle.exec({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    returnValue: 'resultRows',
    rowMode: 'object',
  }) as Array<{ name?: string }>
  return rows.map((row) => row.name).filter((name): name is string => !!name)
}

function getTableColumns(dbHandle: any, tableName: string): string[] {
  const columns: string[] = []
  const stmt = dbHandle.prepare(`PRAGMA table_info(${quoteSQLiteIdentifier(tableName)})`)
  try {
    while (stmt.step()) {
      const row = stmt.get({}) as { name?: string }
      if (row.name) columns.push(row.name)
    }
  } finally {
    stmt.finalize()
  }
  return columns
}

function tableRowCount(dbHandle: any, tableName: string): number {
  const stmt = dbHandle.prepare(`SELECT COUNT(*) AS count FROM ${quoteSQLiteIdentifier(tableName)}`)
  try {
    if (!stmt.step()) return 0
    const row = stmt.get({}) as { count?: number }
    return Number(row.count || 0)
  } finally {
    stmt.finalize()
  }
}

function hasMeaningfulData(dbHandle: any): boolean {
  const tables = getUserTableNames(dbHandle)
  for (const table of tables) {
    if (EMPTY_DB_IGNORED_TABLES.has(table)) continue
    if (tableRowCount(dbHandle, table) > 0) return true
  }
  return false
}

function copyTableRows(sourceDb: any, targetDb: any, tableName: string): number {
  const sourceColumns = getTableColumns(sourceDb, tableName)
  const targetColumns = new Set(getTableColumns(targetDb, tableName))
  const columns = sourceColumns.filter((column) => targetColumns.has(column))
  if (columns.length === 0) return 0

  const quotedTable = quoteSQLiteIdentifier(tableName)
  const columnList = columns.map((column) => quoteSQLiteIdentifier(column)).join(', ')
  const placeholders = columns.map((_, index) => `?${index + 1}`).join(', ')

  const selectStmt = sourceDb.prepare(`SELECT ${columnList} FROM ${quotedTable}`)
  const insertStmt = targetDb.prepare(`INSERT INTO ${quotedTable} (${columnList}) VALUES (${placeholders})`)

  let copied = 0
  try {
    while (selectStmt.step()) {
      const row = selectStmt.get({}) as Record<string, unknown>
      insertStmt.reset()
      for (let index = 0; index < columns.length; index++) {
        insertStmt.bind(index + 1, row[columns[index]])
      }
      insertStmt.step()
      copied++
    }
  } finally {
    selectStmt.finalize()
    insertStmt.finalize()
  }
  return copied
}

function copyAllUserTables(sourceDb: any, targetDb: any): number {
  const tables = getUserTableNames(sourceDb)
  targetDb.exec({ sql: 'PRAGMA foreign_keys = OFF' })
  targetDb.exec({ sql: 'BEGIN IMMEDIATE' })
  let totalCopied = 0
  try {
    for (const table of tables) {
      const quoted = quoteSQLiteIdentifier(table)
      targetDb.exec({ sql: `DELETE FROM ${quoted}` })
      totalCopied += copyTableRows(sourceDb, targetDb, table)
    }
    targetDb.exec({ sql: 'COMMIT' })
  } catch (error) {
    try {
      targetDb.exec({ sql: 'ROLLBACK' })
    } catch {
      // Ignore rollback errors after failed copy attempt.
    }
    throw error
  } finally {
    targetDb.exec({ sql: 'PRAGMA foreign_keys = ON' })
  }
  return totalCopied
}

/**
 * Migrate messages from conversations.messages_json to the independent messages table.
 * This runs inside the worker thread after schema migration.
 * Idempotent: inserts are de-duplicated by message id.
 */
async function migrateMessagesFromJsonBlob(dbHandle: any): Promise<void> {
  try {
    // Ensure messages table exists
    try {
      const stmt = dbHandle.prepare('SELECT COUNT(*) as count FROM messages')
      stmt.finalize()
    } catch {
      console.log('[SQLite Worker] messages table not found, skipping message migration')
      return
    }

    const legacyColumnStmt = dbHandle.prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('conversations') WHERE name='messages_json'"
    )
    let hasLegacyColumn = false
    if (legacyColumnStmt.step()) {
      const row = legacyColumnStmt.get({}) as { count: number }
      hasLegacyColumn = Number(row.count || 0) > 0
    }
    legacyColumnStmt.finalize()
    if (!hasLegacyColumn) {
      console.log('[SQLite Worker] Message migration skipped: conversations.messages_json does not exist')
      return
    }

    // Migrate all conversations with legacy payload; per-conversation inserts are idempotent.
    const pendingCountStmt = dbHandle.prepare(
      `SELECT COUNT(*) as count
       FROM conversations c
       WHERE COALESCE(c.messages_json, '[]') != '[]'`
    )
    let pendingConversations = 0
    if (pendingCountStmt.step()) {
      const row = pendingCountStmt.get({}) as { count: number }
      pendingConversations = Number(row.count || 0)
    }
    pendingCountStmt.finalize()
    if (pendingConversations === 0) return

    // Read pending conversations' messages_json
    const rows: Array<{ id: string; messages_json: string }> = []
    const selectStmt = dbHandle.prepare(
      `SELECT c.id, c.messages_json
       FROM conversations c
       WHERE COALESCE(c.messages_json, '[]') != '[]'`
    )
    try {
      while (selectStmt.step()) {
        const row = selectStmt.get({}) as { id: string; messages_json: string }
        rows.push(row)
      }
    } finally {
      selectStmt.finalize()
    }

    if (rows.length === 0) return

    let totalMessages = 0
    let totalConversations = 0

    for (const row of rows) {
      let messages: any[]
      try {
        messages = JSON.parse(row.messages_json || '[]')
      } catch {
        console.warn(`[SQLite Worker] Skipping malformed messages_json for conversation ${row.id}`)
        continue
      }
      if (!Array.isArray(messages) || messages.length === 0) continue

      // Insert messages in a transaction per conversation
      dbHandle.exec('BEGIN TRANSACTION')
      try {
        const beforeStmt = dbHandle.prepare(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
        )
        beforeStmt.bind(1, row.id)
        let beforeCount = 0
        if (beforeStmt.step()) {
          const before = beforeStmt.get({}) as { count: number }
          beforeCount = Number(before.count || 0)
        }
        beforeStmt.finalize()

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          if (!msg || !msg.id) continue

          const contentJson = JSON.stringify(msg.content ?? null)
          const metaJson = serializeMessageMetadata(msg)

          dbHandle.exec({
            sql: `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [msg.id, row.id, msg.role, contentJson, metaJson, msg.timestamp, i, msg.timestamp || Date.now()],
          })
        }
        const afterStmt = dbHandle.prepare(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
        )
        afterStmt.bind(1, row.id)
        let afterCount = beforeCount
        if (afterStmt.step()) {
          const after = afterStmt.get({}) as { count: number }
          afterCount = Number(after.count || 0)
        }
        afterStmt.finalize()

        dbHandle.exec('COMMIT')
        const added = Math.max(0, afterCount - beforeCount)
        if (added > 0) {
          totalMessages += added
          totalConversations++
        }
      } catch (error) {
        try { dbHandle.exec('ROLLBACK') } catch { /* ignore */ }
        console.error(`[SQLite Worker] Message migration failed for conversation ${row.id}:`, error)
        // Continue with other conversations instead of failing completely
      }
    }

    if (totalMessages > 0) {
      console.log(
        `[SQLite Worker] Message migration complete: ${totalMessages} messages from ${totalConversations} conversations`
      )
    }

    // Keep legacy messages_json as rollback safety net (read path no longer depends on it).
  } catch (error) {
    console.error('[SQLite Worker] Message migration error:', error)
  }
}

async function migrateFromLegacySahpoolIfNeeded(currentDb: any): Promise<void> {
  if (ENABLE_OPFS_SAHPOOL) return
  if (hasMeaningfulData(currentDb)) return
  if (typeof sqlite3?.installOpfsSAHPoolVfs !== 'function') return

  let legacyPool: any = null
  let legacyDb: any = null
  try {
    legacyPool = await sqlite3.installOpfsSAHPoolVfs(POOL_CONFIG)
    legacyDb = new legacyPool.OpfsSAHPoolDb(DB_NAME, 'c')
    if (!hasMeaningfulData(legacyDb)) return

    const copiedRows = copyAllUserTables(legacyDb, currentDb)
    console.warn(
      `[SQLite Worker] Migrated legacy SAH pool data into OPFS database (rows copied: ${copiedRows}).`
    )
  } catch (error) {
    console.warn('[SQLite Worker] Legacy SAH pool migration skipped:', error)
  } finally {
    if (legacyDb) {
      try {
        legacyDb.close()
      } catch {
        // Ignore close errors in migration path.
      }
    }
  }
}

async function backfillLegacyMessagesFromSahpoolIfNeeded(currentDb: any): Promise<void> {
  if (ENABLE_OPFS_SAHPOOL) return
  if (typeof sqlite3?.installOpfsSAHPoolVfs !== 'function') return

  let legacyPool: any = null
  let legacyDb: any = null
  try {
    legacyPool = await sqlite3.installOpfsSAHPoolVfs(POOL_CONFIG)
    legacyDb = new legacyPool.OpfsSAHPoolDb(DB_NAME, 'c')
    if (!hasMeaningfulData(legacyDb)) return

    const legacyColumnStmt = legacyDb.prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('conversations') WHERE name='messages_json'"
    )
    let hasLegacyMessagesColumn = false
    if (legacyColumnStmt.step()) {
      const row = legacyColumnStmt.get({}) as { count: number }
      hasLegacyMessagesColumn = Number(row.count || 0) > 0
    }
    legacyColumnStmt.finalize()
    if (!hasLegacyMessagesColumn) return

    const rows: Array<{
      id: string
      title: string
      title_mode?: string
      context_usage_json?: string | null
      created_at: number
      updated_at: number
      messages_json: string
    }> = []

    const selectStmt = legacyDb.prepare(
      `SELECT id, title, title_mode, context_usage_json, created_at, updated_at, messages_json
       FROM conversations
       WHERE COALESCE(messages_json, '[]') != '[]'`
    )
    try {
      while (selectStmt.step()) {
        rows.push(selectStmt.get({}) as any)
      }
    } finally {
      selectStmt.finalize()
    }
    if (rows.length === 0) return

    let backfilledConversations = 0
    let backfilledMessages = 0
    for (const row of rows) {
      let messages: any[] = []
      try {
        messages = JSON.parse(row.messages_json || '[]')
      } catch {
        continue
      }
      if (!Array.isArray(messages) || messages.length === 0) continue

      const existingStmt = currentDb.prepare(
        'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
      )
      existingStmt.bind(1, row.id)
      let existingCount = 0
      if (existingStmt.step()) {
        const existingRow = existingStmt.get({}) as { count: number }
        existingCount = Number(existingRow.count || 0)
      }
      existingStmt.finalize()
      if (existingCount >= messages.length) continue

      currentDb.exec('BEGIN TRANSACTION')
      try {
        currentDb.exec({
          sql: `INSERT INTO conversations (id, title, title_mode, context_usage_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title = excluded.title,
                  title_mode = excluded.title_mode,
                  context_usage_json = excluded.context_usage_json,
                  updated_at = excluded.updated_at`,
          bind: [
            row.id,
            row.title || 'New Chat',
            row.title_mode || 'manual',
            row.context_usage_json || null,
            row.created_at || Date.now(),
            row.updated_at || Date.now(),
          ],
        })

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          if (!msg || !msg.id) continue

          const contentJson = JSON.stringify(msg.content ?? null)
          const metaJson = serializeMessageMetadata(msg)
          currentDb.exec({
            sql: `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [msg.id, row.id, msg.role, contentJson, metaJson, msg.timestamp, i, msg.timestamp || Date.now()],
          })
        }

        const addedStmt = currentDb.prepare(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?'
        )
        addedStmt.bind(1, row.id)
        let finalCount = existingCount
        if (addedStmt.step()) {
          const rowCount = addedStmt.get({}) as { count: number }
          finalCount = Number(rowCount.count || 0)
        }
        addedStmt.finalize()
        backfilledMessages += Math.max(0, finalCount - existingCount)

        currentDb.exec('COMMIT')
        backfilledConversations++
      } catch {
        try { currentDb.exec('ROLLBACK') } catch { /* ignore */ }
      }
    }

    if (backfilledConversations > 0) {
      console.warn(
        `[SQLite Worker] Backfilled ${backfilledMessages} messages from legacy SAH pool for ${backfilledConversations} conversations`
      )
    }
  } catch (error) {
    console.warn('[SQLite Worker] Legacy message backfill skipped:', error)
  } finally {
    if (legacyDb) {
      try {
        legacyDb.close()
      } catch {
        // Ignore close errors in migration path.
      }
    }
  }
}

const OPFS_LOCK_NAME = 'creatorweave-sqlite-opfs'

let requestQueue: Promise<void> = Promise.resolve()
let transactionLockRelease: (() => void) | null = null

function supportsWebLocks(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks
}

async function withOpfsLock<T>(operation: () => Promise<T> | T): Promise<T> {
  if (transactionLockRelease || !supportsWebLocks()) {
    return operation()
  }
  return navigator.locks.request(OPFS_LOCK_NAME, { mode: 'exclusive' }, operation)
}

async function acquireTransactionLock(): Promise<void> {
  if (transactionLockRelease || !supportsWebLocks()) return

  let acquired!: () => void
  const lockAcquired = new Promise<void>((resolve) => {
    acquired = resolve
  })
  let release!: () => void
  const holdLock = new Promise<void>((resolve) => {
    release = resolve
  })

  void navigator.locks
    .request(OPFS_LOCK_NAME, { mode: 'exclusive' }, async () => {
      acquired()
      await holdLock
    })
    .catch((error) => console.error('[SQLite Worker] OPFS transaction lock failed:', error))

  await lockAcquired
  transactionLockRelease = release
}

function releaseTransactionLock(): void {
  transactionLockRelease?.()
  transactionLockRelease = null
}

async function processWorkerRequest(request: WorkerRequest): Promise<void> {
  const { type } = request
  const id = 'id' in request ? (request.id as string) : `msg-${Date.now()}`

  try {
    if (type === 'beginTransaction') {
      await acquireTransactionLock()
      try {
        handleExecute('BEGIN TRANSACTION', [])
        postMessage({ type: 'beginTransaction', id } as const)
      } catch (error) {
        releaseTransactionLock()
        throw error
      }
      return
    }

    if (type === 'commit' || type === 'rollback') {
      try {
        handleExecute(type === 'commit' ? 'COMMIT' : 'ROLLBACK', [])
        postMessage({ type, id } as const)
      } finally {
        releaseTransactionLock()
      }
      return
    }

    await withOpfsLock(async () => {
      switch (type) {
        case 'init':
          // schemaSQL parameter is ignored - we use the migration system instead
          await handleInit(request.reportProgress, id)
          postMessage({ type: 'init', id, success: true, mode: dbMode })
          break

        case 'recover':
          await handleRecover()
          postMessage({ type: 'recover', id, success: true })
          break

        case 'queryAll': {
          const rows = handleQueryAll(request.sql, request.params)
          postMessage({ type: 'queryAll', id, rows } as const)
          break
        }

        case 'queryFirst': {
          const row = handleQueryFirst(request.sql, request.params)
          postMessage({ type: 'queryFirst', id, row } as const)
          break
        }

        case 'execute':
          handleExecute(request.sql, request.params)
          postMessage({ type: 'execute', id } as const)
          break

        case 'close':
          if (db) {
            db.close()
            db = null
          }
          releaseTransactionLock()
          postMessage({ type: 'close', id } as const)
          break

        case 'getMode':
          postMessage({ type: 'getMode', id, mode: dbMode })
          break

        case 'setSQLLogging':
          enableSQLLogging = request.enabled
          console.log(`[SQLite Worker] SQL logging ${enableSQLLogging ? 'ENABLED' : 'DISABLED'}`)
          postMessage({ type: 'setSQLLogging', id, enabled: enableSQLLogging })
          break
      }
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    postMessage({ type, id, error: errorMsg } as any)
  }
}

// Queue messages so an async init/recovery cannot race a later transaction.
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  requestQueue = requestQueue.then(() => processWorkerRequest(e.data)).catch(() => undefined)
}

/**
 * Open an OpfsDb with retry on OPFS sync-handle contention.
 *
 * Regular OPFS VFS (not SAH Pool) acquires a Sync Access Handle for each I/O
 * operation. When multiple tabs/workers access the same database file, their
 * I/O can collide and the OPFS API throws NoModificationAllowedError, which
 * SQLite wraps as SQLITE_BUSY or GetSyncHandleError.
 *
 * Instead of failing immediately, we retry with exponential backoff. The
 * contention window is very short (milliseconds), so even a modest retry
 * budget dramatically reduces spurious init failures.
 *
 * Returns the opened OpfsDb on success; throws the last error on exhaustion.
 */
function isOpfsBusyError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase()
  return (
    msg.includes('nomodificationallowederror') ||
    msg.includes('modifications are not allowed') ||
    msg.includes('sync handle') ||
    msg.includes('getsynchandleerror') ||
    msg.includes('sqlite_busy') ||
    msg.includes('database is locked') ||
    msg.includes('result code 5') ||
    msg.includes('result code 6') // SQLITE_LOCKED
  )
}

async function openOpfsDbWithRetry(
  opener: () => OpfsDatabase,
  initId: string,
  options: { maxAttempts?: number; baseDelay?: number; maxDelay?: number } = {}
): Promise<OpfsDatabase> {
  const maxAttempts = options.maxAttempts ?? 6
  if (maxAttempts < 1) {
    throw new Error('openOpfsDbWithRetry: maxAttempts must be >= 1')
  }
  const baseDelay = options.baseDelay ?? 150 // ms
  const maxDelay = options.maxDelay ?? 2000 // ms

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return opener()
    } catch (error) {
      lastError = error
      if (!isOpfsBusyError(error) || attempt === maxAttempts) {
        throw error
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
      // Add small jitter to avoid synchronized retry storms
      const jitter = Math.random() * delay * 0.3
      const wait = delay + jitter
      console.warn(
        `[SQLite Worker] ${initId}: OPFS busy (attempt ${attempt}/${maxAttempts}), retrying in ${Math.round(wait)}ms...`,
        String(error instanceof Error ? error.message : error)
      )
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}

/**
 * Recover from database errors by attempting reconnection first
 * This is called when SQLITE_CANTOPEN or GetSyncHandleError errors occur
 *
 * IMPORTANT: This will NEVER delete an existing database to prevent data loss.
 * Recovery strategy with opfs-sahpool:
 * 1. Try to reopen database (sahpool can recover from stale handles)
 * 2. If that fails, throw error asking user to refresh (data is safe in OPFS)
 */
async function handleRecover() {
  const recoverId = `recover-${Date.now()}`
  console.log(`[SQLite Worker] ${recoverId}: Starting database recovery...`)

  // Close existing database if open
  if (db) {
    try {
      db.close()
      console.log(`[SQLite Worker] ${recoverId}: Closed existing database`)
    } catch {
      // Ignore close errors during recovery
    }
    db = null
  }

  // Step 1: Try to reconnect to existing database
  // opfs-sahpool can often recover from stale handles without needing refresh
  if (ENABLE_OPFS_SAHPOOL && (poolUtil || typeof sqlite3.installOpfsSAHPoolVfs === 'function')) {
    try {
      // Use the stored poolUtil if available, otherwise reinitialize
      if (!poolUtil) {
        console.warn(`[SQLite Worker] ${recoverId}: poolUtil was null, reinitializing...`)
        poolInitCount++
        poolUtil = await sqlite3.installOpfsSAHPoolVfs(POOL_CONFIG)
        console.log(
          `[SQLite Worker] ${recoverId}: Created NEW pool during recovery (count: ${poolInitCount})`
        )
      } else {
        console.log(`[SQLite Worker] ${recoverId}: Reusing existing poolUtil`)
      }
      // Use OpfsSAHPoolDb to reopen the database
      db = new poolUtil.OpfsSAHPoolDb(DB_NAME, 'c')
      dbMode = 'opfs'

      // Verify connection works
      db.exec({ sql: 'SELECT 1', returnValue: 'resultRows' })
      console.log(`[SQLite Worker] ${recoverId}: Successfully reopened existing database`)

      // Run migrations after reconnection to ensure schema is up-to-date
      try {
        await initializeSchema(db)
      } catch (schemaError) {
        console.warn('[SQLite Worker] Schema migration warning:', schemaError)
        // Continue - reconnection succeeded, migrations are idempotent
      }

      console.log(`[SQLite Worker] ${recoverId}: Recovery SUCCESS`)
      return
    } catch (reconnectError) {
      const errorMsg =
        reconnectError instanceof Error ? reconnectError.message : String(reconnectError)

      console.error(`[SQLite Worker] ${recoverId}: Reconnection FAILED:`, errorMsg)

      // Check error type to determine safe action
      const isCorrupted = errorMsg.includes('malformed') || errorMsg.includes('corruption')
      const isNotFound =
        errorMsg.includes('unable to open') ||
        errorMsg.includes('CANTOPEN') ||
        errorMsg.includes('no such file')

      if (isCorrupted) {
        // Database exists but is corrupted - DON'T auto-delete
        console.error(
          '[SQLite Worker] Database exists but appears corrupted. Auto-recovery disabled to prevent data loss.'
        )
        throw new Error(
          'Database corrupted. Please reset manually using window.__resetSQLiteDB() if needed.'
        )
      }

      if (isNotFound) {
        // Database appears inaccessible after reconnection failure
        // This is likely an OPFS issue that requires page refresh
        // DON'T auto-create a new database as this will cause data loss!
        console.error('[SQLite Worker] Database inaccessible after reconnection failure.')
        console.error('[SQLite Worker] Your data is SAFE in OPFS, but we cannot access it.')
        console.error('[SQLite Worker] User needs to refresh the page to restore connection.')
        throw new Error(
          'DATABASE_INACCESSIBLE: Please refresh the page to restore database access. ' +
            'Your conversation data is safe, but we cannot access it due to a browser OPFS issue. ' +
            'Refreshing the page will restore the database connection.'
        )
      }

      // Unknown error - don't risk auto-creating database
      console.error('[SQLite Worker] Unknown database error:', errorMsg)
      throw reconnectError
    }
  }

  // Step 2: Try regular OPFS reconnection when SAH pool is disabled/unavailable.
  if (sqlite3?.oo1?.OpfsDb) {
    try {
      db = await openOpfsDbWithRetry(
        () => new sqlite3.oo1.OpfsDb(DB_NAME),
        recoverId
      )
      dbMode = 'opfs'
      db.exec({ sql: 'SELECT 1', returnValue: 'resultRows' })

      try {
        await initializeSchema(db)
      } catch (schemaError) {
        console.warn('[SQLite Worker] Schema migration warning:', schemaError)
      }

      console.log(`[SQLite Worker] ${recoverId}: Recovery SUCCESS via regular OPFS`)
      return
    } catch (reconnectError) {
      const errorMsg = reconnectError instanceof Error ? reconnectError.message : String(reconnectError)
      console.error(`[SQLite Worker] ${recoverId}: Regular OPFS reconnection FAILED:`, errorMsg)
      throw new Error(
        'DATABASE_INACCESSIBLE: Please refresh the page to restore database access. ' +
          'Your conversation data is safe, but we cannot access it due to a browser OPFS issue. ' +
          'Refreshing the page will restore the database connection.'
      )
    }
  }

  // Step 2: DO NOT fallback to in-memory during recovery!
  // In-memory mode creates an isolated empty database per worker/tab,
  // causing multi-tab data desync (tabs see different data).
  // During recovery, we must either succeed with OPFS or fail explicitly.
  const errorMsg =
    'Recovery failed to reconnect to OPFS database. ' +
    'Your data is safe in OPFS, but please refresh the page to restore access.'
  console.error('[SQLite Worker] Recovery failed:', errorMsg)
  throw new Error('RECOVERY_FAILED: ' + errorMsg)
}

async function handleInit(reportProgress = false, _id: string = 'init') {
  initCount++
  const initId = `init-${initCount}-${Date.now()}`
  console.log(`[SQLite Worker] ${initId}: Starting initialization...`)

  // Wait for crossOriginIsolated to be true before initializing SQLite
  if (!self.crossOriginIsolated) {
    const maxWait = 5000 // 5 seconds max
    const startTime = Date.now()
    while (!self.crossOriginIsolated && Date.now() - startTime < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  // Initialize SQLite WASM module
  // @ts-ignore - sqlite3InitModule types are incomplete
  sqlite3 = await sqlite3InitModule({
    print: (msg: string) => console.log('[SQLite Worker]', msg),
    printErr: (msg: string) => console.error('[SQLite Worker]', msg),
  })

  // Try to use opfs-sahpool VFS for better performance and reliability
  // @ts-ignore - installOpfsSAHPoolVfs types are incomplete
  if (ENABLE_OPFS_SAHPOOL && typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
      const isNewPool = !poolUtil
      if (isNewPool) {
        poolInitCount++
        console.log(
          `[SQLite Worker] ${initId}: Creating NEW opfs-sahpool (count: ${poolInitCount})`
        )
      } else {
        console.log(`[SQLite Worker] ${initId}: Reusing existing opfs-sahpool`)
      }
      poolUtil = await sqlite3.installOpfsSAHPoolVfs(POOL_CONFIG)

      // Use the OpfsSAHPoolDb constructor from poolUtil
      // 'c' flag = create-if-not-exists (opens existing or creates new, never truncates)
      // @ts-ignore - OpfsSAHPoolDb types are incomplete
      db = new poolUtil.OpfsSAHPoolDb(DB_NAME, 'c')
      dbMode = 'opfs'

      // Check if database was newly created or opened existing
      let tableCount = 0
      try {
        const stmt = db.prepare('SELECT COUNT(*) as count FROM sqlite_master')
        if (stmt.step()) {
          const result = stmt.get({}) as { count: number }
          tableCount = result.count
          console.log(
            `[SQLite Worker] ${initId}: Database OPENED (existing) - tables: ${tableCount}`
          )
        }
        stmt.finalize()
      } catch {
        // If query fails, database might be newly created with no schema yet
        console.log(`[SQLite Worker] ${initId}: Database likely NEW (schema not yet initialized)`)
      }

      // Additional check: verify actual data exists in key tables
      if (tableCount > 0) {
        try {
          const stmt = db.prepare(
            'SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM workspaces) as total_rows'
          )
          if (stmt.step()) {
            const result = stmt.get({}) as { total_rows: number }
            const totalRows = result.total_rows

            if (totalRows > 0) {
              hasSeenData = true
              console.log(
                `[SQLite Worker] ${initId}: Data check - ${totalRows} rows found (conversations + workspaces)`
              )
            } else {
              console.warn(
                `[SQLite Worker] ${initId}: ⚠️ Database exists but is EMPTY! Schema present but no data.`
              )

              // If we've seen data before but now it's gone, that's data loss!
              if (hasSeenData) {
                console.error(
                  `[SQLite Worker] ${initId}: 🚨 DATA LOSS DETECTED! Previous session had data, but database is now empty.`
                )
                console.error(
                  `[SQLite Worker] ${initId}: This may indicate opfs-sahpool handle staleness or OPFS data cleanup by browser.`
                )
                console.error(
                  `[SQLite Worker] ${initId}: Consider checking browser storage settings or using a more persistent storage method.`
                )
              }
            }
          }
          stmt.finalize()
        } catch {
          console.log(
            `[SQLite Worker] ${initId}: Could not check data existence (tables may not exist yet)`
          )
        }
      }
    } catch (error) {
      console.warn(
        `[SQLite Worker] ${initId}: opfs-sahpool failed, falling back to regular OPFS:`,
        error
      )
      // Fallback to regular opfs VFS
      db = await openOpfsDbWithRetry(
        () => new sqlite3!.oo1.OpfsDb(DB_NAME),
        initId
      )
      dbMode = 'opfs'
      poolUtil = null
    }
  } else if (sqlite3 && 'opfs' in sqlite3 && sqlite3.opfs) {
    // opfs-sahpool not available, use regular opfs VFS
    console.log(`[SQLite Worker] ${initId}: Using regular OPFS VFS`)
    db = await openOpfsDbWithRetry(
      () => new sqlite3.oo1.OpfsDb(DB_NAME),
      initId
    )
    dbMode = 'opfs'
  } else {
    // OPFS completely unavailable - this MUST NOT fallback to memory mode
    // because memory mode creates an isolated empty database per worker/tab,
    // causing different tabs to see different data (the "multi-tab desync" bug).
    // Instead, throw an error which will trigger recovery or ask user to refresh.
    const diagnostics = [
      `crossOriginIsolated=${self.crossOriginIsolated}`,
      `isSecureContext=${self.isSecureContext}`,
      `opfsGetDirectory=${typeof navigator?.storage?.getDirectory}`,
      `location=${self.location?.href}`,
      `UA=${navigator?.userAgent}`,
    ].join(', ')

    let cause: string
    if (!self.isSecureContext) {
      cause =
        'Page is not in a secure context (https:// or localhost). ' +
        'OPFS requires a secure context — accessing via http://<LAN-IP> or file:// will fail. '
    } else if (typeof navigator?.storage?.getDirectory !== 'function') {
      cause =
        'This browser does not support OPFS (navigator.storage.getDirectory is missing). ' +
        'Try Chrome/Edge desktop, or Safari/iOS 15.2+. '
    } else if (!self.crossOriginIsolated) {
      cause =
        'Page is not cross-origin isolated. The main document must be served with ' +
        'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp ' +
        '(or credentialless). '
    } else {
      cause = 'OPFS VFS could not be installed in this worker context. '
    }

    const errorMsg =
      cause +
      'Please refresh the page or switch to a supported browser. ' +
      `[${diagnostics}]`
    console.error('[SQLite Worker] OPFS unavailable: ' + diagnostics)
    throw new Error('OPFS_NOT_AVAILABLE: ' + errorMsg)
  }

  // Initialize schema using migration + schema-healing.
  // Do not run destructive auto-recovery heuristics here.
  try {
    await initializeSchema(db, reportProgress ? createProgressReporter() : undefined)
    await migrateFromLegacySahpoolIfNeeded(db)
    // Migrate messages from JSON blob to independent table (idempotent)
    await migrateMessagesFromJsonBlob(db)
    // Safety net: if metadata exists but message rows are missing, backfill from legacy SAH pool.
    await backfillLegacyMessagesFromSahpoolIfNeeded(db)
  } catch (error) {
    console.error(`[SQLite Worker] ${initId}: Database initialization failed:`, error)
    const errorMsg = error instanceof Error ? error.message : String(error)
    const isSchemaError =
      errorMsg.includes('no such column') ||
      errorMsg.includes('no such table') ||
      errorMsg.includes('schema') ||
      errorMsg.includes('malformed')
    if (isSchemaError) {
      throw new Error(
        `SCHEMA_INCOMPATIBLE: ${errorMsg}. ` +
          'Existing data was not deleted. Export a backup before resetting, then refresh to retry.'
      )
    }
    throw error
  }
}

/**
 * Create a progress reporter function that sends messages back to main thread
 */
function createProgressReporter() {
  return (progress: { step: string; details: string; current: number; total: number }) => {
    postMessage({
      type: 'migrationProgress',
      step: progress.step,
      details: progress.details,
      current: progress.current,
      total: progress.total,
    } as WorkerResponse)
  }
}

function handleQueryAll(sql: string, params: unknown[]): unknown[] {
  if (!db) {
    throw new Error('Database not initialized')
  }

  // SQL logging (dev only)
  if (enableSQLLogging) {
    const sqlPreview = sql.slice(0, 100)
    const paramsStr = params.length > 0 ? JSON.stringify(params).slice(0, 50) : ''
    console.log(`[SQLite SQL] QUERY ${sqlPreview}${sql.length > 100 ? '...' : ''}`, paramsStr || '')
  }

  // Check if database connection is still valid
  // With opfs-sahpool, stale handles are less common but we still check
  try {
    // Simple check: try to get the filename
    const filename = db.filename
    if (!filename) {
      throw new Error('Database connection invalid: no filename')
    }
  } catch {
    // Try to reconnect using opfs-sahpool
    if (poolUtil) {
      try {
        db = new poolUtil.OpfsSAHPoolDb(DB_NAME, 'c')
        dbMode = 'opfs'
      } catch (reconnectError) {
        console.error('[SQLite Worker] Reconnection failed:', reconnectError)
        throw new Error('DATABASE_INACCESSIBLE: Database connection lost. Please refresh the page.')
      }
    } else if (sqlite3?.oo1?.OpfsDb) {
      try {
        db = new sqlite3.oo1.OpfsDb(DB_NAME)
        dbMode = 'opfs'
      } catch (reconnectError) {
        console.error('[SQLite Worker] Reconnection failed:', reconnectError)
        throw new Error('DATABASE_INACCESSIBLE: Database connection lost. Please refresh the page.')
      }
    } else {
      throw new Error('Database connection is no longer valid. Please reload the page.')
    }
  }

  const rows: unknown[] = []
  const stmt = db.prepare(sql)

  try {
    for (let i = 0; i < params.length; i++) {
      stmt.bind(i + 1, params[i])
    }

    while (stmt.step()) {
      rows.push(stmt.get({}))
    }
  } finally {
    stmt.finalize()
  }

  return rows
}

function handleQueryFirst(sql: string, params: unknown[]): unknown | null {
  const rows = handleQueryAll(sql, params)
  return rows[0] || null
}

function handleExecute(sql: string, params: unknown[]): void {
  if (!db) {
    throw new Error('Database not initialized')
  }

  // SQL logging (dev only)
  if (enableSQLLogging) {
    const sqlPreview = sql.slice(0, 100)
    const paramsStr = params.length > 0 ? JSON.stringify(params).slice(0, 50) : ''
    console.log(`[SQLite SQL] EXEC ${sqlPreview}${sql.length > 100 ? '...' : ''}`, paramsStr || '')
  }

  // Check if database connection is still valid before executing
  // With opfs-sahpool, stale handles are less common but we still check
  try {
    const filename = db.filename
    if (!filename) {
      throw new Error('Database connection invalid: no filename')
    }
  } catch {
    // Try to reconnect using opfs-sahpool
    if (poolUtil) {
      try {
        db = new poolUtil.OpfsSAHPoolDb(DB_NAME, 'c')
        dbMode = 'opfs'
      } catch (reconnectError) {
        console.error('[SQLite Worker] Reconnection failed:', reconnectError)
        throw new Error('DATABASE_INACCESSIBLE: Database connection lost. Please refresh the page.')
      }
    } else if (sqlite3?.oo1?.OpfsDb) {
      try {
        db = new sqlite3.oo1.OpfsDb(DB_NAME)
        dbMode = 'opfs'
      } catch (reconnectError) {
        console.error('[SQLite Worker] Reconnection failed:', reconnectError)
        throw new Error('DATABASE_INACCESSIBLE: Database connection lost. Please refresh the page.')
      }
    } else {
      throw new Error('Database connection is no longer valid. Please reload the page.')
    }
  }

  db.exec({ sql, bind: params })
}

export {}
